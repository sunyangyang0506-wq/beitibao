ALTER TABLE courses ADD COLUMN exam_at timestamptz;
ALTER TABLE question_recall ADD COLUMN last_mistake_at timestamptz;
ALTER TABLE mistake_retries ADD COLUMN attempted_at timestamptz;
ALTER TABLE mistake_retries ALTER COLUMN attempted_at SET DEFAULT clock_timestamp();
