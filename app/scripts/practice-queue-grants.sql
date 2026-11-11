-- Run as the migration role with psql -v queue_role=beitibao_practice_queue.
GRANT USAGE ON SCHEMA public TO :"queue_role";
GRANT SELECT, UPDATE (state, attempts, lease, lease_until, next_attempt_at)
  ON practice_deadline_outbox TO :"queue_role";
DROP POLICY IF EXISTS practice_deadline_outbox_queue ON practice_deadline_outbox;
CREATE POLICY practice_deadline_outbox_queue ON practice_deadline_outbox TO :"queue_role" USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, paper_id, deadline_at, submitted_at, revision, attempt_id, title, questions, answers, draft_state),
  UPDATE (submitted_at, revision) ON practice_attempts TO :"queue_role";
DROP POLICY IF EXISTS practice_attempts_queue ON practice_attempts;
CREATE POLICY practice_attempts_queue ON practice_attempts TO :"queue_role" USING (true) WITH CHECK (true);
GRANT INSERT, SELECT (tenant_id, paper_id) ON practice_results TO :"queue_role";
DROP POLICY IF EXISTS practice_results_queue ON practice_results;
CREATE POLICY practice_results_queue ON practice_results TO :"queue_role" USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, paper_id, id, stem, input_revision, visual_review, model_solution, solution_status)
  ON paper_questions TO :"queue_role";

GRANT SELECT ON question_revision_history TO :"queue_role";
GRANT SELECT (question_kind, reference, figure_review_blocked) ON paper_questions TO :"queue_role";
