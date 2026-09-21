-- UI history is private to a user in a workspace; execution remains in agent_tasks.
CREATE TABLE public.assistant_chat_entries (
  organization_id text NOT NULL REFERENCES public.organizations(id),
  user_id text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id, id)
);
CREATE INDEX assistant_chat_entries_order ON public.assistant_chat_entries(organization_id, user_id, created_at);
ALTER TABLE public.assistant_chat_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_chat_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_chat_entries_own ON public.assistant_chat_entries FOR ALL TO aval_app
  USING (organization_id = aval_private.current_organization_id() AND user_id = aval_private.current_principal_id() AND aval_private.has_org_access(organization_id))
  WITH CHECK (organization_id = aval_private.current_organization_id() AND user_id = aval_private.current_principal_id() AND aval_private.has_org_access(organization_id));
GRANT SELECT, INSERT, UPDATE ON public.assistant_chat_entries TO aval_app;
-- Background workers execute tasks, but never read personal chat history.
REVOKE ALL ON public.assistant_chat_entries FROM aval_worker;
CREATE POLICY assistant_chat_entries_worker_deny ON public.assistant_chat_entries FOR ALL TO aval_worker USING (false) WITH CHECK (false);
