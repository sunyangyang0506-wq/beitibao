ALTER TABLE papers ADD COLUMN is_prediction boolean NOT NULL DEFAULT false;
CREATE TABLE predictions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL,
  source_digest text NOT NULL,
  evidence jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed', 'superseded')),
  paper_id uuid,
  lease uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, course_id, source_digest),
  FOREIGN KEY (tenant_id, course_id) REFERENCES courses (tenant_id, id),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES papers (tenant_id, id)
);
CREATE INDEX predictions_queue ON predictions (created_at) WHERE status IN ('queued','processing');
ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictions FORCE ROW LEVEL SECURITY;
CREATE POLICY predictions_tenant ON predictions
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
