-- READ ONLY. Counts are sensitive operational metadata; store results privately.

SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;

SELECT 'access_grants' AS table_name, count(*) AS row_count FROM "access_grants"
UNION ALL
SELECT 'action_evidence' AS table_name, count(*) AS row_count FROM "action_evidence"
UNION ALL
SELECT 'agent_approval_decisions' AS table_name, count(*) AS row_count FROM "agent_approval_decisions"
UNION ALL
SELECT 'agent_approvals' AS table_name, count(*) AS row_count FROM "agent_approvals"
UNION ALL
SELECT 'agent_checks' AS table_name, count(*) AS row_count FROM "agent_checks"
UNION ALL
SELECT 'agent_deployments' AS table_name, count(*) AS row_count FROM "agent_deployments"
UNION ALL
SELECT 'agent_execution_policies' AS table_name, count(*) AS row_count FROM "agent_execution_policies"
UNION ALL
SELECT 'agent_financial_events' AS table_name, count(*) AS row_count FROM "agent_financial_events"
UNION ALL
SELECT 'agent_financial_operations' AS table_name, count(*) AS row_count FROM "agent_financial_operations"
UNION ALL
SELECT 'agent_memory' AS table_name, count(*) AS row_count FROM "agent_memory"
UNION ALL
SELECT 'agent_model_contexts' AS table_name, count(*) AS row_count FROM "agent_model_contexts"
UNION ALL
SELECT 'agent_personas' AS table_name, count(*) AS row_count FROM "agent_personas"
UNION ALL
SELECT 'agent_plan_nodes' AS table_name, count(*) AS row_count FROM "agent_plan_nodes"
UNION ALL
SELECT 'agent_task_steps' AS table_name, count(*) AS row_count FROM "agent_task_steps"
UNION ALL
SELECT 'agent_tasks' AS table_name, count(*) AS row_count FROM "agent_tasks"
UNION ALL
SELECT 'agent_worker_runs' AS table_name, count(*) AS row_count FROM "agent_worker_runs"
UNION ALL
SELECT 'ai_employee_scopes' AS table_name, count(*) AS row_count FROM "ai_employee_scopes"
UNION ALL
SELECT 'ai_employees' AS table_name, count(*) AS row_count FROM "ai_employees"
UNION ALL
SELECT 'ai_usage' AS table_name, count(*) AS row_count FROM "ai_usage"
UNION ALL
SELECT 'answer_audit_log' AS table_name, count(*) AS row_count FROM "answer_audit_log"
UNION ALL
SELECT 'approval_authorities' AS table_name, count(*) AS row_count FROM "approval_authorities"
UNION ALL
SELECT 'attempt_policies' AS table_name, count(*) AS row_count FROM "attempt_policies"
UNION ALL
SELECT 'automation_runs' AS table_name, count(*) AS row_count FROM "automation_runs"
UNION ALL
SELECT 'automation_steps' AS table_name, count(*) AS row_count FROM "automation_steps"
UNION ALL
SELECT 'communication_deliveries' AS table_name, count(*) AS row_count FROM "communication_deliveries"
UNION ALL
SELECT 'communication_poll_sources' AS table_name, count(*) AS row_count FROM "communication_poll_sources"
UNION ALL
SELECT 'communication_settings' AS table_name, count(*) AS row_count FROM "communication_settings"
UNION ALL
SELECT 'conversations' AS table_name, count(*) AS row_count FROM "conversations"
UNION ALL
SELECT 'documents' AS table_name, count(*) AS row_count FROM "documents"
UNION ALL
SELECT 'draft_documents' AS table_name, count(*) AS row_count FROM "draft_documents"
UNION ALL
SELECT 'employee_expertise' AS table_name, count(*) AS row_count FROM "employee_expertise"
UNION ALL
SELECT 'expertise_profiles' AS table_name, count(*) AS row_count FROM "expertise_profiles"
UNION ALL
SELECT 'expertise_selections' AS table_name, count(*) AS row_count FROM "expertise_selections"
UNION ALL
SELECT 'funnel_snapshots' AS table_name, count(*) AS row_count FROM "funnel_snapshots"
UNION ALL
SELECT 'gl_accounts' AS table_name, count(*) AS row_count FROM "gl_accounts"
UNION ALL
SELECT 'gl_transactions' AS table_name, count(*) AS row_count FROM "gl_transactions"
UNION ALL
SELECT 'identity_links' AS table_name, count(*) AS row_count FROM "identity_links"
UNION ALL
SELECT 'insight_decisions' AS table_name, count(*) AS row_count FROM "insight_decisions"
UNION ALL
SELECT 'integration_connections' AS table_name, count(*) AS row_count FROM "integration_connections"
UNION ALL
SELECT 'integration_events' AS table_name, count(*) AS row_count FROM "integration_events"
UNION ALL
SELECT 'integration_sync_state' AS table_name, count(*) AS row_count FROM "integration_sync_state"
UNION ALL
SELECT 'learned_preferences' AS table_name, count(*) AS row_count FROM "learned_preferences"
UNION ALL
SELECT 'lease_residents' AS table_name, count(*) AS row_count FROM "lease_residents"
UNION ALL
SELECT 'leases' AS table_name, count(*) AS row_count FROM "leases"
UNION ALL
SELECT 'leasing_leads' AS table_name, count(*) AS row_count FROM "leasing_leads"
UNION ALL
SELECT 'ledger_entries' AS table_name, count(*) AS row_count FROM "ledger_entries"
UNION ALL
SELECT 'messages' AS table_name, count(*) AS row_count FROM "messages"
UNION ALL
SELECT 'oauth_states' AS table_name, count(*) AS row_count FROM "oauth_states"
UNION ALL
SELECT 'operational_facts' AS table_name, count(*) AS row_count FROM "operational_facts"
UNION ALL
SELECT 'operations_conflicts' AS table_name, count(*) AS row_count FROM "operations_conflicts"
UNION ALL
SELECT 'organization_invitations' AS table_name, count(*) AS row_count FROM "organization_invitations"
UNION ALL
SELECT 'organization_members' AS table_name, count(*) AS row_count FROM "organization_members"
UNION ALL
SELECT 'organization_seat_slugs' AS table_name, count(*) AS row_count FROM "organization_seat_slugs"
UNION ALL
SELECT 'organizations' AS table_name, count(*) AS row_count FROM "organizations"
UNION ALL
SELECT 'ownership_entities' AS table_name, count(*) AS row_count FROM "ownership_entities"
UNION ALL
SELECT 'planning_items' AS table_name, count(*) AS row_count FROM "planning_items"
UNION ALL
SELECT 'planning_projects' AS table_name, count(*) AS row_count FROM "planning_projects"
UNION ALL
SELECT 'pms_action_flows' AS table_name, count(*) AS row_count FROM "pms_action_flows"
UNION ALL
SELECT 'pms_seat_messages' AS table_name, count(*) AS row_count FROM "pms_seat_messages"
UNION ALL
SELECT 'pms_seat_sender_addresses' AS table_name, count(*) AS row_count FROM "pms_seat_sender_addresses"
UNION ALL
SELECT 'pms_seat_senders' AS table_name, count(*) AS row_count FROM "pms_seat_senders"
UNION ALL
SELECT 'pms_write_authorizations' AS table_name, count(*) AS row_count FROM "pms_write_authorizations"
UNION ALL
SELECT 'pms_write_queue' AS table_name, count(*) AS row_count FROM "pms_write_queue"
UNION ALL
SELECT 'portfolio_snapshots' AS table_name, count(*) AS row_count FROM "portfolio_snapshots"
UNION ALL
SELECT 'portfolios' AS table_name, count(*) AS row_count FROM "portfolios"
UNION ALL
SELECT 'principals' AS table_name, count(*) AS row_count FROM "principals"
UNION ALL
SELECT 'properties' AS table_name, count(*) AS row_count FROM "properties"
UNION ALL
SELECT 'rate_limit_hits' AS table_name, count(*) AS row_count FROM "rate_limit_hits"
UNION ALL
SELECT 'regions' AS table_name, count(*) AS row_count FROM "regions"
UNION ALL
SELECT 'residents' AS table_name, count(*) AS row_count FROM "residents"
UNION ALL
SELECT 'sso_connections' AS table_name, count(*) AS row_count FROM "sso_connections"
UNION ALL
SELECT 'subscriptions' AS table_name, count(*) AS row_count FROM "subscriptions"
UNION ALL
SELECT 'sync_runs' AS table_name, count(*) AS row_count FROM "sync_runs"
UNION ALL
SELECT 'token_top_ups' AS table_name, count(*) AS row_count FROM "token_top_ups"
UNION ALL
SELECT 'units' AS table_name, count(*) AS row_count FROM "units"
UNION ALL
SELECT 'user_appearance' AS table_name, count(*) AS row_count FROM "user_appearance"
UNION ALL
SELECT 'user_onboarding' AS table_name, count(*) AS row_count FROM "user_onboarding"
UNION ALL
SELECT 'users' AS table_name, count(*) AS row_count FROM "users"
UNION ALL
SELECT 'utility_bills' AS table_name, count(*) AS row_count FROM "utility_bills"
UNION ALL
SELECT 'utility_meters' AS table_name, count(*) AS row_count FROM "utility_meters"
UNION ALL
SELECT 'vendors' AS table_name, count(*) AS row_count FROM "vendors"
UNION ALL
SELECT 'work_attempts' AS table_name, count(*) AS row_count FROM "work_attempts"
UNION ALL
SELECT 'work_orders' AS table_name, count(*) AS row_count FROM "work_orders"
UNION ALL
SELECT 'workspace_usage' AS table_name, count(*) AS row_count FROM "workspace_usage";

PRAGMA page_count;

PRAGMA page_size;

PRAGMA foreign_key_check;

PRAGMA quick_check;

SELECT 'agent_approvals' AS table_name, status, count(*) AS row_count FROM "agent_approvals" GROUP BY status;

SELECT 'agent_approvals' AS table_name, 'amount_cents' AS column_name, CAST(sum("amount_cents") AS TEXT) AS total FROM "agent_approvals";

SELECT 'agent_deployments' AS table_name, status, count(*) AS row_count FROM "agent_deployments" GROUP BY status;

SELECT 'agent_execution_policies' AS table_name, status, count(*) AS row_count FROM "agent_execution_policies" GROUP BY status;

SELECT 'agent_execution_policies' AS table_name, 'single_approval_max_cents' AS column_name, CAST(sum("single_approval_max_cents") AS TEXT) AS total FROM "agent_execution_policies";

SELECT 'agent_execution_policies' AS table_name, 'hard_ceiling_cents' AS column_name, CAST(sum("hard_ceiling_cents") AS TEXT) AS total FROM "agent_execution_policies";

SELECT 'agent_execution_policies' AS table_name, 'daily_limit_cents' AS column_name, CAST(sum("daily_limit_cents") AS TEXT) AS total FROM "agent_execution_policies";

SELECT 'agent_financial_operations' AS table_name, status, count(*) AS row_count FROM "agent_financial_operations" GROUP BY status;

SELECT 'agent_financial_operations' AS table_name, 'amount_cents' AS column_name, CAST(sum("amount_cents") AS TEXT) AS total FROM "agent_financial_operations";

SELECT 'agent_tasks' AS table_name, status, count(*) AS row_count FROM "agent_tasks" GROUP BY status;

SELECT 'agent_tasks' AS table_name, 'max_tokens' AS column_name, CAST(sum("max_tokens") AS TEXT) AS total FROM "agent_tasks";

SELECT 'agent_worker_runs' AS table_name, status, count(*) AS row_count FROM "agent_worker_runs" GROUP BY status;

SELECT 'ai_employees' AS table_name, status, count(*) AS row_count FROM "ai_employees" GROUP BY status;

SELECT 'ai_employees' AS table_name, 'spend_limit_cents' AS column_name, CAST(sum("spend_limit_cents") AS TEXT) AS total FROM "ai_employees";

SELECT 'ai_usage' AS table_name, 'input_tokens' AS column_name, CAST(sum("input_tokens") AS TEXT) AS total FROM "ai_usage";

SELECT 'ai_usage' AS table_name, 'output_tokens' AS column_name, CAST(sum("output_tokens") AS TEXT) AS total FROM "ai_usage";

SELECT 'approval_authorities' AS table_name, 'maximum_amount_cents' AS column_name, CAST(sum("maximum_amount_cents") AS TEXT) AS total FROM "approval_authorities";

SELECT 'automation_runs' AS table_name, status, count(*) AS row_count FROM "automation_runs" GROUP BY status;

SELECT 'communication_deliveries' AS table_name, status, count(*) AS row_count FROM "communication_deliveries" GROUP BY status;

SELECT 'conversations' AS table_name, status, count(*) AS row_count FROM "conversations" GROUP BY status;

SELECT 'draft_documents' AS table_name, status, count(*) AS row_count FROM "draft_documents" GROUP BY status;

SELECT 'gl_transactions' AS table_name, 'amount_cents' AS column_name, CAST(sum("amount_cents") AS TEXT) AS total FROM "gl_transactions";

SELECT 'integration_connections' AS table_name, status, count(*) AS row_count FROM "integration_connections" GROUP BY status;

SELECT 'integration_events' AS table_name, status, count(*) AS row_count FROM "integration_events" GROUP BY status;

SELECT 'leases' AS table_name, status, count(*) AS row_count FROM "leases" GROUP BY status;

SELECT 'leases' AS table_name, 'rent_cents' AS column_name, CAST(sum("rent_cents") AS TEXT) AS total FROM "leases";

SELECT 'leases' AS table_name, 'deposit_cents' AS column_name, CAST(sum("deposit_cents") AS TEXT) AS total FROM "leases";

SELECT 'ledger_entries' AS table_name, 'amount_cents' AS column_name, CAST(sum("amount_cents") AS TEXT) AS total FROM "ledger_entries";

SELECT 'operations_conflicts' AS table_name, status, count(*) AS row_count FROM "operations_conflicts" GROUP BY status;

SELECT 'ownership_entities' AS table_name, status, count(*) AS row_count FROM "ownership_entities" GROUP BY status;

SELECT 'planning_items' AS table_name, status, count(*) AS row_count FROM "planning_items" GROUP BY status;

SELECT 'pms_action_flows' AS table_name, status, count(*) AS row_count FROM "pms_action_flows" GROUP BY status;

SELECT 'pms_write_authorizations' AS table_name, status, count(*) AS row_count FROM "pms_write_authorizations" GROUP BY status;

SELECT 'pms_write_queue' AS table_name, status, count(*) AS row_count FROM "pms_write_queue" GROUP BY status;

SELECT 'portfolios' AS table_name, status, count(*) AS row_count FROM "portfolios" GROUP BY status;

SELECT 'principals' AS table_name, status, count(*) AS row_count FROM "principals" GROUP BY status;

SELECT 'properties' AS table_name, status, count(*) AS row_count FROM "properties" GROUP BY status;

SELECT 'properties' AS table_name, 'acquisition_cost_cents' AS column_name, CAST(sum("acquisition_cost_cents") AS TEXT) AS total FROM "properties";

SELECT 'properties' AS table_name, 'current_value_cents' AS column_name, CAST(sum("current_value_cents") AS TEXT) AS total FROM "properties";

SELECT 'regions' AS table_name, status, count(*) AS row_count FROM "regions" GROUP BY status;

SELECT 'residents' AS table_name, status, count(*) AS row_count FROM "residents" GROUP BY status;

SELECT 'subscriptions' AS table_name, status, count(*) AS row_count FROM "subscriptions" GROUP BY status;

SELECT 'sync_runs' AS table_name, status, count(*) AS row_count FROM "sync_runs" GROUP BY status;

SELECT 'units' AS table_name, status, count(*) AS row_count FROM "units" GROUP BY status;

SELECT 'units' AS table_name, 'market_rent_cents' AS column_name, CAST(sum("market_rent_cents") AS TEXT) AS total FROM "units";

SELECT 'utility_bills' AS table_name, 'cost_cents' AS column_name, CAST(sum("cost_cents") AS TEXT) AS total FROM "utility_bills";

SELECT 'work_attempts' AS table_name, 'cost_cents' AS column_name, CAST(sum("cost_cents") AS TEXT) AS total FROM "work_attempts";

SELECT 'work_orders' AS table_name, status, count(*) AS row_count FROM "work_orders" GROUP BY status;

SELECT 'work_orders' AS table_name, 'estimate_cents' AS column_name, CAST(sum("estimate_cents") AS TEXT) AS total FROM "work_orders";

SELECT 'work_orders' AS table_name, 'actual_cost_cents' AS column_name, CAST(sum("actual_cost_cents") AS TEXT) AS total FROM "work_orders";

SELECT organization_id, max(sequence) AS head_sequence FROM answer_audit_log GROUP BY organization_id;

SELECT a.organization_id, a.sequence, a.entry_hash FROM answer_audit_log a WHERE a.sequence = (SELECT max(b.sequence) FROM answer_audit_log b WHERE b.organization_id = a.organization_id);
