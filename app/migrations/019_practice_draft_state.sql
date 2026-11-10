ALTER TABLE practice_attempts ADD COLUMN draft_state jsonb NOT NULL DEFAULT '{"marked":[],"position":null}'
  CHECK (jsonb_typeof(draft_state) = 'object');
