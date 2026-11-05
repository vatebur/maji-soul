CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  process_instance_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  recovery_required INTEGER NOT NULL CHECK (recovery_required IN (0, 1))
) STRICT;
CREATE TABLE checkpoints (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  projection TEXT NOT NULL CHECK (json_valid(projection))
) STRICT;
CREATE TABLE game_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  sequence INTEGER NOT NULL,
  connection_epoch INTEGER NOT NULL,
  dedup_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, connection_epoch, dedup_key)
) STRICT;
CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  sequence INTEGER NOT NULL,
  game_match_key TEXT NOT NULL,
  game_hand_key TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
) STRICT;
CREATE TABLE action_attempts (
  attempt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  decision_id TEXT NOT NULL REFERENCES decisions(decision_id),
  game_match_key TEXT NOT NULL,
  game_hand_key TEXT NOT NULL,
  expected_cursor TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'dispatching', 'awaiting-confirmation', 'confirmed', 'rejected', 'uncertain', 'not-dispatched', 'simulated')),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('dry-run', 'contract-test')),
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;
CREATE INDEX unresolved_attempts ON action_attempts (game_match_key, status);
CREATE TABLE action_slots (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  hand_id TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL,
  window_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES action_attempts(attempt_id),
  PRIMARY KEY (session_id, hand_id, connection_epoch, window_id)
) STRICT;
CREATE TABLE source_action_slots (
  game_match_key TEXT NOT NULL,
  game_hand_key TEXT NOT NULL,
  source_cursor TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES action_attempts(attempt_id),
  PRIMARY KEY (game_match_key, game_hand_key, source_cursor)
) STRICT;
CREATE TABLE observed_actions (
  fact_key TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  game_match_key TEXT NOT NULL,
  game_hand_key TEXT NOT NULL,
  source_cursor TEXT NOT NULL,
  fact_hash TEXT NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;
CREATE TABLE action_confirmations (
  attempt_id TEXT PRIMARY KEY REFERENCES action_attempts(attempt_id),
  fact_key TEXT NOT NULL UNIQUE REFERENCES observed_actions(fact_key),
  event_id TEXT NOT NULL,
  matched_by TEXT NOT NULL CHECK (matched_by IN ('authoritative-event', 'authoritative-sync')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind = 'contract-test')
) STRICT;
CREATE TABLE outbox (
  outbox_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  fact_key TEXT NOT NULL UNIQUE REFERENCES observed_actions(fact_key),
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload))
) STRICT;
CREATE TABLE storage_faults (
  fault_id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  code TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;
