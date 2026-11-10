ALTER TABLE accounts
  ALTER COLUMN email DROP NOT NULL,
  ADD COLUMN phone text UNIQUE CHECK (phone ~ '^1[3-9][0-9]{9}$'),
  ADD CONSTRAINT account_identity CHECK (num_nonnulls(email, phone) = 1);

ALTER TABLE invitations
  ALTER COLUMN email DROP NOT NULL,
  ADD COLUMN phone text CHECK (phone ~ '^1[3-9][0-9]{9}$'),
  ADD CONSTRAINT invitation_identity CHECK (num_nonnulls(email, phone) = 1);
