ALTER TABLE papers ADD COLUMN auto_title boolean NOT NULL DEFAULT false;
ALTER TABLE paper_uploads ADD COLUMN auto_title boolean NOT NULL DEFAULT false;
