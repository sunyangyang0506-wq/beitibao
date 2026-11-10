ALTER TABLE paper_questions ADD COLUMN solution_status text
  CHECK (solution_status IN ('queued', 'processing', 'ready', 'failed')),
  ADD COLUMN model_solution jsonb,
  ADD COLUMN solution_lease uuid,
  ADD COLUMN solution_lease_until timestamptz;
ALTER TABLE paper_questions ALTER COLUMN solution_status SET DEFAULT 'queued';
CREATE INDEX question_solution_queue ON paper_questions (created_at)
  WHERE solution_status IN ('queued', 'processing');
