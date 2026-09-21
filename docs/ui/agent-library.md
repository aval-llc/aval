# Agent library UI

Your 24/7 employees leads with a folder library. Built-in personas come from the existing persona registry, saved custom personas from `/api/agents`, and employees from the paginated employee directory. Human portraits are the default for built-in and custom agents; Aval retains its brand icon. Retired saved blob choices migrate to portraits while preserving the chosen background. Settings keeps the 48 portraits (including the 24 supplied personality animations), the Aval icon, motion and background controls, and now includes paginated employee identities in the customization selector. All controls use Aval’s local Inter font. No UI employee ceiling is imposed. Search and filters distinguish workspace employees from Aval's built-in agents. Creation is a focused dialog supporting arbitrary responsibilities, names, and roles; every starter template remains available in a disclosure.

Folders show agent identity, granted connections, and recent work. Only `COMPLETED` tasks receive a check mark. Connection labels resolve granted IDs against the integration catalog; an unresolved ID is labeled “Assigned connection,” not guessed to be a provider. Built-in personas live in the Aval workspace; this is not a claim that a provider is connected.

Opening a folder centralizes Work, Documents, and Review. The separate Aval Tasks and Review Center navigation entries now resolve to this library. Work retains results, cancellation, execution plans and checks; Review retains approval and rejection controls; Documents retains generation, download, sending, pause, resume, retry and removal for persona drafts. Employee documents are available in completed work. Aval’s additional Workspace tab contains the automation timeline and explicitly labeled older drafts without a saved owner. Assistant document links open their persona folder. Employee lifecycle controls remain available. Memory is a compact editable list, with examples and the detailed explanation collapsed.

## Backend handoff

- Task and approval APIs accept `employeeId` or `agentId` scopes. Ownership is matched by employee ID for employees. Persona folders exclude employee-owned tasks, even when the underlying execution persona matches. Approval responses expose their task’s owner; filtering applies before the pending-request limit.
- Folder previews use the latest 25 workspace tasks; opened folders retrieve the latest 100 tasks for their owner. Counts describe recent work. Full historical browsing still needs a cursor.
- Employee details return `scopes` as a map of scope kind to string values, plus `openWork`. The UI reads granted connection IDs; it does not grant access during creation.
- New employees start as drafts. Their execution composer remains unavailable until the backend task-creation route supports validated employee assignment; sending an employee ID as a persona ID would not establish ownership or permissions.
- Migration `20260920000200_draft_agent_owner.sql` adds nullable `persona_id` to assistant drafts. Generation persists the resolved persona; hydration restores that ownership. Historical null ownership stays visible under Aval’s Workspace tab. Task results support `headline`, `narrative`, and `document` markdown. Employee draft and sent-message records still need explicit employee ownership before joining their folder; do not infer it from names, roles, titles, or integration names.
- No backend routes, permission rules, or production signing requirements were weakened.

## Validation

Typecheck, English/Spanish key parity, focused ESLint, production build, 719 unit tests, 187 PostgreSQL integration checks (including persisted draft ownership, isolation, and filtering before history limits), and 23 desktop tests pass. An isolated browser fixture exercised the directory's accessibility rendering with a named employee, assigned connection, completed task, and active task. Fixtures do not validate providers or authenticated end-to-end behavior. Native browser controls were interrupted during screenshot review, so full visual and interaction QA is not claimed.

The local app targets `http://127.0.0.1:3010`. The local DMG is ad-hoc signed and not notarized. A native PostgreSQL fallback supports local pages/database access, but cannot supply Supabase Auth. Production signing and hosted release gates stay unchanged.
