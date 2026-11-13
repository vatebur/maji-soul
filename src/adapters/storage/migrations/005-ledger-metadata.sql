-- The full expression must match inspectMatch. Retain every lifecycle row and
-- its implicit rowid; the query orders by rowid after reading compact metadata.
CREATE INDEX game_events_ledger_metadata ON game_events (
  type, session_id,
  CASE WHEN type='SyncApplied' THEN json_object(
    'gameMatchKey',json_extract(payload,'$.gameMatchKey'),
    'gameHandKey',json_extract(payload,'$.gameHandKey'),
    'handOrdinal',json_extract(payload,'$.handOrdinal'),
    'terminal',json_extract(payload,'$.terminal')) ELSE payload END
) WHERE type IN ('MatchStarted','HandStarted','HandEnded','MatchEnded','SyncApplied');
