CREATE TABLE mistake_retries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  question_id uuid NOT NULL,
  attempt_key uuid NOT NULL,
  answer text NOT NULL,
  result text NOT NULL CHECK (result IN ('correct', 'incorrect', 'needs_review')),
  UNIQUE (tenant_id, question_id, attempt_key),
  FOREIGN KEY (tenant_id, question_id) REFERENCES paper_questions (tenant_id, id)
);
CREATE INDEX mistake_retry_latest ON mistake_retries (tenant_id, question_id, id DESC);
ALTER TABLE mistake_retries ENABLE ROW LEVEL SECURITY;
ALTER TABLE mistake_retries FORCE ROW LEVEL SECURITY;
CREATE POLICY mistake_retry_tenant ON mistake_retries
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
