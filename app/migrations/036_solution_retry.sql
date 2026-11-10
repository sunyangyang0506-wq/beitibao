ALTER TABLE paper_questions ADD COLUMN solution_attempt_count integer NOT NULL DEFAULT 0
  CHECK (solution_attempt_count >= 0);
