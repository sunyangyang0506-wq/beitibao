CREATE TABLE model_budget_days (
  day date PRIMARY KEY,
  held_micros bigint NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  warned boolean NOT NULL DEFAULT false
);

CREATE TABLE model_tenant_days (
  tenant_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day date NOT NULL,
  held_micros bigint NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  PRIMARY KEY (tenant_id, day)
);

CREATE TABLE model_invocations (
  tenant_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  day date NOT NULL,
  task text NOT NULL CHECK (task IN ('paper', 'page', 'solution', 'prediction', 'figure')),
  model text NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'metered', 'rejected', 'unknown')),
  held_micros bigint NOT NULL CHECK (held_micros >= 0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  input_tokens integer,
  output_tokens integer,
  request_id text,
  http_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX model_invocations_day ON model_invocations (tenant_id, day, state);
ALTER TABLE model_tenant_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_tenant_days FORCE ROW LEVEL SECURITY;
CREATE POLICY model_tenant_days_tenant ON model_tenant_days
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
ALTER TABLE model_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY model_invocations_tenant ON model_invocations
  USING (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('beitibao.tenant_id', true), '')::uuid);
