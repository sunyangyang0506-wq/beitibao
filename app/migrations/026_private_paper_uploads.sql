ALTER TABLE papers
  ADD COLUMN object_key text,
  ADD COLUMN object_version text,
  ADD COLUMN object_bytes integer,
  ADD COLUMN model_allowed boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT papers_original_location CHECK (
    (object_key IS NULL AND object_version IS NULL AND object_bytes IS NULL)
    OR (object_key IS NOT NULL AND object_version IS NOT NULL AND object_bytes IS NOT NULL
      AND object_bytes BETWEEN 1 AND 52428800 AND octet_length(pdf) = 0 AND NOT is_prediction)
  );

CREATE TABLE paper_uploads (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL,
  title text NOT NULL,
  school text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 52428800),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  model_allowed boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  paper_id uuid,
  kept_version text,
  cleaned_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, course_id) REFERENCES courses (tenant_id, id),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES papers (tenant_id, id)
);
CREATE INDEX paper_uploads_expiring ON paper_uploads (expires_at) WHERE cleaned_at IS NULL;
CREATE INDEX paper_uploads_tenant_created ON paper_uploads (tenant_id, created_at);
ALTER TABLE paper_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY paper_uploads_tenant ON paper_uploads
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
