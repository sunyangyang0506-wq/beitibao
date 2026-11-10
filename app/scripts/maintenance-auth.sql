-- Run on a bounded schedule as an authorized database maintenance role.
DELETE FROM sessions WHERE expires_at <= now();
DELETE FROM auth_limits WHERE window_started_at <= now() - interval '1 day';
DELETE FROM password_recovery WHERE expires_at <= now() - interval '1 day';
