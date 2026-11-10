ALTER TABLE papers ALTER COLUMN course_id DROP NOT NULL;
ALTER TABLE paper_uploads ALTER COLUMN course_id DROP NOT NULL;
ALTER TABLE papers ADD COLUMN recognized_subject text;
ALTER TABLE papers ADD CONSTRAINT prediction_course_required CHECK (NOT is_prediction OR course_id IS NOT NULL);
ALTER TABLE paper_uploads ALTER COLUMN school DROP NOT NULL;
ALTER TABLE papers ADD COLUMN auto_assignment boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX papers_auto_assignment_fingerprint ON papers (tenant_id, fingerprint) WHERE auto_assignment;
