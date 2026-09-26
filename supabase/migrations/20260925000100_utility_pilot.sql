-- Additive migration. Labels and existing meter/bill IDs are preserved.
-- Legacy meters remain unmapped until an owner reviews an explicit mapping.
CREATE TABLE public.utility_sites (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES public.organizations(id),
 property_id text,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL,
 CONSTRAINT utility_sites_org_id_uq UNIQUE (organization_id,id),
 CONSTRAINT utility_sites_property_fk FOREIGN KEY (organization_id,property_id) REFERENCES public.properties(organization_id,id)
);
ALTER TABLE public.utility_meters ADD COLUMN site_id text, ADD COLUMN parent_meter_id text;
ALTER TABLE public.utility_meters ADD CONSTRAINT utility_meters_org_id_uq UNIQUE(organization_id,id);
ALTER TABLE public.utility_meters ADD CONSTRAINT utility_meters_org_unit_uq UNIQUE(organization_id,id,unit_of_measure);
ALTER TABLE public.utility_meters ADD CONSTRAINT utility_meters_type_unit CHECK(
 (utility_type='electricity' AND unit_of_measure='kWh') OR
 (utility_type='water' AND unit_of_measure IN ('m3','gal','ccf')) OR
 (utility_type='gas' AND unit_of_measure IN ('m3','ccf','therm'))
) NOT VALID;
ALTER TABLE public.utility_meters ADD CONSTRAINT utility_meters_org_site_id_uq UNIQUE(organization_id,site_id,id);
ALTER TABLE public.utility_meters ADD CONSTRAINT utility_meters_site_fk FOREIGN KEY(organization_id,site_id) REFERENCES public.utility_sites(organization_id,id);
ALTER TABLE public.utility_meters ADD CONSTRAINT utility_meters_parent_fk FOREIGN KEY(organization_id,site_id,parent_meter_id) REFERENCES public.utility_meters(organization_id,site_id,id);
ALTER TABLE public.utility_meters ADD CONSTRAINT utility_meters_parent_site CHECK(parent_meter_id IS NULL OR (site_id IS NOT NULL AND parent_meter_id <> id));
CREATE INDEX utility_meters_site_idx ON public.utility_meters(organization_id,site_id);

-- A stable lock on the owning organization serializes hierarchy edits, including
-- opposing parent updates. The application acquires this lock before its update.
CREATE FUNCTION aval_private.guard_utility_meter() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog,public AS $$
BEGIN
 PERFORM id FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
 IF TG_OP='UPDATE' AND OLD.site_id IS NOT NULL AND NEW.site_id IS DISTINCT FROM OLD.site_id THEN
   RAISE EXCEPTION 'Mapped meter site is immutable; use a new meter for another site';
 END IF;
 IF TG_OP='UPDATE' AND OLD.unit_of_measure IS DISTINCT FROM NEW.unit_of_measure THEN
   RAISE EXCEPTION 'Meter units are immutable; preserve the source unit';
 END IF;
 IF TG_OP='UPDATE' AND OLD.utility_type IS DISTINCT FROM NEW.utility_type THEN
   RAISE EXCEPTION 'Meter utility type is immutable';
 END IF;
 IF NEW.parent_meter_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.utility_meters WHERE organization_id=NEW.organization_id AND id=NEW.parent_meter_id AND utility_type<>NEW.utility_type) THEN
   RAISE EXCEPTION 'Parent meter must measure the same utility type';
 END IF;
 IF NEW.parent_meter_id IS NOT NULL AND EXISTS (
   WITH RECURSIVE ancestors AS (
    SELECT id,parent_meter_id FROM public.utility_meters WHERE organization_id=NEW.organization_id AND id=NEW.parent_meter_id
    UNION
    SELECT m.id,m.parent_meter_id FROM public.utility_meters m JOIN ancestors a ON m.id=a.parent_meter_id WHERE m.organization_id=NEW.organization_id
   ) SELECT 1 FROM ancestors WHERE id=NEW.id
 ) THEN RAISE EXCEPTION 'Meter hierarchy cycle'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER utility_meter_guard BEFORE INSERT OR UPDATE ON public.utility_meters FOR EACH ROW EXECUTE FUNCTION aval_private.guard_utility_meter();

ALTER TABLE public.utility_bills
 ADD COLUMN unit_of_measure text,
 ADD COLUMN reading_kind text NOT NULL DEFAULT 'unknown' CHECK(reading_kind IN ('actual','estimated','unknown')),
 ADD COLUMN source_system text,
 ADD COLUMN external_id text,
 ADD COLUMN tariff_code text,
 ADD COLUMN subtotal_cents bigint,
 ADD COLUMN tax_cents bigint,
 ADD COLUMN supersedes_bill_id text,
 ADD COLUMN superseded_at timestamptz;
UPDATE public.utility_bills b SET unit_of_measure=m.unit_of_measure FROM public.utility_meters m WHERE b.organization_id=m.organization_id AND b.meter_id=m.id;
ALTER TABLE public.utility_bills ALTER COLUMN unit_of_measure SET NOT NULL;
ALTER TABLE public.utility_bills ADD CONSTRAINT utility_bills_org_meter_fk FOREIGN KEY(organization_id,meter_id) REFERENCES public.utility_meters(organization_id,id);
ALTER TABLE public.utility_bills ADD CONSTRAINT utility_bills_meter_unit_fk FOREIGN KEY(organization_id,meter_id,unit_of_measure) REFERENCES public.utility_meters(organization_id,id,unit_of_measure);
ALTER TABLE public.utility_bills ADD CONSTRAINT utility_bills_org_id_uq UNIQUE(organization_id,id);
ALTER TABLE public.utility_bills ADD CONSTRAINT utility_bills_revision_fk FOREIGN KEY(organization_id,supersedes_bill_id) REFERENCES public.utility_bills(organization_id,id);
CREATE UNIQUE INDEX utility_bills_source_uq ON public.utility_bills(organization_id,source_system,external_id) WHERE superseded_at IS NULL;
-- NOT VALID preserves legacy records while enforcing correctness on new writes.
ALTER TABLE public.utility_bills ADD CONSTRAINT utility_bill_values CHECK(period_end>period_start AND usage_amount>=0 AND usage_amount<=100000000 AND cost_cents>=0 AND cost_cents<=10000000000 AND currency IN ('USD','MXN')) NOT VALID;
ALTER TABLE public.utility_bills ADD CONSTRAINT utility_bill_tax CHECK((subtotal_cents IS NULL AND tax_cents IS NULL) OR (subtotal_cents>=0 AND tax_cents>=0 AND subtotal_cents IS NOT NULL AND tax_cents IS NOT NULL AND subtotal_cents+tax_cents=cost_cents)) NOT VALID;

ALTER TABLE public.utility_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.utility_sites FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.utility_sites TO aval_app,aval_worker;
-- Pilot utilities require organization-wide grants; scoped users must not read
-- the organization's entire meter portfolio through the existing summary API.
CREATE POLICY utility_sites_read ON public.utility_sites FOR SELECT TO aval_app USING(aval_private.has_org_role(organization_id,ARRAY['org_admin','regional_manager','property_manager','operator','approver','viewer']));
CREATE POLICY utility_sites_write ON public.utility_sites FOR ALL TO aval_app USING(aval_private.has_org_role(organization_id,ARRAY['org_admin'])) WITH CHECK(aval_private.has_org_role(organization_id,ARRAY['org_admin']));
CREATE POLICY utility_sites_worker ON public.utility_sites FOR ALL TO aval_worker USING(organization_id=nullif(current_setting('aval.organization_id',true),'')) WITH CHECK(organization_id=nullif(current_setting('aval.organization_id',true),''));
DROP POLICY utility_meters_select ON public.utility_meters;
CREATE POLICY utility_meters_select ON public.utility_meters FOR SELECT TO aval_app USING(aval_private.has_org_role(organization_id,ARRAY['org_admin','regional_manager','property_manager','operator','approver','viewer']));
DROP POLICY utility_bills_select ON public.utility_bills;
CREATE POLICY utility_bills_select ON public.utility_bills FOR SELECT TO aval_app USING(aval_private.has_org_role(organization_id,ARRAY['org_admin','regional_manager','property_manager','operator','approver','viewer']));
