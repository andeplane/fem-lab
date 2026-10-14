ALTER TABLE usage_receipts DROP CONSTRAINT usage_receipts_outcome_check;
ALTER TABLE usage_receipts ADD CONSTRAINT usage_receipts_outcome_check
  CHECK (outcome IN ('confirmed','undispatched','unknown','provider-rejected'));
