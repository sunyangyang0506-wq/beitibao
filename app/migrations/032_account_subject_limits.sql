ALTER TABLE accounts ADD COLUMN subject_limit integer CHECK (subject_limit BETWEEN 0 AND 1000);
ALTER TABLE invitations ADD COLUMN subject_limit integer CHECK (subject_limit BETWEEN 0 AND 1000);
