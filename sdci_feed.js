// sdci_feed.js
//
// Pure helpers for the scheduled SDCI base-feed ingest (worker.js
// runScheduledIngest). The ingest no longer re-reads "the newest 5,000
// applications": it pulls every record whose Socrata system field
// `:updated_at` moved since the last successful run (keyset-paginated on
// `:updated_at, permitnum`), and a weekly full sweep re-reads every permit in
// the coverage window (keyset-paginated on `permitnum`). Both are bounded per
// run and resume from a cursor stored on their ingest_logs row.
//
// Socrata documents `:updated_at` as "a Fixed Timestamp representing when this
// record was last updated", usable in $where to get recent updates; a full
// dataset *replace* bumps it on every row (dev.socrata.com/docs/system-fields).
// How Seattle publishes k44w-2dcq (row upserts vs. daily replace) is not
// verified here: on a daily replace the incremental pull degrades to a rolling
// full refresh of PAGE_SIZE * pages rows a day, which is still bounded and
// still correct, just slower to converge. Tests: tests/sdci_feed.test.js.

export const SDCI_PERMIT_URL = "https://data.seattle.gov/resource/k44w-2dcq.json";

export const SDCI_SELECT_FIELDS = [
  "permitnum",
  "permitclass",
  "permitclassmapped",
  "permittypemapped",
  "permittypedesc",
  "description",
  "housingunits",
  "statuscurrent",
  "originaladdress1",
  "originalcity",
  "originalstate",
  "originalzip",
  "contractorcompanyname",
  "link",
  "latitude",
  "longitude",
  "applieddate",
  "issueddate",
  "expiresdate",
  "completeddate",
  "estprojectcost",
  "readytoissuedate",
  "planreviewcompletedate",
  "zoning",
  "housingcategory",
  "dwellingunittype",
  "parentpermitnum",
  "relatedmup",
  "numberreviewcycles",
  "totaldaysplanreview",
  "daysoutcorrections",
  "housingunitsadded",
  "housingunitsremoved",
  ":updated_at",
];

// Socrata leaves null fields out of each JSON row, so absence on one row means
// nothing. A field absent from *every* row of a sizeable page means the feed
// renamed or dropped it, and the run fails loudly instead of writing NULLs.
export const SDCI_EXPECTED_FIELDS = [
  "permitclass",
  "statuscurrent",
  "originaladdress1",
  "applieddate",
  "latitude",
  "longitude",
];
export const SDCI_REQUIRED_FIELDS = ["permitnum", ":updated_at"];

export const FEED_LIMITS = Object.freeze({
  pageSize: 1000,
  // Per scheduled run, across the incremental pull and the sweep. The old
  // window wrote 5 pages (5,000 rows) a day well inside Workers limits.
  maxPagesPerRun: 8,
  // Pages kept back for the sweep while one is due, so a busy feed cannot
  // starve it.
  sweepReservedPages: 2,
  overlapMinutes: 120,
  sweepIntervalDays: 7,
  fetchAttempts: 3,
  backoffMs: 1000,
  schemaGuardMinRows: 50,
  mappingGuardMinRows: 200,
  mappingGuardMaxOtherRatio: 0.05,
});

// Used only when D1 has no permits yet (a fresh database).
export const DEFAULT_COVERAGE_FLOOR = "2022-01-01";

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function soqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function soqlTimestamp(value) {
  const text = String(value || "");
  if (!TIMESTAMP_RE.test(text)) throw new Error(`Invalid Socrata timestamp in cursor: ${text.slice(0, 40)}`);
  // SoQL compares fixed timestamps against ISO-8601 literals.
  return `'${text}'`;
}

/** "YYYY-MM-DD HH:MM:SS" (ingest_logs) minus overlap -> Socrata ISO literal. */
export function watermarkFromLogTime(logTime, overlapMinutes = FEED_LIMITS.overlapMinutes) {
  const text = String(logTime || "").trim();
  if (!text) return null;
  const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(text) ? text.replace(" ", "T") : `${text.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms - overlapMinutes * 60000).toISOString();
}

export function encodeCursor(cursor) {
  return cursor ? JSON.stringify(cursor) : null;
}

export function decodeCursor(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Query string for one page.
 * - incremental: { mode: "incremental", since, cursor: { updated_at, permitnum } | null }
 * - sweep:       { mode: "sweep", cursor: { permitnum } | null }
 * Both are restricted to applieddate >= floor (the coverage window).
 */
export function buildFeedQuery({ mode, since = null, cursor = null, floor = DEFAULT_COVERAGE_FLOOR, pageSize = FEED_LIMITS.pageSize }) {
  if (!DATE_RE.test(String(floor))) throw new Error(`Invalid coverage floor: ${floor}`);
  const where = [`applieddate >= ${soqlString(`${floor}T00:00:00.000`)}`];
  let order;
  if (mode === "incremental") {
    if (cursor?.updated_at) {
      const t = soqlTimestamp(cursor.updated_at);
      where.push(`(:updated_at > ${t} OR (:updated_at = ${t} AND permitnum > ${soqlString(cursor.permitnum || "")}))`);
    } else if (since) {
      where.push(`:updated_at > ${soqlTimestamp(since)}`);
    }
    order = ":updated_at, permitnum";
  } else if (mode === "sweep") {
    if (cursor?.permitnum) where.push(`permitnum > ${soqlString(cursor.permitnum)}`);
    order = "permitnum";
  } else {
    throw new Error(`Unknown feed mode: ${mode}`);
  }
  const params = new URLSearchParams();
  params.set("$select", SDCI_SELECT_FIELDS.join(","));
  params.set("$where", where.join(" AND "));
  params.set("$order", order);
  params.set("$limit", String(pageSize));
  return params;
}

export function feedPageUrl(query, baseUrl = SDCI_PERMIT_URL) {
  return `${baseUrl}?${query.toString()}`;
}

/** Cursor after the last row of a page (rows arrive in keyset order). */
export function cursorAfterPage(mode, page) {
  const last = page[page.length - 1];
  if (!last) return null;
  return mode === "incremental"
    ? { updated_at: last[":updated_at"], permitnum: last.permitnum }
    : { permitnum: last.permitnum };
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * GET one feed page with retry and exponential backoff on network errors,
 * 408/429 and 5xx. A 4xx such as 400 (Socrata's answer to an unknown column in
 * $select/$where) fails at once with the response body: that is a schema
 * change, not a blip.
 */
export async function fetchFeedPage(url, {
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = FEED_LIMITS.fetchAttempts,
  backoffMs = FEED_LIMITS.backoffMs,
  log = console,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "BuildingSeattle-Worker/1.1" },
      });
    } catch (error) {
      lastError = new Error(`Seattle Open Data request failed: ${error?.message || error}`);
    }
    if (response) {
      if (response.ok) {
        const page = await response.json();
        if (!Array.isArray(page)) throw new Error("Seattle Open Data returned a non-array page");
        return page;
      }
      const body = (await response.text().catch(() => "")).slice(0, 300);
      lastError = new Error(`Seattle Open Data returned ${response.status}: ${body}`);
      if (!RETRYABLE_STATUS.has(response.status)) {
        if (response.status === 400) {
          lastError.message = `Schema guard: Socrata rejected the query (a selected or filtered column may have been renamed). ${lastError.message}`;
        }
        throw lastError;
      }
    }
    if (attempt < attempts) {
      const delay = backoffMs * 2 ** (attempt - 1);
      log.warn?.(`SDCI feed fetch attempt ${attempt}/${attempts} failed (${lastError.message}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Throw if a page lost a required field or an expected column. */
export function assertFeedPage(page, { minRows = FEED_LIMITS.schemaGuardMinRows } = {}) {
  for (const field of SDCI_REQUIRED_FIELDS) {
    const missing = page.filter((row) => row?.[field] === undefined || row?.[field] === null || row?.[field] === "").length;
    if (missing) throw new Error(`Schema guard: ${missing} of ${page.length} feed rows have no ${field}`);
  }
  if (page.length >= minRows) {
    const absent = SDCI_EXPECTED_FIELDS.filter((field) => !page.some((row) => row?.[field] !== undefined));
    if (absent.length) {
      throw new Error(`Schema guard: no row in a ${page.length}-row feed page has ${absent.join(", ")}`);
    }
  }
}

/**
 * Fail a page before writing when classification collapses: more than 5% of a
 * sizeable page landing in type "other" or neighborhood "Other" means the feed
 * changed a vocabulary (permitclass) or stopped sending coordinates.
 */
export function assertMappingHealth(permits, {
  minRows = FEED_LIMITS.mappingGuardMinRows,
  maxRatio = FEED_LIMITS.mappingGuardMaxOtherRatio,
} = {}) {
  if (permits.length < minRows) return;
  const otherType = permits.filter((p) => p.type === "other").length;
  const otherNeighborhood = permits.filter((p) => p.neighborhood === "Other").length;
  if (otherType / permits.length > maxRatio) {
    throw new Error(`Mapping guard: ${otherType} of ${permits.length} permits classified as type "other"`);
  }
  if (otherNeighborhood / permits.length > maxRatio) {
    throw new Error(`Mapping guard: ${otherNeighborhood} of ${permits.length} permits have neighborhood "Other"`);
  }
}

function logTimeMs(text) {
  const value = String(text || "").trim();
  if (!value) return NaN;
  return Date.parse(/Z$/.test(value) ? value.replace(" ", "T") : `${value.replace(" ", "T")}Z`);
}

/**
 * Decide what this run pulls, from the latest successful ingest_logs rows.
 * `lastIncremental` / `lastSweep`: { start_time, cursor } or null.
 * - incremental: resume from a stored cursor (the last run hit its page cap),
 *   else everything updated since the last success's start minus the overlap,
 *   else (first run ever) since the last success of any scheduled run / null
 *   = everything in the window.
 * - sweep: continue a stored cursor; start a new one when the last completed
 *   sweep started more than sweepIntervalDays ago (or never ran).
 */
export function planFeedRun({ lastIncremental = null, lastSweep = null, now = new Date(), limits = FEED_LIMITS } = {}) {
  const incCursor = decodeCursor(lastIncremental?.cursor);
  const incremental = incCursor?.updated_at
    ? { mode: "incremental", cursor: incCursor, since: null }
    : { mode: "incremental", cursor: null, since: watermarkFromLogTime(lastIncremental?.start_time, limits.overlapMinutes) };

  let sweep = null;
  const sweepCursor = decodeCursor(lastSweep?.cursor);
  if (lastSweep && sweepCursor?.permitnum) {
    sweep = { mode: "sweep", cursor: sweepCursor, resumed: true };
  } else {
    const started = logTimeMs(lastSweep?.start_time);
    if (!lastSweep || Number.isNaN(started) || now.getTime() - started >= limits.sweepIntervalDays * 86400000) {
      sweep = { mode: "sweep", cursor: null, resumed: false };
    }
  }

  const sweepPages = sweep ? Math.min(limits.sweepReservedPages, limits.maxPagesPerRun) : 0;
  return {
    incremental: { ...incremental, maxPages: limits.maxPagesPerRun - sweepPages },
    sweep: sweep ? { ...sweep, maxPages: sweepPages } : null,
  };
}
