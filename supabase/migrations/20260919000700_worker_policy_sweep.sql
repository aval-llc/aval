-- Every tenant table the worker can reach gets a worker policy, generically.
--
-- `20260919000600` named four tables explicitly and missed seven more, which is
-- the same mistake in a smaller font: a hand-maintained list of tables goes
-- stale the moment someone adds a table. `20260911000200_worker_role.sql`
-- generated these policies by looping over the tables that existed then, and
-- nothing has looped since.
--
-- The seven found by the guard in tests/postgres/application.integration.mjs
-- were agent_deployments, organization_seat_slugs, pms_action_flows,
-- pms_seat_messages, pms_seat_senders, pms_write_authorizations and
-- pms_write_queue — all created by the PMS seat work. `20260919000100` gave
-- them table privileges and, reasonably enough, did not treat policies as a
-- separate inheritance problem. The effect is that the cron runtime, which is
-- `aval_worker`, is refused on tables a request-scoped session can write, and
-- the PMS capability gate reads agent_deployments on every write call.
--
-- This sweep is idempotent and self-healing: re-running it adds nothing when
-- nothing is missing, and any table created before it is covered whether or not
-- someone remembered. Tables created *after* it still need their own policy,
-- which is what the guard test now fails on.

DO $$
DECLARE target record;
DECLARE policy_name text;
BEGIN
  FOR target IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN information_schema.columns col
      ON col.table_schema = 'public' AND col.table_name = c.relname
     AND col.column_name = 'organization_id'
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname
          AND 'aval_worker' = ANY (p.roles)
      )
  LOOP
    policy_name := target.table_name || '_worker_all';
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, target.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO aval_worker USING (organization_id = aval_private.current_organization_id()) WITH CHECK (organization_id = aval_private.current_organization_id())',
      policy_name, target.table_name);
  END LOOP;
END $$;
