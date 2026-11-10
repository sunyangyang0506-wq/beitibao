ALTER TABLE papers ADD COLUMN media_type text NOT NULL DEFAULT 'application/pdf'
  CHECK (media_type IN ('application/pdf', 'image/png', 'image/jpeg'));
ALTER TABLE papers ADD COLUMN recognition jsonb;

CREATE TABLE recognition_feedback (
  tenant_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  candidate_index integer NOT NULL CHECK (candidate_index >= 0),
  model text NOT NULL,
  prompt_version text NOT NULL,
  original_stem text NOT NULL,
  reviewed_stem text,
  outcome text NOT NULL CHECK (outcome IN ('confirmed', 'corrected', 'rejected')),
  question_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, paper_id, candidate_index),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES papers (tenant_id, id),
  FOREIGN KEY (tenant_id, question_id) REFERENCES paper_questions (tenant_id, id)
);
ALTER TABLE recognition_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY feedback_tenant ON recognition_feedback
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
