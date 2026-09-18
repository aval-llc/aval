-- Calendar-only business values must not shift when rendered in another time
-- zone. Event timestamps remain timestamptz; only date-only fields convert.

ALTER TABLE public.portfolio_snapshots
  ALTER COLUMN period_start TYPE date USING period_start::date,
  ALTER COLUMN period_end TYPE date USING period_end::date;

ALTER TABLE public.ai_usage
  ALTER COLUMN day TYPE date USING day::date;

ALTER TABLE public.utility_bills
  ALTER COLUMN period_start TYPE date USING period_start::date,
  ALTER COLUMN period_end TYPE date USING period_end::date;

ALTER TABLE public.units
  ALTER COLUMN vacant_since TYPE date USING vacant_since::date;

ALTER TABLE public.leases
  ALTER COLUMN start_date TYPE date USING start_date::date,
  ALTER COLUMN end_date TYPE date USING end_date::date,
  ALTER COLUMN move_in_date TYPE date USING move_in_date::date,
  ALTER COLUMN move_out_date TYPE date USING move_out_date::date;

ALTER TABLE public.ledger_entries
  ALTER COLUMN due_at TYPE date USING due_at::date;

ALTER TABLE public.vendors
  ALTER COLUMN insurance_expires_at TYPE date USING insurance_expires_at::date;
