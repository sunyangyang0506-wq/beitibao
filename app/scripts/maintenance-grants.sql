-- Run as the migration role with psql -v maintenance_role=beitibao_maintenance.
GRANT USAGE ON SCHEMA public TO :"maintenance_role";
GRANT SELECT (expires_at), DELETE ON sessions, password_recovery TO :"maintenance_role";
GRANT SELECT (window_started_at), DELETE ON auth_limits TO :"maintenance_role";
GRANT SELECT (tenant_id, id, expires_at, erased_at, cleaned_at, kept_version, cleanup_lease, cleanup_lease_until),
  UPDATE (cleanup_lease, cleanup_lease_until, cleaned_at), DELETE ON paper_uploads TO :"maintenance_role";
DROP POLICY IF EXISTS paper_uploads_maintenance ON paper_uploads;
CREATE POLICY paper_uploads_maintenance ON paper_uploads TO :"maintenance_role" USING (true) WITH CHECK (true);
GRANT SELECT (created_at, state), DELETE ON business_job_outbox TO :"maintenance_role";
DROP POLICY IF EXISTS business_job_outbox_maintenance ON business_job_outbox;
CREATE POLICY business_job_outbox_maintenance ON business_job_outbox TO :"maintenance_role" USING (true);
GRANT SELECT (started_at), DELETE ON model_rate_events TO :"maintenance_role";
