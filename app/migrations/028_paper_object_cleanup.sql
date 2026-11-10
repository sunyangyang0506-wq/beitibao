ALTER TABLE paper_uploads
  ADD COLUMN erased_at timestamptz,
  ADD COLUMN cleanup_lease uuid,
  ADD COLUMN cleanup_lease_until timestamptz;
