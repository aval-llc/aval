-- Planning keeps epoch milliseconds for API compatibility. PostgreSQL integer
-- is 32-bit, so current timestamps overflow it; bigint safely preserves the
-- existing number contract and remains within JavaScript's safe integer range.
ALTER TABLE public.planning_projects
  ALTER COLUMN created_at TYPE bigint USING created_at::bigint;

ALTER TABLE public.planning_items
  ALTER COLUMN starts_at TYPE bigint USING starts_at::bigint,
  ALTER COLUMN ends_at TYPE bigint USING ends_at::bigint,
  ALTER COLUMN updated_at TYPE bigint USING updated_at::bigint;
