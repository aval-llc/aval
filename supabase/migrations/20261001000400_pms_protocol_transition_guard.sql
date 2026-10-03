-- A rollback to a pre-v2 application must not make its old queue drain able to
-- claim v2 work. Durable effects and their approvals are immutable artifacts.
ALTER TABLE public.pms_write_queue ADD CONSTRAINT pms_protocol_states CHECK (
  protocol_json IS NULL OR status IN ('pending','leased','submission_unknown','verifying','confirmed','needs_review')
);
CREATE OR REPLACE FUNCTION aval_private.preserve_pms_submission() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  IF OLD.protocol_json IS NOT NULL AND (
    NEW.protocol_json IS DISTINCT FROM OLD.protocol_json OR
    NEW.payload_json IS DISTINCT FROM OLD.payload_json OR
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.connection_id IS DISTINCT FROM OLD.connection_id OR
    NEW.approval_id IS DISTINCT FROM OLD.approval_id OR
    NEW.flow_id IS DISTINCT FROM OLD.flow_id OR
    NEW.provider IS DISTINCT FROM OLD.provider OR
    NEW.action IS DISTINCT FROM OLD.action OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  ) THEN RAISE EXCEPTION 'An approved PMS artifact is immutable'; END IF;
  IF OLD.protocol_json IS NOT NULL AND NEW.status IN ('leased','verifying') AND (
    NEW.status IS DISTINCT FROM OLD.status OR NEW.leased_by IS DISTINCT FROM OLD.leased_by OR
    NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
  ) AND NEW.lease_generation <> OLD.lease_generation+1 THEN
    RAISE EXCEPTION 'PMS claims require a new protocol lease generation';
  END IF;
  IF OLD.submitted_at IS NOT NULL AND
    (NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.status IN ('pending','leased')) THEN
    RAISE EXCEPTION 'A possible PMS submission may only be reconciled';
  END IF;
  RETURN NEW;
END $$;
