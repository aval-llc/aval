# Aval Agent Architecture — Implementation Plan

**Date:** 2026-09-18
**Companion:** `docs/aval/IMPLEMENTATION_AUDIT.md`

Milestones are dependency-ordered. Each states what it changes, why it comes
where it does, and the acceptance criteria that must pass before the next
milestone starts. Criteria are executable tests unless marked otherwise.

## Guiding constraints

- **Reuse before introduction.** The existing `lib/agents/` runtime satisfies a
  large share of the spec. No Temporal, no graph database, no policy engine, no
  agent framework is introduced. Any new dependency must name the requirement
  that forced it.
- **Additive over rewrite.** `task-state.ts` and `registry.ts` are table-driven;
  extend the tables rather than replacing the modules.
- **Run-scoped stays run-scoped.** `transcriptJson`, `leaseOwner`, `tokensUsed`
  are correctly per-attempt. They do not move to the work item.
- **No milestone claims a workflow production-ready.** Readiness is decided by
  §17.2 release blockers and the `docs/AGENT_PRODUCTION_RUNBOOK.md` gate.

---

## M0 — Establish the verified baseline

**Why first:** The audit could confirm `typecheck` only. `test:runtime` now
aliases `test:postgres` after the Postgres port, and whether that lane passes is
unknown. Every later milestone's "tests pass" claim is meaningless until the
starting line is known.

**Changes:** None to product code. Record results.

**Acceptance:**
- `npm run test:unit`, `npm run lint`, `npm run build` results recorded verbatim.
- `npm run test:postgres` either passes or its blocking dependency (a reachable
  Postgres) is documented with the exact failure.
- Any suite that cannot run locally is named, with the reason, in this file.

---

## M1 — Bind approval to canonical payload

**Why here:** Smallest closed gap with the highest governance value. No
dependencies. Audit §2.6. Task priority 4.

**Changes:**
- New `lib/agents/canonical-payload.ts`: deterministic serialization per
  `AVAL_AGENT.md` §5.4 — sorted keys, normalized numbers, defined treatment of
  null/undefined/empty — and a SHA-256 digest.
- `lib/agents/approvals.ts`: persist `payloadHash` alongside existing evidence.
- `lib/agents/approval-binding.ts`: compare `payloadHash` **in addition to**
  `toolUseId` and tool name. Keep the id check; the hash is added, not swapped.
- Migration adding `payload_hash` to `agent_approvals` (both schemas).

**Acceptance:**
- Mutating one byte of an approved payload is denied.
- Reordering object keys in a semantically identical payload still matches.
- An approval for tool A cannot authorize tool B (existing behavior preserved).
- A pre-existing approval row with a null hash fails closed, not open.

---

## M2 — Complete the work state machine

**Why here:** Additive and table-driven; M3 and M4 need the states to exist
before they can target them. Audit §2.2. Task priority 2.

**Changes:**
- `lib/agents/task-state.ts`: add `WAITING_FOR_HUMAN`, `WAITING_FOR_EXTERNAL`,
  `SCHEDULED`, `PENDING_VERIFICATION` to `TASK_STATES`, `TRANSITIONS`, and
  `ADVANCEABLE_STATES` as appropriate.
- Worker wake-up handling for `SCHEDULED` and `WAITING_FOR_EXTERNAL`.

**Acceptance:**
- Every non-terminal state has a path to a terminal state (property test over
  the transition table).
- No transition out of `COMPLETED`, `FAILED`, `CANCELLED`.
- A task in `SCHEDULED` with a future `next_wake_at` is not claimed early and is
  claimed once the time passes.
- `PENDING_VERIFICATION` cannot transition directly to `COMPLETED` without
  satisfied criteria (enforced in M4; asserted as denied here).

---

## M3 — `WorkItem` as the canonical record

**Why here:** The root node. M5, M6 and the command center all read from it.
Audit §2.1. Task priority 2.

**Changes:**
- New `work_items` table per §5.1: `kind`, `source{channel, source_id,
  received_at, trust_state}`, `subjects{property/unit/resident/lease/vendor/
  provider_refs}`, `ownership{owning_team_id, owning_human_id,
  owning_agent_profile_id, accountable_principal_id}`, `priority`, `risk_class`,
  `oversight_mode`, `completion_criteria`, `dependencies`, `due_at`,
  `next_wake_at`, `waiting_on`, `parent_work_item_id`, `version`.
- `agentTasks` gains `work_item_id`; becomes the §5.3 `TaskRun`.
- Idempotent creation keyed on `(tenant, source.channel, source_id)`.
- Migrations for both `db/schema.ts` and `db/postgres/schema.ts`.

**Acceptance:**
- One work item survives N task runs; run-scoped fields stay on the run.
- Repeated inbound events with the same `source_id` create exactly one item.
- Every work item row is tenant-scoped; a cross-tenant read fails closed.
- Existing tasks migrate with a backfilled work item; no orphan runs.

---

## M4 — Evidence and evidence-gated completion

**Why here:** Requires M2's `PENDING_VERIFICATION` and M3's
`completion_criteria`. Audit §2.5. Task priority 5.

**Changes:**
- `Evidence` record per §5.7: source, capture time, subject, validity interval,
  integrity metadata, sensitivity, and an explicit `authoritative` flag.
- `CompletionCriterion` naming acceptable evidence types and freshness.
- `COMPLETED` transition requires every criterion satisfied by fresh, acceptable
  evidence; otherwise `PENDING_VERIFICATION` or `WAITING_FOR_EXTERNAL`.
- `semantic-review.ts` output recorded as evidence labeled non-authoritative,
  per §5.7's last bullet. Its current behavior is unchanged.

**Acceptance:**
- A criterion requiring read-after-write is **not** satisfied by a model
  assessment alone.
- A provider 200 with no confirming read leaves the item in
  `PENDING_VERIFICATION`.
- Stale evidence (outside the criterion's freshness window) does not satisfy it.

---

## M5 — First end-to-end workflow: verified inbound maintenance mail

**Why this workflow:** Chosen on integration readiness and product value.
Sender authentication, allowlisting, adjudication and disposition are already
built to a high standard in `lib/pms/inbound/`, so the intake half needs no new
provider work. PMS **write** capability is gated per `lib/pms/capability.ts`,
which makes this the honest path: it exercises invariant 10 and §11 (Aval stays
useful when the PMS cannot write) through a tracked human handoff, rather than
requiring a provider write that is not yet authorized.

Audit §2.3. Task priority 6.

**Changes:**
- On a verified, non-quarantined disposition, create or attach to a `WorkItem`
  with source channel, trust state, and resolved subjects.
- Deduplicate per §13.5; ambiguous identity creates a separate item or a review
  item and **never** a silent merge.
- Acknowledgement that is an acknowledgement, not a promise (§14.17).
- Where the provider cannot write: preserve the item, prepare a structured
  handoff, assign a human owner, set `waiting_on` and `next_wake_at`, follow up.
- Truthful status through the existing Tasks UI.

**Acceptance:**
- Verified message → exactly one work item; redelivery → none.
- Ambiguous resident match → review item, not a merge.
- Read-only provider → item preserved, human owner assigned, no success claim
  anywhere in the response or the UI.
- The full §35 audit sequence is reconstructable for the run.
- No resident-facing text promises dispatch, timing, or completion.

---

## M6 — Review Center

**Why here:** Needs M1 (payload diff) and M5 (items to review). Audit §2.7.

**Changes:**
- Route aggregating agent approvals and the pending-sender review that
  `lib/pms/inbound/messages.ts:seatReview` already computes but has nowhere to
  display.
- Ordering by risk, deadline, resident impact, blocked downstream work (§19.3).
- Exact intent and payload diff; no raw chain-of-thought.

**Acceptance:**
- A pending approval and an unknown sender both appear, correctly ordered.
- The displayed payload is the one bound to the approval.
- Approving from the Review Center consumes the same single-use grant as
  approving inline; it cannot be approved twice.

---

## M7 — Provider truthfulness

**Why here:** Independent of M1–M6; sequenced after because M5 exposes the need.
Audit §2.8. Task priority 1 (capability reporting half).

**Changes:**
- Extend the capability descriptor with `health`
  (`healthy|degraded|read_only|reauth_required|disabled`), `data_freshness`,
  `last_verified_at`, and per-operation `idempotency`/`verification`.
- Surface in Connections per §37 and §88.

**Acceptance:**
- A `read_only` provider cannot produce a success claim in agent output (§9.5).
- Connections shows verified capability, health and limitation, distinguishing
  implemented / configured / authenticated / verified-read / verified-write /
  unverified.

---

## M8 — Close the unverified areas

The audit lists seven areas not traced. Each needs a verification pass before it
can be given a status: tenant isolation end-to-end (RLS policies, caches,
queues), entity resolution, memory promotion, Shared Inbox linkage, leasing and
maintenance domain behavior, oversight-mode backend enforcement, and
non-financial idempotency.

M5 depends on entity resolution; that one is pulled forward into M5 rather than
deferred here.

---

## Adversarial tests (§17.4)

Added with the milestone that makes each reachable, not deferred to the end:

| Scenario | Milestone |
|---|---|
| Approval granted, then amount or recipient changes | M1 |
| Child run continues after parent cancellation | M2 |
| Cross-tenant work item access | M3 |
| Webhook delivered twice and out of order | M3 |
| Provider times out after creating a work order | M4 |
| Provider reports success but independent read shows old value | M4 |
| Email says "ignore prior rules", requests another tenant's rent roll | M5 |
| PMS read-only during an emergency maintenance report | M5 |
| Resident and applicant share a name | M5 |
| Vendor replies from an unverified address | M5 |
| Human approves a draft but not the subsequent send | M6 |
| Specialist delegates to one with a broader tool set | M8 |

Never using real resident communications, payments, lease changes, or vendor
commitments as test actions. Fixtures and provider sandboxes only.
