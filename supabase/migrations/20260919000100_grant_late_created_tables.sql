-- Grants for the tables `20260918000100_pms_seat.sql` created.
--
-- `20260911000200_worker_role.sql` and the generated RLS bootstrap both use
-- `GRANT ... ON ALL TABLES IN SCHEMA public`, which is evaluated once against
-- the tables existing at that moment. Every table a later migration creates is
-- therefore ungranted, and a table with row-level policies but no table
-- privilege is denied before its policy is ever consulted.
--
-- The PMS seat migration created six such tables. Each carries carefully
-- written RLS policies and none was reachable: the PMS write path reads
-- agent_deployments on every call, the capability gate swallowed the resulting
-- error, and the poisoned transaction then failed at COMMIT.
--
-- Named explicitly rather than re-running `ON ALL TABLES`. A blanket grant
-- would silently restore privileges that later migrations deliberately took
-- away — `20260912000300` revokes UPDATE and DELETE on answer_audit_log to keep
-- the audit log append-only, and a blanket re-grant hands both back.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.agent_deployments,
  public.pms_seat_messages,
  public.pms_seat_senders,
  public.pms_write_authorizations,
  public.pms_write_queue,
  public.pms_action_flows
TO aval_app, aval_worker;

-- Future tables, so the next migration that adds one does not repeat this.
-- Default privileges apply only to tables created after this runs, so they
-- cannot restore a privilege an existing table had revoked.
DO $$
DECLARE
  creator text := current_user;
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aval_app, aval_worker',
    creator);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND creator <> 'postgres' THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aval_app, aval_worker';
  END IF;
END $$;
