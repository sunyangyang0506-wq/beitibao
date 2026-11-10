CREATE TABLE papers (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  fingerprint text NOT NULL,
  pdf bytea NOT NULL CHECK (octet_length(pdf) <= 10485760),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'review', 'failed')),
  pages jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(pages) = 'array'),
  failure text,
  lease_id uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, course_id, fingerprint),
  FOREIGN KEY (tenant_id, course_id) REFERENCES courses (tenant_id, id)
);
CREATE INDEX papers_queue ON papers (created_at) WHERE status IN ('queued', 'processing');

CREATE TABLE paper_questions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  paper_id uuid NOT NULL,
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 30),
  fingerprint text NOT NULL,
  stem text NOT NULL CHECK (length(stem) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, paper_id, page_number, fingerprint),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES papers (tenant_id, id)
);

ALTER TABLE papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE papers FORCE ROW LEVEL SECURITY;
CREATE POLICY papers_tenant ON papers
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);

ALTER TABLE paper_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_questions FORCE ROW LEVEL SECURITY;
CREATE POLICY questions_tenant ON paper_questions
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
