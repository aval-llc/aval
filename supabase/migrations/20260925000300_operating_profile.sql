-- What business a workspace runs.
--
-- Two multi-select axes, business models and asset classes, stored as ids
-- (lib/organizations/operating-profile.ts holds the taxonomy). Routing reads it
-- to decide which Leads and Specialists a workspace's work may reach, so a pure
-- association manager is never routed into leasing and a market-rate owner is
-- never routed into subsidy recertification.
--
-- Defaults to an empty profile, which routing treats as "every domain": a
-- workspace that has not said reaches exactly what it reached before this
-- column existed. Unknown ids are dropped when the profile is read, so the
-- taxonomy can grow or retire an entry without a migration here.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS operating_profile_json jsonb NOT NULL DEFAULT '{"businessModels":[],"assetClasses":[],"version":0}'::jsonb;
