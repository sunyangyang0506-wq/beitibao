-- Run as the migration role with psql -v worker_role=beitibao_paper -v worker_lane=paper.
SELECT :'worker_lane' = 'paper' AS paper, :'worker_lane' = 'page' AS page,
       :'worker_lane' = 'solution' AS solution, :'worker_lane' = 'prediction' AS prediction,
       :'worker_lane' IN ('paper', 'page', 'solution', 'prediction') AS valid_lane \gset
\if :valid_lane
\else
  \echo Invalid business worker lane
  SELECT 1 / 0;
\endif

\set paper_policy :worker_lane '_release_papers'
\set question_policy :worker_lane '_release_questions'
\set page_policy :worker_lane '_release_pages'
\set outbox_policy :worker_lane '_release_outbox'

GRANT USAGE ON SCHEMA public TO :"worker_role";
GRANT SELECT ON papers TO :"worker_role";
GRANT SELECT (id, school_id) ON accounts TO :"worker_role";
DROP POLICY IF EXISTS :"paper_policy" ON papers;
CREATE POLICY :"paper_policy" ON papers TO :"worker_role" USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE (state, attempts, lease, lease_until, next_attempt_at) ON business_job_outbox TO :"worker_role";
DROP POLICY IF EXISTS :"outbox_policy" ON business_job_outbox;
\if :paper
  CREATE POLICY :"outbox_policy" ON business_job_outbox TO :"worker_role"
    USING (lane = 'paper') WITH CHECK (lane IN ('paper', 'page', 'solution', 'prediction'));
  GRANT INSERT ON business_job_outbox TO :"worker_role";
\elif :page
  CREATE POLICY :"outbox_policy" ON business_job_outbox TO :"worker_role"
    USING (lane = 'page') WITH CHECK (lane IN ('page', 'solution', 'prediction'));
  GRANT INSERT ON business_job_outbox TO :"worker_role";
\else
  CREATE POLICY :"outbox_policy" ON business_job_outbox TO :"worker_role"
    USING (lane = :'worker_lane') WITH CHECK (lane = :'worker_lane');
  \if :prediction
    GRANT INSERT ON business_job_outbox TO :"worker_role";
  \endif
\endif
GRANT SELECT, INSERT, UPDATE ON model_budget_days, model_tenant_days, model_invocations TO :"worker_role";
GRANT SELECT, INSERT, DELETE ON model_rate_events TO :"worker_role";

\if :paper
  GRANT SELECT (tenant_id, id, name) ON courses TO :"worker_role";
  GRANT SELECT, INSERT ON school_paper_index TO :"worker_role";
  GRANT INSERT ON predictions TO :"worker_role";
  DROP POLICY IF EXISTS prediction_release_paper ON predictions;
  CREATE POLICY prediction_release_paper ON predictions FOR INSERT TO :"worker_role" WITH CHECK (true);
  GRANT SELECT, INSERT ON paper_questions TO :"worker_role";
  GRANT UPDATE (page_order, title, recognized_subject, course_id, school_page_hashes, school_content_key, school_candidate_id, school_reuse,
    status, pages, failure, lease_id, lease_until, recognition) ON papers TO :"worker_role";
  GRANT SELECT, INSERT ON paper_page_recognition TO :"worker_role";
  DROP POLICY IF EXISTS :"page_policy" ON paper_page_recognition;
  CREATE POLICY :"page_policy" ON paper_page_recognition TO :"worker_role" WITH CHECK (true);
  GRANT SELECT, INSERT ON paper_model_cache TO :"worker_role";
  GRANT SELECT, INSERT, UPDATE, DELETE ON paper_model_cache_claim TO :"worker_role";
\elif :page
  GRANT SELECT (tenant_id, id, name) ON courses TO :"worker_role";
  GRANT UPDATE (page_order, missing_pages, review_revision, title, course_id, recognized_subject) ON papers TO :"worker_role";
  GRANT SELECT, UPDATE (subject_key) ON school_paper_index TO :"worker_role";
  GRANT UPDATE (school_reuse) ON papers TO :"worker_role";
  GRANT SELECT, INSERT, UPDATE (solution_status, source_pages, model_solution, standalone_solution) ON paper_questions TO :"worker_role";
  GRANT INSERT ON predictions TO :"worker_role";
  DROP POLICY IF EXISTS prediction_release_page ON predictions;
  CREATE POLICY prediction_release_page ON predictions FOR INSERT TO :"worker_role" WITH CHECK (true);
  DROP POLICY IF EXISTS :"question_policy" ON paper_questions;
  CREATE POLICY :"question_policy" ON paper_questions TO :"worker_role" USING (true) WITH CHECK (true);
  GRANT SELECT ON recognition_feedback TO :"worker_role";
  DROP POLICY IF EXISTS feedback_release_page ON recognition_feedback;
  CREATE POLICY feedback_release_page ON recognition_feedback FOR SELECT TO :"worker_role" USING (true);
  GRANT SELECT, UPDATE (status, failure, recognition, lease_id, lease_until, reviewed_at, original_recognition) ON paper_page_recognition TO :"worker_role";
  DROP POLICY IF EXISTS :"page_policy" ON paper_page_recognition;
  CREATE POLICY :"page_policy" ON paper_page_recognition TO :"worker_role" USING (true) WITH CHECK (true);
\elif :solution
  GRANT SELECT, UPDATE (solution_status, model_solution, solution_lease, solution_lease_until, solution_failure, solution_finished_at, solution_attempt_count) ON paper_questions TO :"worker_role";
  DROP POLICY IF EXISTS :"question_policy" ON paper_questions;
  CREATE POLICY :"question_policy" ON paper_questions TO :"worker_role" USING (true) WITH CHECK (true);
  GRANT SELECT ON paper_model_cache TO :"worker_role";
  GRANT SELECT (tenant_id, paper_id, page_number, original_recognition, recognition) ON paper_page_recognition TO :"worker_role";
  DROP POLICY IF EXISTS :"page_policy" ON paper_page_recognition;
  CREATE POLICY :"page_policy" ON paper_page_recognition FOR SELECT TO :"worker_role" USING (true);
  GRANT UPDATE (standalone_solution) ON paper_questions TO :"worker_role";
\elif :prediction
  GRANT SELECT (tenant_id, paper_id, reviewed_at, status) ON paper_page_recognition TO :"worker_role";
  DROP POLICY IF EXISTS :"page_policy" ON paper_page_recognition;
  CREATE POLICY :"page_policy" ON paper_page_recognition FOR SELECT TO :"worker_role" USING (true);
  GRANT SELECT (tenant_id, id, name, teacher, term) ON courses TO :"worker_role";
  GRANT SELECT ON school_paper_index TO :"worker_role";
  GRANT SELECT, INSERT, DELETE ON school_prediction_index TO :"worker_role";
  GRANT UPDATE (school_reused) ON predictions TO :"worker_role";
  GRANT INSERT ON papers TO :"worker_role";
  GRANT SELECT, INSERT ON paper_questions TO :"worker_role";
  DROP POLICY IF EXISTS :"question_policy" ON paper_questions;
  CREATE POLICY :"question_policy" ON paper_questions TO :"worker_role" USING (true) WITH CHECK (true);
  GRANT SELECT, UPDATE (status, paper_id, lease, lease_until, failure, model_calls) ON predictions TO :"worker_role";
  DROP POLICY IF EXISTS prediction_release_worker ON predictions;
  CREATE POLICY prediction_release_worker ON predictions TO :"worker_role" USING (true) WITH CHECK (true);
\endif
