ALTER TABLE paper_questions ADD COLUMN visual_review text
  CHECK (char_length(visual_review) BETWEEN 1 AND 8000);
