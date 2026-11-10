-- Run as the migration role with psql -v mail_role=beitibao_mail.
GRANT USAGE ON SCHEMA public TO :"mail_role";
GRANT SELECT (id, email) ON accounts TO :"mail_role";
GRANT SELECT (id, account_id, expires_at, used_at, sent_at, send_lease, lease_until, attempts, next_attempt_at),
  UPDATE (sent_at, send_lease, lease_until, attempts, next_attempt_at) ON password_recovery TO :"mail_role";
