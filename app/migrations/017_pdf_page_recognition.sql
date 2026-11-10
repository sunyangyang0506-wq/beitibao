ALTER TABLE papers ADD COLUMN recognize_scans boolean NOT NULL DEFAULT false;

CREATE TABLE paper_page_recognition (
  tenant_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 30),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'review', 'failed')),
  recognition jsonb,
  failure text,
  lease_id uuid,
  lease_until timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, paper_id, page_number),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES papers (tenant_id, id)
);
CREATE INDEX paper_page_recognition_queue ON paper_page_recognition (created_at, page_number)
  WHERE status IN ('queued', 'processing');
ALTER TABLE paper_page_recognition ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_page_recognition FORCE ROW LEVEL SECURITY;
CREATE POLICY page_recognition_tenant ON paper_page_recognition
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
