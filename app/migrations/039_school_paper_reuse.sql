CREATE TABLE schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  name_key text NOT NULL UNIQUE
);

ALTER TABLE accounts ADD COLUMN school_id uuid REFERENCES schools(id);
ALTER TABLE paper_uploads ADD COLUMN share_school_id uuid REFERENCES schools(id);
ALTER TABLE papers
  ADD COLUMN share_school_id uuid REFERENCES schools(id),
  ADD COLUMN school_content_key text,
  ADD COLUMN school_reuse text CHECK (school_reuse IN ('exact', 'pages')),
  ADD COLUMN school_page_hashes text[],
  ADD COLUMN school_candidate_id uuid;

ALTER TABLE paper_page_recognition ADD COLUMN original_recognition jsonb;
ALTER TABLE paper_questions ADD COLUMN standalone_solution boolean NOT NULL DEFAULT false;
ALTER TABLE predictions ADD COLUMN school_reused boolean NOT NULL DEFAULT false;

CREATE TABLE school_paper_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  tenant_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  file_hash text NOT NULL,
  render_version text NOT NULL,
  page_hashes text[] NOT NULL CHECK (cardinality(page_hashes) BETWEEN 1 AND 30),
  content_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, paper_id),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES papers(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX school_paper_file ON school_paper_index(school_id, file_hash);
CREATE INDEX school_paper_first_page ON school_paper_index(school_id, render_version, (page_hashes[1]));
CREATE INDEX school_paper_content ON school_paper_index(school_id, content_key);

CREATE TABLE school_prediction_index (
  school_id uuid NOT NULL REFERENCES schools(id),
  input_key text NOT NULL,
  tenant_id uuid NOT NULL,
  prediction_id uuid NOT NULL,
  PRIMARY KEY (school_id, input_key),
  FOREIGN KEY (tenant_id, prediction_id) REFERENCES predictions(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE school_paper_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_paper_index FORCE ROW LEVEL SECURITY;
CREATE POLICY school_paper_read ON school_paper_index FOR SELECT USING (EXISTS (
  SELECT 1 FROM accounts a WHERE a.id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid AND a.school_id = school_paper_index.school_id
));
CREATE POLICY school_paper_insert ON school_paper_index FOR INSERT WITH CHECK (
  tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM accounts a WHERE a.id = tenant_id AND a.school_id = school_paper_index.school_id
  )
);

ALTER TABLE school_prediction_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_prediction_index FORCE ROW LEVEL SECURITY;
CREATE POLICY school_prediction_read ON school_prediction_index FOR SELECT USING (EXISTS (
  SELECT 1 FROM accounts a WHERE a.id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid AND a.school_id = school_prediction_index.school_id
));
CREATE POLICY school_prediction_insert ON school_prediction_index FOR INSERT WITH CHECK (
  tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM accounts a WHERE a.id = tenant_id AND a.school_id = school_prediction_index.school_id
  )
);
CREATE POLICY school_prediction_remove ON school_prediction_index FOR DELETE USING (EXISTS (
  SELECT 1 FROM accounts a WHERE a.id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid AND a.school_id = school_prediction_index.school_id
));

-- A learner-edited source is a private version. Automated solution writes and cross-page joins do not run this trigger.
CREATE FUNCTION invalidate_school_question_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.stem, OLD.reference, OLD.question_kind, OLD.visual_review) IS DISTINCT FROM
     (NEW.stem, NEW.reference, NEW.question_kind, NEW.visual_review) THEN
    UPDATE public.papers SET share_school_id = NULL, school_content_key = NULL
    WHERE tenant_id = NEW.tenant_id AND id = NEW.paper_id AND (share_school_id IS NOT NULL OR school_content_key IS NOT NULL);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_school_question_source AFTER UPDATE OF stem, reference, question_kind, visual_review
  ON paper_questions FOR EACH ROW EXECUTE FUNCTION invalidate_school_question_source();

ALTER TABLE school_paper_index ADD COLUMN subject_key text;
CREATE POLICY school_paper_subject_owner ON school_paper_index FOR UPDATE
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
