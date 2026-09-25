-- The shipped expertise catalogue, and three guards the review was right about.
--
-- SEEDING. The eleven profiles below are what Aval ships. They are inserted
-- here rather than by application code because a shipped profile carries a null
-- organization, and the insert policy on `expertise_profiles` deliberately
-- refuses that from an application session — a workspace must not be able to
-- author a row every other workspace can see. A seeding function that cannot
-- run under its own RLS is not a seeding function.
--
-- The rows are generated from SHIPPED_EXPERTISE in lib/agents/expertise.ts, and
-- a test asserts the two still agree, so the duplication cannot drift quietly.
--
-- GUARDS, in the order the review found them:
--
-- 1. Authorization. Granting an employee new expertise is an authority
--    decision, and the insert policy allowed it to anyone with read access to
--    the workspace. `ai_employee_scopes` already required org_admin or
--    regional_manager for exactly this reason; this brings the sibling table
--    into line rather than inventing a second standard.
--
-- 2. Audit integrity. `expertise_selections` records why an employee was
--    briefed the way it was. An UPDATE policy on it means that record can be
--    rewritten after the fact, which is precisely what an audit record must not
--    permit — the same reasoning that made agent_task_steps and action_evidence
--    append-only.
--
-- 3. Cross-tenant integrity. Nothing tied `employee_expertise.employee_id` and
--    `expertise_id` to the row's own organization. A composite foreign key
--    handles the employee; the expertise cannot use one because a shipped
--    profile has a null organization, so a trigger checks both together.

INSERT INTO public.expertise_profiles
  (id, organization_id, slug, name, description, capability_tags_json, domains_json,
   routing_signals_json, required_capabilities_json, instructions, risk_ceiling,
   version, enabled, created_at, updated_at)
SELECT gen_random_uuid()::text, NULL, seed.slug, seed.name, seed.description,
       seed.capability_tags, seed.domains, seed.routing_signals, seed.required_capabilities,
       seed.instructions, seed.risk_ceiling, 1, true, now(), now()
FROM (VALUES
  ('financial-analysis', 'Financial analysis', 'Portfolio economics: operating statements, delinquency, accounting breakdowns.', '["financial"]'::jsonb, '["financial"]'::jsonb, '["noi", "ledger", "arrears", "delinquent", "operating", "statement", "budget", "variance"]'::jsonb, '[]'::jsonb, 'Reason from posted figures only. Name the period and the source of every number, and say plainly when a figure is unavailable rather than estimating it.', 'medium'),
  ('brokerage-leasing', 'Brokerage and leasing', 'Leasing funnel, velocity, and conversion across the portfolio.', '["leasing"]'::jsonb, '["leasing"]'::jsonb, '["leasing", "vacancy", "funnel", "tour", "application", "conversion", "lead"]'::jsonb, '[]'::jsonb, 'Distinguish inquiries from tours and tours from applications. A funnel figure without its stage is not an answer.', 'medium'),
  ('real-estate', 'Real estate', 'Property and unit composition, ownership structure, portfolio shape.', '["property"]'::jsonb, '["property"]'::jsonb, '["property", "unit", "portfolio", "building", "square", "footage"]'::jsonb, '[]'::jsonb, 'Be precise about what is a property, a unit and a lease; conflating them produces figures that look right and are not.', 'low'),
  ('market-research', 'Market research', 'Comparables, rent positioning and local market context.', '["market"]'::jsonb, '["market"]'::jsonb, '["market", "comparable", "comp", "benchmark", "submarket"]'::jsonb, '[]'::jsonb, 'Separate what the portfolio''s own records show from anything asserted about the wider market, and never present the second as the first.', 'low'),
  ('maintenance', 'Maintenance', 'Work orders, repairs, vendor execution and completion evidence.', '["maintenance"]'::jsonb, '["maintenance"]'::jsonb, '["repair", "leak", "hvac", "work_order", "maintenance_request", "broken", "outage", "plumbing"]'::jsonb, '[]'::jsonb, 'A work order accepted by a provider is not a repair completed. Track the objective through to evidence that the condition is actually resolved.', 'high'),
  ('risk-analysis', 'Risk analysis', 'Exposure, concentration and what could go wrong across the portfolio.', '["risk"]'::jsonb, '["financial", "property"]'::jsonb, '["risk", "exposure", "concentration", "insurance", "liability", "compliance"]'::jsonb, '[]'::jsonb, 'Quantify exposure where the records allow and state the unquantified residue explicitly. An unmentioned risk reads as an absent one.', 'medium'),
  ('portfolio-outlook', 'Portfolio outlook', 'Trend and trajectory across the portfolio over time.', '["financial", "property"]'::jsonb, '["financial", "property"]'::jsonb, '["trend", "outlook", "forecast", "trajectory", "quarter"]'::jsonb, '[]'::jsonb, 'Distinguish what the series shows from what it implies, and give the window every trend is measured over.', 'low'),
  ('lease-review', 'Lease review', 'Lease terms, renewals, occupancy and obligations.', '["leasing"]'::jsonb, '["leasing"]'::jsonb, '["lease", "renewal", "term", "expiry", "occupant", "clause"]'::jsonb, '[]'::jsonb, 'Quote the lease rather than summarising it when the answer turns on wording, and name the document every term comes from.', 'medium'),
  ('resident-experience', 'Resident experience', 'Resident communication, expectations and follow-through until an issue is resolved.', '["resident"]'::jsonb, '["resident"]'::jsonb, '["resident", "tenant", "complaint", "request", "unhappy"]'::jsonb, '[]'::jsonb, 'Keep the resident informed of what will happen and when. Silence between updates is itself an outcome the resident experiences.', 'medium'),
  ('vendor-coordination', 'Vendor coordination', 'Scheduling, dispatching and chasing third parties to completion.', '["vendor"]'::jsonb, '["vendor", "maintenance"]'::jsonb, '["vendor", "contractor", "dispatch", "schedule", "appointment", "technician"]'::jsonb, '[]'::jsonb, 'A vendor accepting a job is not a job done. Track the appointment through to a confirmed outcome and chase what is overdue.', 'high'),
  ('escalation', 'Escalation', 'Recognising when something has stopped progressing and needs a person.', '["escalation"]'::jsonb, '["resident", "maintenance", "vendor"]'::jsonb, '["repeated", "escalate", "urgent", "unresolved", "again"]'::jsonb, '[]'::jsonb, 'Say what has already been tried, why it did not work, and exactly what decision is being asked of the person. An escalation without those three is an interruption.', 'critical')
) AS seed(slug, name, description, capability_tags, domains, routing_signals,
          required_capabilities, instructions, risk_ceiling)
ON CONFLICT DO NOTHING;

-- 1. Granting expertise is an authority decision.
DROP POLICY IF EXISTS employee_expertise_insert ON public.employee_expertise;
CREATE POLICY employee_expertise_insert ON public.employee_expertise FOR INSERT TO aval_app
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager']));
DROP POLICY IF EXISTS employee_expertise_update ON public.employee_expertise;
CREATE POLICY employee_expertise_update ON public.employee_expertise FOR UPDATE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager']))
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager']));

-- 2. A routing decision is a record of what happened, not a working note.
DROP POLICY IF EXISTS expertise_selections_update ON public.expertise_selections;
REVOKE UPDATE ON public.expertise_selections FROM aval_app;

-- 3. An employee and the expertise granted to it must belong to the workspace
--    the grant claims. Absent this, a row naming another tenant's expertise is
--    accepted by the database and only filtered later, by application code that
--    has to remember to.
CREATE UNIQUE INDEX IF NOT EXISTS ai_employees_org_id_uq ON public.ai_employees (organization_id, id);

CREATE OR REPLACE FUNCTION aval_private.employee_expertise_is_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ai_employees e
    WHERE e.id = NEW.employee_id AND e.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'employee % does not belong to organization %', NEW.employee_id, NEW.organization_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.expertise_profiles p
    WHERE p.id = NEW.expertise_id
      AND (p.organization_id IS NULL OR p.organization_id = NEW.organization_id)
  ) THEN
    RAISE EXCEPTION 'expertise % is not available to organization %', NEW.expertise_id, NEW.organization_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employee_expertise_same_tenant ON public.employee_expertise;
CREATE TRIGGER employee_expertise_same_tenant
  BEFORE INSERT OR UPDATE ON public.employee_expertise
  FOR EACH ROW EXECUTE FUNCTION aval_private.employee_expertise_is_same_tenant();
