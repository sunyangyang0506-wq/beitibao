CREATE TABLE practice_attempts (
  tenant_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  title text NOT NULL,
  questions jsonb NOT NULL,
  answers jsonb NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  PRIMARY KEY (tenant_id, paper_id),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES papers (tenant_id, id)
);
ALTER TABLE practice_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_tenant ON practice_attempts
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
