REVOKE cloudsqlsuperuser FROM femlab_api, femlab_jobs;
GRANT CONNECT ON DATABASE femlab TO femlab_api, femlab_jobs;
GRANT USAGE ON SCHEMA public TO femlab_api, femlab_jobs;
GRANT SELECT ON service_migrations, ai_limits TO femlab_api, femlab_jobs;
GRANT SELECT, INSERT ON credit_grants, credit_entries, credit_holds, usage_receipts, paid_periods TO femlab_api, femlab_jobs;
GRANT SELECT, INSERT, UPDATE ON accounts, ai_requests, billing_accounts, billing_inbox, billing_leases, billing_reviews, checkout_intents, plan_changes, account_exports, account_deletions TO femlab_api, femlab_jobs;
GRANT DELETE ON billing_leases, checkout_intents, plan_changes TO femlab_api, femlab_jobs;
GRANT DELETE ON account_exports TO femlab_jobs;
