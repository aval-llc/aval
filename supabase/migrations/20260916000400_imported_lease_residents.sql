-- Null provenance preserves manually maintained and legacy associations.
ALTER TABLE public.lease_residents ADD COLUMN source_provider text;
ALTER TABLE public.lease_residents ADD COLUMN source_connection_id text;
