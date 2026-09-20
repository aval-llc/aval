# Agent library UI

The Setup page leads with a folder library. Built-in personas come from the existing persona registry, saved custom personas from `/api/agents`, and employees from the paginated employee directory. Human portraits are the default for built-in and custom agents; Aval retains its brand icon. Retired saved blob choices migrate to portraits while preserving the chosen background. Settings keeps the 48 portraits (including the 24 supplied personality animations), the Aval icon, motion and background controls, and now includes paginated employee identities in the customization selector. All controls use Aval’s local Inter font. No UI employee ceiling is imposed. Search and filters distinguish workspace employees from Aval's built-in agents. Creation is a focused dialog supporting arbitrary responsibilities, names, and roles; every starter template remains available in a disclosure.

Folders show agent identity, granted connections, and recent work. Only `COMPLETED` tasks receive a check mark. Connection labels resolve granted IDs against the integration catalog; an unresolved ID is labeled “Assigned connection,” not guessed to be a provider. Built-in personas live in the Aval workspace; this is not a claim that a provider is connected.

Opening a folder shows results, available markdown documents (including download), lifecycle controls for employees, and task activity behind a disclosure. Existing approvals, cancellation, execution plans, checks, and task creation for personas remain available. Memory is a compact editable list, with examples and the detailed explanation collapsed.

## Backend handoff

- Task list serialization now includes existing `task.employeeId`. This is the only server change. Ownership is matched by employee ID for employees. Persona folders exclude employee-owned tasks, even when the underlying execution persona matches.
- The task list currently returns the latest 25 tasks across the workspace. The folder previews/counts explicitly describe recent work. A server-side owner filter and cursor are needed for full historical browsing.
- Employee details return `scopes` as a map of scope kind to string values, plus `openWork`. The UI reads granted connection IDs; it does not grant access during creation.
- New employees start as drafts. Their execution composer remains unavailable until the backend task-creation route supports validated employee assignment; sending an employee ID as a persona ID would not establish ownership or permissions.
- Task results support `headline`, `narrative`, and `document` markdown today. Persisted assistant drafts and sent-message records do not expose employee ownership in their current response. They must gain explicit ownership before joining this folder. Do not infer ownership from names, roles, document titles, or integration names.
- No backend routes, permission rules, or production signing requirements were weakened.

## Validation

Typecheck, English/Spanish key parity, focused ESLint, production build, 707 unit tests (including ownership and complete registry rendering), and 23 desktop tests pass. An isolated browser fixture exercised the directory's accessibility rendering with a named employee, assigned connection, completed task, and active task. Fixtures do not validate providers or authenticated end-to-end behavior. Native browser controls were interrupted during screenshot review, so full visual and interaction QA is not claimed.

The local app targets `http://127.0.0.1:3010`. The local DMG is ad-hoc signed and not notarized. A native PostgreSQL fallback supports local pages/database access, but cannot supply Supabase Auth. Production signing and hosted release gates stay unchanged.
