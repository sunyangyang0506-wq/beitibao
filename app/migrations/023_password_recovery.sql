CREATE TABLE password_recovery (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  sent_at timestamptz,
  send_lease uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_recovery_account ON password_recovery (account_id);
CREATE INDEX password_recovery_unsent ON password_recovery (next_attempt_at)
  WHERE sent_at IS NULL AND used_at IS NULL AND attempts < 3;
