CREATE TABLE discard_explanations (
  outbox_id TEXT PRIMARY KEY REFERENCES outbox(outbox_id),
  fact_text TEXT NOT NULL
) STRICT;
CREATE INDEX live_outbox_session ON outbox(session_id, sequence, outbox_id);
CREATE INDEX live_decisions_session ON decisions(session_id, sequence, decision_id);
CREATE TABLE console_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;
CREATE TABLE console_commands (
  command_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;
CREATE INDEX console_command_time ON console_commands(accepted_at);
CREATE TABLE viewer_deliveries (
  delivery_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dispatching','simulated','published','blocked','expired','uncertain','failed'))
) STRICT;
CREATE TABLE viewer_seen (
  message_key TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
) STRICT;
CREATE INDEX viewer_seen_time ON viewer_seen(received_at);
CREATE TABLE console_replays (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
  run_id TEXT NOT NULL,
  last_used_at TEXT NOT NULL
) STRICT;
CREATE INDEX console_replays_age ON console_replays(last_used_at);
