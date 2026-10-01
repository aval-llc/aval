-- Additive control; existing owner-only organizations UPDATE policy applies.
ALTER TABLE public.organizations ADD COLUMN agents_paused boolean NOT NULL DEFAULT false;

-- Direct operational updates use the same fence as the owner endpoint.
CREATE FUNCTION aval_private.fence_agent_pause() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.agents_paused IS DISTINCT FROM OLD.agents_paused THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('aval:pause:' || NEW.id, 0));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fence_agent_pause BEFORE UPDATE OF agents_paused ON public.organizations
FOR EACH ROW EXECUTE FUNCTION aval_private.fence_agent_pause();
