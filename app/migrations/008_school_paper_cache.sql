ALTER TABLE papers ADD COLUMN school text;
ALTER TABLE papers ADD COLUMN model_cache_key text;
ALTER TABLE papers DROP CONSTRAINT papers_tenant_id_course_id_fingerprint_key;
CREATE UNIQUE INDEX paper_upload_identity
  ON papers (tenant_id, course_id, fingerprint, school) NULLS NOT DISTINCT;

CREATE TABLE paper_model_cache (
  cache_key text PRIMARY KEY,
  pages jsonb NOT NULL,
  recognition jsonb,
  solutions jsonb NOT NULL
);
