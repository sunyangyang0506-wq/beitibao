CREATE FUNCTION publish_recognized_pdf_page(target_tenant uuid, target_paper uuid, target_page integer)
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
    AND r.status = 'review' AND r.reviewed_at IS NULL AND p.model_allowed AND p.media_type = 'application/pdf';
END;
$$;

-- Existing practice attempts retain their captured questions.
DO $$
DECLARE entry record;
BEGIN
  FOR entry IN
    SELECT r.tenant_id, r.paper_id, r.page_number
    FROM paper_page_recognition r
    JOIN papers p ON (p.tenant_id, p.id) = (r.tenant_id, r.paper_id)
    WHERE r.status = 'review' AND r.reviewed_at IS NULL AND p.model_allowed AND p.media_type = 'application/pdf'
      AND NOT EXISTS (
        SELECT 1 FROM practice_attempts a WHERE (a.tenant_id, a.paper_id) = (r.tenant_id, r.paper_id)
      )
    ORDER BY r.tenant_id, r.paper_id, r.page_number
    FOR UPDATE OF p, r
  LOOP
    PERFORM publish_recognized_pdf_page(entry.tenant_id, entry.paper_id, entry.page_number);
  END LOOP;
END;
$$;

ALTER TABLE question_recall ADD COLUMN stem_correction text
  CHECK (char_length(stem_correction) BETWEEN 1 AND 8000);
