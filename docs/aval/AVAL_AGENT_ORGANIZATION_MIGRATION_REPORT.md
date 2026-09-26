# Aval Agent Organization — Migration Report

**Phase covered:** B (organizational model), per directive §38, plus the gap-closure pass (items 1–8, §12) and the capability-architecture pass (§13)
**Date:** 2026-09-25, §13 on 2026-09-26
**Branch:** `phase-b-agent-organization`
**Audit this builds on:** `docs/aval/AGENT_ORGANIZATION_EXISTING_SYSTEM_AUDIT.md`

This report follows the structure of directive §40. Every claim is backed by
code, or by a test that ran in this pass. Anything not verified says so.

---

## 1. Decisions applied

| Decision | What was built |
|---|---|
| 1. Custom personas become AI Employees | Migration `20260925000200` turns every `agent_personas` row into an `ai_employees` row **with the same id**. The persona's tools become read-only capability grants. Its task history gains `employee_id`; `agent_id` is never rewritten. `/api/agents` and `/api/agents/[id]` are now compatibility adapters over employees. `lib/ask-aval/custom-personas.ts` is removed. |
| 2. No automatic starter team | `seedWorkspaceEmployees` is gone. It had no production caller, and now nothing seeds employees at all. There are five optional templates: Resident Operations, Maintenance Operations, Leasing Operations, Portfolio Analyst and Owner Reporting. `createEmployeeFromTemplate` copies each template's capabilities and expertise, not just its name. |
| 3. "Ask Aval" stays; Aval One is the identity | The chat label is unchanged. Aval One is the runtime identity behind it: the historical `general` id, with `aval-one` as an alias. The agent library shows "Aval One · Global orchestrator". |
| 4. Controlled delegation | `DELEGATION_POLICY` (`lib/agents/delegation-policy.ts`) replaces the single `MAX_DELEGATION_DEPTH = 2`. It sets depth 3, fan-out, concurrency, total Work size, a peer-request allowance and a recheck interval. Alongside it: cycle refusal, reuse of duplicate sub-problems, budget carving, cascading cancellation, authority and scope narrowing, a shared Work id, and the existing attempt and stagnation handling. All six acceptance tests you asked for pass against Postgres (§6). |

## 2. Existing capabilities

**Preserved unchanged**

- **The nine historical ids.** `general` and the eight legacy agents keep their exact permission envelopes and tool subsets. A unit test checks each one against `AGENT_PERMISSIONS` and `PERSONAS`.
- **Everything recorded under those ids.** Deep links (`?view=agents&agent=<id>`), task and approval history, audit attribution and PMS deployments all keep resolving. So do the legacy delegation pairs, each of which is still an edge of the new graph.
- **The core runtime.** Durable tasks, leases, approvals, the financial envelope, verification, the PMS capability matrix and no-PMS mode.

**Modified**

- **Authority resolution.** It now goes through `lib/agents/organization` (`actorHolds`, `actorOrchestrates`, `actorMayDelegateTo`) rather than `roleForPersona` alone. An unknown id still gets the read-only envelope.
- **Work owned by an employee.**
  - Where Aval One acts for an employee, the employee's own grant is the authority.
  - A Lead or Specialist working for an employee holds the intersection of its own permissions and the employee's.
  - Child tasks inherit the owning employee.
  - This closes audit gaps 5 and 6.
- **Coordinator routing.** Before, Aval One could route only PMS writes, so Aval One → Maintenance → a work-order Specialist could never act. Now it may route every permission a Lead exercises. It still exercises none of them itself. Money movement, lease execution, access changes and preferences can never be routed.
- **Planning.**
  - A Lead may be a plan node (`{"kind":"plan"}`) and plan for its own team.
  - When a plan is revised, the replaced nodes become `SUPERSEDED` and their descendants are cancelled.
- **Evidence review.** A planner below the root is judged on the evidence gathered under its own plan. That evidence is collected upward through the Leads beneath it.
- **Budget for a coordinating root.** Roots opened by `/api/agents/tasks` or Ask Aval (both through `openWork`) now get 240k tokens (up from 60k) and 60 steps (up from 24). Each hand-off gives a child about half of what is left, so a Specialist two levels down keeps what a single task always had: about 60k tokens and 12 steps. At 24 steps that Specialist got 3, too few to retry, repair a check or be recognised as stuck. These are ceilings: usage caps are still checked on every step.
- **Task states.**
  - Added: `WAITING_FOR_OWNER`, `WAITING_FOR_APPLICANT`, `WAITING_FOR_AGENT`, `SUPERSEDED`. `PLANNING` was added and then removed in the gap-closure pass, because nothing produced it.
  - Every waiting state now has a producer and a wake path (§12, item 4).
  - `OPEN_STATES` now covers every state that is not finished.
  - A database CHECK closes the set. It is added `NOT VALID`, so historical rows are not re-checked.

**Retired**

| Item | Reason |
|---|---|
| Custom personas as a separate concept | Decision 1. The table is kept and marked deprecated; no data was destroyed. |
| The automatic starter team | Decision 2. It never ran in production. |
| `canOrchestrate` in `permissions.ts` | Superseded by `actorOrchestrates`. Its tests now check the resolver the runtime actually uses. |

## 3. Legacy agent mapping

| Historical id | Now | Alias |
|---|---|---|
| `general` (Ask Aval) | Aval One | `aval-one` |
| `financial` | Finance & Accounting Lead | `lead.finance` |
| `brokerage` | Leasing & Marketing Lead | `lead.leasing-marketing` |
| `realEstate` | Property Operations Lead | `lead.property-operations` |
| `marketResearch` | Market Intelligence & Revenue Strategy Lead | `lead.market-revenue` |
| `maintenance` | Maintenance & Facilities Lead | `lead.maintenance` |
| `riskAnalyst` | Risk, Insurance & Compliance Lead | `lead.risk-compliance` |
| `portfolioOutlook` | Portfolio & Asset Strategy Lead | `lead.portfolio-strategy` |
| `leaseReview` | Lease Administration & Legal Operations Lead | `lead.lease-admin` |

Aliases resolve to the historical id, never the reverse, so no stored row is
reinterpreted.

## 4. Organization status

| | Count | Source |
|---|---|---|
| Aval One | 1 | `lib/agents/organization/domains.ts` |
| Leads | 22 | same |
| Specialists | 266 | `lib/agents/organization/specialists/*.ts` |
| Canonical capabilities | 127 in the vocabulary; 124 in use | `lib/agents/organization/capabilities.ts` |

**One source for the counts.** The registry, the API
(`/api/agents/organization`) and the UI all read the same TypeScript registry.
`tests/agent-organization.test.ts` checks the counts.

**Specialists are not seeded into `expertise_profiles`.** That table still holds
the 11 profiles an employee can be briefed from. Built-in actors are reached by
delegation, not by grants. Seeding 266 rows would create a second copy of the
catalogue that could drift from the first.

**What every Specialist carries:**

- a boundary
- a named nearest sibling and how it differs
- triggers
- inputs and outputs
- canonical capabilities
- an execution model
- a completion contract (done / not done)
- forbidden actions
- approvals
- collaborators

The catalogue was drafted with model assistance, then checked by a validator and
by unit tests. **No property-management or legal professional has reviewed it.**
Treat the boundaries and forbidden actions as a reviewed draft, not as legal
policy.

**Readiness** is derived from each Specialist's contract (`lib/agents/organization/contract.ts`), not assigned by hand. The generated list is in `docs/aval/SPECIALIST_READINESS.md`, which is internal and never shown in the UI.

| Readiness | Count | Meaning |
|---|---|---|
| complete | 87 | Every required capability has an implemented tool. |
| analysis-only | 41 | Nothing is missing except proposals a person acts on (prepare, review, recommend, draft). |
| incomplete | 138 | A required read or act has no tool yet. The missing capabilities are listed per Specialist. |
| Provider-tested | 0 | Provider testing belongs to provider workflows, not to Specialists. |

The earlier `TOOLED` / `ROUTABLE` split counted a Specialist as untooled when an *optional* capability lacked a tool. The contract separates required from optional capabilities, and seven new entity reads were added (§12, item 5).

## 5. Customer AI Employee status

- **Unchanged:** creating employees, scoping them, running them, and their lifecycle.
- **Now enforced (Postgres-tested):**
  - An employee's grant is the ceiling of everything its work opens.
  - An employee may use any built-in Lead or Specialist as expertise. This can only narrow authority, because of the intersection rule above.
  - Handing work to another employee still needs an explicit `delegate_to` grant.
- **Not yet enforced:** employee `spend_limit_cents` and `risk_ceiling` (audit §3.10).

## 6. Tests

All of these ran in this pass on the branch:

| Suite | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run i18n:check` | pass (2332 keys) |
| `npm run lint` | 0 errors; 5 warnings, all present before this change |
| `npm run build` | pass |
| `npm run test:unit` | 1054 / 1054 (baseline 768) |
| `npm run test:postgres:local` | 261 / 261 (baseline 224), including every migration applied from clean and replayed as a no-op |

**The six requested acceptance tests** are in `tests/postgres/organization-cases.mjs`:

1. Aval One → Lead → Specialist runs to COMPLETED through the real task route and the real cron, with a scripted model.
2. A Specialist asks a declared peer, waits in `WAITING_FOR_AGENT`, and resumes with the peer's answer. The answer is framed as a peer's view, not a provider fact.
3. A → B → C → A is refused as a loop, even though C is otherwise allowed to reach A.
4. The same question asked twice returns the same task, and the Work does not grow.
5. Authority never expands:
   - a peer request cannot reach a permission the asker lacks;
   - a Lead above a Specialist does not lend it the Lead's permissions;
   - an employee's grant caps its Specialists until the grant is widened.
6. Recursion stops deterministically: at the depth limit, on a chain written past that limit, and at the Work-size limit.

**Also tested:**

- The custom-persona migration. The real SQL runs twice against seeded rows. Ids, names, read-only access and history are preserved, and the second run changes nothing.
- The empty-roster rule. A new workspace has zero employees, and a template creates one employee with its grants.

**Gaps these tests exposed, now fixed.** Each layer had passed its own tests;
the joins between them had not:

- `plan_goal`'s argument schema rejected `{"kind":"plan"}` nodes, so no Lead could ever receive a plan.
- Evidence review assumed every planner is a root, so a Lead's reviewer never saw its team's evidence.
- Evidence did not travel up through a Lead to Aval One.
- The historical 60k root budget left a Specialist two levels down unable to fit its own context.

## 7. UI changes

The agent library now has four tabs, saved in the URL as `&tab=`:

- **All agents:** Aval One, your employees and the Leads.
- **Your employees:** customer-created employees only.
- **Aval One & Leads:** 23 folder cards, in the existing card style.
- **Expertise library:** 22 collapsible domains, each showing its Lead card and a grid of Specialists. Opening a Specialist shows what it does, when Aval uses it, what it needs and produces, what needs approval, what it never does, how it differs from its nearest sibling, and recent work.

Two related changes:

- Maturity labels, execution models and prompt text never reach the UI.
- Template chips now create the employee from the template, grants included.

Limits of this pass:

- **Visually checked in an isolated harness, not a signed-in session.** Local sign-in needs Supabase Auth, and this machine has no container runtime. `tests/visual/library-harness` renders the real library components with fixture data. The pass covered every tab, search, filtering, pagination, creation, migrated personas, the member role, dark theme and narrow widths, and the defects it found are fixed (§12, item 6). A signed-in pass on a hosted or Docker stack is still owed.
- **Catalogue text is English in both locales.** That covers Lead and Specialist names and boundaries. The rest of the UI is translated.

## 8. Provider capabilities and gaps

Unchanged from the audit (§3.9, §3.12). No provider is live-validated, and no
PMS write can succeed in production: DoorLoop is blocked, AppFolio's driver
refuses to run, and there are no real verifiers.

The canonical vocabulary maps onto today's tools and keeps every `PmsAction` as
an alias. `work_order.create` now covers both the Aval-native tool and the PMS
write as one capability with two tools; merging those two adapters is not done
yet.

## 9. Remaining blockers

The first four blockers in the Phase B version of this report are closed (§12, items 1–4). What remains:

1. **138 Specialists are incomplete.** A required read or act has no tool yet (`SPECIALIST_READINESS.md`). Delivering those capabilities is Phase C.
2. **No jurisdiction-aware policy records** (directive §22) **and no market or pricing tools** (§23). The antitrust boundary exists only as briefing and forbidden actions, because there is no pricing tool yet for it to guard.
3. **Catalogue review.** All 266 Specialists need domain review, and 110 need legal or compliance review (`SPECIALIST_CATALOGUE_REVIEW.md`). None has been done.
4. **Ledger writes are not live-validated.** `post_payment` and `create_payment_plan` are on the financial contract and tested against Postgres with fixtures. No PMS tenant has accepted one.
5. **No signed-in visual pass** (§7).
6. **Employee `spend_limit_cents` and `risk_ceiling`** are still not enforced (§5).

## 10. No-PMS functionality

Unchanged and tested (`tests/postgres/no-pms-cases.mjs`). A workspace with no
PMS reaches Aval One, every Lead and every Specialist; only the PMS write tools
are absent.

## 11. Known legal and jurisdiction dependencies

- **Human-gated or prepare-only work.** Every Specialist that touches fair housing, FCRA adverse action, accommodations, notices, evictions, deposits, late fees or rent increases can only prepare the work or needs a person to approve it. That work depends on jurisdiction rule records that do not exist yet.
- **Pricing.** Pricing Specialists are briefed never to use competitors' nonpublic data, never to pool data across organizations, and never to coordinate prices.
- **Review.** Counsel has not reviewed any of this.

## 12. Gap closure (items 1–8)

Every item was tested against Postgres through the public routes, with only the model scripted.

| Item | What changed | Evidence |
|---|---|---|
| 1. Deterministic money movement | `post_payment` and `create_payment_plan` require a currency and are on the financial contract (`destination: "ledger"`). The reservation checks the lease belongs to the workspace and is in the employee's property scope. The provider result settles the operation: `done` → submitted, `queued` → stays reserved, `denied`/`failed` → failed, not executed. | `tests/postgres/payment-safety-cases.mjs` |
| 2. Operating profile | Workspaces record business models and asset classes (Settings → Business, owner-only, audited). Domain eligibility reads it; silence never excludes. A deterministic router names candidate Leads and Specialists, and delegation refuses out-of-profile actors. | `tests/postgres/operating-profile-cases.mjs` |
| 3. Ask Aval on the one path | A turn that asks for specialist work becomes Aval One Work through `openWork`, the same path as `/api/agents/tasks`, and the chat follows it. A read is answered directly. The person never picks a Lead or Specialist. | `tests/postgres/ask-orchestration-cases.mjs` |
| 4. Waiting states | `wait_for` produces every waiting state. Wakes come from inbound messages, documents, verified connections, timers and a person's resume (`POST /api/agents/tasks/[id]`, `action: "resume"`). `PLANNING` is removed. `BLOCKED` and `WAITING_FOR_HUMAN` wake only on an event. | `tests/postgres/waits-cases.mjs` |
| 5. Specialist tooling | Derived contracts (required and optional capabilities, approval classes, fallback, readiness) and seven new entity reads. An evaluation suite covers all 266 Specialists. Tools are decided only by the assembler's intersection chain, and **execution is now bound to it**: a call to a tool the run was not offered is refused before policy. | `tests/agent-specialist-evaluation.test.ts`, `tests/postgres/record-tools-cases.mjs` |
| 6. Agent Library | Browser pass in the isolated harness; the defects it found are fixed (see §7). | `tests/visual/library-harness` |
| 7. Catalogue review | Each field is classed as routing, capability, guidance or legal. Regulated text and regulated domains are flagged. Every briefing states that deterministic policy, not the catalogue, is the authority. | `SPECIALIST_CATALOGUE_REVIEW.md` |
| 8. Hierarchy E2E | Chat turn → `/api/assistant/ask` → durable Work → Aval One → Maintenance Lead → Work Order Creation Specialist → evidence → verified result, then the same path with each failure injected (below). | `tests/postgres/hierarchy-e2e-cases.mjs` |

**Item 8 scenarios, all passing:**

| Injected | Observed |
|---|---|
| None | Every level COMPLETED; the chat turn links the root. Planners are offered only planning tools. The Specialist is offered its read plus `wait_for` and `request_peer_help`, and none of `post_payment`, `create_payment_plan`, `publish_listing`, `dispatch_vendor`, `close_work_order` or `plan_goal`. |
| Transient model failure (503) | Specialist QUEUED with backoff, then COMPLETED on retry. |
| Deterministic denial | `post_payment` refused as not offered; nothing reserved; Specialist replans and COMPLETES. |
| Provider wait | `WAITING_FOR_VENDOR`, untouched by sweeps, woken by an inbound message on its conversation, COMPLETED. |
| Human approval | In assisted mode, a Lead-retained preference write parks `WAITING_FOR_APPROVAL`, is approved through `POST /api/agents/approvals`, and COMPLETES. |
| Cancellation | `DELETE` on the root marks every task cancel-requested and settles each one CANCELLED or SUPERSEDED. |
| Duplicate delegation | The same question to the same actor twice is refused; the Lead replans; one Specialist task runs. |
| Repeated invalid strategy | The third identical refusal hands the task to `WAITING_FOR_HUMAN` as stagnation. Sweeps leave it alone. A person resumes it with a note, and it COMPLETES. |

**Defects the E2E found, fixed in `099bd4a`:**

- The executor enforced permission and policy but not the offered toolset, so a model could run a permitted tool it was never offered.
- Expertise narrowing removed `wait_for`, `request_peer_help` and `write_memory` from every Specialist, so no Specialist could wait or ask a peer.
- The 24-step root left a Specialist under a Lead with 3 steps (see §2).

**Limits.** The model is scripted, and providers are fixtures. This proves the orchestration and its failure handling, not model quality or any live provider.

## 13. Capability architecture (2026-09-26)

Does the 266-Specialist organization map cleanly onto Aval's capabilities and runtime? It now maps as **Specialist → canonical capability → tool resolver**, with every gap named. No Specialist-specific tool was added.

### Requirement audit

`SPECIALIST_REQUIREMENT_AUDIT.md` classifies every missing requirement of the 138 incomplete Specialists at `7d529fb`: 189 pairs over 34 capabilities, each exactly one class, with evidence.

| A wrong mapping | B new capability | C provider workflow | D analysis by design | E decision support | F duplicate | G invalid |
|---|---|---|---|---|---|---|
| 13 | 99 | 52 | 0 | 1 | 22 | 2 |

D≈0 is a finding. The Specialists whose product is analysis had already been separated out. What remained were missing *reads*.

### Normalization (`511e68a`, `8c1dd97`)

- **A:** `document.extract`, `sop.read` and `knowledge.read` now resolve to the document reads. Vendor COI reads `vendor.insurance.read`. Three domain-core reads became `contextOnly` where the Specialist's boundary shows they are context.
- **F:** six duplicate reads were folded into one canonical each (`CONSOLIDATED_CAPABILITIES`). Only Credit Screening Coordination orders a screening report. `task.route` was declared by 43 Specialists to mean "hand this off", which is the hierarchy's job. It now stays only on Staff Task Routing, and `route` is an act.
- **G/E:** On-call no longer claims to route. Workload balancing proposes rather than routes. `task.read` and `staff.schedule.read` name the reads those Specialists need.
- **Readiness is now what a Specialist can execute.** Four "analysis-only" Specialists held executing tools (including `payment_plan.create`), and 77 "complete" ones executed nothing. `lease.execute` counted as tooled although `execute_lease` is unimplemented.

### Readiness now

| | Count |
|---|---|
| EXECUTION_READY | 28 |
| ANALYSIS_ONLY_READY | 128 |
| INCOMPLETE | 110 |

Every analysis-only Specialist carries a derived `AnalysisContract`: the evidence it may read and the tools for it, the evidence it cannot read yet, what it returns, the Lead that consumes it, the approval class of its proposals, what it must never execute, and its completion contract. The evaluation suite asserts each one is offered no mutating tool (`SPECIALIST_READINESS.md`).

### Canonical capabilities

- **Built** (`f70f216`): `owner.read` (`get_owners`) and `turn.read` (`get_turns`), over records Aval already holds.
  - Owners are reached through grant-filtered properties, because `ownership_entities` RLS is org-wide. A one-property grant sees one owner (Postgres case).
  - A turn is derived from unit status, move-out and work orders. It states that scope, budget and target date are not recorded.
- **Defined** (`8255174`): the 26 capabilities still missing. Each has a contract in `capability-contracts.ts`, grouped by domain: what it returns, its risk class, possible sources with what exists in this repo (none), verification, evidence, and what it is blocked on. A test holds the list equal to the live gap set.

### Budgets (`d7ddf66`)

The halving rule was replaced (`budget-model.ts`):
- orchestration: 12 steps at any depth;
- Specialist execution, by contract: 12 execution-ready, 8 analysis-only, 6 incomplete;
- peer help: at most 6;
- retry: no step;
- replan: attempt-policy count;
- waiting on children, peers, approvals or providers: no step.

All of it comes from one pool per Work (120 steps / 600k tokens), reserved under a lock. A child is funded in full or refused, and delegating takes nothing from the delegator. `rootMaxSteps` is gone.

Proven in unit and Postgres cases:
- the three hierarchy shapes;
- a four-way fan-out where the fourth Specialist gets what the first got (the old rule left it 2 steps);
- two delegations racing for a Work's last room: exactly one is funded;
- exhaustion is refused without writing a task;
- a superseded node refunds what it did not spend.

### Invariants at every level (`1cf1e79`, `23a87fb`)

`invariant-matrix-cases.mjs` runs one real chain (Aval One → Lead → Specialist → related Lead as peer) and the same probes through `executeTool` at each level. Each denial is asserted for its named cause:
- unheld permission;
- no widening through a peer;
- held acts gated;
- another person refused;
- peer cycles refused;
- employee grants, with a control;
- cancellation;
- revoked membership.

**Defect found and fixed:** the approval-resume path executed calls that shared the approved call's message without the offered-tools gate. That bypassed expertise narrowing, the PMS matrix and employee capability grants (never permission). A regression test fails on the old code.

Attempt history, retry versus replan, evidence flowing upward and waits are asserted through the E2Es at the Lead and Specialist levels. Every level runs the same `advanceTask`.

### Organization E2E (`5d7f588`)

`organization-e2e-cases.mjs`, through the public routes:
- 16 ready Lead domains complete the whole chain with evidence flowing upward.
- The 6 domains with no ready Specialist are refused by name and handed to a person with the gap in the reason.
- Peer help completes.
- A connection revoked between two turns is refused at execution.
- A provider wait parks without spending steps and completes on reconnection.

With `hierarchy-e2e-cases.mjs`, every requested injection is covered.

Middleware changes this exposed:
- A plan that assigns a Specialist tools it is not offered is refused with the missing capability.
- A planner's hand-off carries the planning refusal.

### Not validated

- **Payments:** `post_payment`/`create_payment_plan` guards pass against fixtures only. No sandbox or live PMS ledger has been exercised: fixture ≠ sandbox ≠ live.
- **Providers:** none of the 26 defined capabilities has a provider. No provider path was exercised against a live tenant.
- **Signed-in UI:** unverified. This machine has no container runtime, so local Supabase Auth cannot run. The Library was checked only in the fixture harness (§7).
- **Employees:** employee-owned Work must be granted coordination (`plan_goal`, `get_goal_plan`) explicitly, like any other capability. This is by design, but setup should surface it.

**Checks at `5d7f588`:** typecheck; 1,066 unit; 281/281 Postgres (harness cluster); i18n parity; production build; lint 0 errors (5 pre-existing warnings in untouched UI files).

