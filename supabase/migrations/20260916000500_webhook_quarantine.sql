CREATE TABLE aval_private.webhook_quarantine (
  event_digest text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('twilio','slack','whatsapp','telegram','apple_messages')),
  payload_ciphertext text NOT NULL,
  reason text NOT NULL,
  signature_verified boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  last_received_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1
);
REVOKE ALL ON aval_private.webhook_quarantine FROM PUBLIC, aval_app, aval_worker;
CREATE FUNCTION aval_private.quarantine_webhook(digest text, provider_name text, ciphertext text, failure_reason text, verified boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF digest !~ '^[0-9a-f]{64}$' OR length(ciphertext) > 2000000
    OR failure_reason NOT IN ('ambiguous_destination','unavailable_destination') THEN
    RAISE EXCEPTION 'Invalid quarantined event';
  END IF;
  INSERT INTO aval_private.webhook_quarantine(event_digest,provider,payload_ciphertext,reason,signature_verified)
    VALUES(digest,provider_name,ciphertext,failure_reason,verified)
    ON CONFLICT(event_digest) DO UPDATE SET last_received_at=now(), attempts=webhook_quarantine.attempts+1;
END $$;
REVOKE ALL ON FUNCTION aval_private.quarantine_webhook(text,text,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aval_private.quarantine_webhook(text,text,text,text,boolean) TO aval_worker;
