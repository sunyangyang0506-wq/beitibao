GRANT UPDATE (page_order, missing_pages, review_revision, title) ON papers TO :"worker_role";
-- Only for the isolated local preview worker.
GRANT USAGE ON SCHEMA public TO :"worker_role";
GRANT SELECT, UPDATE (status, pages, failure, lease_id, lease_until, recognition) ON papers TO :"worker_role";
DROP POLICY IF EXISTS papers_local_worker ON papers;
CREATE POLICY papers_local_worker ON papers TO :"worker_role" USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE (source_pages, reference, solution_status, model_solution, solution_lease, solution_lease_until, solution_failure, solution_finished_at, solution_attempt_count) ON paper_questions TO :"worker_role";
DROP POLICY IF EXISTS solutions_local_worker ON paper_questions;
CREATE POLICY solutions_local_worker ON paper_questions TO :"worker_role" USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON paper_model_cache TO :"worker_role";
GRANT SELECT, UPDATE (status, paper_id, lease, lease_until, failure, model_calls) ON predictions TO :"worker_role";
GRANT INSERT ON papers, paper_questions, predictions TO :"worker_role";
DROP POLICY IF EXISTS predictions_local_worker ON predictions;
CREATE POLICY predictions_local_worker ON predictions TO :"worker_role" USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, paper_id, deadline_at, submitted_at, revision),
  UPDATE (submitted_at, revision) ON practice_attempts TO :"worker_role";
DROP POLICY IF EXISTS deadline_local_worker ON practice_attempts;
CREATE POLICY deadline_local_worker ON practice_attempts TO :"worker_role" USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE (status, failure, recognition, lease_id, lease_until, reviewed_at) ON paper_page_recognition TO :"worker_role";
DROP POLICY IF EXISTS page_recognition_worker ON paper_page_recognition;
CREATE POLICY page_recognition_worker ON paper_page_recognition TO :"worker_role" USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON paper_model_cache_claim TO :"worker_role";
GRANT SELECT, INSERT, UPDATE ON model_budget_days, model_tenant_days, model_invocations TO :"worker_role";
GRANT SELECT (attempt_id, title, questions, answers, draft_state) ON practice_attempts TO :"worker_role";
GRANT SELECT, INSERT ON practice_results TO :"worker_role";
DROP POLICY IF EXISTS practice_results_worker ON practice_results;
CREATE POLICY practice_results_worker ON practice_results TO :"worker_role" USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE (state, attempts, lease, lease_until, next_attempt_at) ON practice_deadline_outbox TO :"worker_role";
DROP POLICY IF EXISTS practice_deadline_outbox_worker ON practice_deadline_outbox;
CREATE POLICY practice_deadline_outbox_worker ON practice_deadline_outbox TO :"worker_role" USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE (state, attempts, lease, lease_until, next_attempt_at)
  ON business_job_outbox TO :"worker_role";
DROP POLICY IF EXISTS business_job_outbox_worker ON business_job_outbox;
CREATE POLICY business_job_outbox_worker ON business_job_outbox TO :"worker_role" USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, DELETE ON model_rate_events TO :"worker_role";

GRANT SELECT ON recognition_feedback TO :"worker_role";
DROP POLICY IF EXISTS feedback_local_worker ON recognition_feedback;
CREATE POLICY feedback_local_worker ON recognition_feedback FOR SELECT TO :"worker_role" USING (true);
GRANT SELECT (tenant_id, id, name, prediction_source_papers) ON courses TO :"worker_role";
GRANT UPDATE (course_id, recognized_subject) ON papers TO :"worker_role";
GRANT SELECT (id, school_id) ON accounts TO :"worker_role";
GRANT SELECT (teacher, term) ON courses TO :"worker_role";
GRANT SELECT, INSERT ON school_paper_index TO :"worker_role";
GRANT SELECT, INSERT, DELETE ON school_prediction_index TO :"worker_role";
GRANT UPDATE (school_page_hashes, school_content_key, school_candidate_id, school_reuse) ON papers TO :"worker_role";
GRANT UPDATE (original_recognition) ON paper_page_recognition TO :"worker_role";
GRANT UPDATE (standalone_solution) ON paper_questions TO :"worker_role";
GRANT UPDATE (school_reused) ON predictions TO :"worker_role";
GRANT UPDATE (subject_key) ON school_paper_index TO :"worker_role";

GRANT SELECT ON question_revision_history TO :"worker_role";

GRANT UPDATE (assignment_reason) ON papers TO :"worker_role";
GRANT SELECT (subject_limit) ON accounts TO :"worker_role";
GRANT INSERT ON courses TO :"worker_role";
