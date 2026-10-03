-- One shipped, reviewed Buildium workflow for the supervised maintenance pilot.
--
-- Values still come from a connection-bound approval manifest. This row only
-- describes the page shape; it carries no customer identifier or credential.
INSERT INTO public.pms_action_flows(
  id,organization_id,provider,action,version,connection_id,access_mode,
  steps_json,digest,status,required_role,risk_class,verification_strategy,
  reconciliation_strategy,fallback,certification,learned_by_user_id,
  promoted_by_user_id,promoted_at,created_at,updated_at
) VALUES (
  'aval-shipped-buildium-work-order-v1',NULL,'buildium','maintenance.work_order.create',1,NULL,'customer_desktop_session',
  '[{"kind":"open","page":"Request work orders"},{"kind":"fill","label":"Subject","from":"summary"},{"kind":"choose","label":"Vendor","from":"vendorName"},{"kind":"fill","label":"Work to be performed","from":"description"},{"kind":"choose","label":"Priority","from":"priority"},{"kind":"commit","button":"Save work order"},{"kind":"capture","label":"Work order","as":"externalId"}]'::jsonb,
  '8fcb2e7499278fd93fa9760ac640d94886355733cbae1d77bbd5c6713bd1c9d7',
  'active','Restricted staff: demo property, task and work-order edit only','high',
  'read_after_write','external_id','human_handoff','unit_tested',
  'aval-release','aval-release',now(),now(),now()
) ON CONFLICT (id) DO NOTHING;
