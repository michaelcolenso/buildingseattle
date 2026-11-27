// First-party page-view logging (the `page_views` D1 table) and its retention.
//
// Before this module every routed HTML request, cache hits included, wrote a
// D1 row with the full user agent and referrer, and nothing ever deleted one.
// About 99% of the rows were crawlers and the table was most of the database
// (audit F3, A17, B7). Now:
// - known bots, crawlers, uptime checkers and scripted clients are not logged;
// - the rest is sampled at PAGE_VIEW_SAMPLE_RATE (wrangler.toml [vars],
//   0..1; "0" turns logging off, default 1);
// - referrer and user agent are truncated;
// - a cache hit logs the same route template a miss logs (`/permits/:id`),
//   so hits and misses no longer split the top-pages numbers;
// - its own daily cron (PAGE_VIEW_RETENTION_CRON, a quiet hour away from the
//   13:00 UTC ingest, so the deletes never compete with ingest writes for the
//   single-threaded D1 database; review S7) deletes rows older than
//   PAGE_VIEW_RETENTION_DAYS in bounded batches (`prunePageViews`).
// Human traffic is also measured, cookieless, by Cloudflare Web Analytics.

export const PAGE_VIEW_RETENTION_DAYS = 90;
// Must match the second entry of [triggers] crons in wrangler.toml
// (tests/page_views.test.js checks). 09:30 UTC is 01:30/02:30 in Seattle.
export const PAGE_VIEW_RETENTION_CRON = "30 9 * * *";
export const PAGE_VIEW_FIELD_MAX_CHARS = 300;
export const PAGE_VIEW_PRUNE_BATCH_SIZE = 5000;
export const PAGE_VIEW_PRUNE_MAX_BATCHES = 40;
export const ANALYTICS_MAX_DAYS = 30;

// Substrings (case-insensitive) that mark a user agent as automated. Generic
// tokens ("bot/", "crawl", "spider", "+http" from the "+http://info-url"
// most crawlers append) catch most crawlers; the named ones are the heavy
// hitters in production page_views plus tools and HTTP libraries whose UA
// has no generic token. Tokens are matched literally.
const BOT_UA_TOKENS = [
  "bot/", "bot;", "bot)", "bot-", "-bot", "_bot", "robot", "+http", "crawl", "spider", "slurp", "scrap",
  "fetcher", "archiver", "semrush", "ahrefs", "mj12", "dotbot", "petalbot", "bytespider", "shapbot",
  "dataforseo", "serpstat", "seokicks", "blexbot", "barkrowler", "megaindex", "screaming frog", "sitebulb",
  "yandexbot", "yandeximages", "baiduspider", "applebot", "bingpreview", "googleother", "google-inspectiontool",
  "google-extended", "storebot", "adsbot", "mediapartners", "feedfetcher", "duckduckbot", "duckassistbot",
  "qwantify", "ccbot", "gptbot", "chatgpt-user", "oai-searchbot", "claudebot", "claude-user",
  "claude-searchbot", "anthropic-ai", "perplexity", "cohere-ai", "diffbot", "amazonbot",
  "meta-externalagent", "facebookexternalhit", "facebookcatalog", "twitterbot", "linkedinbot", "slackbot",
  "discordbot", "telegrambot", "whatsapp", "skypeuripreview", "embedly", "iframely", "headlesschrome",
  "phantomjs", "puppeteer", "playwright", "selenium", "lighthouse", "pagespeed", "gtmetrix", "pingdom",
  "uptimerobot", "statuscake", "site24x7", "betteruptime", "better uptime", "checkly", "datadogsynthetics",
  "newrelicsynthetics", "monitor", "python-requests", "python-urllib", "python-httpx", "aiohttp", "httpx",
  "go-http-client", "okhttp", "java/", "apache-httpclient", "libwww", "lwp::", "wget", "curl/",
  "node-fetch", "undici", "axios/", "postmanruntime", "insomnia", "httpie", "scrapy", "colly", "nutch",
  "heritrix", "ia_archiver", "wayback", "zgrab", "masscan", "nmap", "nuclei", "censys", "shodan",
  "netcraft", "internet-measurement", "preview",
];
const BOT_UA_PATTERN = new RegExp(
  BOT_UA_TOKENS.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i",
);

// True when the request looks automated: a known bot/tool UA, or no UA at
// all (every real browser sends one).
export function isLikelyBot(userAgent) {
  const ua = String(userAgent || "").trim();
  if (!ua) return true;
  return BOT_UA_PATTERN.test(ua);
}

// The sampling rate from env (string var), clamped to [0, 1]; default 1.
export function pageViewSampleRate(env) {
  const raw = env?.PAGE_VIEW_SAMPLE_RATE;
  if (raw === undefined || raw === null || String(raw).trim() === "") return 1;
  const rate = Number(raw);
  if (!Number.isFinite(rate)) return 1;
  return Math.min(1, Math.max(0, rate));
}

// Decide whether to write a page_views row for this request. `random` is
// injectable for tests.
export function shouldLogPageView(request, env, random = Math.random) {
  if (isLikelyBot(request?.headers?.get?.("user-agent"))) return false;
  // Cloudflare marks verified bots (Googlebot etc.) on some plans; respect it
  // when present.
  if (request?.cf?.botManagement?.verifiedBot || request?.cf?.verifiedBotCategory) return false;
  const rate = pageViewSampleRate(env);
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return random() < rate;
}

export function truncateField(value, max = PAGE_VIEW_FIELD_MAX_CHARS) {
  const text = String(value || "");
  return text.length > max ? text.slice(0, max) : text;
}

// Map a raw path to the route template the router logs on a cache miss, so a
// cache hit and a miss for the same page count as the same page.
const PAGE_VIEW_TEMPLATES = [
  [/^\/permits\/.+/, "/permits/:id"],
  [/^\/contractor\/.+/, "/contractor/:slug"],
  [/^\/address\/.+/, "/address/:slug"],
  [/^\/project\/.+/, "/project/:slug"],
  [/^\/neighborhood\/.+/, "/neighborhood/:slug"],
];

export function pageViewTemplatePath(path) {
  const raw = String(path || "/");
  for (const [pattern, template] of PAGE_VIEW_TEMPLATES) {
    if (pattern.test(raw)) return template;
  }
  // "/permits/" and "/about/" log as their slash-less route.
  return raw.length > 1 ? raw.replace(/\/+$/, "") || "/" : raw;
}

// Insert one page_views row unless the request is a bot or sampled out.
// Never throws: analytics must not break a page.
export async function recordPageView(request, env, path, random = Math.random) {
  try {
    if (!env?.DB || !shouldLogPageView(request, env, random)) return false;
    const country = truncateField(request.cf?.country || "", 8);
    const referrer = truncateField(request.headers.get("referer"));
    const ua = truncateField(request.headers.get("user-agent"));
    await env.DB.prepare(`INSERT INTO page_views (path, referrer, user_agent, country) VALUES (?, ?, ?, ?)`)
      .bind(truncateField(path, 200), referrer, ua, country)
      .run();
    return true;
  } catch {
    return false;
  }
}

// `created_at` is CURRENT_TIMESTAMP text ("YYYY-MM-DD HH:MM:SS", UTC).
export function retentionCutoff(now = new Date(), days = PAGE_VIEW_RETENTION_DAYS) {
  return new Date(now.getTime() - days * 86400000).toISOString().replace("T", " ").slice(0, 19);
}

// Delete page_views rows older than the cutoff, at most `batchSize` rows per
// statement and `maxBatches` statements per run, so the first runs over the
// ~1.2M-row backlog never hold D1 for long (a single unbounded DELETE or
// scan of this table has already returned D1 429 "overloaded"). Each batch
// walks idx_page_views_created_at from the oldest row, so it reads only the
// rows it deletes. Stops early once nothing older than the cutoff is left.
export async function prunePageViews(db, {
  now = new Date(),
  days = PAGE_VIEW_RETENTION_DAYS,
  batchSize = PAGE_VIEW_PRUNE_BATCH_SIZE,
  maxBatches = PAGE_VIEW_PRUNE_MAX_BATCHES,
} = {}) {
  const cutoff = retentionCutoff(now, days);
  let deleted = 0;
  let batches = 0;
  let complete = false;
  while (batches < maxBatches) {
    const result = await db
      .prepare(
        `DELETE FROM page_views WHERE id IN (
           SELECT id FROM page_views WHERE created_at < ? ORDER BY created_at LIMIT ?
         )`,
      )
      .bind(cutoff, batchSize)
      .run();
    batches += 1;
    const changes = Number(result?.meta?.changes ?? 0);
    deleted += changes;
    if (changes < batchSize) {
      complete = true;
      break;
    }
  }
  return { cutoff, deleted, batches, complete };
}

// Scheduled entry point: prune and log the outcome; never throws.
export async function runPageViewRetention(env, options = {}) {
  if (!env?.DB) return null;
  try {
    const outcome = await prunePageViews(env.DB, options);
    console.log(
      `page_views retention: deleted ${outcome.deleted} rows older than ${outcome.cutoff} in ${outcome.batches} batch(es)${outcome.complete ? "" : "; more remain for the next run"}`,
    );
    return outcome;
  } catch (error) {
    console.error("page_views retention failed:", error);
    return null;
  }
}

// /api/admin/analytics `days`: an integer in [1, ANALYTICS_MAX_DAYS], default 7
// (audit F9: an unbounded value scanned the whole 3M-row table).
export function clampAnalyticsDays(raw) {
  const days = Number.parseInt(String(raw ?? "7"), 10);
  if (!Number.isFinite(days)) return 7;
  return Math.min(ANALYTICS_MAX_DAYS, Math.max(1, days));
}
