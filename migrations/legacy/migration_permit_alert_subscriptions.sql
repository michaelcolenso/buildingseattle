CREATE TABLE IF NOT EXISTS permit_alert_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    permit_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'unsubscribed')),
    confirmation_token_hash TEXT,
    unsubscribe_token TEXT NOT NULL UNIQUE,
    confirmation_sent_at DATETIME,
    confirmed_at DATETIME,
    unsubscribed_at DATETIME,
    last_notified_change_id INTEGER,
    last_notified_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (email, permit_number),
    FOREIGN KEY (permit_number) REFERENCES permits(permit_number)
);

CREATE INDEX IF NOT EXISTS idx_permit_alert_subscriptions_status
    ON permit_alert_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_permit_alert_subscriptions_permit
    ON permit_alert_subscriptions(permit_number);
CREATE INDEX IF NOT EXISTS idx_permit_alert_subscriptions_email
    ON permit_alert_subscriptions(email);
