PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  verified_at TEXT,
  token_hash TEXT,
  code_hash TEXT,
  code_expires_at TEXT,
  last_code_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_reminders (
  subscription_id TEXT NOT NULL,
  reminder_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  send_at TEXT NOT NULL,
  sent_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, reminder_key),
  FOREIGN KEY (subscription_id) REFERENCES notification_subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS notification_reminders_due_idx
ON notification_reminders(active, sent_at, send_at);

CREATE TABLE IF NOT EXISTS notification_push_devices (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_push_reminders (
  device_id TEXT NOT NULL,
  reminder_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  send_at TEXT NOT NULL,
  sent_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, reminder_key),
  FOREIGN KEY (device_id) REFERENCES notification_push_devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS notification_push_reminders_due_idx
ON notification_push_reminders(active, sent_at, send_at);
