-- Coordinate audit heads and rolling financial caps without granting members
-- permission to update organization settings. Row locks work through Hyperdrive.
CREATE OR REPLACE FUNCTION aval_private.lock_organization(target_org text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF target_org IS NULL
     OR target_org IS DISTINCT FROM aval_private.current_organization_id()
     OR NOT (aval_private.has_org_access(target_org)
             OR current_setting('role', true) = 'aval_worker') THEN
    RAISE EXCEPTION 'organization lock denied' USING ERRCODE = '42501';
  END IF;
  PERFORM id FROM public.organizations WHERE id = target_org FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization lock denied' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION aval_private.lock_organization(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aval_private.lock_organization(text) TO aval_app, aval_worker;
-- Worker RLS policies call this helper; table grants alone are insufficient.
GRANT EXECUTE ON FUNCTION aval_private.current_organization_id() TO aval_worker;

-- Read-only users and approvers still produce audit events when using Aval.
-- This permits evidence append, not modification of business records.
DROP POLICY IF EXISTS answer_audit_log_insert ON public.answer_audit_log;
CREATE POLICY answer_audit_log_insert ON public.answer_audit_log FOR INSERT TO aval_app
  WITH CHECK (aval_private.has_org_access(organization_id));
REVOKE UPDATE, DELETE ON public.answer_audit_log FROM aval_app, aval_worker;
