CREATE TABLE business_job_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  lane text NOT NULL CHECK (lane IN ('paper', 'page', 'solution', 'prediction')),
  job_key uuid NOT NULL,
  page_number integer,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'publishing', 'published', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  lease uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lane = 'page' AND page_number BETWEEN 1 AND 30)
      OR (lane <> 'page' AND page_number IS NULL))
);
CREATE INDEX business_job_outbox_dispatch ON business_job_outbox (lane, next_attempt_at, id)
  WHERE state IN ('pending', 'publishing');
CREATE INDEX business_job_outbox_tenant_job ON business_job_outbox (tenant_id, lane, job_key);
ALTER TABLE business_job_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_job_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY business_job_outbox_tenant ON business_job_outbox
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);

CREATE FUNCTION notify_business_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  work_status text;
  prior_status text;
  work_key uuid;
  work_page integer;
BEGIN
  IF TG_ARGV[0] = 'solution' THEN
    work_status := NEW.solution_status;
    IF TG_OP = 'UPDATE' THEN prior_status := OLD.solution_status; END IF;
  ELSE
    work_status := NEW.status;
    IF TG_OP = 'UPDATE' THEN prior_status := OLD.status; END IF;
  END IF;
  IF work_status = 'queued' AND prior_status IS DISTINCT FROM 'queued' THEN
    IF TG_ARGV[0] = 'page' THEN
      work_key := NEW.paper_id;
      work_page := NEW.page_number;
    ELSE
      work_key := NEW.id;
    END IF;
    INSERT INTO public.business_job_outbox (tenant_id, lane, job_key, page_number)
    VALUES (NEW.tenant_id, TG_ARGV[0], work_key, work_page);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enqueue_paper AFTER INSERT OR UPDATE OF status ON papers
  FOR EACH ROW EXECUTE FUNCTION notify_business_job('paper');
CREATE TRIGGER enqueue_page AFTER INSERT OR UPDATE OF status ON paper_page_recognition
  FOR EACH ROW EXECUTE FUNCTION notify_business_job('page');
CREATE TRIGGER enqueue_solution AFTER INSERT OR UPDATE OF solution_status ON paper_questions
  FOR EACH ROW EXECUTE FUNCTION notify_business_job('solution');
CREATE TRIGGER enqueue_prediction AFTER INSERT OR UPDATE OF status ON predictions
  FOR EACH ROW EXECUTE FUNCTION notify_business_job('prediction');
