-- Stop rather than silently choose an owner for an existing shared account.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.integration_connections
    WHERE provider IN ('twilio', 'slack', 'whatsapp') AND status = 'connected'
    GROUP BY provider, external_account_id
    HAVING count(*) > 1 OR external_account_id IS NULL OR btrim(external_account_id) = ''
  ) THEN RAISE EXCEPTION 'Resolve missing or duplicate connected messaging account bindings before migration'; END IF;
END $$;

CREATE UNIQUE INDEX integration_connections_exclusive_messaging_account
  ON public.integration_connections(provider, external_account_id)
  WHERE provider IN ('twilio', 'slack', 'whatsapp') AND status = 'connected';
ALTER TABLE public.integration_connections ADD CONSTRAINT connected_messaging_account_required
  CHECK (provider NOT IN ('twilio', 'slack', 'whatsapp') OR status <> 'connected'
    OR (external_account_id IS NOT NULL AND btrim(external_account_id) <> ''));

CREATE OR REPLACE FUNCTION aval_private.webhook_connection(
  provider_name text, connection_identifier text DEFAULT NULL, external_account_key text DEFAULT NULL
) RETURNS TABLE(organization_id text, connection_id text, encrypted_credentials text, external_account_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.organization_id, c.id, c.access_token_ciphertext, c.external_account_id
  FROM public.integration_connections c
  WHERE c.provider = provider_name AND c.status = 'connected' AND (
    (provider_name IN ('telegram', 'apple_messages') AND c.id = connection_identifier)
    OR (provider_name IN ('twilio', 'slack', 'whatsapp') AND c.external_account_id = external_account_key)
  )
  LIMIT 2
$$;
