-- Where an external effect actually landed.
--
-- Verification re-reads the record a write created, which means it needs the
-- provider and the provider's own id for that record. Neither was stored
-- anywhere durable: the id came back in the tool result, went into the
-- transcript, and was never written to a column. The consequence was that the
-- (provider, tool) verifier registry could not be reached from a real run —
-- there was nothing to tell it which record to look up.
--
-- The reservation row is written before the provider is called, so it cannot
-- know these at insert time. They are filled in against the same idempotency
-- key once the provider has accepted the write.

ALTER TABLE public.agent_task_steps ADD COLUMN IF NOT EXISTS source_provider text;
ALTER TABLE public.agent_task_steps ADD COLUMN IF NOT EXISTS external_record_id text;

-- Verification sweeps look up the unproven executions of one task, so the
-- partial index only carries rows that actually name an external record.
CREATE INDEX IF NOT EXISTS agent_task_steps_external_record_idx
  ON public.agent_task_steps (organization_id, task_id, external_record_id)
  WHERE external_record_id IS NOT NULL;
