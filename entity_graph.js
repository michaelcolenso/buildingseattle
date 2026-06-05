// entity_graph.js
//
// Pure (database-free) logic that turns raw permit rows into the derived
// entity graph: addresses, people/orgs, projects and neighborhoods.
//
// Everything here is deterministic and side-effect free so it can be unit
// tested in isolation. The worker (worker.js) is responsible for loading
// permits from D1, calling buildEntityGraph(), and persisting the result.

// --------------------------------------------------------------------------
// slugs
// --------------------------------------------------------------------------

// Stable slug: lowercase, strip punctuation, collapse whitespace/hyphens.
export function makeSlug(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Deduplicate a slug against a Set of taken slugs, appending -2, -3, ...
// The Set is mutated to include the returned slug.
export function dedupeSlug(base, taken) {
  let slug = base || "item";
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n += 1;
  const result = `${slug}-${n}`;
  taken.add(result);
  return result;
}

// --------------------------------------------------------------------------
// address normalization
// --------------------------------------------------------------------------

function collapse(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// Parse a raw permit address string into structured parts.
// Examples:
//   "6737 6th AVE NW, Seattle, WA"
//   "3703 14TH AVE S, SEATTLE, WA 98108"
//   "Ballard Warehouse District"
export function parseAddress(raw) {
  const parts = collapse(raw)
    .split(",")
    .map((p) => collapse(p))
    .filter(Boolean);

  const street = parts[0] || collapse(raw) || "Unknown location";
  let city = "Seattle";
  let state = "WA";
  let zip = null;

  for (const token of parts.slice(1)) {
    // A token may be like "WA 98108" or "Seattle WA".
    const words = token.split(" ");
    for (const word of words) {
      if (/^\d{5}(-\d{4})?$/.test(word)) {
        zip = word;
      } else if (/^[A-Za-z]{2}$/.test(word) && word.toUpperCase() !== "NW" && word.toUpperCase() !== "NE" && word.toUpperCase() !== "SW" && word.toUpperCase() !== "SE") {
        state = word.toUpperCase();
      } else if (/^washington$/i.test(word)) {
        state = "WA";
      } else if (!/^\d+$/.test(word)) {
        // treat the non-numeric remainder as the city only if it isn't the state token
        if (words.length === 1) city = token;
      }
    }
    // If the whole token was a single city word (e.g. "Seattle"), keep it.
    if (words.length === 1 && /^[A-Za-z][A-Za-z .'-]*$/.test(token) && token.toUpperCase() !== state) {
      city = token;
    }
  }

  const displayStreet = street;
  const display_address = `${displayStreet}, ${city}, ${state}`;
  // Normalized (dedup) key is uppercased + collapsed so case/spacing variants merge.
  const normalized_address = collapse(`${displayStreet}, ${city}, ${state}`).toUpperCase();

  return { street: displayStreet, display_address, normalized_address, city, state, zip };
}

// --------------------------------------------------------------------------
// people / organization normalization
// --------------------------------------------------------------------------

export function normalizeOrgName(name) {
  return collapse(name).toUpperCase().replace(/\.+$/g, "");
}

const ORG_TOKENS = [
  "LLC", "INC", "CORP", "CORPORATION", "COMPANY", "CONSTRUCTION", "BUILDERS",
  "BUILDING", "GROUP", "LLP", "ENTERPRISES", "ENGINEERING", "ARCHITECTS",
  "ARCHITECT", "ARCHITECTURE", "DESIGN", "DEVELOPMENT", "PROPERTIES", "HOMES",
  "CONTRACTOR", "CONTRACTORS", "SERVICES", "REMODEL", "REMODELING", "PARTNERS",
  "ASSOCIATES", "INVESTMENTS", "CAPITAL", "REALTY", "MANAGEMENT", "SYSTEMS",
  "SOLUTIONS", "INDUSTRIES", "ELECTRIC", "ELECTRICAL", "PLUMBING", "MECHANICAL",
  "ROOFING", "EXCAVATION", "FRAMING", "DEVELOPERS", "HOLDINGS", "TRUST", "LP",
];

// Guess whether a participant name is an organization or a person.
export function guessOrgType(name) {
  const upper = normalizeOrgName(name);
  if (!upper) return "unknown";

  const words = upper.split(/[^A-Z0-9&]+/).filter(Boolean);
  if (words.some((w) => ORG_TOKENS.includes(w)) || upper.includes("&")) {
    return "organization";
  }
  // "Last, First" or a simple 2-3 word human name with no digits.
  if (/,/.test(name) && /^[A-Za-z.' -]+$/.test(name)) {
    return "person";
  }
  if (!/\d/.test(upper) && words.length >= 2 && words.length <= 3) {
    return "person";
  }
  return "unknown";
}

// --------------------------------------------------------------------------
// project clustering
// --------------------------------------------------------------------------

const PARTICIPANT_ROLES = [
  ["contractor_name", "contractor"],
  ["owner_name", "owner"],
  ["applicant_name", "applicant"],
  ["architect_name", "architect"],
];

function bestDate(permit) {
  return permit.issued_date || permit.applied_date || permit.completed_date || null;
}

function dayNumber(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  return Number.isNaN(t) ? null : Math.floor(t / 86400000);
}

function descTokens(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const BUILT_CATEGORIES = new Set(["residential", "commercial", "industrial", "new"]);
const NON_BUILD_CATEGORIES = new Set(["demolition", "land", "grading"]);

function unrelatedCategory(t1, t2) {
  const a = String(t1 || "").toLowerCase();
  const b = String(t2 || "").toLowerCase();
  if (!a || !b || a === b) return false;
  return (
    (NON_BUILD_CATEGORIES.has(a) && BUILT_CATEGORIES.has(b)) ||
    (NON_BUILD_CATEGORIES.has(b) && BUILT_CATEGORIES.has(a))
  );
}

function participantKeys(permit) {
  const keys = [];
  for (const [field] of PARTICIPANT_ROLES) {
    const v = normalizeOrgName(permit[field]);
    if (v) keys.push(v);
  }
  return keys;
}

// Score similarity between two permits that already share an address.
export function scorePair(a, b) {
  let score = 50; // +50 same address (clustering only runs within an address)

  const aKeys = new Set(participantKeys(a));
  const bKeys = participantKeys(b);
  if (bKeys.some((k) => aKeys.has(k))) score += 20;

  const da = dayNumber(bestDate(a));
  const db = dayNumber(bestDate(b));
  if (da !== null && db !== null) {
    const diff = Math.abs(da - db);
    if (diff <= 180) score += 15;
    if (diff > 365 * 3) score -= 30;
  }

  if (a.type && b.type && String(a.type).toLowerCase() === String(b.type).toLowerCase()) {
    score += 10;
  }

  const simDesc = jaccard(descTokens(a.detailed_description || a.description), descTokens(b.detailed_description || b.description));
  if (simDesc >= 0.5) score += 20;

  if (unrelatedCategory(a.type, b.type)) score -= 25;

  return score;
}

const CLUSTER_THRESHOLD = 70;

// Cluster permits at a single address into connected components where an edge
// exists when scorePair >= 70. Returns array of { permits, edgeScores }.
export function clusterPermits(permits) {
  const n = permits.length;
  const parent = permits.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (x, y) => {
    parent[find(x)] = find(y);
  };

  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = scorePair(permits[i], permits[j]);
      if (s >= CLUSTER_THRESHOLD) {
        union(i, j);
        edges.push({ i, j, s });
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, { permits: [], members: new Set(), edgeScores: [] });
    groups.get(root).permits.push(permits[i]);
    groups.get(root).members.add(i);
  }
  for (const e of edges) {
    const g = groups.get(find(e.i));
    if (g) g.edgeScores.push(e.s);
  }
  return [...groups.values()];
}

// --------------------------------------------------------------------------
// project naming
// --------------------------------------------------------------------------

export function projectNameFor(permits, street) {
  const text = permits
    .map((p) => `${p.type || ""} ${p.detailed_description || p.description || ""}`)
    .join(" ")
    .toLowerCase();

  let prefix;
  if (/tenant improvement|tenant impr|\bt\.?i\.?\b/.test(text)) prefix = "Tenant improvement at";
  else if (/demolition|demolish/.test(text)) prefix = "Demolition at";
  else if (/new construction|construct new|new building|establish use|new .*(townhouse|residence|dwelling|building)/.test(text)) prefix = "New construction at";
  else if (/electrical/.test(text)) prefix = "Electrical upgrade at";
  else if (/mechanical|hvac/.test(text)) prefix = "Mechanical upgrade at";
  else if (/\baddition\b/.test(text)) prefix = "Addition at";
  else if (/alteration|renovat|remodel|substantial alter/.test(text)) prefix = "Renovation at";
  else prefix = "Construction activity at";

  return `${prefix} ${street}`;
}

// --------------------------------------------------------------------------
// graph builder
// --------------------------------------------------------------------------

function pickDominant(values) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

// Build the full derived entity graph from an array of permit rows.
// Each permit row should include: id, address, neighborhood, type, value,
// description, detailed_description, applied_date, issued_date,
// completed_date, contractor_name, owner_name, applicant_name,
// architect_name, lat, lng, zip.
// `options.addressSlugByNorm` / `options.orgSlugByNorm` let callers preserve
// slugs that were already minted in a previous build (keyed by the stable
// normalized address / name) so existing URLs never change across rebuilds.
export function buildEntityGraph(permits, options = {}) {
  const addressSlugByNorm = options.addressSlugByNorm || new Map();
  const orgSlugByNorm = options.orgSlugByNorm || new Map();

  const addressTaken = new Set(addressSlugByNorm.values());
  const orgTaken = new Set(orgSlugByNorm.values());
  const projectTaken = new Set();

  // --- addresses ---
  const addressByKey = new Map(); // normalized_address -> address object
  const permitAddress = new Map(); // permit.id -> address tmpId
  let addressId = 0;

  for (const permit of permits) {
    const parsed = parseAddress(permit.address);
    let addr = addressByKey.get(parsed.normalized_address);
    if (!addr) {
      addressId += 1;
      addr = {
        tmpId: addressId,
        slug: addressSlugByNorm.get(parsed.normalized_address) || dedupeSlug(makeSlug(parsed.normalized_address), addressTaken),
        normalized_address: parsed.normalized_address,
        display_address: parsed.display_address,
        city: parsed.city,
        state: parsed.state,
        zip: parsed.zip || permit.zip || null,
        lat: permit.lat != null ? Number(permit.lat) : null,
        lng: permit.lng != null ? Number(permit.lng) : null,
        street: parsed.street,
        permits: [],
        neighborhoods: [],
      };
      addressByKey.set(parsed.normalized_address, addr);
    }
    if (addr.lat == null && permit.lat != null) addr.lat = Number(permit.lat);
    if (addr.lng == null && permit.lng != null) addr.lng = Number(permit.lng);
    if (!addr.zip && (parsed.zip || permit.zip)) addr.zip = parsed.zip || permit.zip;
    addr.permits.push(permit);
    addr.neighborhoods.push(permit.neighborhood);
    permitAddress.set(permit.id, addr.tmpId);
  }
  const addresses = [...addressByKey.values()];

  // --- people / orgs + permit_participants ---
  const orgByKey = new Map(); // normalized_name -> org object
  const permitParticipants = []; // { permit_id, orgTmpId, role }
  let orgId = 0;
  for (const permit of permits) {
    const seen = new Set();
    for (const [field, role] of PARTICIPANT_ROLES) {
      const raw = permit[field];
      const norm = normalizeOrgName(raw);
      if (!norm) continue;
      let org = orgByKey.get(norm);
      if (!org) {
        orgId += 1;
        org = {
          tmpId: orgId,
          slug: orgSlugByNorm.get(norm) || dedupeSlug(makeSlug(raw), orgTaken),
          name: collapse(raw),
          normalized_name: norm,
          type_guess: guessOrgType(raw),
        };
        orgByKey.set(norm, org);
      }
      const dedupeKey = `${org.tmpId}:${role}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        permitParticipants.push({ permit_id: permit.id, orgTmpId: org.tmpId, role });
      }
    }
  }
  const peopleOrgs = [...orgByKey.values()];

  // participants grouped by permit for quick project rollup
  const participantsByPermit = new Map();
  for (const pp of permitParticipants) {
    if (!participantsByPermit.has(pp.permit_id)) participantsByPermit.set(pp.permit_id, []);
    participantsByPermit.get(pp.permit_id).push(pp);
  }

  // --- projects (clustered per address) ---
  const projects = [];
  const projectParticipants = []; // { projectTmpId, orgTmpId, role }
  const permitProject = new Map(); // permit.id -> project tmpId
  let projectId = 0;

  for (const addr of addresses) {
    const clusters = clusterPermits(addr.permits);
    for (const cluster of clusters) {
      projectId += 1;
      const cps = cluster.permits;
      const dates = cps.map((p) => bestDate(p)).filter(Boolean).sort();
      const first = dates[0] || null;
      const latest = dates[dates.length - 1] || null;
      const totalValue = cps.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
      const longestDesc = cps
        .map((p) => p.detailed_description || p.description || "")
        .sort((a, b) => b.length - a.length)[0] || "";
      const edgeScores = cluster.edgeScores || [];
      const confidence =
        cps.length <= 1
          ? 50
          : Math.max(0, Math.min(100, Math.round(edgeScores.reduce((s, v) => s + v, 0) / Math.max(1, edgeScores.length))));
      const name = projectNameFor(cps, addr.street);

      const project = {
        tmpId: projectId,
        slug: dedupeSlug(makeSlug(name), projectTaken),
        addressTmpId: addr.tmpId,
        name,
        description_summary: longestDesc.slice(0, 300),
        confidence_score: confidence,
        first_seen_date: first,
        latest_activity_date: latest,
        total_estimated_value: totalValue,
        permitIds: cps.map((p) => p.id),
      };
      projects.push(project);

      const projOrgRoles = new Set();
      for (const p of cps) {
        permitProject.set(p.id, project.tmpId);
        for (const pp of participantsByPermit.get(p.id) || []) {
          const key = `${pp.orgTmpId}:${pp.role}`;
          if (!projOrgRoles.has(key)) {
            projOrgRoles.add(key);
            projectParticipants.push({ projectTmpId: project.tmpId, orgTmpId: pp.orgTmpId, role: pp.role });
          }
        }
      }
    }
  }

  // --- neighborhoods + address_neighborhoods ---
  const nbByName = new Map();
  let nbId = 0;
  const nbTaken = new Set();
  const ensureNb = (name) => {
    const clean = collapse(name);
    if (!clean) return null;
    let nb = nbByName.get(clean);
    if (!nb) {
      nbId += 1;
      nb = { tmpId: nbId, slug: dedupeSlug(makeSlug(clean), nbTaken), name: clean };
      nbByName.set(clean, nb);
    }
    return nb;
  };
  const addressNeighborhoods = [];
  for (const addr of addresses) {
    const dominant = pickDominant(addr.neighborhoods);
    if (!dominant) continue;
    const nb = ensureNb(dominant);
    if (nb) addressNeighborhoods.push({ addressTmpId: addr.tmpId, nbTmpId: nb.tmpId });
  }
  const neighborhoods = [...nbByName.values()];

  return {
    addresses,
    peopleOrgs,
    projects,
    permitParticipants,
    projectParticipants,
    neighborhoods,
    addressNeighborhoods,
    permitAddress,
    permitProject,
  };
}
