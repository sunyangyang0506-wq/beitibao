ALTER TABLE papers ADD COLUMN assignment_reason text
  CHECK (assignment_reason IN ('assigned', 'unknown', 'ambiguous', 'subject_limit', 'duplicate'));
