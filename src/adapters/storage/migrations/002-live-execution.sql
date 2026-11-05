CREATE TABLE action_attempts_v2 (
  attempt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  decision_id TEXT NOT NULL REFERENCES decisions(decision_id),
  game_match_key TEXT NOT NULL,
  game_hand_key TEXT NOT NULL,
  expected_cursor TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'dispatching', 'awaiting-confirmation', 'confirmed', 'rejected', 'uncertain', 'not-dispatched', 'simulated')),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('dry-run', 'contract-test', 'live')),
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;
INSERT INTO action_attempts_v2 SELECT * FROM action_attempts;
DROP TABLE action_attempts;
ALTER TABLE action_attempts_v2 RENAME TO action_attempts;
CREATE INDEX unresolved_attempts ON action_attempts (game_match_key, status);
CREATE TABLE action_confirmations_v2 (
  attempt_id TEXT PRIMARY KEY REFERENCES action_attempts(attempt_id),
  fact_key TEXT NOT NULL UNIQUE REFERENCES observed_actions(fact_key),
  event_id TEXT NOT NULL,
  matched_by TEXT NOT NULL CHECK (matched_by IN ('authoritative-event', 'authoritative-sync')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('contract-test', 'live'))
) STRICT;
INSERT INTO action_confirmations_v2 SELECT * FROM action_confirmations;
DROP TABLE action_confirmations;
ALTER TABLE action_confirmations_v2 RENAME TO action_confirmations;
