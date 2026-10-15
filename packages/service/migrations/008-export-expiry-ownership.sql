-- The API queues/signs exports; only the recovery identity deletes storage objects.
-- Retain an expired object's pointer until that job removes it, while allowing a new export.
ALTER TABLE account_exports DROP CONSTRAINT account_exports_account_id_key;
CREATE UNIQUE INDEX account_exports_current_owner ON account_exports(account_id) WHERE state<>'expired';
