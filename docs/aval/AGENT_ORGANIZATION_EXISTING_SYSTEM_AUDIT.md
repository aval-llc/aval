# Aval Agent Organization — Existing System Audit

**Date:** 2026-09-25
**Tree:** `main` at `ea257f0`
**Directive:** `AVAL_PROPERTY_MANAGEMENT_AGENTIC_ORGANIZATION_MASTER_DIRECTIVE.md` (2026-09-24), §2 "First deliverable"
**Predecessor:** `docs/aval/IMPLEMENTATION_AUDIT.md` (2026-09-18)
**Method:** I read the code directly, and every claim cites the file it came
from. Before writing each headline gap here, I checked a second time by
grepping for its callers.

## How to read this document

| Status | Meaning |
|---|---|
| `implemented` | Code exists, was read, and does what it says |
| `partial` | Mechanism exists but the contract is incomplete |
| `defined` | Declared in a type, constant or table, with no runtime writer or caller |
| `missing` | No implementation found |
| `unverified` | Not traced in this pass. This is not a claim that it is absent |

Maturity uses one scale throughout:

- `stub`
- `UI-only`
- `unit-tested`
- `postgres-tested`
- `simulator-tested`
- `live`

`live` means the code is reachable from the production UI or cron against real
data. It does **not** mean the code was checked against a real provider
tenant. **No provider integration in this repo has been validated live.**

**What was checked, and how.** This audit comes from reading code. No tests
were run in this pass. Test counts come from counting files and `test(` calls:

- 89 unit test files in `tests/`
- 27 Postgres case files in `tests/postgres/`, holding about 215 cases
- 29 legacy suites in `tests/integration/`, of which an npm script reaches only
  7 (§3.24)

Where the code was read but no test exercises the path, the item is marked
*inference*.

---

## 1. Executive summary

Aval already has most of the middleware this directive asks for. It is not a
greenfield. The directive's migration rule is *map, preserve, extend*. That
rule fits here because very little should be deleted.

| Area | What already exists |
|---|---|
| Durable work | Leased and fenced tasks, crash recovery, a step log |
| Attempts | An attempt policy, a failure signature, and stagnation detection that hands off to a human |
| Approvals | Bound to a canonical payload hash, with two-approver tiers |
| Money movement | A financial envelope with a daily-limit reservation |
| Evidence | An evidence ledger, and an operational-facts store with authoritativeness and freshness |
| Expertise | A registry with an audited selection log |
| Customer AI Employees | Scoped authority, in Postgres with row-level security (RLS) |
| Providers | A capability resolver with a certification ladder |

The problem is the **joins**. Each layer is well built and passes its own
tests, but the wiring between layers is often missing. The 09-18 audit found
the same failure mode, and it has moved rather than gone away:

1. **The specialist roster cannot be reached from chat.** The UI hard-codes
   `personaId: 'general'` (`app/components/aval-assistant.tsx:304`), so the
   keyword router in `lib/ask-aval/agent-router.ts` never runs. The eight
   visible agents can be reached only through the agent library and through
   durable tasks.
2. **Ask Aval ignores employees and expertise.** Nothing in `lib/ask-aval/`
   imports either one. Expertise reaches the model only on durable tasks that
   an employee owns, and only as extra prompt text
   (`lib/agents/runtime.ts:194-205,248-253`).
3. **Expertise never narrows the tools.** No caller supplies
   `expertiseCapabilities` (`lib/agents/toolset.ts:49,93`). All 11 seeded
   profiles also have `required_capabilities = []`.
4. **The starter team is never created for real workspaces.**
   `seedWorkspaceEmployees` (`lib/agents/expertise.ts:413`) is called only
   from `tests/postgres/expertise-cases.mjs` and `pms-journey-cases.mjs`.
5. **An employee's authority is capped at the general agent's.** Employee
   tasks run as `agentId 'general'` (`app/api/agents/tasks/route.ts:76`).
   `taskBoundary` then checks `roleForPersona(task.agentId)`
   (`lib/agents/task-boundary.ts:30`). So an employee granted
   `maintenance.create` or `pms.*` would still be refused at the boundary.
   *Inference; no test covers it.*
6. **Employee ownership is lost on delegation.** `goal-plan.ts:111,134`
   creates child tasks with `employeeId: null`. `delegate()` and
   `checkDelegation()` compute the authority intersection, and neither has a
   production caller.
7. **No PMS write can reach `allow` in production.**
   - DoorLoop is blocked in `lib/pms/derive.ts:44`.
   - The only `registerVerifier` call is in the simulator
     (`lib/pms/adapters/simulator.ts:125`).
   - `discoverGrants` and `recordFlow` have no route callers.
   - The AppFolio driver refuses to run while `UNRESOLVED` is not empty.
8. **`post_payment` bypasses the money-movement guards.** It is `critical` and
   executable, but it has no `financial` descriptor
   (`lib/agents/registry.ts:195`). The only tools that do have one,
   `authorize_vendor_spend` and `issue_payment`, are `unimplemented`. So the
   financial envelope is wired in, but no tool that can actually run reaches
   it.
9. **Six capability vocabularies exist side by side.** None of them is the
   entity-shaped taxonomy of directive §11, such as `work_order.create`
   (see §4 below).

The organizational layer the directive asks for does not exist yet: Aval One,
Leads and Specialists. The pieces to build it are all here:

- a persona catalogue with 9 IDs
- an expertise registry with 11 profiles
- 9 starter templates
- AI employees
- a delegation pair table

They are not joined to each other. Nothing maps persona IDs to expertise slugs
or template slugs; the correspondence lives only in a comment
(`lib/agents/expertise.ts:1-11`).

### What closed since the 09-18 audit

| 09-18 gap | Now |
|---|---|
| `PENDING_VERIFICATION` state missing | Defined, and written by the runtime (`runtime.ts:564`) |
| Approval binds identity, not payload | Payload hash is bound (`approval-binding.ts:25`, `canonical-payload.ts`) |
| Inbound PMS mail never becomes work | Seat adjudication calls `intakeEvent` (`app/api/pms/seat/adjudicate/route.ts:96-104`) |
| No attempt/replan model | `work_attempts`, `attempt_policies`, and a stagnation detector, all wired (`runtime.ts:479,887`) |
| No provenance/freshness | `operational_facts` and `action_evidence` (migration `20260919000200`) |

---

## 2. Legacy agent mapping (directive §4)

**Where the IDs live.** Persona IDs are defined in
`lib/ask-aval/persona-catalog.ts:2`, with labels at lines 14-79. They are
copied by hand in two more places:

- `app/components/agent-avatar/personas.ts:10`
- `AgentRole` in `lib/agents/permissions.ts:59-69`, which adds `custom`

**No alias layer.** Kebab-case legacy IDs exist, but for avatars only
(`lib/appearance.ts:50-80`). There is no alias layer for persona IDs.
`roleForPersona` sends any unknown ID to the read-only `custom` envelope
(`permissions.ts:131-134`), so a renamed ID would silently lose its authority.

**What commit `f2aeb29` changed.** It renamed the avatar collections ("Agent
Portraits" and "Team Portraits"), **not** the agents. No agent IDs changed.

| Stable ID | Current label | Expertise slug | Starter template | Envelope highlights | Directive target |
|---|---|---|---|---|---|
| `general` | Ask Aval | — | — | reads all; `messaging.send.external`, `listing.publish` | **Aval One** (orchestrator identity); "Ask Aval" stays as the entry surface |
| `financial` | Financial Analyst | `financial-analysis` | `financial-analyst` | + `pms.arrears.write` | Finance & Accounting Lead |
| `brokerage` | Brokerage & Leasing | `brokerage-leasing` | `brokerage-leasing` ("Leasing Manager") | + `pms.leasing.write`, `listing.publish` | Leasing & Marketing Lead |
| `realEstate` | Real Estate | `real-estate` | `real-estate` | read-only | Property Operations Lead (valuation work → Portfolio & Asset Strategy) |
| `marketResearch` | Market Research | `market-research` | `market-research` | read-only | Market Intelligence & Revenue Strategy Lead |
| `maintenance` | Maintenance | `maintenance` | `maintenance` | `maintenance.create`, `vendor.dispatch`, `pms.maintenance.write` | Maintenance & Facilities Lead |
| `riskAnalyst` | Risk Analyst | `risk-analysis` | `risk-analyst` | reads all, no writes | Risk, Insurance & Compliance Lead |
| `portfolioOutlook` | Portfolio Outlook | `portfolio-outlook` | `portfolio-outlook` | read + provenance | Portfolio & Asset Strategy Lead |
| `leaseReview` | Lease Review | `lease-review` | `lease-review` | `documents.read`, `leases.read` | Lease Administration & Legal Operations Lead |

**Shipped pieces with no persona.** Three shipped expertise profiles have no
persona (`expertise.ts:45-167`):

- `resident-experience` maps to the Resident Experience Lead.
- `vendor-coordination` maps to the Spend & Vendor Operations Lead.
- `escalation` maps to an Aval One escalation behaviour.

The starter template `resident-operations` also has no persona.

**Deep links to preserve.** The format is
`/{locale}?view=agents&agent=<personaId|employeeId>`.

- Emitted at `aval-assistant.tsx:349` and `setup-workspace.tsx:152`.
- Read at `employee-directory.tsx:191-199`.
- `?view=tasks` and `?view=reviewCenter` both alias to `agents`.
- There are no `/agents/<id>` path routes.

**History to preserve.** These IDs are stored in `agent_tasks.agent_id`,
approvals, audit events and `assistant_chat_entries`. They must stay valid
keys. Leads have to be added as aliases over these IDs, not as renames of them.

---

## 3. Component records

Each record uses the fields the directive lists. The row labels are shortened:
Files, Runtime, Data, Tools, Providers, Permissions, UI, Tests, Maturity, then
Reuse / Modify / Deprecate, and Why.

### 3.1 Ask Aval

| | |
|---|---|
| Files | `app/api/assistant/ask/route.ts:10-24`; `lib/ask-aval/handler.ts:52-125` (system prompt at :33-50); `loop.ts:36-163` (max 4 rounds, :20); `agent-router.ts:135-162`; `personas.ts:38-52`; `tools.ts`; `faithfulness.ts`; UI in `app/components/aval-assistant.tsx` |
| Runtime | UI → `POST /api/assistant/ask` (`personaId:'general'`) → `resolvePersona` → `assembleToolset` (no employee, `handler.ts:96`) → `runAskAvalLoop` → `executeTool` → faithfulness gate → audit. "Agent work" mode, or a selected employee, goes to `POST /api/agents/tasks` (the durable runtime) instead |
| Data | `assistant_chat_entries`, plus usage and audit tables. The persona itself is a TypeScript constant |
| Tools | `TOOLS` in `lib/ask-aval/tools.ts:40-224`, narrowed by the toolset (§3.2) |
| Providers | Only the workspace's own model connection (`model-router.ts:117-150`): Claude OAuth, ChatGPT OAuth, or OpenAI-compatible keys |
| Permissions | `policy.evaluate` runs on every call; guests cannot write (`policy.ts:117`) |
| UI | Chat rail, docked on every module (`ca4d887`) |
| Tests | `agent-router` (8), `persona-tool-access` (4), `agent-injection-redaction` (10), chat panel/turn/minimal (7); Postgres `minimal-chat-cases` (6) |
| Maturity | `live` |
| Reuse / Modify / Deprecate | Reuse the loop, faithfulness gate and toolset. Modify the routing and the persona hard-code. Deprecate nothing |
| Why | This is the only production entry point, and it becomes the Aval One surface. Its orchestration today is keyword routing, which the UI switches off |

### 3.2 The eight visible agents

| | |
|---|---|
| Files | `lib/ask-aval/persona-catalog.ts:14-79` (`{id,label,systemPromptAddition,toolNames}`); envelopes in `lib/agents/permissions.ts:87-128`; delegation pairs in `delegation-rules.ts:34-51`; avatars in `app/components/agent-avatar/personas.ts` |
| Runtime | Reachable through the library deep link and through `POST /api/agents/tasks { agentId }`. Auto-routing cannot be reached (§1, gap 1). Every persona also gets the shared support tools (`personas.ts:50`) |
| Data | No table. The IDs persist as `agent_tasks.agent_id` |
| Tools | Each persona has its own subset (see the table in §2) |
| Permissions | One envelope per persona. `taskBoundary` still uses them as the subjects of authority |
| UI | Folders in the agent library (`employee-directory.tsx:185`) |
| Tests | `agent-router` (8), `persona-validation` (8), `agent-policy` (13), `agent-delegation` (9), `agent-orchestration` (16) |
| Maturity | `live` as addressable personas. Auto-routing is `unit-tested` only |
| Reuse / Modify / Deprecate | Reuse the IDs as stable legacy keys. Modify: collapse the three copies of the IDs and add an alias layer. Deprecate nothing |
| Why | Authority, history and deep links are all keyed on these IDs |

**A third kind of agent exists: custom personas.** They use the
`custom_personas` table, `lib/ask-aval/custom-personas.ts` and
`GET/POST /api/agents`, and they get the read-only `custom` envelope. They
must be either mapped into "Your employees" or deprecated on purpose. They must
not be dropped silently.

### 3.3 Customer-created AI Employees

| | |
|---|---|
| Files | `lib/agents/employees.ts` (statuses :20, scope kinds :26, transitions :47, `createEmployee` :174); `employee-access.ts:17-50`; `app/api/agents/employees/**` |
| Runtime | `POST /api/agents/tasks {employeeId}` forces `agentId='general'` (`tasks/route.ts:76`). The runtime loads the owner, scopes and envelope (`runtime.ts:179-193`), then assembles tools with the employee's capabilities (:207-215). Access is checked again before execution (:589) and in `executor.ts:85-88` |
| Data | `ai_employees` (`20260919000800:22-47`): name, role, objective, instructions, status, autonomy_mode, approval_policy, spend_limit_cents, risk_ceiling, memory_scope, may_communicate_externally, may_delegate. Also `ai_employee_scopes` (property, connection, capability, work_type, data_domain, delegate_to), `organizations.ai_employee_limit`, and `agent_tasks.employee_id` |
| Permissions | `employeeEnvelope` (`policy.ts:189-201`) takes precedence over the persona envelope in `evaluate`. RLS lets org_admin and regional_manager write |
| UI | Create dialog (`employee-directory.tsx:246-255`); setup drawer with access, expertise and memory tabs; employee picker in chat |
| Tests | Postgres `employee-cases` (16), `employee-api-cases` (5), `employee-folder-cases` (2), `setup-graph-cases` (5) |
| Maturity | Data model `postgres-tested`. The join into execution is `partial` |
| Reuse / Modify / Deprecate | Reuse; this is almost exactly directive §27. Modify the gaps below. Deprecate nothing |
| Why | Four gaps. (1) Authority is capped at the general agent's (§1, gap 5). (2) Ownership is lost on delegation (§1, gap 6). (3) `spend_limit_cents` and `risk_ceiling` are never enforced. (4) The template chips copy only name, role and objective (`employee-directory.tsx:252`) |

### 3.4 Expertise profiles and library

| | |
|---|---|
| Files | `lib/agents/expertise.ts` (`SHIPPED_EXPERTISE` :45-167, `STARTER_TEMPLATES` :193-230, `selectExpertiseForWork` :340, `assignEmployeeForWork` :467); `expertise-routing.ts` (weights :75, threshold 2, max 4) |
| Runtime | Only on durable tasks an employee owns: the selected profiles' instructions are appended to the system prompt. `intake.ts:93` also uses it for assignment |
| Data | `expertise_profiles` (`20260919001000:18-35`): slug, name, description, capability_tags, domains, routing_signals, required_capabilities, instructions, risk_ceiling, version, enabled. Also `employee_expertise`. `expertise_selections` is audit-only; its UPDATE permission is revoked. **11 profiles are seeded**, with a null org. A workspace can shadow a profile by reusing its slug |
| Missing vs directive §7 | Task boundary, trigger types, prerequisites, expected inputs and outputs, completion contract, forbidden actions, approval requirements, allowed delegations, preferred collaborators, evaluation suite, maturity state |
| Tests | `agent-expertise-routing` (13); Postgres `expertise-cases` (9), including a check that the TypeScript list matches the SQL seed |
| Maturity | `postgres-tested`. Its only effect is briefing the prompt |
| Reuse / Modify / Deprecate | Reuse as the base for the Specialist registry. Modify: extend the schema. Deprecate nothing |
| Why | It is data-driven, versioned and audited, and it is exactly where 266 profiles belong. Today it is too thin to count as an executable expertise profile |

### 3.5 Work / Task / WorkItem persistence

| | |
|---|---|
| Files | `lib/agents/task-state.ts:11-43` (states) and :108-134 (transitions); `tasks.ts` (`createTask` :106, `claimTask` with compare-and-set, skip-locked and fencing :186, `updateTask` :236, retry :301, cancel cascade :319/:350); `goal-plan.ts`; `task-boundary.ts` |
| Runtime | `advanceTask` (`runtime.ts:130`) → `planReadiness` → `claimTask` → a step loop that checkpoints after each step → `finish` |
| Data | `agent_tasks` (`db/postgres/schema.ts:1206`), `agent_task_steps` (append-only, with an idempotency key), `agent_plan_nodes`, `agent_checks`, `agent_model_contexts`. There is **no database CHECK on `status`**. The comment at `schema.ts:1227` lists 7 states and is out of date |
| States | Defined (15): QUEUED, RUNNING, WAITING_FOR_TOOL, WAITING_FOR_APPROVAL, PENDING_VERIFICATION, WAITING_FOR_HUMAN, WAITING_FOR_PROVIDER, WAITING_FOR_RESIDENT, WAITING_FOR_VENDOR, WAITING_FOR_DOCUMENT, SCHEDULED, BLOCKED, COMPLETED, FAILED, CANCELLED |
| | **Missing** compared with directive §17: PLANNING, WAITING_FOR_OWNER, WAITING_FOR_APPLICANT, WAITING_FOR_AGENT, SUPERSEDED |
| | **Defined but never written** anywhere in `lib/` or `app/` (grep-verified): WAITING_FOR_RESIDENT, WAITING_FOR_VENDOR, WAITING_FOR_DOCUMENT, SCHEDULED, BLOCKED |
| Waits | A single `next_attempt_at` column. There is no wait reason, no counterparty, and no recheck policy per wait |
| Permissions | Default-deny org RLS; worker-role policies; the step log is append-only |
| Tests | `agent-task-state`, `agent-task-sql`; Postgres crash-resume, planner, read-model, workflow-lifecycle |
| Maturity | `postgres-tested` for leases, fencing and transitions |
| Reuse / Modify / Deprecate | Reuse. Modify the gaps below. Deprecate nothing |
| Why | Five gaps. (1) WAITING_FOR_HUMAN and BLOCKED can only be exited by cancelling, because neither is claimable (`tasks.ts:373-374`). (2) `OPEN_STATES` in `read-model.ts:23` leaves out every provider, resident, vendor, document, scheduled and blocked wait, so that work does not appear in `openWork` (grep-verified). (3) Superseded plan nodes are cancelled with a raw update that skips the transition table (`goal-plan.ts:124`). (4) The task is still a run record. It is not the WorkItem with subjects (property, unit, resident, lease, vendor) that directive §8 needs; this gap from 09-18 is still open. (5) Resuming from PENDING_VERIFICATION goes back to the model instead of re-running verification (`runtime.ts:397,616-618,686`). *Inference: `crash-resume-cases.mjs:134` tests only the claim layer* |

### 3.6 AgentRun / attempt state

| | |
|---|---|
| Files | `attempt-policy.ts` (defaults :74-114; `resolveAttemptPolicy` :151; `detectStagnation`, window of 3, :252); `work-attempts.ts` (`attemptSignature` = hash of tool, args and failure, :77); `tool-failure.ts:80`; `retry-policy.ts:3` (max 4, backoff 30 s → 10 min) |
| Runtime | A provider or model error → `scheduleTaskRetry` (`runtime.ts:914-920`). Check repair runs at :398-420. Replan runs through `replanAfter` at :470. Stagnation → human handoff (:479, :887) |
| Data | `attempt_policies`, `work_attempts` (unique on task + kind + number) |
| Tests | `agent-attempt-policy`, `agent-retry-policy`, `agent-tool-failure`; Postgres `replan-cases` drives the full runtime |
| Maturity | `postgres-tested` |
| Reuse / Modify / Deprecate | Reuse; retry and replan really are separate, as directive §18 asks. Modify the gaps below. Deprecate nothing |
| Why | Five gaps. (1) Tool-execution failures are recorded as `kind:"replan"` (`runtime.ts:867`) and use up the replan budget; the `execution` kind is never written. (2) Stagnation detection mixes attempt kinds (:478, :886). (3) `attemptHistory` has no caller. (4) `riskClass` is always null. (5) RLS lets any org member write `attempt_policies` (`20260919000300:66-78`) |

### 3.7 Delegation

| | |
|---|---|
| Files | `delegation-rules.ts` (`DELEGATION_RULES` :34-51, `effectivePermissions` :62-65, `checkDelegation` :79-110); `delegation.ts` (`delegate` :35, ancestor cycle walk capped at 16 steps :77-91, `delegationRefusal` :105-137); `MAX_DELEGATION_DEPTH = 2` (`policy.ts:75`) |
| Allowed pairs | general → financial, leaseReview, maintenance, riskAnalyst, brokerage. financial → leaseReview, maintenance. riskAnalyst → leaseReview, financial, maintenance. portfolioOutlook → leaseReview, financial. brokerage → leaseReview. Employees may delegate only to the actors in their `delegate_to` scopes |
| Runtime | `plan_goal` → `writeGoalPlan` → `delegationRefusal` (`goal-plan.ts:109-112`) → `createTask` for each child. The narrowing that actually runs comes from `validatePlanNodes` (`goal-plan.ts:47`) and the per-ancestor check in `taskBoundary` |
| Tests | `agent-delegation` (9), `agent-orchestration` (16); Postgres `employee-cases` (`delegate_to` cycles), `planner-cases` |
| Maturity | Persona-to-persona delegation is `live`. `delegate()` and `checkDelegation()` are `defined` with no caller (grep-verified). Employee delegation is `postgres-tested`, but only in isolation |
| Reuse / Modify / Deprecate | Reuse the cycle detection and the depth cap. Modify: the pair table needs Lead and Specialist entries, and the intersection needs wiring in. Deprecate nothing |
| Why | Directive §6's effective-toolset intersection is exactly `effectivePermissions`, and nothing calls it. No UI grants `delegate_to`, so a plan rooted at an employee probably cannot delegate at all. *Inference* |

### 3.8 PMS intake / synchronization

| | |
|---|---|
| Files | `app/api/sync/route.ts`; `lib/integrations/sync-worker.ts:13` (QuickBooks, Buildium); `lib/operations/import-apply.ts`; `worker/pms-seat-inbound.ts`, `worker/pms-seat-reader.ts`; `lib/pms/inbound/*`; `app/api/pms/seat/adjudicate/route.ts` |
| Runtime | **API import:** cron (`lib/workers/scheduled-sweep.ts:28-31`) → one leased page per connection → `applyImport`. **Seat mail:** Email Worker → R2 → reader cron every 5 minutes → adjudicate (bearer token checked with a constant-time compare) → DMARC/DKIM against the org's allowlist → `integration_events` → `intakeEvent(trustState:"verified")` |
| Data | `integration_sync_state`, `sync_runs`; `source_provider` and `source_connection_id` provenance on properties, units, residents and lease_residents; seat tables `organization_seat_slugs`, `pms_seat_messages`, `pms_seat_senders`, `pms_seat_sender_addresses` |
| Tests | Unit `pms-mime`, `pms-inbound-authentication`, `pms-seat-disposition`, `pms-sender-domain`; Postgres `seat-sender-cases` |
| Maturity | Import is `postgres-tested`, with no live account (`docs/ONBOARDING_AND_CONNECTIONS.md:31`). Seat capture is `postgres-tested`. Extracting entities from seat mail is a `stub`: the parser registry is empty (`lib/pms/inbound/notifications.ts:1-22`) |
| Reuse / Modify / Deprecate | Reuse. Modify: add read adapters keyed by capability, and fill the parser registry. Deprecate nothing |
| Why | The reads are real but branch on provider (`sync-worker.ts:58`). Nothing dispatches reads by canonical capability |

### 3.9 PMS write tools

| | |
|---|---|
| Files | `lib/pms/tool-map.ts:18-29` (10 tools); `tool-schemas.ts`; `tools.ts:34`; `execute.ts:65-101`; `adapters/doorloop.ts`; `browser/drain.ts`; `app/api/pms/runner/route.ts`; `desktop/providers/appfolio.cjs`; `registry.ts:187-202` |
| Runtime | Agent turn → PMS availability narrowing (`toolset.ts:85` → `assembly.ts:78` → `capability.ts:66`) → `runPmsWriteTool` → `executePmsWrite`, which checks again. Then either an API adapter runs, or a `pms_write_queue` row is written. For queued rows, the desktop runner claims the row, checks the digest, then reconciles, executes and verifies over IPC |
| Data | `pms_write_queue` (unique on org + idempotency key), `pms_write_authorizations`, `pms_action_flows` (nullable org, lifecycle, certification) |
| Tools | `create_work_order`, `update_work_order_status`, `close_work_order`, `dispatch_vendor`, `create_payment_plan`, `post_payment`, `reply_to_inquiry`, `book_viewing`, `send_application`, `update_lease_status`. All have `requiresApproval:true`. `MANDATORY_HUMAN_CHECKPOINT` covers the inquiry reply and the application send (`lib/pms/types.ts:199-202`), and it is enforced again at `execute.ts:88-97` |
| Tests | Unit `pms-tools`, `pms-provider-driver`, `pms-flow-steps`, `pms-semantic-*`; Postgres `pms-write-cases`, `browser-write-cases`, `runner-api-cases`, `pms-journey-cases`, `pms-adversarial-cases` |
| Maturity | `simulator-tested`. **Zero** production writes are possible (§1, gap 7) |
| Reuse / Modify / Deprecate | Reuse; the idempotent queue, digest-bound flows and verify-after-write are the right base for adapters. Modify the gaps below. Deprecate the duplication between `create_maintenance_work_order` and `create_work_order`: merge them into one capability with an `aval_native` adapter. The `fallback:"aval_native"` field already exists (`flows.ts:204`) |
| Why | Six gaps. (1) The model supplies the `provider` argument itself (`tool-schemas.ts:38,75`). (2) No mapping exists from Aval IDs to provider IDs; `property_id` is passed straight through. (3) `claimForRunner` filters flows by org, but shipped flows have a NULL org (`drain.ts:~273` vs `flows.ts:76`), so a write against a shipped flow would be abandoned at the claim step. (4) The "reseal" of the shipped `'seeded'` digest that the migration describes is not implemented. (5) Nothing on the server answers the grant question for UI-driven providers. (6) There are two adapter registries: `WriteAdapter` (`flows.ts:20-43`) and `ProviderDriver` |

### 3.10 Approval policies

| | |
|---|---|
| Files | `approvals.ts` (`requestApproval` :80, `decideApproval` :188); `approval-rules.ts:43` (self-approval refused only at critical risk, :57); `approvals-ttl.ts:9` (24 h); `approval-binding.ts:25`; `canonical-payload.ts:38,81`; `financial.ts` (tiers :69, idempotency :130, two approvers :152); `execution-policy.ts:159` |
| Runtime | The executor checks the financial policy and its version (`executor.ts:145-156`) → reservation (:211-249) → the runtime stores the payload hash with the approval and parks the task (`runtime.ts:822`) → the decision is settled through `approvalMatchesToolUse` (:984). The worker expires stale approvals and runs reconciliation (`worker.ts:56,69`) |
| Data | `agent_approvals`, `agent_approval_decisions` (unique per approval and user), `agent_execution_policies`, `approval_authorities` (amount caps enforced in SQL), `agent_financial_operations` and `_events` |
| Tests | `agent-approvals`, `agent-approval-binding`, `agent-financial`, `agent-financial-policy-form`, `agent-reconciliation`; Postgres pilot and audit cases |
| Maturity | Approval binding is `postgres-tested`. The financial envelope is `unit-tested`, but no tool that can actually run reaches it |
| Reuse / Modify / Deprecate | Reuse. Modify the gaps below. Deprecate nothing |
| Why | Three gaps. (1) `post_payment` and `create_payment_plan` are `critical` but have no `financial` descriptor (grep-verified), so neither gets an amount tier, a daily limit or an allowlist. Directive §25 requires money movement to use controlled transaction services. (2) The UPDATE policy on `agent_approvals` admits the operator and property_manager roles (`20260911000400:130`). Going by the policy text, the database would not stop such a user from writing the status directly. *Inference.* (3) Nothing reads the employee's `spend_limit_cents` or `risk_ceiling` |

### 3.11 Evidence, verification and completion

| | |
|---|---|
| Files | `checks.ts` (`TaskCheck` kinds: evidence, delivery, preference, plan; `checkTask` :56); `verification.ts` (`verifyExternalEffects` :193); `evidence.ts` (`executionVerdict` :100, where a contradiction outranks a confirmation; verifier registry :140-153); `semantic-review.ts`, `document-evidence.ts`, `transcript-evidence.ts`; `facts.ts` (`recordFact` :114, `actionableFact` :285) |
| Runtime | `completeAnswer` runs the document number gate → `checkTask` → the effect sweep → the attempt policy, and only then sets COMPLETED (`runtime.ts:386-575`). **The worker does verify before it completes** |
| Data | `action_evidence` (provider_reread, provider_event, human_confirmation, document, aval_native). `operational_facts` carries the source type, authoritativeness (authoritative, reported, inferred, human_confirmed), confidence, `expires_at` and `freshness_policy`, and a conflict/supersede state |
| Tests | Postgres `facts-evidence-cases` (~20) and `verification-cases`; unit tests for document and transcript evidence |
| Maturity | `postgres-tested` as a layer. It is joined to a provider only for the simulator |
| Reuse / Modify / Deprecate | Reuse; in substance this is directive §19 and §26. Modify the gaps below. Deprecate nothing |
| Why | Six gaps. (1) There are no completion contracts per work type, only four generic check kinds, so §19's ladder ("lead created ≠ contacted") cannot be expressed yet. (2) `registerVerifier` exists only in the simulator, so real external effects park at PENDING_VERIFICATION and end in WAITING_FOR_HUMAN. (3) `recordEvidence` has a single caller, and nothing writes evidence from webhooks, humans, documents or delivery receipts. (4) `actionableFact` has no caller, so actions are not gated on how fresh their facts are. (5) Facts are written only for properties and units. (6) The UPDATE policy on evidence and facts admits any org member (`20260919000200:86-102`). Directive §26's seven trust classes are a superset of today's four authoritativeness levels, so the levels can be extended rather than replaced |

### 3.12 Provider connections / capabilities

| | |
|---|---|
| Files | `lib/pms/types.ts` (`PmsAction` :122-140, mechanisms :21-38); `providers/index.ts`; `capability-rules.ts:76-205` (supported → permitted → path → probe → probed → granted → enabled → signed); `grants.ts`; `browser/adapter.ts:174-222` (`ProviderDriver`); `browser/certification.ts:100-108`; `flows.ts:160-196`; `app/api/pms/{matrix,session,workflows}` |
| Permissions | The routes require `canManagePolicy`. RLS on `pms_action_flows` admits four roles, which is broader than the route gate |
| Tests | `pms-capability`, `pms-descriptors`, `pms-certification`, `pms-deployments`; Postgres `workflow-lifecycle-cases` |
| Maturity | The resolver and lifecycle are `postgres-tested`. The certification harness is `unit-tested`; no route runs it |
| Reuse / Modify / Deprecate | Reuse the `ProviderDriver`, the multi-step resolver and the certification ladder; this is the model directive §12 describes. Modify: use entity-shaped capabilities, extend `ProviderDriver` to API adapters, and add an access mode and ranking per connection. Deprecate the duplicate adapter registries |
| Why | The certification ladder already maps onto directive §32's maturity states |

Certification state by provider:

| Provider | State |
|---|---|
| AppFolio | Driven through the UI on the desktop, `permitted:false`. `simulator_e2e_tested` on a **draft** flow; it has never touched AppFolio itself |
| DoorLoop | API adapter written, but **no test imports it** (its header cites a test file that does not exist). Blocked from connecting |
| Buildium, Entrata, RealPage, Rent Manager, Rentvine, Yardi | Descriptors only; they resolve to `unlearned` |

No provider has reached `customer_authorized_ui_tested`, `sandbox_tested` or
`live_provider_tested`.

Two provider docs are out of date to different degrees. `docs/aval/PMS_ACCESS_AUDIT.md`
(09-20) is stale (§8 lists what it gets wrong). `PROVIDER_CERTIFICATION.md`
(09-21) is closer to the code.

### 3.13 Dashboard operational tables

| | |
|---|---|
| Files | `app/api/operations/overview/route.ts:16-45`; `lib/operations/summary.ts:88`; `lib/operations/dashboard-state.ts:7-45` (states PREVIEW, SYNCING, EMPTY, LIVE) |
| Real data | Every tile and chart on Overview, Properties, Leasing, Maintenance and Accounting reads Postgres through `/overview`. Only Buildium (property, unit, lease, work) and QuickBooks (accounting) unlock LIVE. PREVIEW shows a labelled "0" and decorative shapes; it never invents business values |
| No backing source | The widget board (clock, weather, calendar, localStorage reminders) holds personal data, not property data. The notifications drawer is never filled (`dashboard-client.tsx:496,504`). The Infrastructure view always shows an empty panel, even though `/api/infrastructure/*` exists. Insights and conflicts are computed on the server but never rendered. `app/components/charts.tsx` has no importers (grep-verified) |
| Tests | `dashboard-state`, `sample-data`, `agent-tools-live-data` |
| Maturity | `unit-tested` |
| Reuse / Modify / Deprecate | Reuse. Modify: render insights and conflicts. Deprecate the orphaned `charts.tsx` |
| Why | No provider grants `lead.read`, so leads imported from Meta leave the Leasing view in PREVIEW. *Inference* |

### 3.14 Communication ingestion

| | |
|---|---|
| Files | `app/api/webhooks/[provider]/route.ts` (Slack, WhatsApp, Telegram, Apple Messages, Twilio; HMAC checks :80-110; quarantine :28); `lib/communications/{polling,gmail-sync,intake,maintenance-intake,providers,store,tools}.ts` |
| Runtime | Webhook or poll → upsert into `conversations` → insert into `messages` (deduplicated) → `inbound_pending` → `createTask` called directly (`intake.ts:43`) → an auto-reply **draft**, which is never sent automatically |
| Data | `conversations` (channel, externalThreadId, contactDisplayName), `messages` (direction, body, payloadJson), `communication_inbox_state`, `inbound_pending`, `communication_deliveries`, `aval_private.webhook_quarantine`. **There are no columns for a normalized sender, for trust or provenance, or for linked entities.** The sender and the match live inside `payloadJson` |
| Tools | `read_conversation`, `list_conversations`, `get_communication_channels`, `send_external_message` and `place_call` (both approval-gated), `read_maintenance_context`, `create_maintenance_work_order`, `publish_listing` |
| Tests | Postgres `conversation-cases`, `intake-cases`, `maintenance-cases`; `communications-routing` |
| Maturity | `postgres-tested`, not validated live |
| Reuse / Modify / Deprecate | Reuse. Modify: normalize the message envelope per directive §15, and route webhooks through `intakeEvent` with a trust state (today there are two intake paths). Deprecate the ad-hoc metadata in `payloadJson` |
| Why | Three gaps. (1) The quarantine is write-only; nothing drains it. (2) Maintenance matching works only for Gmail (`maintenance-intake.ts:11`). (3) Going by the code, inbound reply tasks carry a delivery check and cannot reach COMPLETED without a person. *Inference* |

### 3.15 Maintenance / work-order tooling

| | |
|---|---|
| Files | `lib/operations/maintenance.ts:52-391`; `metrics/maintenance.ts`; `lib/communications/maintenance-intake.ts`; `app/api/operations/{work-orders,vendors,maintenance}` |
| Data | `work_orders` (four lifecycle timestamps, vendorId, estimate and actual cents, callbackOfWorkOrderId); `vendors` (including `insuranceExpiresAt`). RLS is scoped by property |
| Tools | `get_maintenance_performance`, `read_maintenance_context`, `create_maintenance_work_order`, plus the 4 PMS maintenance writes |
| UI | Charts only. **No UI calls `/api/operations/work-orders` or `/vendors`**, so there are no screens for the queue, creation or assignment |
| Tests | Postgres `maintenance-cases`, `pilot-cases`, `pms-write-cases`, `intake-cases`; unit `operations-maintenance` |
| Maturity | The Aval-native path is `postgres-tested`. The PMS path is `simulator-tested` |
| Reuse / Modify / Deprecate | Reuse; this is the most complete domain. Modify: add scheduling, permission-to-enter and a vendor UI. Deprecate nothing |
| Why | There is no appointment or schedule entity beyond `startedAt`. The `vendor_insurance_lapsed` insight exists (`lib/operations/insights.ts:45`) |

### 3.16 Leasing tooling

| | |
|---|---|
| Files | `lib/operations/leasing.ts:43-413`; `metrics/funnel.ts`; `lib/marketing/service.ts:9-40` (Meta publishing and lead import); `app/api/operations/{leads,leases,leasing,residents,units}`, `app/api/marketing` |
| Data | `leasing_leads`, with stage timestamps from inquired to signed, plus lost. **There are no listing, showing, application or screening tables** |
| Tools | `get_leasing_funnel`, `get_leasing_velocity`, `get_marketing_channels`, `publish_listing` (Meta only), plus the 4 PMS leasing writes (no adapter; `WORKFLOW_WRITE_DEFAULT.leasing="off"`) |
| Tests | Unit `operations-funnel`. **No Postgres test covers createLead or advanceLead** |
| Maturity | Leads and the funnel are `unit-tested`. Meta publishing is written and reachable, but not validated live. The PMS leasing writes are `defined`. Showings, applications and screening are `missing` |
| Reuse / Modify / Deprecate | Reuse. Modify: add Application, Showing and ScreeningResult entities. Deprecate nothing |
| Why | The Fair Housing human checkpoint is hard-coded and enforced twice. It should become the gate pattern for every Specialist that faces applicants |

### 3.17 Accounting / financial tooling

| | |
|---|---|
| Files | `lib/operations/accounting.ts:57-410`; `metrics/{financials,receivables}.ts`; `lib/finance/money.ts` and `metrics.ts` (NOI, cap rate, DSCR, IRR, amortization); `lib/agents/financial*.ts`, `reconciliation-rules.ts`; `lib/integrations/quickbooks.ts:62` |
| Data | `ledger_entries`, `gl_accounts` (`isTrustAccount`), `gl_transactions`, financial operations and events. **There are no owner-statement, distribution, invoice/AP or bank-reconciliation tables.** `ownership_entities` is never referenced in `lib/` |
| Tools | `get_accounting_breakdown`, `get_operating_statement`, `get_delinquent_accounts`, `create_payment_plan`, `post_payment` |
| Tests | `operations-financials`, `operations-receivables`, `finance-money`, `finance-metrics`, `agent-financial`, `agent-reconciliation` |
| Maturity | Reporting is `unit-tested`. The money-movement envelope has no tool that reaches it (§3.10) |
| Reuse / Modify / Deprecate | Reuse; the money arithmetic is deterministic, which satisfies directive §25. Modify: attach `financial` descriptors to the arrears writes. Deprecate nothing |
| Why | The Owner, Investor & Client Services domain has no data model yet |

### 3.18 Lease / document tooling

| | |
|---|---|
| Files | `lib/documents/{types,store,extraction}.ts` (a verbatim quote for each field, and "leave blank rather than infer"); `lib/agents/document-evidence.ts`; `app/api/documents/**` |
| Data | `documents` (title, kind, contentText; capped at 60k characters). **There is no link to lease or property IDs, no blob storage, and no abstract table.** Extraction results are returned to the UI and **not saved** (`extract/route.ts:29-35`) |
| Tools | `list_documents` and `read_document`. Both return `numbers:[]`, so figures from documents never count as verified evidence |
| Tests | Unit `agent-document-evidence`. **No test covers `extractDocumentFinancials`** |
| Maturity | `unit-tested`; extraction is untested |
| Reuse / Modify / Deprecate | Reuse. Modify: link documents to entities, save reviewed abstracts, and extract critical dates. Deprecate nothing |
| Why | The Lease Administration Lead needs LeaseVersion and Notice entities, and neither exists |

### 3.19 Market / web tooling

| | |
|---|---|
| Files | `lib/agents/expertise.ts:80-88` (framing only); loss-to-lease computed from `units.marketRentCents` (`lib/operations/metrics/occupancy.ts:141-158`) |
| Tools | **None.** There is no web-search, comparables, public-data or pricing tool. Grep confirms that `comparable` appears only in comments and metric variable names |
| Providers | None. The catalogue has no market-data provider |
| Maturity | `stub` |
| Reuse / Modify / Deprecate | Reuse the expertise slot. Modify: new tools are needed. Deprecate nothing |
| Why | **No antitrust or data-sharing guardrail exists**, because there is no pricing tool for it to guard. Directive §23 therefore applies to greenfield work here, which makes this the easiest point to build the guardrail in |

### 3.20 Risk / compliance tooling

| | |
|---|---|
| Files | The Fair Housing checkpoint (`lib/pms/types.ts:188-202`, `execute.ts:88-97`); `lib/agents/redaction.ts` (withholds by default in audit digests and approval cards); `lib/security/rate-limit.ts` and `constant-time.ts`; an AppFolio terms-of-service note flagged "NOT yet read … by counsel" (`providers/appfolio.ts:46-55`) |
| Missing | Screening compliance, adverse action, rules that depend on jurisdiction (only a comment at `lib/infrastructure/plumbing.ts:14`), insurance policies, incidents, lead-paint disclosure, the accommodation workflow |
| Tests | `agent-injection-redaction`, `agent-tool-hardening`, `org-scoping-isolation`, `guest-isolation`; Postgres `pms-adversarial-cases` |
| Maturity | The checkpoint, redaction and rate limiting are `unit-tested` or `postgres-tested`. Everything else is `missing` |
| Reuse / Modify / Deprecate | Reuse. Modify: turn `MANDATORY_HUMAN_CHECKPOINT` into policy records that are versioned, sourced and jurisdiction-aware (directive §22). Deprecate nothing |

### 3.21 Setup / connection graph

| | |
|---|---|
| Files | `lib/setup/workspace-graph.ts:21-52`; `app/api/setup/workspace-graph/route.ts`; `setup-workspace.tsx`, `setup-canvas.tsx` |
| Runtime | A projection, with no graph table behind it. It reads the connections, runs `resolveMatrix` for PMS rows, and runs `assembleToolset` for each employee as `agentId:'general'` |
| Maturity | `postgres-tested` (`setup-graph-cases`) |
| Reuse / Modify / Deprecate | Reuse. Modify: show session health, grants and certification. Deprecate the binary "online" chip |
| Why | For OAuth and credential providers, "connected" is set only after real verification. For desktop PMS connections, `/api/pms/session` writes `status:"connected"` on **any** session report, including an expired one (`session/route.ts:193-196`, grep-verified). The canvas then shows "online", which overstates the connection's health. This is exactly what directive §30 warns about |

### 3.22 APIs and routes

- **Pages.** There are two:
  - `app/[locale]/page.tsx`, the single-page dashboard.
  - `app/[locale]/mobile/page.tsx`, a redirect.
- **Views.** Each view is chosen with `?view=`: overview, agents, setup,
  inbox, properties, leasing, maintenance, accounting, infrastructure,
  calendar, projects, teams, connections, documents, settings. `tasks` and
  `reviewCenter` both alias to `agents`.
- **API routes.** About 60 routes live under `app/api/`.
  - Agent-related: `agents`, `agents/[id]`, `agents/default`,
    `agents/employees/**`, `agents/tasks/**`, `agents/approvals`,
    `agents/policy`, `agents/memory`, `agents/recommendations`,
    `agents/health`.
  - Also relevant: `assistant/*` and `pms/*`.
- **Routes with no UI consumer.** These are working backends waiting for UI.
  Do not delete them.
  - `operations/*`, except `overview`
  - `insights/decision`
  - `infrastructure/bills*` and `infrastructure/summary`
  - `agents/health`
  - `audit`
- **Compatibility constraint.** New tabs (`All agents`, `Your employees`,
  `Aval One & Leads`, `Expertise library`) should be sub-states of
  `?view=agents`, for example `&tab=`. Existing `&agent=<id>` links must keep
  working.

### 3.23 Background workers / queues

| | |
|---|---|
| Runtime | The App Worker cron runs every minute (`wrangler.deploy.jsonc:14-17`) → `runScheduledSweep` → `due_worker_organizations` → for each org, isolated jobs (imports, communications polling, agents, inbound-pending retry). `runAgentWorkerBatch` handles 8 tasks, one at a time, with 35 s and 3 steps per invocation. A fast path uses `waitUntil` in the tasks and approvals routes. Seat inbound is an email-only Worker that writes to R2; the reader runs every 5 minutes |
| Restart | Work survives a restart through expiring leases with a generation fence, a transcript checkpoint after each step, and mutations reserved before they execute (Postgres `crash-resume-cases`) |
| Maturity | `postgres-tested`; deploy configs exist |
| Reuse / Modify / Deprecate | Reuse. Modify the gaps below. Deprecate nothing |
| Why | Three gaps. (1) There are no Cloudflare Queues or Durable Objects; cron is the only scheduler, which limits throughput if work fans out across 266 Specialists. (2) Audit events are buffered in memory and written only at finish, yield or retry (`runtime.ts:280-285`), so an invocation that crashes loses its audit events even though its step log survives. (3) Nothing drains the webhook quarantine |

### 3.24 Tests and fixtures

| Suite | Count | How it runs |
|---|---|---|
| Unit (`tests/*.test.*`) | 89 files | `npm run test:unit` |
| Postgres (`tests/postgres/*-cases.mjs`) | 27 files, ~215 cases | `npm run test:postgres` or `test:postgres:local`; also in CI (`postgres-foundation.yml`) |
| Legacy integration (`tests/integration/*.integration.mjs`) | 29 files | **Only 7 are reachable**, because unit tests import them. About 22 run under no script or CI job, including `agent-runtime`, `chat-approvals`, `semantic-review` and `agent-plan-contract`. They use `node:sqlite` with the old `drizzle/*.sql` schema, so they are probably stale |
| Migration | 4 files | `npm run test:migration` |
| Browser E2E | none | Only `scripts/smoke-production-readiness.mjs`, run after deploy |

The last full-run figures on record are 768 unit and 218 Postgres tests
(session notes, 2026-09-22). They were **not re-run in this pass.**

---

## 4. Capability vocabularies in use

Directive §11 asks for a single entity-shaped taxonomy, such as
`work_order.create`. Six vocabularies exist today:

| Vocabulary | Location | Shape | Example |
|---|---|---|---|
| `PmsAction` | `lib/pms/types.ts:122-140` | `<workflow>.<object>.<verb>` | `maintenance.work_order.create` |
| `DashboardCapability` | `lib/operations/dashboard-state.ts:20-29` | entity | `lease.read` |
| `Permission` | `lib/agents/permissions.ts:23-56` | mixed | `pms.maintenance.write`, `vendor.dispatch` |
| PMS tool names | `lib/pms/tool-map.ts:18-29` | verb_object | `create_work_order` |
| Aval-native tool names | `lib/communications/tools.ts` | verb_object | `create_maintenance_work_order` |
| Priority enums | several files | inconsistent | `low\|medium\|high\|emergency` vs `routine\|urgent\|emergency` |

`PmsAction` is already provider-independent, and `ProviderDriver` already
calls it the canonical capability (`browser/adapter.ts:178`).

Recommended path:

1. Adopt the directive's entity names as the canonical key.
2. Keep the `PmsAction` values as aliases, because flows and certifications
   are keyed on them.
3. Map tool names and permissions onto the canonical capabilities in one
   table.

Do not rename stored `PmsAction` keys in place: that would invalidate the
`pms_action_flows` digests.

---

## 5. Directive §8 domain entities: what exists and what is missing

**Entities that exist** (all org-scoped, with RLS):

| Area | Entities |
|---|---|
| Agents and work | Organization, HumanUser, AIEmployee, ExpertiseProfile, AgentRun (as `agent_tasks`), Attempt, Evidence, Approval, AuditEvent, OperationalFact |
| Property records | Property, Unit, Resident, Lease, Household/Occupancy (as `lease_residents`), Charge/Payment (as `ledger_entries`) |
| Maintenance | WorkOrder, Vendor (with insurance expiry) |
| Accounting | GeneralLedgerAccount, JournalEntry (as `gl_transactions`) |
| Leasing, messages, documents | Lead (as `leasing_leads`), CommunicationThread/Message, Document |
| Providers | ProviderConnection, ProviderCapability/CapabilityGrant (in connection metadata), ProviderWorkflow, CertificationRecord (on flows) |
| Utilities | UtilityAccount/Bill, as `utility_meters` and `utility_bills`, keyed by a text `propertyLabel` with **no foreign key** |

**Defined but unused:** `ownership_entities`, `portfolios`, `regions`.

**Missing:**

| Area | Entities |
|---|---|
| Work and structure | WorkItem (as distinct from the run), Objective, Building, UnitType, KnowledgeSource, WorkflowVersion (as its own record) |
| Owners | Owner as a party, OwnerGroup, ManagementAgreement |
| Leasing and screening | Prospect, Showing, Application, Applicant, ScreeningResult, AdverseActionRecord |
| Lease administration | LeaseVersion, LeaseRenewal (only `renewalOfLeaseId` exists), Addendum, Notice, Deposit (only `depositCents` exists) |
| Receivables | DelinquencyCase, PaymentPlan, CollectionsPlacement |
| Maintenance and turns | MaintenanceRequest, Technician, Bid, PurchaseOrder, Part/Inventory, PreventiveMaintenancePlan, Turn, MakeReadyTask, Inspection, InspectionFinding, KeyAccessRecord |
| Accounting and owner money | Bill/Invoice (AP), BankAccount, Reconciliation, Budget, OwnerStatement, OwnerDistribution, OwnerContribution |
| Risk and compliance | InsurancePolicy, Incident, Claim, RiskAssessment, ComplianceRequirement, RegulatoryDeadline, AccommodationRequest, FairHousingReview |
| Utilities | Submeter, SustainabilityMetric |
| Whole domains | All HOA, Commercial and Subsidy/Affordable entities |

Extend the existing near-matches rather than creating duplicates. For example,
`leasing_leads` should become the Lead/Prospect record.

---

## 6. Migration recommendation (entry into Phase B)

This order follows directive §38. Each step names the gap it closes.

1. **Add an organization registry, additively.** Add `lib/agents/organization.ts`
   containing:
   - Aval One, as an alias of `general`.
   - 22 Leads, each with a `legacyPersonaId` where one exists (table in §2).
   - 266 Specialists, stored as versioned records in `expertise_profiles` and
     extended with the fields §3.4 lists as missing.

   Make this module the single source of persona IDs, which removes the three
   copies, and give it an alias resolver. Keep the database seed and the
   TypeScript catalogue under a parity test, as today.
2. **Fix the employee authority gaps before adding more agents.** Adding 266
   Specialists on top of gaps 5 and 6 in §1 would multiply those gaps.
   - Stop employee tasks from inheriting the general agent's boundary.
   - Make `goal-plan` pass `employeeId` down to child tasks.
   - Wire `effectivePermissions` into delegation.
   - Supply `expertiseCapabilities`.
3. **Make routing reachable.** Either have the chat UI send the agent the user
   chose, or run `routeToPersona` and expertise selection when the user
   addresses no one. Directive §6 requires an explicit choice to stay
   meaningful.
4. **Put `post_payment` and `create_payment_plan` under the financial
   contract** before any Finance or Receivables Specialist is given them.
5. **Add wait metadata and the missing states.**
   - New states: WAITING_FOR_OWNER, WAITING_FOR_APPLICANT, WAITING_FOR_AGENT,
     SUPERSEDED, PLANNING.
   - Store a wait reason and a counterparty for each wait.
   - Give WAITING_FOR_HUMAN a way out other than cancelling.
   - Fix `OPEN_STATES`.
   - Add a CHECK constraint on status.
6. **Build the agent library UI** (directive §28).
   - Use sub-tabs under `?view=agents`.
   - Use progressive disclosure: never show all 266 cards by default.
   - Keep maturity and fixture labels out of customer-facing UI.
7. **Write a completion contract for each work type** in the Phase C domains
   that already have real data paths: maintenance, leasing leads, resident
   communication, lease/document review, and accounting reads.

These come later (Phase D or beyond) and should not block Phase B:

- the domain entities listed in §5
- jurisdiction policy records
- market and pricing tools, together with their antitrust guard
- verifiers for real providers

---

## 7. Open questions for the product owner

1. **Custom personas.** `custom_personas` predates AI Employees. Should
   custom personas move into "Your employees", stay a separate kind, or be
   retired with a data migration?
2. **Seeding the starter team.** Should new workspaces get the starter
   employees automatically? The code and the test titles assume they do, but
   production never creates them. Directive §5 says "do not automatically
   create 22 employees", which says nothing either way about the 9 existing
   starters.
3. **Where "Aval One" appears.** Should "Ask Aval" stay as the visible label
   on the chat rail, with "Aval One" appearing only in the agent library
   (directive §4)?
4. **How Specialists execute.** Directive §7 offers three models:
   deterministic, expertise loaded into the current run, or a bounded child
   run. The runtime supports the second today. Child runs exist only as plan
   nodes, and delegation depth is capped at 2. Should the Lead → Specialist
   hop count against that depth?

---

## 8. Stale documents and comments found

- `docs/aval/PMS_ACCESS_AUDIT.md` (2026-09-20) is wrong in three places:
  - It says the runner, drain and adapter are missing. They now exist.
  - It lists Yardi as UI/desktop. The descriptor says API/cloud.
  - It calls DoorLoop `UNIT_TESTED`. No test imports that adapter.
- `lib/pms/adapters/doorloop.ts:10` cites `tests/pms-doorloop.test.ts`, which
  does not exist.
- The comment at `db/postgres/schema.ts:1227` lists 7 task states. There are
  15.
- `lib/agents/registry.ts:156-160` calls the communication tools "declared,
  not yet wired". They have executors.
- `lib/agents/expertise.ts:401-408` says the eight agents are seeded as
  employees. That is true only in tests.
