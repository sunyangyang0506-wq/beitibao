-- Run as the migration role with psql -v app_role=beitibao_api.
GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT, INSERT, UPDATE (subject_limit) ON accounts TO :"app_role";
GRANT SELECT, INSERT, UPDATE (used_at) ON invitations TO :"app_role";
GRANT SELECT, INSERT, DELETE ON sessions TO :"app_role";
GRANT SELECT, INSERT, UPDATE ON auth_limits TO :"app_role";
GRANT SELECT, INSERT ON courses TO :"app_role";
GRANT SELECT, INSERT ON papers TO :"app_role";
GRANT SELECT, INSERT ON paper_questions TO :"app_role";
GRANT SELECT, INSERT ON recognition_feedback TO :"app_role";
GRANT UPDATE (status, failure, recognition) ON papers TO :"app_role";
GRANT SELECT, INSERT, UPDATE (answers, revision, submitted_at) ON practice_attempts TO :"app_role";
GRANT UPDATE (reference) ON paper_questions TO :"app_role";
GRANT UPDATE (solution_status, solution_attempt_count) ON paper_questions TO :"app_role";
GRANT UPDATE (question_kind) ON paper_questions TO :"app_role";
GRANT SELECT, INSERT, UPDATE (revealed, correction, stem_correction) ON question_recall TO :"app_role";
GRANT SELECT (cache_key) ON paper_model_cache TO :"app_role";
GRANT SELECT, INSERT ON mistake_retries TO :"app_role";
GRANT SELECT, INSERT, UPDATE (status) ON predictions TO :"app_role";
GRANT UPDATE (self_rating) ON question_recall TO :"app_role";
GRANT UPDATE (bookmarked, had_recall_difficulty) ON question_recall TO :"app_role";
GRANT UPDATE (mistake_recorded_at) ON question_recall TO :"app_role";
GRANT SELECT, INSERT, UPDATE (status, failure, recognition, reviewed_at) ON paper_page_recognition TO :"app_role";
GRANT UPDATE (lease_id, lease_until) ON paper_page_recognition TO :"app_role";
GRANT UPDATE (draft_state) ON practice_attempts TO :"app_role";
GRANT SELECT, INSERT, UPDATE ON model_budget_days, model_tenant_days, model_invocations TO :"app_role";
GRANT SELECT, INSERT ON practice_results TO :"app_role";
GRANT UPDATE (page_order, missing_pages, review_revision) ON papers TO :"app_role";
GRANT UPDATE (password_hash) ON accounts TO :"app_role";
GRANT SELECT (id, account_id, token_hash, expires_at, used_at), INSERT, UPDATE (used_at) ON password_recovery TO :"app_role";
GRANT INSERT ON practice_deadline_outbox TO :"app_role";
GRANT SELECT, INSERT, UPDATE (revoked_at) ON question_equivalence TO :"app_role";
GRANT SELECT ON current_question_equivalence TO :"app_role";
GRANT SELECT, INSERT, UPDATE (paper_id, kept_version) ON paper_uploads TO :"app_role";
GRANT INSERT ON business_job_outbox TO :"app_role";
GRANT UPDATE (title, school, fingerprint, cleaned_at, erased_at) ON paper_uploads TO :"app_role";
GRANT SELECT (tenant_id, lane, job_key), DELETE ON business_job_outbox TO :"app_role";
GRANT DELETE ON papers, paper_questions, recognition_feedback, paper_page_recognition,
  practice_attempts, practice_results, practice_deadline_outbox, predictions, question_equivalence,
  question_recall, mistake_retries, paper_model_cache, paper_model_cache_claim TO :"app_role";
GRANT SELECT (tenant_id, paper_id) ON practice_deadline_outbox TO :"app_role";
GRANT SELECT (tenant_id, cache_key) ON paper_model_cache_claim TO :"app_role";
GRANT SELECT, INSERT, DELETE ON model_rate_events TO :"app_role";
GRANT UPDATE (solution_snapshots, graded) ON practice_results TO :"app_role";
GRANT UPDATE (exam_at) ON courses TO :"app_role";
GRANT UPDATE (last_mistake_at) ON question_recall TO :"app_role";
GRANT UPDATE (course_id) ON papers TO :"app_role";
GRANT SELECT, INSERT ON schools TO :"app_role";
GRANT UPDATE (school_id) ON accounts TO :"app_role";
GRANT UPDATE (share_school_id, school_content_key) ON papers TO :"app_role";
GRANT UPDATE (share_school_id) ON paper_uploads TO :"app_role";

-- Versioned personal inputs and append-only history; no UPDATE grant on archives.
GRANT SELECT, INSERT, DELETE ON question_revision_history, practice_history TO :"app_role";
GRANT SELECT ON submitted_practice_history TO :"app_role";
GRANT UPDATE (stem, input_revision, model_solution, solution_lease, solution_lease_until,
  solution_failure, solution_finished_at, standalone_solution) ON paper_questions TO :"app_role";
GRANT UPDATE (assessed_revision) ON question_recall TO :"app_role";
GRANT UPDATE (questions, title, deadline_at) ON practice_attempts TO :"app_role";

GRANT UPDATE (graded, solution_snapshots) ON practice_history TO :"app_role";

GRANT UPDATE (assignment_reason) ON papers TO :"app_role";

-- Recover validated legacy PDF recognition with original cross-page provenance.
GRANT UPDATE (source_pages) ON paper_questions TO :"app_role";
