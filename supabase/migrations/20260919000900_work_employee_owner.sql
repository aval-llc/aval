-- Who owns a piece of work.
--
-- `agent_tasks.agent_id` holds a built-in PersonaId or an `agent_personas` row,
-- and resolves anything it does not recognise to a read-only envelope. That was
-- a reasonable fail-narrow default while the roster was fixed in source; it is
-- not an owner. An employee is a record with a lifecycle, scopes and a history,
-- and Work has to point at one.
--
-- Nullable during the migration: the built-in specialists are still addressed
-- by `agent_id`, and work created before employees existed has no owner to
-- name. Once every persona resolves to an employee record, this column becomes
-- the only answer to "who is doing this" and `agent_id` becomes history.
--
-- No foreign key, matching the deliberate choice on `agent_deployments.persona_id`:
-- the column has to be able to hold an owner whose row may be archived, and
-- archiving must never be blocked by work that already refers to it.

ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS employee_id text;

-- Listing the open work an employee owns is the question the directory, the
-- archive guard and reassignment all ask, so it is worth an index. Partial,
-- because rows without an owner are never the answer to it.
CREATE INDEX IF NOT EXISTS agent_tasks_employee_idx
  ON public.agent_tasks (organization_id, employee_id, status)
  WHERE employee_id IS NOT NULL;
