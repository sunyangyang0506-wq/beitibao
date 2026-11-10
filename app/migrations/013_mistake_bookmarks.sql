ALTER TABLE question_recall ADD COLUMN bookmarked boolean NOT NULL DEFAULT false,
  ADD COLUMN had_recall_difficulty boolean NOT NULL DEFAULT false;
UPDATE question_recall SET had_recall_difficulty = true WHERE self_rating IN ('partial', 'needs_practice');
