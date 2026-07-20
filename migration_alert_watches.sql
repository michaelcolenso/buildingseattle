-- Phase 3 (Workstream C) schema: paid permit-alert watches.
-- Not applied to production by this change — apply explicitly when Task C4
-- (billing) and C5 (matching/sending engine) are ready to ship:
--   npx wrangler d1 execute buildingseattle --local --file migration_alert_watches.sql   (test first)
--   npx wrangler d1 execute buildingseattle --file migration_alert_watches.sql            (production)
--
-- Keeps the existing free per-permit `permit_alert_subscriptions` table
-- as-is; this is a separate, additive watch system for the Contractor
-- Watch / Address Watch / Neighborhood Digest products (docs/alerts-pricing.md).

CREATE TABLE IF NOT EXISTS alert_watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    watch_type TEXT NOT NULL
        CHECK (watch_type IN ('permit', 'contractor', 'address', 'neighborhood')),
    target TEXT NOT NULL,               -- contractor license/name, normalized address, or neighborhood slug
    radius_m INTEGER,                   -- v1.1: address radius watches (NULL = exact match)
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'unsubscribed')),
    confirmation_token_hash TEXT,
    unsubscribe_token TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'free'
        CHECK (plan IN ('free', 'pro', 'team')),
    stripe_customer_id TEXT,
    last_notified_change_id INTEGER,
    last_notified_permit_id INTEGER,
    confirmation_sent_at DATETIME,
    confirmed_at DATETIME,
    unsubscribed_at DATETIME,
    last_notified_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (email, watch_type, target, radius_m)
);

CREATE INDEX IF NOT EXISTS idx_alert_watches_status ON alert_watches(status);
CREATE INDEX IF NOT EXISTS idx_alert_watches_type_target ON alert_watches(watch_type, target);
CREATE INDEX IF NOT EXISTS idx_alert_watches_email ON alert_watches(email);
CREATE INDEX IF NOT EXISTS idx_alert_watches_stripe_customer ON alert_watches(stripe_customer_id);

-- Dedupe log so a re-ingest (or the daily ingest + enrichment passes both
-- touching the same permit) never sends the same notification twice.
CREATE TABLE IF NOT EXISTS alert_notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id INTEGER NOT NULL,
    permit_number TEXT NOT NULL,
    change_id INTEGER,                  -- NULL for "new permit" notifications, set for status-change notifications
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (watch_id, permit_number, change_id),
    FOREIGN KEY (watch_id) REFERENCES alert_watches(id)
);

CREATE INDEX IF NOT EXISTS idx_alert_notification_log_watch
    ON alert_notification_log(watch_id);
