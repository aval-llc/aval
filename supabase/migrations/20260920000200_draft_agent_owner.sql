-- New drafts retain their actual resolved persona; historical rows stay unassigned.
ALTER TABLE public.draft_documents ADD COLUMN IF NOT EXISTS persona_id text;
CREATE INDEX IF NOT EXISTS draft_documents_org_persona_idx
  ON public.draft_documents (organization_id, persona_id, created_at);
