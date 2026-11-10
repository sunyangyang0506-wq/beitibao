ALTER TABLE question_recall ADD COLUMN self_rating text
  CHECK (self_rating IN ('mastered', 'partial', 'needs_practice'));
