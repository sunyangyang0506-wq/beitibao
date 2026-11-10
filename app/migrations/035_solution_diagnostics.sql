ALTER TABLE paper_questions ADD COLUMN solution_failure text;
ALTER TABLE paper_questions ADD COLUMN solution_finished_at timestamptz;
