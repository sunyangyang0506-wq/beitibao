ALTER TABLE papers ADD COLUMN page_order integer[] NOT NULL DEFAULT '{}';
ALTER TABLE papers ADD COLUMN missing_pages boolean NOT NULL DEFAULT false;
ALTER TABLE papers ADD COLUMN review_revision integer NOT NULL DEFAULT 0 CHECK (review_revision >= 0);
ALTER TABLE paper_questions ADD COLUMN source_pages integer[] NOT NULL DEFAULT '{}';
