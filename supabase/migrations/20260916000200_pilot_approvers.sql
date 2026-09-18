-- Approvers retain ordinary operational writes, never connection administration.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['agent_tasks','documents','conversations','work_orders'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO aval_app WITH CHECK (aval_private.has_org_role(organization_id, ARRAY[''approver'']))', t || '_approver_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO aval_app USING (aval_private.has_org_role(organization_id, ARRAY[''approver''])) WITH CHECK (aval_private.has_org_role(organization_id, ARRAY[''approver'']))', t || '_approver_update', t);
  END LOOP;
END $$;
