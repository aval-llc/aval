-- Shared Work identity, and a closed set of task states.
--
-- A piece of Work is now a tree: Aval One (or the customer employee that owns
-- it) at the root, Leads and Specialists beneath, and bounded peer requests
-- beneath those. Until now the only way to ask "which tasks belong to this
-- Work" was to walk `parent_task_id` upward from every row. That walk is what
-- delegation limits, duplicate detection and wake-ups all need, so the answer
-- is stored: `work_id` is the id of the root task, inherited by every task
-- created under it.
--
-- Nullable because rows are created with it set by the application; the
-- backfill below gives every existing row its root. No foreign key, for the
-- same reason `parent_task_id` has none: a root is never deleted, and a key
-- would only add a lock to every insert.

ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS work_id text;

-- Every existing task inherits the id of the root of its chain. Bounded at 16
-- generations, matching the ancestry walk in lib/agents/delegation.ts, so a
-- corrupted chain ends the recursion rather than the migration.
WITH RECURSIVE chain AS (
  SELECT id, id AS root_id, 0 AS generation
  FROM public.agent_tasks
  WHERE parent_task_id IS NULL
  UNION ALL
  SELECT child.id, chain.root_id, chain.generation + 1
  FROM public.agent_tasks AS child
  JOIN chain ON child.parent_task_id = chain.id
  WHERE chain.generation < 16
)
UPDATE public.agent_tasks AS task
SET work_id = chain.root_id
FROM chain
WHERE task.id = chain.id AND task.work_id IS NULL;

-- Anything the walk could not reach is its own Work rather than nobody's.
UPDATE public.agent_tasks SET work_id = id WHERE work_id IS NULL;

CREATE INDEX IF NOT EXISTS agent_tasks_work_idx
  ON public.agent_tasks (organization_id, work_id, status);

-- The task states, closed. `lib/agents/task-state.ts` has always rejected an
-- illegal transition in code; nothing stopped a direct write from storing a
-- status no worker understands, which is a task that silently never runs.
--
-- NOT VALID: the constraint governs every insert and update from here on. It
-- is not asserted over historical rows, so a deployment never fails on a row
-- written by an older build — and every state such a build could write is in
-- this list anyway.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_tasks_status_check' AND conrelid = 'public.agent_tasks'::regclass
  ) THEN
    ALTER TABLE public.agent_tasks ADD CONSTRAINT agent_tasks_status_check CHECK (status IN (
      'QUEUED', 'RUNNING',
      'WAITING_FOR_TOOL', 'WAITING_FOR_APPROVAL', 'PENDING_VERIFICATION', 'WAITING_FOR_HUMAN',
      'WAITING_FOR_PROVIDER', 'WAITING_FOR_RESIDENT', 'WAITING_FOR_OWNER', 'WAITING_FOR_VENDOR',
      'WAITING_FOR_APPLICANT', 'WAITING_FOR_DOCUMENT', 'WAITING_FOR_AGENT',
      'SCHEDULED', 'BLOCKED',
      'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'
    )) NOT VALID;
  END IF;
END $$;
