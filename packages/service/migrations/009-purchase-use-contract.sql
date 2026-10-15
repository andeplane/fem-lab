-- Existing attempts are deliberately left unversioned. Their original wire
-- parameters cannot be reconstructed from today's merchant/tax/catalog settings.
ALTER TABLE checkout_intents
  ADD COLUMN request_version integer CHECK (request_version > 0),
  ADD COLUMN price_id text,
  ADD COLUMN purchase_use text CHECK (purchase_use IN ('personal','business')),
  ADD COLUMN merchant_mode text CHECK (merchant_mode IN ('direct','managed')),
  ADD COLUMN tax_mode text CHECK (tax_mode IN ('automatic','not_collecting')),
  ADD COLUMN return_origin text,
  ADD COLUMN customer_id text,
  ADD COLUMN project_id text;
ALTER TABLE plan_changes
  ADD COLUMN request_version integer CHECK (request_version > 0),
  ADD COLUMN price_id text,
  ADD COLUMN purchase_use text CHECK (purchase_use IN ('personal','business'));
ALTER TABLE paid_periods
  ADD COLUMN purchase_use text CHECK (purchase_use IN ('personal','business'));
