ALTER TABLE paper_questions ALTER COLUMN solution_status DROP DEFAULT;
ALTER TABLE paper_questions NO FORCE ROW LEVEL SECURITY;
UPDATE paper_questions SET solution_status = NULL WHERE solution_status = 'queued';
ALTER TABLE paper_questions FORCE ROW LEVEL SECURITY;

ALTER TABLE paper_questions ADD COLUMN question_kind text NOT NULL DEFAULT 'other'
  CHECK (question_kind IN ('choice', 'fill', 'calculation', 'short_answer', 'other'));

CREATE TABLE question_recall (
  tenant_id uuid NOT NULL,
  question_id uuid NOT NULL,
  revealed boolean NOT NULL DEFAULT false,
  correction jsonb,
  PRIMARY KEY (tenant_id, question_id),
  FOREIGN KEY (tenant_id, question_id) REFERENCES paper_questions (tenant_id, id)
);
ALTER TABLE question_recall ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_recall FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant ON question_recall
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
