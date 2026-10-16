-- Explicit launch funding for reviewed monthly free allowances, after migration 010.
-- This is an operator action, not an automatic migration or release-time cap reset.
-- Existing overall spend, concurrency, unresolved exposure and enabled state stay intact.
BEGIN;
UPDATE ai_limits
  SET free_daily_micros=10000000, free_monthly_micros=50000000
  WHERE id=true;
COMMIT;
