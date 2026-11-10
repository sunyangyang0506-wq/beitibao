CREATE TABLE question_equivalence (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  anchor_id uuid NOT NULL,
  member_id uuid NOT NULL,
  question_kind text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, anchor_id) REFERENCES paper_questions (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES paper_questions (tenant_id, id),
  CHECK (anchor_id <> member_id)
);
CREATE UNIQUE INDEX one_active_question_group ON question_equivalence (tenant_id, member_id) WHERE revoked_at IS NULL;
CREATE INDEX question_equivalence_anchor ON question_equivalence (tenant_id, anchor_id) WHERE revoked_at IS NULL;
ALTER TABLE question_equivalence ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_equivalence FORCE ROW LEVEL SECURITY;
CREATE POLICY question_equivalence_tenant ON question_equivalence
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
CREATE VIEW current_question_equivalence WITH (security_invoker = true) AS
SELECT e.tenant_id, e.anchor_id, e.member_id
FROM question_equivalence e
JOIN paper_questions a ON (a.tenant_id, a.id) = (e.tenant_id, e.anchor_id)
JOIN paper_questions m ON (m.tenant_id, m.id) = (e.tenant_id, e.member_id)
JOIN papers ap ON (ap.tenant_id, ap.id) = (a.tenant_id, a.paper_id)
JOIN papers mp ON (mp.tenant_id, mp.id) = (m.tenant_id, m.paper_id)
WHERE e.revoked_at IS NULL AND a.question_kind = e.question_kind AND m.question_kind = e.question_kind
  AND ap.course_id = mp.course_id AND NOT ap.is_prediction AND NOT mp.is_prediction;
