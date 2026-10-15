-- Stripe test payments must never unlock real supplier spending on public staging.
-- Reapply after every staging migration, including when no schema changed.
BEGIN;
ALTER TABLE ai_limits
  ALTER COLUMN enabled SET DEFAULT false,
  ALTER COLUMN daily_micros SET DEFAULT 0,
  ALTER COLUMN monthly_micros SET DEFAULT 0,
  ALTER COLUMN free_daily_micros SET DEFAULT 0,
  ALTER COLUMN uncertain_micros SET DEFAULT 0;
UPDATE ai_limits
  SET enabled=false, daily_micros=0, monthly_micros=0,
      free_daily_micros=0, uncertain_micros=0
  WHERE id=true;
COMMIT;
