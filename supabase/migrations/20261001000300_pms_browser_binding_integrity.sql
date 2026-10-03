-- RLS protects rows; these keys also prevent references into another workspace.
ALTER TABLE public.integration_connections ADD CONSTRAINT pms_connection_workspace UNIQUE(id,organization_id);
ALTER TABLE public.pms_browser_devices ADD CONSTRAINT pms_device_workspace UNIQUE(id,organization_id);
ALTER TABLE public.pms_write_queue ADD CONSTRAINT pms_queue_workspace UNIQUE(id,organization_id);
ALTER TABLE public.pms_browser_bindings
  ADD CONSTRAINT pms_binding_connection_workspace FOREIGN KEY(id,organization_id)
    REFERENCES public.integration_connections(id,organization_id),
  ADD CONSTRAINT pms_binding_device_workspace FOREIGN KEY(device_id,organization_id)
    REFERENCES public.pms_browser_devices(id,organization_id);
ALTER TABLE public.pms_write_queue ADD CONSTRAINT pms_queue_connection_workspace FOREIGN KEY(connection_id,organization_id)
  REFERENCES public.integration_connections(id,organization_id);
ALTER TABLE public.pms_action_flows ADD CONSTRAINT pms_flow_connection_workspace FOREIGN KEY(connection_id,organization_id)
  REFERENCES public.integration_connections(id,organization_id);
ALTER TABLE public.pms_browser_reports
  ADD CONSTRAINT pms_report_queue_workspace FOREIGN KEY(queue_id,organization_id)
    REFERENCES public.pms_write_queue(id,organization_id),
  ADD CONSTRAINT pms_report_device_workspace FOREIGN KEY(device_id,organization_id)
    REFERENCES public.pms_browser_devices(id,organization_id);
