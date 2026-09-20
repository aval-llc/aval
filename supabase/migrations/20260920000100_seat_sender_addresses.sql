-- Grant a mailbox, not a population.
--
-- `pms_seat_senders` allows a *domain* to write to a workspace's seat, and the
-- rule that a consumer mailbox domain may never be allowlisted is now settled
-- closed: `gmail.com` on an allowlist is not a party, it is everyone who ever
-- signed up, and every one of them could then put text into an agent's context
-- DMARC-clean with no forgery involved.
--
-- That rule left two legitimate senders with nowhere to go, and this table is
-- where they go:
--
--   * The smallest customer, whose "PMS" is a person forwarding notices from a
--     Gmail account. `john@gmail.com` grants John and nobody else.
--   * A message a human adjudicated. Approving what arrived must approve that
--     sender; it must never be widened into the domain behind them.
--
-- A separate table rather than a nullable `address` column on
-- `pms_seat_senders`, because the two are different grants with different
-- rules, and one column would have made every read decide which kind of row it
-- was holding before it could apply the right rule.

CREATE TABLE IF NOT EXISTS public.pms_seat_sender_addresses (
  organization_id text        NOT NULL REFERENCES public.organizations(id),
  address         text        NOT NULL,
  provider_id     text        NOT NULL,
  added_by        text        NOT NULL,
  added_at        timestamptz NOT NULL,
  -- Normalization belongs to `sender-domain.ts`; this is the backstop that
  -- keeps a row written by any other path from being unmatchable.
  CONSTRAINT pms_seat_sender_addresses_shape
    CHECK (address = lower(address) AND position('@' in address) > 1 AND address !~ '\s')
);

CREATE UNIQUE INDEX IF NOT EXISTS pms_seat_sender_addresses_uq
  ON public.pms_seat_sender_addresses (organization_id, address);
CREATE INDEX IF NOT EXISTS pms_seat_sender_addresses_org_idx
  ON public.pms_seat_sender_addresses (organization_id);

ALTER TABLE public.pms_seat_sender_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pms_seat_sender_addresses FORCE ROW LEVEL SECURITY;

-- The same roles that may allow a domain may allow a mailbox. Approving one
-- sender is a narrower act than approving a domain, never a broader one, so it
-- needs no additional authority — and granting it less would push operators
-- back toward the domain list, which is the outcome this table exists to avoid.
DROP POLICY IF EXISTS pms_seat_sender_addresses_select ON public.pms_seat_sender_addresses;
CREATE POLICY pms_seat_sender_addresses_select ON public.pms_seat_sender_addresses
  FOR SELECT TO aval_app
  USING (aval_private.has_org_access(organization_id));

DROP POLICY IF EXISTS pms_seat_sender_addresses_insert ON public.pms_seat_sender_addresses;
CREATE POLICY pms_seat_sender_addresses_insert ON public.pms_seat_sender_addresses
  FOR INSERT TO aval_app
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));

DROP POLICY IF EXISTS pms_seat_sender_addresses_update ON public.pms_seat_sender_addresses;
CREATE POLICY pms_seat_sender_addresses_update ON public.pms_seat_sender_addresses
  FOR UPDATE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']))
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));

DROP POLICY IF EXISTS pms_seat_sender_addresses_delete ON public.pms_seat_sender_addresses;
CREATE POLICY pms_seat_sender_addresses_delete ON public.pms_seat_sender_addresses
  FOR DELETE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));

-- The seat reader adjudicates as `aval_worker`, and a tenant table without a
-- worker policy is refused for the cron runtime while a request-scoped session
-- can write it — the systemic defect `20260919000700` swept up. Written here
-- rather than left for the next sweep.
DROP POLICY IF EXISTS pms_seat_sender_addresses_worker_all ON public.pms_seat_sender_addresses;
CREATE POLICY pms_seat_sender_addresses_worker_all ON public.pms_seat_sender_addresses
  FOR ALL TO aval_worker
  USING (organization_id = aval_private.current_organization_id())
  WITH CHECK (organization_id = aval_private.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pms_seat_sender_addresses TO aval_app, aval_worker;

-- The mailbox a held message authenticated as, so a person adjudicating it can
-- approve that sender rather than the domain behind them.
--
-- Null under the same rule as `authenticated_domain`: only ever written when
-- authentication established it, never from a sender-chosen `From`. The
-- condition here is the stricter of the two — DMARC plus an aligned DKIM
-- signature — because a local part is only as trustworthy as the signature
-- covering the header it sits in.
ALTER TABLE public.pms_seat_messages
  ADD COLUMN IF NOT EXISTS authenticated_address text;
