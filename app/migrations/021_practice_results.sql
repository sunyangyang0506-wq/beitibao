CREATE TABLE practice_results (
  tenant_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  graded jsonb NOT NULL CHECK (jsonb_typeof(graded) = 'object'),
  covered uuid[] NOT NULL,
  submitted_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, paper_id),
  UNIQUE (event_id),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES practice_attempts (tenant_id, paper_id)
);
ALTER TABLE practice_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_results FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_results_tenant ON practice_results
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
