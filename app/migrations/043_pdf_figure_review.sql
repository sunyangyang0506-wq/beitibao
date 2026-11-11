ALTER TABLE paper_questions ADD COLUMN figure_review_blocked boolean NOT NULL DEFAULT false;

CREATE FUNCTION pdf_figure_pending(recognition jsonb, candidate integer)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE jsonb_typeof(recognition->'figures'->candidate)
    WHEN 'array' THEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(recognition->'figures'->candidate) AS figure
      WHERE figure->>'status' IS DISTINCT FROM 'consistent'
    ) OR (jsonb_array_length(recognition->'figures'->candidate) = 0
      AND coalesce(recognition->'visualContexts'->>candidate, '') <> ''
      AND coalesce(recognition->'resolvedContexts'->>candidate, '') = '')
    ELSE (recognition->'figures'->candidate IS NOT NULL AND recognition->'figures'->candidate <> 'null'::jsonb)
      OR (coalesce(recognition->'visualContexts'->>candidate, '') <> ''
        AND coalesce(recognition->'resolvedContexts'->>candidate, '') = '')
  END;
$$;

CREATE OR REPLACE FUNCTION publish_recognized_pdf_page(target_tenant uuid, target_paper uuid, target_page integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  WITH candidates AS (
    SELECT r.tenant_id, r.paper_id, r.page_number, btrim(item.stem) AS stem, item.ordinality
    FROM paper_page_recognition r
    JOIN papers p ON (p.tenant_id, p.id) = (r.tenant_id, r.paper_id)
    CROSS JOIN LATERAL jsonb_array_elements_text(r.recognition->'stems') WITH ORDINALITY AS item(stem, ordinality)
    WHERE (r.tenant_id, r.paper_id, r.page_number) = (target_tenant, target_paper, target_page)
      AND r.status = 'review' AND r.reviewed_at IS NULL AND p.model_allowed AND p.media_type = 'application/pdf'
      AND char_length(btrim(item.stem)) BETWEEN 1 AND 8000
      AND NOT pdf_figure_pending(r.recognition, item.ordinality::integer - 1)
      AND NOT EXISTS (
        SELECT 1 FROM recognition_feedback f
        WHERE (f.tenant_id, f.paper_id, f.candidate_index) =
          (r.tenant_id, r.paper_id, (r.page_number - 1) * 100 + item.ordinality - 1)
      )
  )
  INSERT INTO paper_questions (tenant_id, paper_id, page_number, fingerprint, stem, question_kind, created_at)
  SELECT tenant_id, paper_id, page_number, encode(sha256(convert_to(stem, 'UTF8')), 'hex'), stem,
    CASE
      WHEN stem ~* '(^|[[:space:]])A[.、．)]' AND stem ~* '(^|[[:space:]])B[.、．)]' THEN 'choice'
      WHEN stem ~ '计算|求出|求值|求其|求下列' THEN 'calculation'
      WHEN stem ~ '____' THEN 'fill'
      ELSE 'other'
    END,
    statement_timestamp() + ordinality * interval '1 microsecond'
  FROM candidates
  ON CONFLICT (tenant_id, paper_id, page_number, fingerprint) DO NOTHING;

  UPDATE paper_page_recognition r SET reviewed_at = clock_timestamp()
  FROM papers p
  WHERE (r.tenant_id, r.paper_id, r.page_number) = (target_tenant, target_paper, target_page)
    AND (p.tenant_id, p.id) = (r.tenant_id, r.paper_id)
    AND r.status = 'review' AND r.reviewed_at IS NULL AND p.model_allowed AND p.media_type = 'application/pdf'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(r.recognition->'stems') WITH ORDINALITY AS item(stem, ordinality)
      WHERE pdf_figure_pending(r.recognition, item.ordinality::integer - 1)
        AND NOT EXISTS (
          SELECT 1 FROM recognition_feedback f
          WHERE (f.tenant_id, f.paper_id, f.candidate_index) =
            (r.tenant_id, r.paper_id, (r.page_number - 1) * 100 + item.ordinality - 1)
        )
    );
END;
$$;

-- A reference read from the same original is part of that original's
-- recognition. Teacher answers and learner confirmations remain private edits.
CREATE OR REPLACE FUNCTION invalidate_school_question_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.stem, OLD.reference, OLD.question_kind, OLD.visual_review) IS DISTINCT FROM
     (NEW.stem, NEW.reference, NEW.question_kind, NEW.visual_review) AND NOT (
       (OLD.stem, OLD.question_kind, OLD.visual_review) IS NOT DISTINCT FROM
       (NEW.stem, NEW.question_kind, NEW.visual_review)
       AND OLD.reference IS NULL AND coalesce(NEW.reference->>'source', '') IN ('paper', 'paper_ocr')
     ) THEN
    UPDATE public.papers SET share_school_id = NULL, school_content_key = NULL
    WHERE tenant_id = NEW.tenant_id AND id = NEW.paper_id AND (share_school_id IS NOT NULL OR school_content_key IS NOT NULL);
  END IF;
  RETURN NEW;
END;
$$;

-- Existing automatically published conflicts must go through the same review.
-- Preserve identifiers and submitted snapshots. A blocked row is never used
-- as a current question, even when a reviewer rejects the candidate.
ALTER TABLE paper_page_recognition NO FORCE ROW LEVEL SECURITY;
ALTER TABLE paper_questions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE recognition_feedback NO FORCE ROW LEVEL SECURITY;
ALTER TABLE question_equivalence NO FORCE ROW LEVEL SECURITY;

WITH pending AS (
  SELECT r.tenant_id, r.paper_id, r.page_number, btrim(item.stem) AS stem
  FROM paper_page_recognition r
  CROSS JOIN LATERAL jsonb_array_elements_text(r.recognition->'stems') WITH ORDINALITY AS item(stem, ordinality)
  WHERE r.status = 'review' AND pdf_figure_pending(r.recognition, item.ordinality::integer - 1)
    AND NOT EXISTS (
      SELECT 1 FROM recognition_feedback f
      WHERE (f.tenant_id, f.paper_id, f.candidate_index) =
        (r.tenant_id, r.paper_id, (r.page_number - 1) * 100 + item.ordinality - 1)
    )
), blocked AS (
  UPDATE paper_questions q SET figure_review_blocked = true, solution_status = NULL,
    solution_lease = NULL, solution_lease_until = NULL
  FROM pending p
  WHERE (q.tenant_id, q.paper_id, q.page_number) = (p.tenant_id, p.paper_id, p.page_number)
    AND q.fingerprint = encode(sha256(convert_to(p.stem, 'UTF8')), 'hex')
    AND q.visual_review IS NULL
  RETURNING q.tenant_id, q.id
), revoked AS (
  UPDATE question_equivalence e SET revoked_at = clock_timestamp()
  FROM blocked b
  WHERE e.tenant_id = b.tenant_id AND b.id IN (e.anchor_id, e.member_id) AND e.revoked_at IS NULL
)
UPDATE paper_page_recognition r SET reviewed_at = NULL
WHERE EXISTS (
  SELECT 1 FROM pending p
  WHERE (r.tenant_id, r.paper_id, r.page_number) = (p.tenant_id, p.paper_id, p.page_number)
);

ALTER TABLE question_equivalence FORCE ROW LEVEL SECURITY;
ALTER TABLE recognition_feedback FORCE ROW LEVEL SECURITY;
ALTER TABLE paper_questions FORCE ROW LEVEL SECURITY;
ALTER TABLE paper_page_recognition FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE VIEW course_learning_progress WITH (security_invoker = true) AS
WITH covered AS (
  SELECT DISTINCT q.tenant_id, coalesce(e.anchor_id, q.id) AS id
  FROM paper_questions q
  JOIN papers p ON (q.tenant_id, q.paper_id) = (p.tenant_id, p.id) AND NOT p.is_prediction
  LEFT JOIN current_question_equivalence e ON (e.tenant_id, e.member_id) = (q.tenant_id, q.id)
  LEFT JOIN question_recall r ON (r.tenant_id, r.question_id) = (q.tenant_id, q.id)
  WHERE NOT q.figure_review_blocked AND (
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
    SELECT 1 FROM paper_questions q WHERE (q.tenant_id, q.paper_id) = (p.tenant_id, p.id) AND NOT q.figure_review_blocked
  ) AND NOT EXISTS (
    SELECT 1 FROM paper_questions q
    LEFT JOIN current_question_equivalence e ON (e.tenant_id, e.member_id) = (q.tenant_id, q.id)
    LEFT JOIN covered done ON done.tenant_id = q.tenant_id AND done.id = coalesce(e.anchor_id, q.id)
    WHERE (q.tenant_id, q.paper_id) = (p.tenant_id, p.id) AND NOT q.figure_review_blocked AND done.id IS NULL
  ))::int AS completed_papers
FROM courses c
LEFT JOIN papers p ON (p.tenant_id, p.course_id) = (c.tenant_id, c.id) AND NOT p.is_prediction
GROUP BY c.tenant_id, c.id;
