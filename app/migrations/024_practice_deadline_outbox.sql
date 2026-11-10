CREATE TABLE practice_deadline_outbox (
  tenant_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  id uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  deliver_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'publishing', 'published', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  lease uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, paper_id),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES practice_attempts (tenant_id, paper_id)
);
CREATE INDEX practice_deadline_outbox_next ON practice_deadline_outbox (next_attempt_at, id)
  WHERE state IN ('pending', 'publishing');
ALTER TABLE practice_attempts NO FORCE ROW LEVEL SECURITY;
INSERT INTO practice_deadline_outbox (tenant_id, paper_id, deliver_at)
SELECT tenant_id, paper_id, deadline_at FROM practice_attempts WHERE deadline_at IS NOT NULL AND submitted_at IS NULL;
ALTER TABLE practice_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE practice_deadline_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_deadline_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_deadline_outbox_tenant ON practice_deadline_outbox
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
