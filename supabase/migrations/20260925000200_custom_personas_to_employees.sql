-- Custom personas become customer AI Employees.
--
-- A custom persona was a workspace-defined agent with a name, a focus and a
-- read-only tool list. An AI Employee is the same thing with a lifecycle,
-- scopes, an owner of work and a history, so the two were parallel concepts for
-- one idea. From here on there is one: Your employees.
--
-- Preserved, in order of what would break if it were not:
--
--   - the id. Each employee takes its persona's id, so deep links
--     (`?view=agents&agent=<id>`), saved appearance, the workspace default
--     agent, draft ownership (`draft_documents.persona_id`) and PMS deployments
--     (`agent_deployments.persona_id`) all keep resolving without a rewrite;
--   - the name, and the focus as both objective and standing instructions;
--   - the authority. A custom persona could only read (the `custom` envelope),
--     and a null tool list meant every read. Its tools become capability grants,
--     reads only, so the employee can do exactly what the persona could;
--   - the history. Every task the persona ran is now owned by the employee.
--     `agent_tasks.agent_id` is left as it was recorded — attribution in the
--     audit trail is never rewritten — and `employee_id` is added beside it.
--
-- `agent_personas` itself is kept, unread and unwritten by the application, so
-- nothing is destroyed by this migration.

-- One name per workspace is enforced on employees. A persona whose label is
-- already taken — by an employee, or by an earlier persona with the same
-- label — keeps its label with a short, stable suffix rather than failing.
WITH source AS (
  SELECT p.*,
         row_number() OVER (PARTITION BY p.organization_id, p.label ORDER BY p.created_at, p.id) AS duplicate_rank
  FROM public.agent_personas AS p
  WHERE NOT EXISTS (SELECT 1 FROM public.ai_employees AS e WHERE e.id = p.id)
)
INSERT INTO public.ai_employees (
  id, organization_id, name, role, description, objective, instructions,
  status, autonomy_mode, approval_policy, risk_ceiling, memory_scope,
  may_communicate_externally, may_delegate, created_by, created_at, updated_at
)
SELECT
  s.id,
  s.organization_id,
  CASE
    WHEN s.duplicate_rank > 1
      OR EXISTS (SELECT 1 FROM public.ai_employees AS e WHERE e.organization_id = s.organization_id AND e.name = s.label)
    THEN s.label || ' (' || left(s.id, 6) || ')'
    ELSE s.label
  END,
  'Custom agent',
  'Created as a custom agent before custom agents became employees.',
  s.focus_description,
  s.focus_description,
  'active', 'supervised', 'standard', 'low', 'work',
  false, false,
  s.created_by, s.created_at, now()
FROM source AS s
ON CONFLICT (id) DO NOTHING;

-- Every read a custom persona could ever reach. Literal on purpose: this is
-- what the persona envelope allowed at the moment of migration.
WITH readable(tool) AS (VALUES ('get_portfolio_metrics'), ('get_metric_series'), ('get_accounting_breakdown'), ('get_operating_statement'), ('get_delinquent_accounts'), ('get_property_breakdown'), ('get_leasing_funnel'), ('get_leasing_velocity'), ('get_maintenance_performance'), ('get_operations_insights'), ('get_data_conflicts'), ('list_documents'), ('read_document'))
INSERT INTO public.ai_employee_scopes (id, organization_id, employee_id, scope_kind, value, granted_by, created_at)
SELECT
  md5(p.id || ':capability:' || tool.name),
  p.organization_id, p.id, 'capability', tool.name, p.created_by, now()
FROM public.agent_personas AS p
CROSS JOIN LATERAL (
  SELECT value AS name
  FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(p.tool_names_json) = 'array' THEN p.tool_names_json
         ELSE (SELECT jsonb_agg(tool) FROM readable) END
  )
) AS tool
WHERE tool.name IN (SELECT tool FROM readable)
  AND EXISTS (SELECT 1 FROM public.ai_employees AS e WHERE e.id = p.id)
ON CONFLICT (employee_id, scope_kind, value) DO NOTHING;

UPDATE public.agent_tasks AS task
SET employee_id = task.agent_id
FROM public.agent_personas AS p
WHERE p.id = task.agent_id
  AND p.organization_id = task.organization_id
  AND task.employee_id IS NULL;

COMMENT ON TABLE public.agent_personas IS
  'Deprecated 2026-09-25: every row was migrated to ai_employees under the same id (migration 20260925000200). Retained for history; the application neither reads nor writes it.';
