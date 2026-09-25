-- Worker policies for tables created after the worker role was defined.
--
-- `20260911000200_worker_role.sql` generates one `<table>_worker_all` policy
-- per table carrying an `organization_id`, by looping over the tables that
-- existed when it ran. Every table a later migration creates therefore has
-- policies for `aval_app` and none for `aval_worker`.
--
-- `20260919000100_grant_late_created_tables.sql` fixed the sibling half of this
-- problem — table privileges — with ALTER DEFAULT PRIVILEGES. Privileges now
-- carry forward automatically; policies still do not, because a policy names a
-- table that does not exist yet.
--
-- The consequence is not a visible error at migration time. It is an insert
-- that fails at runtime only on the worker path: the cron-driven runtime runs
-- as `aval_worker`, so anything the background runtime writes to one of these
-- tables is refused by RLS while the same write from a request succeeds.

DO $$
DECLARE t text;
DECLARE policy_name text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attempt_policies','work_attempts','operational_facts','action_evidence'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
      policy_name := t || '_worker_all';
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO aval_worker USING (organization_id = aval_private.current_organization_id()) WITH CHECK (organization_id = aval_private.current_organization_id())',
        policy_name, t);
    END IF;
  END LOOP;
END $$;
