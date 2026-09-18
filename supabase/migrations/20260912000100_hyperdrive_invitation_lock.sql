-- Replace the invitation audit lock without rewriting applied migration history.
-- NO KEY UPDATE permits concurrent foreign-key checks against the organization.
CREATE OR REPLACE FUNCTION aval_private.redeem_invitation(
  invitation_code_hash text,
  audit_payload_digest text
) RETURNS TABLE(outcome text, organization_id text, granted_role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions AS $$
-- The table-return column organization_id must not shadow conflict targets.
#variable_conflict use_column
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

  PERFORM id FROM public.organizations WHERE id = invitation.organization_id FOR NO KEY UPDATE;
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
