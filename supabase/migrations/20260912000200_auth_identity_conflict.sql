-- Fix first-login bootstrap on PostgreSQL and reject a null verification flag.
CREATE OR REPLACE FUNCTION aval_private.bootstrap_supabase_identity(
  subject text,
  email text,
  display_name text,
  email_verified boolean,
  personal_organization text,
  requested_organization text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
-- Resolve ON CONFLICT (provider, subject) as index columns, not parameters.
#variable_conflict use_column
DECLARE
  selected_organization text;
  linked_principal text;
BEGIN
  IF subject IS NULL OR subject = '' OR length(subject) > 256
     OR subject <> aval_private.current_principal_id() THEN
    RAISE EXCEPTION 'invalid authenticated subject' USING ERRCODE = '22023';
  END IF;
  IF email_verified IS DISTINCT FROM true OR email IS NULL OR email = '' OR length(email) > 320 THEN
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
