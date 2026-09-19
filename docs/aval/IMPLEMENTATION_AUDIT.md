# Aval Agent Architecture — Implementation Audit

**Date:** 2026-09-18
**Tree:** `main`, clean working tree
**Specs audited against:** `AVAL_AGENT.md` v1.0.0, `AVAL_MASTER_AGENT_PRODUCT_CONTEXT(1).md`
**Method:** Code read directly. Every status below cites the file it was read from.

## How to read the status column

| Status | Meaning |
|---|---|
| `implemented` | Code exists, was read, and satisfies the requirement |
| `partial` | Mechanism exists but does not meet the specified contract |
| `missing` | No implementation found |
| `conflicting` | Implementation contradicts the specification |
| `unverified` | Not traced in this pass — explicitly not a claim of absence |

**Inspected vs. tested.** Everything below is *code inspection* unless the
Verification column says otherwise. The only behavior actually executed in this
pass was `npm run typecheck` (exit 0). No integration suite, unit suite, or
provider call was run. Nothing here should be read as live-validated.

---

## 1. Executive summary

The repository is substantially further along than a greenfield reading of the
specs would suggest. A real durable agent runtime exists: `lib/agents/` is ~40
modules including a deterministic policy engine (`policy.ts`), an execution
authorizer (`executor.ts`, 20 KB), a durable state machine (`task-state.ts`),
worker leases with heartbeat (`tasks.ts`), bounded retry, constrained
delegation, financial reservation with a DB-enforced unique index, and an
independent semantic reviewer (`semantic-review.ts`).

The gaps are **not** "the runtime is missing." They are three specific joins and
one contract mismatch:

1. **`agentTasks` is a run record, not a `WorkItem`.** It is bound to a chat
   goal and a single user. It carries no property/unit/resident/lease/vendor
   subjects, no source channel or trust state, no completion criteria, no
   waiting-on, no ownership beyond `userId`.
2. **Four of eleven required work states do not exist**, including
   `PENDING_VERIFICATION`. Without it, an accepted-but-unconfirmed external
   action has no state to occupy.
3. **Verified inbound PMS mail never becomes owned work.** `lib/pms/inbound/`
   authenticates, records, and adjudicates seat messages and then stops.
4. **Approval binds proposal identity, not canonical payload.**

Items 1–3 are the same failure mode: each layer is well built and passes its own
tests; the wiring between them is absent.

---

## 2. Requirement-by-requirement

### 2.1 Canonical durable work independent of chat sessions

**Requirement** — `AVAL_AGENT.md` §2 ("Canonical unit of work: `WorkItem`, not
chat, session, run, or inbox thread"), §5.1.

**Current implementation** — `db/schema.ts` `agentTasks`; `lib/agents/tasks.ts`.
Columns: `id`, `organizationId`, `userId`, `agentId`, `goal`, `status`,
`executionScopeJson`, `transcriptJson`, `stepCount`/`maxSteps`,
`tokensUsed`/`maxTokens`, `executionAttempts`/`nextAttemptAt`, `parentTaskId`,
`delegationDepth`, `cancelRequested`, `leaseOwner`/`leaseExpiresAt`/
`lastHeartbeatAt`, `resultJson`, `error`.

**Status** — `partial`.

Present and genuinely durable: persistence, leases, crash recovery, retry,
cancellation, delegation lineage. Absent relative to §5.1: `kind`, `source`
(`channel`, `source_id`, `trust_state`), `subjects` (`property_ids`,
`unit_ids`, `resident_ids`, `lease_ids`, `vendor_ids`, `provider_refs`),
`ownership` (`owning_team_id`, `owning_human_id`, `accountable_principal_id`),
`priority`, `risk_class`, `oversight_mode`, `completion_criteria`,
`dependencies`, `due_at`, `next_wake_at`, `waiting_on`.

**Operational impact** — Work cannot survive a channel change, cannot be owned
by a team or vendor, and cannot be found by property or resident. A resident
emailing twice from two addresses produces two unrelated runs. The command
center in §19.2 cannot be built on this shape because the fields it must
display do not exist.

**Proposed change** — Add a `work_items` table implementing §5.1 and demote
`agentTasks` to the `TaskRun` of §5.3, joined by `work_item_id`. Do not widen
`agentTasks` in place: run-scoped columns (`transcriptJson`, `leaseOwner`,
`tokensUsed`) are correctly per-attempt and must not become per-work-item.

**Dependencies** — None. This is the root node; items 2.3, 2.5, 2.7 depend on it.

**Verification** — Migration test asserting a work item outlives N task runs;
a test attaching a second inbound message to an existing open item.

---

### 2.2 Work state machine

**Requirement** — §5.2, eleven states.

**Current implementation** — `lib/agents/task-state.ts`. Defines seven:
`QUEUED`, `RUNNING`, `WAITING_FOR_TOOL`, `WAITING_FOR_APPROVAL`, `COMPLETED`,
`FAILED`, `CANCELLED`, with an explicit `TRANSITIONS` table and `canTransition`.

**Status** — `partial`. Missing `WAITING_FOR_HUMAN`, `WAITING_FOR_EXTERNAL`,
`SCHEDULED`, `PENDING_VERIFICATION`.

**Operational impact** — `PENDING_VERIFICATION` is the most consequential
omission. §7.5 requires: "If an action is accepted but not confirmed, the
correct state is `PENDING_VERIFICATION` or `WAITING_FOR_EXTERNAL`, never
`COMPLETED`." With neither state available, an action a provider accepted but
has not confirmed must be recorded as `COMPLETED` or `FAILED`. `COMPLETED` is a
false completion, which §17.2 lists as a non-negotiable release blocker for
safety-, financial-, legal-, access-, and lease-sensitive workflows.

The absence of `WAITING_FOR_EXTERNAL` and `SCHEDULED` means a vendor ETA or a
weekly lease-expiration sweep has no durable representation, so §54 proactive
follow-up cannot be built.

**Proposed change** — Extend `TASK_STATES` and `TRANSITIONS`; the table-driven
design makes this additive. Gate `COMPLETED` behind satisfied completion
criteria (2.5).

**Dependencies** — 2.1 for `waiting_on` / `next_wake_at` storage.

**Verification** — Unit tests on the transition table; an integration test that
an accepted-unconfirmed write lands in `PENDING_VERIFICATION`, not `COMPLETED`.

---

### 2.3 Inbound PMS mail → durable work

**Requirement** — §7.1 intake; §30–33 of the product context; invariant 10
("No task disappears because a provider is unavailable or read-only").

**Current implementation** — `lib/pms/inbound/`: `authentication.ts`
(SPF/DKIM/DMARC parsing, `verifySender`, `domainMatches`), `messages.ts`
(`recordSeatMessage`, `seatReview`, `seatMessageCounts`), `adjudicate.ts`
(`adjudicateSeatMessage`), `disposition.ts`, `notifications.ts`.

**Status** — `missing` (the join, not the layer).

`grep` for `createTask|agentTasks|enqueueTask` across `lib/pms/` returns
nothing. Sender verification, allowlisting, pending-sender review, and
disposition are implemented to a high standard. The pipeline terminates at a
recorded, adjudicated message.

**Operational impact** — This is the product's headline loop — resident or PMS
email becomes owned, followed-through work — and it is not connected. A verified
maintenance email is stored and never actioned. No acknowledgement, no
ownership, no SLA, no follow-up.

**Proposed change** — On `adjudicateSeatMessage` returning a verified,
non-quarantined disposition, create or attach to a `WorkItem` with
`source.channel = "email"`, `source.trust_state`, and the resolved subjects.
Attachment must use §13.5 deduplication; ambiguous matches create a separate
item or enter review, never a silent merge.

**Dependencies** — 2.1 (`WorkItem` with `source` and `subjects`); entity
resolution for resident/unit/property (status `unverified`, see 2.9).

**Verification** — Integration test: verified inbound message produces exactly
one work item; redelivery of the same message produces none; an ambiguous
resident match produces a review item rather than a merge.

---

### 2.4 Models propose, deterministic services authorize

**Requirement** — §2 reasoning boundary; §4.5; invariant 3.

**Current implementation** — `lib/agents/policy.ts` (`evaluate`, `DenyCode`,
`PolicyContext`, `PolicySubject`, `allowedToolNames`);
`lib/agents/executor.ts` re-checks at execution: registry descriptor lookup,
`requiredPermission` against workspace role, financial policy via
`execution-policy.ts`, policy-version equality, argument-shape validation, and
`policy_decision` audit rows on both allow and deny;
`lib/agents/permissions.ts` per-agent envelopes; `lib/agents/registry.ts`
(17 KB) typed descriptors.

**Status** — `implemented`.

This closes the authorization inversion the earlier `docs/AGENT_ARCHITECTURE_AUDIT.md`
identified as P0. `executor.ts:96` denies on missing role; `:149` denies when
the financial policy version changed after approval. Tool schemas shown to the
model are hints; the executor does not trust the tool name it receives.

**Operational impact** — None outstanding for the currently wired tool surface.

**Proposed change** — None to the mechanism. It should be the enforcement point
for new write tools rather than being bypassed by them.

**Verification** — `tests/postgres/*.integration.mjs` exists but was not run in
this pass. Status of that lane is `unverified`; see §4.

---

### 2.5 Evidence-based completion

**Requirement** — §2 ("Completion: evidence-based, domain-specific, and
independently checked"); §5.7 `Evidence`; §7.5; §14.25; invariant 9.

**Current implementation** — `lib/agents/checks.ts` (10 KB), `agent_checks`
table, `lib/agents/semantic-review.ts` (11 KB) with a reviewer that holds no
action tools, `lib/agents/document-evidence.ts`,
`lib/agents/transcript-evidence.ts`, `lib/agents/semantic-evidence.ts`.

**Status** — `partial`.

What exists is a strong *answer*-verification layer: numeric faithfulness
against stored observations, plus an independent model review whose source
packet excludes actor prose and refuses oversized context rather than
truncating. That addresses truthfulness of analysis.

What does not exist is the §5.7 `Evidence` record type (source, capture time,
subject, validity interval, integrity metadata, sensitivity) or per-workflow
`CompletionCriterion`. Completion today is "the reviewer passed the answer,"
not "every completion criterion is satisfied by acceptable, fresh evidence."

**Operational impact** — Acceptable while the tool surface is read-only. It
becomes a §17.2 release blocker the moment a write tool can be called, because
there is no structure in which "the provider returned 200" is distinguished
from "an independent read confirms the work order exists."

**Proposed change** — Add `Evidence` and `CompletionCriterion` per §5.7; make
the `COMPLETED` transition require satisfied criteria; keep `semantic-review`
as one evidence *producer* labeled non-authoritative per §5.7.

**Dependencies** — 2.1, 2.2.

**Verification** — Test that a criterion requiring read-after-write cannot be
satisfied by a model assessment alone.

---

### 2.6 Approval bound to exact payload

**Requirement** — §2 ("binds a canonical payload hash"), §5.4 (canonicalization
must make material changes hash differently), §8.4, §15 acceptance test
("One-byte material change invalidates approval"), §17.2 release blocker
("any approval payload mismatch accepted").

**Current implementation** — `lib/agents/approval-binding.ts`:

```ts
export function approvalMatchesToolUse(evidenceJson, toolUse, approvedToolName) {
  if (toolUse.name !== approvedToolName) return false;
  const evidence = JSON.parse(evidenceJson);
  return typeof evidence.toolUseId === "string" && evidence.toolUseId === toolUse.id;
}
```

Called once, at `lib/agents/runtime.ts:650`.

**Status** — `partial`, trending `conflicting`.

The approval binds the **identity of a model proposal** (`toolUse.id`), not a
**canonical hash of its payload**. No `payload_hash` is computed, stored, or
compared on the approval path. `executor.ts` does compute `digestPayload(...)`
for audit rows, but that digest is not what gates approved execution.

**I did not construct an exploit and am not claiming a demonstrated
vulnerability.** In the present single-turn flow the input travels with the
tool-use block that carries the matched id, so the two are coherent in practice.
The finding is a contract gap with a real structural consequence: there is no
mechanism that would reject a mutated payload, so the §15 acceptance test is
satisfied incidentally rather than enforced, and an approval cannot be bound to
an intent re-proposed in a later run.

**Operational impact** — Blocks the §22 checklist item "Does a material edit
invalidate approval?" from being answered yes on evidence.

**Proposed change** — Canonicalize the payload per §5.4 (stable key order,
normalized numbers/whitespace), store `payload_hash` on the approval, and
compare it in `approvalMatchesToolUse` alongside the id. Keep the id check;
add the hash.

**Dependencies** — None. This is small, self-contained, and high value.

**Verification** — Test mutating one byte of an approved payload and asserting
denial; test that semantically identical payloads with reordered keys still match.

---

### 2.7 Review Center

**Requirement** — §19.3; product context §65.

**Current implementation** — `app/api/agents/approvals/route.ts` (GET pending
evidence, POST decision); `app/components/agent-approval-prompt.tsx`;
surfaced inside `app/components/agent-task-conversation.tsx` and
`app/components/agent-trace.tsx`.

**Status** — `partial`.

Approvals are real, expiring, append-only, and role-gated. They are presented
**inside a task conversation**, not as a standalone queue prioritized by risk,
deadline, resident impact, and blocked downstream work.

**Operational impact** — A reviewer must know which conversation to open. The
§65 categories beyond tool approval — ambiguous classification, low-confidence
decisions, policy exceptions, unknown-sender approval, conflicting data,
specialist disagreement — have no surface. Notably, the pending-sender review
that `lib/pms/inbound/messages.ts:seatReview` already computes has no Review
Center to appear in.

**Proposed change** — A Review Center route aggregating agent approvals and
`seatReview` output, sorted by risk and deadline, showing exact intent and
payload diff per §19.3.

**Dependencies** — 2.6 for payload diff.

---

### 2.8 Provider capability vs. authorization

**Requirement** — §5.9, §9.5, product context §12, §43, §88.

**Current implementation** — `lib/pms/capability.ts` (`resolveCapability`,
`resolveMatrix`, `allowedActions`), `lib/pms/capability-rules.ts` (pure
decision), `lib/pms/grants.ts`, `lib/pms/enablement.ts`, `lib/pms/flows.ts`,
`lib/pms/deployments.ts`, `lib/pms/providers/`.

**Status** — `implemented` in substance, `partial` in shape.

Capability is resolved from grants + enablements + executable paths (registered
API adapters or learned UI flows) + whether a grant probe exists — the
least-destructive-probe discipline §12 asks for. Capability is correctly
separated from authorization.

Not present: the §5.9 descriptor's `health` (`healthy|degraded|read_only|
reauth_required|disabled`), `data_freshness`, `last_verified_at`, and
per-operation `idempotency`/`verification`/`rate_limits`. So §9.5 provider
truthfulness ("if a provider is read-only or degraded, Aval MUST say so
plainly") has no field to read.

**Proposed change** — Extend the descriptor with health and freshness; surface
in Connections per §37.

---

### 2.9 Areas not traced in this pass

Listed explicitly so absence of a finding is not read as absence of a problem.

| Area | Status | Note |
|---|---|---|
| Tenant isolation end-to-end (RLS, caches, queues, vector) | `unverified` | Postgres RLS is generated by `npm run db:postgres:rls`; policies not read, not executed |
| Entity/identity resolution (§85) | `unverified` | No module located; required by 2.3 |
| Memory promotion pipeline (§10.2) | `unverified` | `agentMemory` table and `lib/agents/*` memory paths not traced |
| Shared Inbox ↔ work linkage | `unverified` | `lib/communications/` not traced |
| Leasing / maintenance domain behavior (§14.18–14.19) | `unverified` | Not traced |
| Oversight modes (supervised/assisted/autonomous) backend enforcement | `partial` | `lib/agents/autonomy.ts` and `autonomy-storage.ts` exist; not read |
| Idempotency for non-financial writes | `unverified` | `financial-reservation-sql.ts` covers financial only |

---

## 3. Invariant conformance (§2.1)

| # | Invariant | Status | Evidence |
|---|---|---|---|
| 1 | Tenant-scoped before retrieval | `partial` | org from session (`lib/integrations/session.ts:45`); RLS unverified |
| 2 | External write bound to durable work + idempotency key | `partial` | idempotency financial-only |
| 3 | Write authorized at execution with current facts | `implemented` | `executor.ts` |
| 4 | High-risk write bound to exact approved payload | `partial` | binds id, not hash — 2.6 |
| 5 | No credential in model context | `implemented` (inspected) | vault refs; not secret-scanned this pass |
| 6 | External content cannot grant authority | `implemented` | retrieved text is not a policy input |
| 7 | No model output becomes verified knowledge alone | `partial` | candidate pipeline unverified |
| 8 | No delegation widens authority | `implemented` | `delegation-rules.ts`, depth cap |
| 9 | No completion without evidence | `partial` | no `PENDING_VERIFICATION` — 2.2, 2.5 |
| 10 | No task lost to unavailable provider | `missing` | inbound never creates work — 2.3 |
| 11 | No cross-tenant session/cache/memory | `unverified` | — |
| 12 | Material decisions attributable | `partial` | audit chain strong; four-part attribution (§6.2) absent |

---

## 4. Checks run

Executed on this tree, 2026-09-18.

| Check | Result |
|---|---|
| `npm run typecheck` | **pass** (exit 0) |
| `npm run test:unit` | **pass** — 609 tests, 608 pass, 0 fail, 1 todo |
| `npm run lint` (project code) | **pass** — 0 errors, 5 warnings |
| `npm run lint` (as scripted) | 20,013 errors — **environmental, not code** |
| `npm run test:postgres` | **cannot run** — unmet dependency |
| `npm run build` | not run |

Notes:

- **The single non-passing unit test is deliberate.** `tests/pms-sender-domain.test.ts:106`
  is marked `{ todo: "policy decision open" }` and asserts the behavior the team
  has *not* chosen yet: whether a `generic_email` workspace may allow a consumer
  mailbox domain. It is a visible open question, not a defect.
- **The lint error count is local-environment noise.** 20,013 of the 20,013
  errors come from `.claude/worktrees` (132 files) and `.remember/tmp` — agent
  tooling directories that the `--ignore-pattern dist --ignore-pattern .next`
  flags do not exclude. Re-running with those paths ignored yields 0 errors and
  5 `<img>` warnings, consistent with `docs/AGENT_RUNTIME.md` (which recorded
  three; two more have since been added). **Recommendation:** add `.claude/`
  and `.remember/` to the lint ignore set so the signal is not buried.
- **The Postgres lane is blocked on an unmet local dependency, not a defect.**
  Both `tests/postgres/application.integration.mjs` and `spike.integration.mjs`
  fail at import with `Set AVAL_TEST_DATABASE_URL to a disposable local
  PostgreSQL database`. The lane's correctness is therefore **unverified**; it
  is not evidence of breakage. Running it requires a disposable Postgres and
  that variable set.

### 4.1 Correction to §2.6

The pre-existing `tests/agent-approval-binding.test.ts` showed approval evidence
already carrying an `arguments` field that was never compared. That strengthens
the finding: the payload was being *recorded* for the reviewer and *not* used as
the binding. It also could not have been — the recorded arguments are a redacted
summary, so a hash must be taken from the raw input separately.

---

# Part II — End-to-end trace of the PMS coordinator

**Date:** 2026-09-18. Code inspection unless stated. Corrections to Part I are
marked.

## 5. Confirmed findings

### 5.1 How inputs enter Aval — **confirmed**

| Path | Entry | Terminus |
|---|---|---|
| Scheduled | `worker/index.ts:67 scheduled()` → `lib/workers/scheduled-sweep.ts` | drives imports, comms polling, `runAgentWorkerBatch`, isolated jobs |
| Inbound seat mail | `worker/pms-seat-inbound.ts email()` | R2 `unverified/{recipient}/{digest}`; the worker holds no DB |
| Seat sweep | `worker/pms-seat-reader.ts scheduled()` → `lib/pms/inbound/sweep.ts` | `POST /api/pms/seat/adjudicate` |
| PMS/accounting sync | `lib/integrations/sync-worker.ts runImportWorker` | `applyImport` → normalized records |

### 5.2 A persistent runtime outside chat exists — **confirmed**

`scheduled-sweep.ts:41` calls `runAgentWorkerBatch(session, bindings, "scheduled")`.
Durable tasks advance on cron, independent of any open chat. Part I did not
state this; it is the single most important thing the runtime already has.

### 5.3 Normalized shared state exists — **confirmed**

`properties, units, leases, residents, workOrders, ledgerEntries, vendors`,
populated by `applyImport` from QuickBooks and Buildium. Inbound seat mail does
**not** reach these tables; `promoteVerifiedMessage` → `captureNotification`
records a notification and an extraction verdict only.

### 5.4 Delegation and cancellation are real — **confirmed**

`delegation.ts:48` creates a genuine child task with `parentTaskId`,
`delegationDepth + 1`, a reserved budget carved from the parent under a
compare-and-set, and the parent's execution scope copied. `tasks.ts:292
cascadeCancel` propagates cancellation to children.

### 5.5 **Correction to Part I §2.5** — completion criteria do exist

Part I said there was no per-workflow `CompletionCriterion`. That understated
it. `lib/agents/checks.ts parseTaskCheck` requires every task to carry a
machine-checkable completion condition — `evidence` (naming specific read
tools), `delivery` (operation + accepted/delivered status), `preference`, or
`plan` — and refuses task creation without one. The §5.7 `Evidence` *record*
(source, capture time, validity interval, integrity metadata) is still absent,
and that remains the gap; the criterion mechanism is not.

### 5.6 **Correction to Part I §2.3** — PMS writes reach the durable runtime

Part I's "PMS inbound does not create durable agent work" was correct but
narrow, and left a misleading impression. The **write** direction is fully
wired: `lib/agents/registry.ts:176-191` declares nine PMS write tools with risk
class, required permission, `requiresApproval: true`, `idempotent: true` and
`maxRetries: 0`; `lib/agents/executor.ts:31` imports `runTool`, which dispatches
`isPmsWriteTool(name)` → `runPmsWriteTool` at `lib/ask-aval/tools.ts:235`, with
an idempotency key of `${task.id}:${tool.name}:${digest(canonicalAction(args))}`.
What was missing was intake, not execution.

### 5.7 The coordinator could not orchestrate anything — **confirmed, now fixed**

The decisive finding. Authority was enforced as *containment*, in two
independent places:

- `lib/agents/task-boundary.ts` walked **every ancestor** of the executing task
  and required each to satisfy `hasPermission(roleForPersona(task.agentId),
  tool.requiredPermission)`.
- `lib/agents/goal-plan.ts:40` required **both** the parent and the child agent
  to hold every permission a plan node declared.

`general` holds no `pms.*` write. So a coordinator-owned task could not delegate
a PMS write to the specialist that owns it — rejected at plan time by the
first, and at execution time by the second. Since the coordinator is the only
role that receives events, event-driven PMS work had no path at all. The
missing `general → brokerage` delegation edge was a symptom, not the cause.

## 6. What was implemented

| Change | File | Purpose |
|---|---|---|
| Event intake seam | `lib/agents/intake.ts` | Turns an authorized event into durable coordinator-owned work |
| Intake rules (storage-free) | `lib/agents/intake-rules.ts` | Trust gate and deterministic id, unit-testable per the `task-state.ts` convention |
| Orchestration permissions | `lib/agents/permissions.ts` | `ORCHESTRATION_PERMISSIONS` / `canOrchestrate` — route without being able to exercise |
| Ancestor check | `lib/agents/task-boundary.ts` | A non-executing ancestor may route; the executing task must still hold |
| Plan-time check | `lib/agents/goal-plan.ts` | Parent may hold **or** route; child must hold |
| Delegation edge | `lib/agents/delegation-rules.ts` | `general → brokerage`, making `pms.leasing.write` reachable |
| The join | `app/api/pms/seat/adjudicate/route.ts` | Verified captured message → `intakeEvent` |
| Adjudication return | `lib/pms/inbound/{sweep,adjudicate}.ts` | Surfaces the resolved `organizationId` |

Design notes:

- **The coordinator gains no write authority.** `hasPermission` is untouched.
  The leaf check still applies to the task actually calling the tool, so a
  coordinator that calls a PMS write directly is still refused. Only its
  presence in a descendant's *ancestry* stops being a block.
- **Intake work is a `plan` root.** `task-boundary.ts` restricts a plan root to
  managing its plan, so the coordinator structurally cannot perform operational
  work itself — it must decompose into checked child tasks owned by specialists.
- **Dedup is DB-enforced.** The task id is derived from (organization, source,
  sourceId); `createTask` inserts with `onConflictDoNothing` and re-reads, so a
  redelivery returns the existing task. Same discipline as `reserveMutation`.
- **Acceptance is not authority.** `admissible()` refuses any non-verified
  trust state before a query runs.

## 7. Still unverified

| Claim | Why |
|---|---|
| The wired route actually creates work against a real database | Requires Postgres; see §8 |
| A duplicate delivery produces one task *in the database* | Same |
| Crash resume, provider-timeout reconciliation, read-only handoff | Same |
| Child results, external IDs and evidence returning to the parent | Not traced |
| How normalized state reaches the dashboard | Not traced |
| Other agents reading PMS-derived state within permissions | Not traced |

## 8. External dependency blocking end-to-end proof

`npm run test:postgres` fails at import with `Set AVAL_TEST_DATABASE_URL to a
disposable local PostgreSQL database`. Every database-backed proof the brief
asks for — duplicate event, crash resume, timeout reconciliation, read-only
handoff, parent-stays-open — requires that. The logic is implemented and
unit-tested; it is **not** integration-verified.
