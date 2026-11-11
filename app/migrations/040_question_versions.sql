-- The live row is the current personal question. Previous inputs and recall state
-- remain available independently of any practice attempt.
ALTER TABLE paper_questions ADD COLUMN input_revision integer NOT NULL DEFAULT 1 CHECK (input_revision > 0);
ALTER TABLE question_recall ADD COLUMN assessed_revision integer;
CREATE TABLE question_revision_history (
  tenant_id uuid NOT NULL,
  question_id uuid NOT NULL,
  input_revision integer NOT NULL,
  question jsonb NOT NULL,
  recall jsonb,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, question_id, input_revision),
  FOREIGN KEY (tenant_id, question_id) REFERENCES paper_questions (tenant_id, id)
);
ALTER TABLE question_revision_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_revision_history FORCE ROW LEVEL SECURITY;
CREATE POLICY question_revision_tenant ON question_revision_history
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);

ALTER TABLE practice_attempts ADD COLUMN attempt_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE practice_history (
  tenant_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL,
  title text NOT NULL,
  questions jsonb NOT NULL,
  answers jsonb NOT NULL,
  revision integer NOT NULL,
  draft_state jsonb NOT NULL,
  submitted_at timestamptz NOT NULL,
  deadline_at timestamptz,
  graded jsonb,
  covered uuid[],
  solution_snapshots jsonb,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES papers (tenant_id, id)
);
CREATE INDEX practice_history_paper ON practice_history (tenant_id, paper_id, submitted_at DESC);
ALTER TABLE practice_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_history FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_history_tenant ON practice_history
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);

-- Only line-ending encoding and surrounding whitespace are considered cosmetic.
-- Internal whitespace can carry meaning in formulae/code and stays significant.
CREATE FUNCTION practice_stem_key(value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN btrim(replace(replace(value, E'\r\n', E'\n'), E'\r', E'\n'), E' \t\n\r');

-- Legacy personal overlays remain visible but cannot claim current coverage until
-- explicitly saved as a version or assessed again. No production data is rewritten.
CREATE VIEW submitted_practice_history WITH (security_invoker = true) AS
  SELECT a.tenant_id, a.paper_id, a.title, a.questions, a.answers, a.submitted_at,
    r.graded, r.covered, r.solution_snapshots
  FROM practice_attempts a LEFT JOIN practice_results r USING (tenant_id, paper_id)
  WHERE a.submitted_at IS NOT NULL
  UNION ALL
  SELECT tenant_id, paper_id, title, questions, answers, submitted_at, graded, covered, solution_snapshots
  FROM practice_history;

-- Upgrade existing personal overlays without rewriting their saved attempts.
-- Queueing new model work is left to the normal consent/feature-gated entrypoints.
ALTER TABLE papers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE paper_questions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE question_recall NO FORCE ROW LEVEL SECURITY;
ALTER TABLE question_revision_history NO FORCE ROW LEVEL SECURITY;
ALTER TABLE question_equivalence NO FORCE ROW LEVEL SECURITY;
INSERT INTO question_revision_history (tenant_id,question_id,input_revision,question,recall)
  SELECT q.tenant_id,q.id,q.input_revision,to_jsonb(q),to_jsonb(r)
  FROM paper_questions q JOIN question_recall r ON (r.tenant_id,r.question_id)=(q.tenant_id,q.id)
  WHERE r.stem_correction IS NOT NULL AND practice_stem_key(r.stem_correction)<>practice_stem_key(q.stem);
UPDATE paper_questions q SET stem=r.stem_correction,input_revision=q.input_revision+1,
  reference=NULL,model_solution=NULL,solution_status=NULL,solution_lease=NULL,solution_lease_until=NULL,
  solution_failure=NULL,solution_finished_at=NULL,solution_attempt_count=0,standalone_solution=false
  FROM question_recall r WHERE (r.tenant_id,r.question_id)=(q.tenant_id,q.id)
    AND r.stem_correction IS NOT NULL AND practice_stem_key(r.stem_correction)<>practice_stem_key(q.stem);
UPDATE question_recall r SET self_rating=NULL,assessed_revision=NULL,revealed=false,correction=NULL
  FROM paper_questions q WHERE (r.tenant_id,r.question_id)=(q.tenant_id,q.id) AND q.input_revision>1;
UPDATE question_equivalence e SET revoked_at=coalesce(revoked_at,now())
  WHERE EXISTS (SELECT 1 FROM paper_questions q WHERE q.tenant_id=e.tenant_id
    AND q.id IN (e.anchor_id,e.member_id) AND q.input_revision>1);
ALTER TABLE papers FORCE ROW LEVEL SECURITY;
ALTER TABLE paper_questions FORCE ROW LEVEL SECURITY;
ALTER TABLE question_recall FORCE ROW LEVEL SECURITY;
ALTER TABLE question_revision_history FORCE ROW LEVEL SECURITY;
ALTER TABLE question_equivalence FORCE ROW LEVEL SECURITY;
