-- Security hardening (audit A1, A3, A7, A12, B3, F2, F10, F11).
-- Apply once, BEFORE deploying the worker that uses these tables:
--   npx wrangler d1 execute buildingseattle --remote --file migrations/0002_security_hardening.sql
-- Every statement is idempotent.

-- Fixed-window counters for the D1 rate-limit fallback (alerts, leads).
-- bucket_key holds a scope plus a truncated sha256 of the IP or email, never
-- the raw value. Rows older than two days are pruned opportunistically.
CREATE TABLE IF NOT EXISTS request_rate_limits (
    bucket_key TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket_key, window_start)
);
CREATE INDEX IF NOT EXISTS idx_request_rate_limits_window ON request_rate_limits(window_start);

-- Addresses that asked for no email at all ("stop all emails" on the
-- unsubscribe page, or the "didn't request this?" link in a confirmation).
CREATE TABLE IF NOT EXISTS alert_email_suppressions (
    email TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT 'user_request',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- One row per (subscription, status change). A sender claims the row before
-- emailing, so overlapping alert runs cannot send the same change twice.
CREATE TABLE IF NOT EXISTS permit_alert_deliveries (
    subscription_id INTEGER NOT NULL,
    change_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'sending'
        CHECK (status IN ('sending', 'sent', 'failed')),
    claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notified_at DATETIME,
    PRIMARY KEY (subscription_id, change_id)
);

-- Optional stored API keys for full /api/permits and MCP access. Store only
-- the sha256 hex of the key; env.API_KEYS also works for a short list.
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL UNIQUE,
    label TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_permit_alert_subscriptions_confirmation_sent
    ON permit_alert_subscriptions(confirmation_sent_at);
