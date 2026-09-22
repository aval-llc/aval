# Living Setup audit

| Area | Source of truth | Current interaction/runtime effect | Duplication / action | Evidence |
|---|---|---|---|---|
| Wiring | Static persona arrays | No mutations; describes framing, not effective access | Remove; derive from runtime assembly | dashboard-client.tsx, personas.ts, agents/toolset.ts |
| Employees | ai_employees + ai_employee_scopes | Directory creates/lifecycles; runtime reads grants | Reuse rows; add scoped editing and derived access | agents/employees.ts, agents/runtime.ts |
| Connections | integration_connections, PMS authorizations/grants/deployments | Real connect/revoke; PMS assembly rechecks provider | Reuse ConnectionDialog, capability matrix and seat controls | integrations routes, pms/assembly.ts |
| Team | access_grants + organization_members | Role/invite mutations change request-time authority | Reuse WorkspaceMembers; no graph-only membership | organizations/membership.ts |
| Independence | onboarding preferences; employee autonomyMode | Workspace user mode enforced per action; employee mode was not consulted | Keep user default; intersect employee policy at execution | agents/autonomy-storage.ts |
| Memory | workspace preference tags; employee instructions | Tags enter prompts; employee instructions enter runtime | Move tags to Aval detail, instructions to employee detail | ask-aval/preferences.ts, agents/runtime.ts |
| Knowledge | documents + integration connections | Runtime document readers query canonical records | Show existing sources; never imply execution authority | postgres/schema.ts, ask-aval/tools.ts |
| Expertise | expertise_profiles + employee_expertise | Selected per Work, narrows mutations | Edit canonical links | agents/expertise.ts |
| Approvals | agent_approvals + access_grants + execution policies | Owner/approver authorization re-read for decisions | Show real routing authority, no fictional named approver assignment | agents/approvals.ts, organizations/membership.ts |
| Dashboard | connection capability mapping + ingestion + normalized data | Capability-specific preview/sync/live/empty | Reuse mapping; no PMS boolean | operations/dashboard-state.ts |
| Active work | agent_tasks + durable wake/wait records | Provider revocation checked at execution | Preserve rows; expose waits and recheck employee grants | agents/executor.ts, pms/assembly.ts |

The graph is a read projection. Its controls call existing configuration APIs; no canvas positions or edge state grant authority. Provider names, scopes, mailboxes, and health are returned from canonical records, never fabricated from the reference image.
