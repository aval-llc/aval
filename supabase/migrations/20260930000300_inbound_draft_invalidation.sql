CREATE FUNCTION aval_private.invalidate_inbound_draft() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.direction='inbound' THEN
    -- All ingestion paths serialize against approval execution on this row.
    UPDATE public.conversations SET draft_reply=NULL, draft_reply_status=NULL, updated_at=now()
      WHERE id=NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_inbound_draft AFTER INSERT OR UPDATE OF body,payload_json,direction ON public.messages
FOR EACH ROW EXECUTE FUNCTION aval_private.invalidate_inbound_draft();

CREATE FUNCTION aval_private.fence_maintenance_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('aval:maintenance-policy:' || coalesce(NEW.organization_id, OLD.organization_id),0));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fence_maintenance_policy BEFORE INSERT OR UPDATE OR DELETE ON public.communication_settings
FOR EACH ROW EXECUTE FUNCTION aval_private.fence_maintenance_policy();
