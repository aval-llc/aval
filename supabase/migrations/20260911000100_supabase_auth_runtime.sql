-- Supabase Auth cutover and policies for tables whose tenant is inherited
-- through a parent row. The project is intentionally empty at cutover, so
-- legacy password material is removed instead of copied.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.users DROP COLUMN IF EXISTS password_hash;

INSERT INTO public.principals (id, kind, display_name, primary_email, status, created_at, updated_at)
VALUES
  ('principal_aval_auth', 'service', 'Aval authentication service', NULL, 'active', statement_timestamp(), statement_timestamp()),
  ('principal_aval_worker', 'service', 'Aval background worker', NULL, 'active', statement_timestamp(), statement_timestamp())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, name, owner_user_id, active_model_provider, default_persona_id, created_at, updated_at)
VALUES ('org_system', 'Aval system', 'principal_aval_auth', NULL, NULL, statement_timestamp(), statement_timestamp())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.access_grants (
  id, organization_id, principal_id, role, organization_scope,
  capabilities_json, created_by_principal_id, created_at, updated_at
)
VALUES
  ('grant_aval_auth_system', 'org_system', 'principal_aval_auth', 'org_admin', true, '[]'::jsonb, 'principal_aval_auth', statement_timestamp(), statement_timestamp()),
  ('grant_aval_worker_system', 'org_system', 'principal_aval_worker', 'operator', true, '[]'::jsonb, 'principal_aval_auth', statement_timestamp(), statement_timestamp())
ON CONFLICT (organization_id, id) DO NOTHING;

ALTER TABLE public.rate_limit_hits ADD COLUMN IF NOT EXISTS organization_id text;
UPDATE public.rate_limit_hits SET organization_id = 'org_system' WHERE organization_id IS NULL;
ALTER TABLE public.rate_limit_hits ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE public.rate_limit_hits
  ADD CONSTRAINT rate_limit_hits_organization_fk
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
CREATE INDEX IF NOT EXISTS rate_limit_hits_org_scope_created_idx
  ON public.rate_limit_hits (organization_id, scope_key, created_at);

ALTER TABLE public.agent_worker_runs ADD COLUMN IF NOT EXISTS organization_id text;
UPDATE public.agent_worker_runs SET organization_id = 'org_system' WHERE organization_id IS NULL;
ALTER TABLE public.agent_worker_runs ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE public.agent_worker_runs
  ADD CONSTRAINT agent_worker_runs_organization_fk
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
CREATE INDEX IF NOT EXISTS agent_worker_runs_org_started_idx
  ON public.agent_worker_runs (organization_id, started_at);

CREATE OR REPLACE FUNCTION aval_private.principal_has_access(target_org text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.access_grants grant_row
    JOIN public.principals principal
      ON principal.id = grant_row.principal_id AND principal.status = 'active'
    WHERE grant_row.organization_id = target_org
      AND grant_row.principal_id = aval_private.current_principal_id()
      AND grant_row.revoked_at IS NULL
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > statement_timestamp())
  )
$$;

CREATE OR REPLACE FUNCTION aval_private.can_view_user(target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT target_user = aval_private.current_principal_id()
    OR EXISTS (
      SELECT 1
      FROM public.organization_members member
      WHERE member.organization_id = aval_private.current_organization_id()
        AND member.user_id = target_user
        AND aval_private.has_org_access(member.organization_id)
    )
$$;

CREATE OR REPLACE FUNCTION aval_private.can_access_conversation(target_conversation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations conversation
    WHERE conversation.id = target_conversation
      AND aval_private.has_org_access(conversation.organization_id)
  )
$$;

CREATE OR REPLACE FUNCTION aval_private.can_access_automation_run(target_run text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.automation_runs run
    WHERE run.id = target_run
      AND aval_private.has_org_access(run.organization_id)
  )
$$;

-- The Worker validates the Supabase access token before opening this
-- transaction. This function creates only that exact subject and computes no
-- authority from email, preventing accidental identity merging.
CREATE OR REPLACE FUNCTION aval_private.bootstrap_supabase_identity(
  subject text,
  email text,
  display_name text,
  email_verified boolean,
  personal_organization text,
  requested_organization text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  selected_organization text;
  linked_principal text;
BEGIN
  IF subject IS NULL OR subject = '' OR length(subject) > 256
     OR subject <> aval_private.current_principal_id() THEN
    RAISE EXCEPTION 'invalid authenticated subject' USING ERRCODE = '22023';
  END IF;
  IF NOT email_verified OR email IS NULL OR email = '' OR length(email) > 320 THEN
    RAISE EXCEPTION 'verified email required' USING ERRCODE = '28000';
  END IF;
  IF personal_organization !~ '^org_[0-9a-f]{24}$' THEN
    RAISE EXCEPTION 'invalid personal organization' USING ERRCODE = '22023';
  END IF;

  SELECT link.principal_id INTO linked_principal
  FROM public.identity_links link
  WHERE link.provider = 'supabase' AND link.subject = bootstrap_supabase_identity.subject;
  IF linked_principal IS NOT NULL AND linked_principal <> subject THEN
    RAISE EXCEPTION 'identity is already linked to another principal' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.principals (id, kind, display_name, primary_email, status, created_at, updated_at)
  VALUES (subject, 'human', left(coalesce(nullif(display_name, ''), email), 160), email, 'active', statement_timestamp(), statement_timestamp())
  ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    primary_email = EXCLUDED.primary_email,
    updated_at = statement_timestamp();

  INSERT INTO public.identity_links (id, principal_id, provider, subject, email_at_link, email_verified, created_at, last_seen_at)
  VALUES ('identity_supabase_' || subject, subject, 'supabase', subject, email, true, statement_timestamp(), statement_timestamp())
  ON CONFLICT (provider, subject) DO UPDATE SET
    email_at_link = EXCLUDED.email_at_link,
    email_verified = true,
    last_seen_at = statement_timestamp();

  SELECT link.principal_id INTO linked_principal
  FROM public.identity_links link
  WHERE link.provider = 'supabase' AND link.subject = bootstrap_supabase_identity.subject;
  IF linked_principal IS DISTINCT FROM subject THEN
    RAISE EXCEPTION 'identity is already linked to another principal' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.users (id, email, display_name, created_at, updated_at)
  VALUES (subject, email, left(coalesce(nullif(display_name, ''), email), 160), statement_timestamp(), statement_timestamp())
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    updated_at = statement_timestamp();

  INSERT INTO public.organizations (id, name, owner_user_id, active_model_provider, default_persona_id, created_at, updated_at)
  VALUES (personal_organization, 'Aval workspace', subject, NULL, NULL, statement_timestamp(), statement_timestamp())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organization_members (id, organization_id, user_id, role, invited_by_user_id, created_at, updated_at)
  VALUES ('membership_' || personal_organization || '_' || subject, personal_organization, subject, 'owner', NULL, statement_timestamp(), statement_timestamp())
  ON CONFLICT (organization_id, user_id) DO UPDATE SET updated_at = statement_timestamp();

  INSERT INTO public.access_grants (
    id, organization_id, principal_id, role, organization_scope,
    capabilities_json, created_by_principal_id, created_at, updated_at
  )
  VALUES (
    'grant_' || personal_organization || '_' || subject,
    personal_organization, subject, 'org_admin', true,
    '[]'::jsonb, subject, statement_timestamp(), statement_timestamp()
  )
  ON CONFLICT (organization_id, id) DO UPDATE SET
    role = 'org_admin', organization_scope = true, revoked_at = NULL,
    expires_at = NULL, updated_at = statement_timestamp();

  selected_organization := personal_organization;
  IF requested_organization IS NOT NULL
     AND requested_organization <> ''
     AND aval_private.principal_has_access(requested_organization) THEN
    selected_organization := requested_organization;
  END IF;
  PERFORM set_config('aval.organization_id', selected_organization, true);
  RETURN selected_organization;
END $$;

-- A person redeeming a code cannot read its target organization through RLS
-- until the grant exists. Lock and consume the invitation, add descriptive
-- membership and authoritative access, and append the audit link atomically.
CREATE OR REPLACE FUNCTION aval_private.redeem_invitation(
  invitation_code_hash text,
  audit_payload_digest text
) RETURNS TABLE(outcome text, organization_id text, granted_role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions AS $$
DECLARE
  invitation public.organization_invitations%ROWTYPE;
  principal text := aval_private.current_principal_id();
  role_name text;
  grant_role text;
  audit_sequence integer;
  previous_hash text;
  entry_hash text;
BEGIN
  IF principal IS NULL OR length(principal) > 256
     OR invitation_code_hash !~ '^[0-9a-f]{64}$'
     OR audit_payload_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid invitation redemption' USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO invitation
  FROM public.organization_invitations candidate
  WHERE candidate.code_hash = invitation_code_hash
  FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text; RETURN; END IF;
  IF invitation.revoked_at IS NOT NULL THEN RETURN QUERY SELECT 'revoked'::text, NULL::text, NULL::text; RETURN; END IF;
  IF invitation.accepted_by_user_id IS NOT NULL THEN RETURN QUERY SELECT 'already_accepted'::text, NULL::text, NULL::text; RETURN; END IF;
  IF invitation.expires_at <= statement_timestamp() THEN RETURN QUERY SELECT 'expired'::text, NULL::text, NULL::text; RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM public.access_grants existing
    WHERE existing.organization_id = invitation.organization_id
      AND existing.principal_id = principal
      AND existing.revoked_at IS NULL
      AND (existing.expires_at IS NULL OR existing.expires_at > statement_timestamp())
  ) THEN
    RETURN QUERY SELECT 'already_member'::text, NULL::text, NULL::text; RETURN;
  END IF;

  role_name := CASE WHEN invitation.role = 'approver' THEN 'approver' ELSE 'member' END;
  grant_role := CASE WHEN role_name = 'approver' THEN 'approver' ELSE 'operator' END;
  UPDATE public.organization_invitations
  SET accepted_by_user_id = principal, accepted_at = statement_timestamp()
  WHERE id = invitation.id;

  INSERT INTO public.organization_members (id, organization_id, user_id, role, invited_by_user_id, created_at, updated_at)
  VALUES (gen_random_uuid()::text, invitation.organization_id, principal, role_name, invitation.created_by_user_id, statement_timestamp(), statement_timestamp())
  ON CONFLICT (organization_id, user_id) DO UPDATE SET
    role = EXCLUDED.role, invited_by_user_id = EXCLUDED.invited_by_user_id, updated_at = statement_timestamp();

  INSERT INTO public.access_grants (
    id, organization_id, principal_id, role, organization_scope,
    capabilities_json, created_by_principal_id, created_at, updated_at
  ) VALUES (
    'grant_' || invitation.organization_id || '_' || principal,
    invitation.organization_id, principal, grant_role, true,
    '[]'::jsonb, invitation.created_by_user_id, statement_timestamp(), statement_timestamp()
  ) ON CONFLICT (organization_id, id) DO UPDATE SET
    role = EXCLUDED.role, organization_scope = true,
    ownership_entity_id = NULL, portfolio_id = NULL, region_id = NULL, property_id = NULL,
    expires_at = NULL, revoked_at = NULL, updated_at = statement_timestamp();

  PERFORM pg_advisory_xact_lock(hashtextextended(invitation.organization_id, 1));
  SELECT log.sequence, log.entry_hash INTO audit_sequence, previous_hash
  FROM public.answer_audit_log log
  WHERE log.organization_id = invitation.organization_id
  ORDER BY log.sequence DESC
  LIMIT 1;
  audit_sequence := coalesce(audit_sequence, 0) + 1;
  previous_hash := coalesce(previous_hash, repeat('0', 64));
  entry_hash := encode(digest(
    audit_sequence::text || chr(31) || previous_hash || chr(31) ||
    'invitation_accepted' || chr(31) || 'role:' || role_name || chr(31) ||
    audit_payload_digest || chr(31) || '0',
    'sha256'
  ), 'hex');
  INSERT INTO public.answer_audit_log (
    id, organization_id, sequence, kind, label, payload_digest,
    count, previous_hash, entry_hash, created_at
  ) VALUES (
    gen_random_uuid()::text, invitation.organization_id, audit_sequence,
    'invitation_accepted', 'role:' || role_name, audit_payload_digest,
    0, previous_hash, entry_hash, statement_timestamp()
  );

  RETURN QUERY SELECT 'accepted'::text, invitation.organization_id, role_name;
END $$;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_select ON public.users;
CREATE POLICY users_select ON public.users FOR SELECT TO aval_app
  USING (aval_private.can_view_user(id));
DROP POLICY IF EXISTS users_update ON public.users;
CREATE POLICY users_update ON public.users FOR UPDATE TO aval_app
  USING (id = aval_private.current_principal_id())
  WITH CHECK (id = aval_private.current_principal_id());

ALTER TABLE public.user_appearance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_appearance FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_appearance_select ON public.user_appearance;
CREATE POLICY user_appearance_select ON public.user_appearance FOR SELECT TO aval_app
  USING (aval_private.can_view_user(user_id));
DROP POLICY IF EXISTS user_appearance_insert ON public.user_appearance;
CREATE POLICY user_appearance_insert ON public.user_appearance FOR INSERT TO aval_app
  WITH CHECK (user_id = aval_private.current_principal_id());
DROP POLICY IF EXISTS user_appearance_update ON public.user_appearance;
CREATE POLICY user_appearance_update ON public.user_appearance FOR UPDATE TO aval_app
  USING (user_id = aval_private.current_principal_id())
  WITH CHECK (user_id = aval_private.current_principal_id());

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_select ON public.messages;
CREATE POLICY messages_select ON public.messages FOR SELECT TO aval_app
  USING (aval_private.can_access_conversation(conversation_id));
DROP POLICY IF EXISTS messages_insert ON public.messages;
CREATE POLICY messages_insert ON public.messages FOR INSERT TO aval_app
  WITH CHECK (aval_private.can_access_conversation(conversation_id));
DROP POLICY IF EXISTS messages_update ON public.messages;
CREATE POLICY messages_update ON public.messages FOR UPDATE TO aval_app
  USING (aval_private.can_access_conversation(conversation_id))
  WITH CHECK (aval_private.can_access_conversation(conversation_id));
DROP POLICY IF EXISTS messages_delete ON public.messages;
CREATE POLICY messages_delete ON public.messages FOR DELETE TO aval_app
  USING (aval_private.can_access_conversation(conversation_id));

ALTER TABLE public.automation_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_steps_select ON public.automation_steps;
CREATE POLICY automation_steps_select ON public.automation_steps FOR SELECT TO aval_app
  USING (aval_private.can_access_automation_run(run_id));
DROP POLICY IF EXISTS automation_steps_insert ON public.automation_steps;
CREATE POLICY automation_steps_insert ON public.automation_steps FOR INSERT TO aval_app
  WITH CHECK (aval_private.can_access_automation_run(run_id));
DROP POLICY IF EXISTS automation_steps_update ON public.automation_steps;
CREATE POLICY automation_steps_update ON public.automation_steps FOR UPDATE TO aval_app
  USING (aval_private.can_access_automation_run(run_id))
  WITH CHECK (aval_private.can_access_automation_run(run_id));
DROP POLICY IF EXISTS automation_steps_delete ON public.automation_steps;
CREATE POLICY automation_steps_delete ON public.automation_steps FOR DELETE TO aval_app
  USING (aval_private.can_access_automation_run(run_id));

ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_hits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rate_limit_hits_all ON public.rate_limit_hits;
CREATE POLICY rate_limit_hits_all ON public.rate_limit_hits TO aval_app
  USING (aval_private.has_org_access(organization_id))
  WITH CHECK (aval_private.has_org_access(organization_id));

ALTER TABLE public.agent_worker_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_worker_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_worker_runs_select ON public.agent_worker_runs;
CREATE POLICY agent_worker_runs_select ON public.agent_worker_runs FOR SELECT TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin']));

DROP POLICY IF EXISTS access_grants_select ON public.access_grants;
CREATE POLICY access_grants_select ON public.access_grants FOR SELECT TO aval_app
  USING (
    principal_id = aval_private.current_principal_id()
    OR aval_private.has_org_role(organization_id, ARRAY['org_admin'])
  );

DROP POLICY IF EXISTS organization_members_select ON public.organization_members;
CREATE POLICY organization_members_select ON public.organization_members FOR SELECT TO aval_app
  USING (
    user_id = aval_private.current_principal_id()
    OR aval_private.has_org_access(organization_id)
  );

DROP POLICY IF EXISTS organizations_select ON public.organizations;
CREATE POLICY organizations_select ON public.organizations FOR SELECT TO aval_app
  USING (aval_private.principal_has_access(id));

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aval_private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aval_private.bootstrap_supabase_identity(text, text, text, boolean, text, text) TO aval_app;
GRANT EXECUTE ON FUNCTION aval_private.redeem_invitation(text, text) TO aval_app;
GRANT EXECUTE ON FUNCTION aval_private.current_principal_id() TO aval_app;
GRANT EXECUTE ON FUNCTION aval_private.current_organization_id() TO aval_app;
GRANT EXECUTE ON FUNCTION aval_private.has_org_access(text) TO aval_app;
GRANT EXECUTE ON FUNCTION aval_private.has_org_role(text, text[]) TO aval_app;
GRANT EXECUTE ON FUNCTION aval_private.can_access_property(text, text) TO aval_app;
GRANT EXECUTE ON FUNCTION aval_private.can_manage_property(text, text) TO aval_app;
GRANT EXECUTE ON FUNCTION aval_private.principal_has_access(text) TO aval_app;
GRANT EXECUTE ON FUNCTION aval_private.can_view_user(text) TO aval_app;
GRANT EXECUTE ON FUNCTION aval_private.can_access_conversation(text) TO aval_app;
GRANT EXECUTE ON FUNCTION aval_private.can_access_automation_run(text) TO aval_app;
