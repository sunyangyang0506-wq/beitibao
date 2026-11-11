ALTER TABLE courses ADD COLUMN prediction_source_papers uuid[];

CREATE VIEW course_learning_progress WITH (security_invoker = true) AS
WITH covered AS (
  SELECT DISTINCT q.tenant_id, coalesce(e.anchor_id, q.id) AS id
  FROM paper_questions q
  JOIN papers p ON (q.tenant_id, q.paper_id) = (p.tenant_id, p.id) AND NOT p.is_prediction
  LEFT JOIN current_question_equivalence e ON (e.tenant_id, e.member_id) = (q.tenant_id, q.id)
  LEFT JOIN question_recall r ON (r.tenant_id, r.question_id) = (q.tenant_id, q.id)
  WHERE (
    (r.self_rating IS NOT NULL AND coalesce(r.assessed_revision, 1) = q.input_revision
      AND practice_stem_key(coalesce(r.stem_correction,q.stem)) = practice_stem_key(q.stem))
    OR EXISTS (
      SELECT 1 FROM submitted_practice_history a
      CROSS JOIN LATERAL jsonb_array_elements(a.questions) input
      WHERE a.tenant_id=q.tenant_id AND a.paper_id=q.paper_id AND input->>'id'=q.id::text
        AND coalesce((input->>'inputRevision')::int,1)=q.input_revision
        AND practice_stem_key(input->>'stem') = practice_stem_key(coalesce(r.stem_correction,q.stem))
        AND (input->>'visualReview') IS NOT DISTINCT FROM q.visual_review
        AND (NOT input ? 'kind' OR input->>'kind'=q.question_kind)
        AND CASE WHEN a.covered IS NOT NULL THEN q.id=ANY(a.covered)
          ELSE coalesce(a.answers->>q.id::text,'') ~ '[^[:space:]]' END
    )
  )
)
SELECT c.tenant_id, c.id AS course_id, count(p.id)::int AS total_papers,
  count(p.id) FILTER (WHERE p.status = 'review' AND NOT p.missing_pages AND NOT EXISTS (
    SELECT 1 FROM paper_page_recognition r
    WHERE (r.tenant_id, r.paper_id) = (p.tenant_id, p.id) AND r.reviewed_at IS NULL
  ) AND EXISTS (
    SELECT 1 FROM paper_questions q WHERE (q.tenant_id, q.paper_id) = (p.tenant_id, p.id)
  ) AND NOT EXISTS (
    SELECT 1 FROM paper_questions q
    LEFT JOIN current_question_equivalence e ON (e.tenant_id, e.member_id) = (q.tenant_id, q.id)
    LEFT JOIN covered done ON done.tenant_id = q.tenant_id AND done.id = coalesce(e.anchor_id, q.id)
    WHERE (q.tenant_id, q.paper_id) = (p.tenant_id, p.id) AND done.id IS NULL
  ))::int AS completed_papers
FROM courses c
LEFT JOIN papers p ON (p.tenant_id, p.course_id) = (c.tenant_id, c.id) AND NOT p.is_prediction
GROUP BY c.tenant_id, c.id;
