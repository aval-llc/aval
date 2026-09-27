-- Additive protocol/outcome fields; historical records deliberately remain unknown.
ALTER TABLE public.agent_tasks ADD COLUMN maintenance_outcome_json jsonb;
ALTER TABLE public.desktop_model_runners ADD COLUMN protocol_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.desktop_model_jobs ADD COLUMN diagnostics_json jsonb;
ALTER TABLE public.desktop_model_jobs ADD COLUMN attempt_history_json jsonb NOT NULL DEFAULT '[]';
