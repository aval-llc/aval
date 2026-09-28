-- No historical backfill: a current row cannot prove what existed at execution time.
ALTER TABLE public.agent_task_steps ADD COLUMN execution_receipt_json jsonb;

CREATE FUNCTION aval_private.preserve_execution_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.execution_receipt_json IS NOT NULL AND
    (NEW.execution_receipt_json IS DISTINCT FROM OLD.execution_receipt_json OR
     NEW.task_id IS DISTINCT FROM OLD.task_id OR
     NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
     NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key) THEN
    RAISE EXCEPTION 'Execution receipts cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_execution_receipt BEFORE UPDATE ON public.agent_task_steps
FOR EACH ROW EXECUTE FUNCTION aval_private.preserve_execution_receipt();
