-- Old shared entries keep their original data but cannot be read by runtime roles.
ALTER TABLE paper_model_cache ADD COLUMN tenant_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE paper_model_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_model_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY model_cache_tenant ON paper_model_cache
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);

CREATE TABLE paper_model_cache_claim (
  tenant_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cache_key text NOT NULL,
  lease_id uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, cache_key)
);
ALTER TABLE paper_model_cache_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_model_cache_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY model_cache_claim_tenant ON paper_model_cache_claim
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
