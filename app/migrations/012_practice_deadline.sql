ALTER TABLE practice_attempts ADD COLUMN deadline_at timestamptz;
CREATE INDEX practice_deadline ON practice_attempts (deadline_at) WHERE submitted_at IS NULL AND deadline_at IS NOT NULL;
