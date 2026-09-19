# Operational state: ownership, freshness, and the dashboard read path

**Date:** 2026-09-18 · **Status:** current-state trace plus the gap model
**Method:** Read from code and from the live schema in a disposable PostgreSQL
instance. Statements below are observations unless labelled *proposed*.

---

## 1. What already exists

More of this is built than the earlier audit implied, and the model below is
grounded in it rather than invented alongside it.

### 1.1 Provenance on operational records

`properties`, `residents`, `workOrders` and `ledgerEntries` each carry:

| Column | Meaning |
|---|---|
| `sourceProvider` | Which connected system the record came from |
| `sourceConnectionId` | Which specific connection, so two accounts of one provider stay distinct |
| `externalId` | The provider's own identifier, which is what makes reconciliation possible |
| `createdAt` / `updatedAt` | Aval-side timestamps |

`portfolioSnapshots` and `funnelSnapshots` carry `source`, `periodStart` and
`capturedAt` — a metric already knows which period it describes and when it was
taken.

### 1.2 Conflicts are already first-class

`operationsConflicts` records `entityType`, `entityId`, `field`, and then
**both** sides: `valueA`/`sourceA` and `valueB`/`sourceB`, with `status`
(`open`/`resolved`), `resolution` (`kept_a`/`kept_b`/`dismissed`), `detectedAt`
and `resolvedAt`.

This is the "do not silently overwrite conflicting facts" requirement, and it
is implemented. A disagreement between two systems becomes a row a person
resolves, not a last-writer-wins overwrite.

### 1.3 Trust is already separated at intake

Seat mail does not become operational fact. `lib/pms/inbound/` records a
message with a disposition (`verified`, `held`, `unauthenticated`,
`unassigned`), and `promoteVerifiedMessage` captures it as a *notification*
with an extraction verdict. Nothing in that path writes `workOrders` or
`ledgerEntries`.

---

## 2. What is missing

| Requirement | State | Note |
|---|---|---|
| source / provider | **present** | `sourceProvider`, `sourceConnectionId` |
| source record id | **present** | `externalId` |
| workspace / org | **present** | `organizationId` on every table, RLS-enforced |
| entity | **present** | the row itself; `operationsConflicts` names it explicitly |
| `observed_at` | **missing** | only Aval-side `createdAt`/`updatedAt`. The provider's own effective time is not retained, so "the PMS changed this at 14:02" cannot be distinguished from "we synced at 14:40" |
| `synced_at` | **missing** | `integrationSyncState` holds a cursor per connection, not a per-record sync time |
| freshness / staleness | **missing** | no threshold, no derived staleness. An agent cannot tell a four-minute-old balance from a four-month-old one |
| authoritative vs derived | **missing** | no column distinguishes a provider-confirmed record from an Aval-native or inferred one |
| confidence | **missing** | no field; identity resolution has nowhere to record how sure it is |
| conflict state | **present** | `operationsConflicts` |
| provenance chain | **partial** | one hop (which provider) but not which sync run or which claim produced a value |

### 2.1 The five classes an agent must distinguish

The directive requires an agent to tell these apart. Today only the first and
third are separable, and only by convention:

| Class | Separable today? | By what |
|---|---|---|
| Provider-authoritative fact | partially | `sourceProvider` is set |
| Aval-native state | partially | `sourceProvider` is null |
| Email-derived information | **yes** | lives in seat message / notification tables, never in operational tables |
| Model inference | **no** | nothing marks a value as inferred |
| Human-confirmed | **no** | `operationsConflicts.resolution` records a human choice for a conflict, but not for an ordinary value |

---

## 3. Proposed model

*Proposed — not implemented.* Additive columns on the operational tables rather
than a new parallel store, because the provenance that exists is already on the
rows and splitting it would create two sources of truth about truth.

```
observedAt      timestamptz  -- provider effective time, when the provider reports one
syncedAt        timestamptz  -- when Aval last read this record from the provider
authority       text         -- authoritative | reported | inferred | human_confirmed
confidence      numeric      -- only meaningful when authority = inferred
freshnessPolicy text         -- named policy; staleness derives from it and syncedAt
```

Rules:

1. `authority` is set by the writer, never by a model. The sync worker writes
   `authoritative`; seat-derived claims write `reported`; an entity-resolution
   match writes `inferred` with a `confidence`; a person confirming writes
   `human_confirmed`.
2. Staleness is derived (`now() - syncedAt` against the named policy), not
   stored, so it cannot go stale itself.
3. A write may not lower `authority` on a row silently. A `reported` claim
   contradicting an `authoritative` value creates an `operationsConflicts` row
   — the mechanism already exists and should be the only path.
4. `observedAt` is nullable and stays null when the provider offers no
   effective time. A null is honest; a fabricated timestamp is not.

---

## 4. Dashboard read path

Traced from `app/[locale]/page.tsx` → `dashboard-client.tsx`.

| Surface | Endpoint | Canonical source | Verdict |
|---|---|---|---|
| Workspace | `/api/workspace` | `organizations` | **returns only `{createdAt}`** — a workspace-age probe, not a data source |
| Documents | `/api/documents` | `documents` | canonical |
| Integrations | `/api/integrations` | `integrationConnections` | canonical |
| Agent default | `/api/agents/default` | persona config | canonical |
| Agent memory | `/api/agents/memory` | `agentMemory` | canonical |
| Meters | `/api/infrastructure/meters` | infrastructure tables | canonical |
| Financial policy | `/api/agents/policy` | `agentExecutionPolicies` | canonical (via `financial-agent-controls.tsx`) |
| PMS seat | `/api/pms/seat` | `pmsSeatMessages`, `pmsSeatSenders` | canonical (via `pms-seat.tsx`) |

### 4.1 What the dashboard does not read

**Active work, approvals and agent state are not on the dashboard.**
`/api/agents/tasks` and `/api/agents/approvals` are consumed only by
`aval-assistant.tsx`, `agent-task-conversation.tsx` and `agent-trace.tsx` —
the chat surface. There is no command-center view of owned work, waiting
reasons, blocked items or failures.

`/api/agents/health` has **no UI consumer at all**.

This is the same finding as the missing Review Center, seen from the other
side: the durable runtime's state is reachable only by opening the conversation
that produced it.

### 4.2 Mocked, stale and legacy paths

- **`lib/ask-aval/tools.ts` carries a stale header comment** stating "This app
  runs on a single static sample-data snapshot (app/data/sample.ts), not a live
  per-tenant database yet, so every executor below reads that snapshot." That
  is **no longer true**: no runtime reference to `sampleData` exists in
  `lib/ask-aval/` or `lib/operations/`, and `portfolio-data.ts` queries
  `portfolioSnapshots` and `funnelSnapshots`. The comment describes a previous
  architecture and should be corrected before it misleads a reader into
  thinking the agent surface is fixture-backed.
- **`app/data/sample.ts` is still imported**, but by `dashboard-client.tsx` for
  a *type* only (`NotificationItem`), and by `charts.tsx` and
  `lib/finance/metrics.ts` for derivation helpers (`derive*Pct`, `rankInsights`).
  The fixture payload itself is not read by the agent path.
- **`/api/workspace` is effectively vestigial** for portfolio purposes.

No change was made to any of these; the directive said establish the read model
first.

---

# Part II — implemented

**Date:** 2026-09-19. The §3 model is no longer proposed; it is schema.

## 5. `operational_facts`

`supabase/migrations/20260919000200_operational_facts_and_evidence.sql`,
`db/schema.ts`, `lib/agents/facts.ts`.

Every column §3 asked for exists: `sourceType`, `sourceProvider`,
`sourceRecordId`, `observedAt`, `syncedAt`, `expiresAt`, `freshnessPolicy`,
`authoritativeness`, `confidence`, `derivedFromJson`, `conflictState`.

Three decisions worth recording:

- **Authority is derived from the source, never passed in.** `authoritativenessFor`
  maps `provider`→`authoritative`, `human`→`human_confirmed`,
  `inference`→`inferred`, `document`→`reported`. A model that could label its
  own output authoritative would make the distinction decorative. A database
  CHECK enforces that only an inference carries a confidence.
- **Staleness is derived at read time**, from `expiresAt`. A stored `stale` flag
  is itself a fact that goes out of date.
- **A source never overwrites another source.** The unique index is on
  (org, entity, field, sourceType, sourceProvider) with `NULLS NOT DISTINCT`, so
  a re-sync updates its own row and a different system gets its own. When live
  values disagree both rows are marked `conflicted` and `actionableFact` returns
  null — a caller may show the disagreement, but nothing gets a quiet answer
  that hides it.

## 6. `action_evidence`

`lib/agents/evidence.ts`. `PENDING_VERIFICATION` can now end in proof.

`compareStates` is deterministic and distinguishes three outcomes: every
expected key present and equal is `confirmed`; a present and different value is
`contradicted`; a missing key is `inconclusive`. Conflating the last two would
let a truncated read be reported as a failed write.

`executionVerdict` lets `contradicted` outrank `confirmed`, so an optimistic
earlier read cannot cancel proof of failure. Anything short of a positive
confirmation is `unproven`, which is what keeps a task out of `COMPLETED`.

The runtime gate now consults evidence before counting another attempt:
contradicted → `FAILED` with the effect named; confirmed → `COMPLETED`;
otherwise the existing backoff to `WAITING_FOR_HUMAN`.

Evidence types supported: `provider_reread`, `provider_event`,
`human_confirmation`, `document`, `aval_native`. A verifier registry
(`registerVerifier`) re-reads provider state; a verifier that returns null
leaves the effect unproven, because a provider that is down, rate-limited or
eventually consistent is not evidence of failure.

## 7. Canonical read model

`lib/agents/read-model.ts` is the single documented source for work, waits,
approvals, evidence and operational counts. It reads persisted state only — no
fixture, no transcript, no model call.

`operationalStatus` deliberately returns counts rather than a health score:
blending "three approvals pending" with "one unproven payment" tells an operator
nothing about which to open first.

`/api/workspace` is marked `@deprecated` in place and now returns a
`Deprecation` header. It is retained because onboarding uses the creation date.
No UI was redesigned.

## 8. Demo-fixture guard

`lib/ask-aval/tools.ts`'s header no longer claims executors read
`app/data/sample.ts`. `tests/agent-tools-live-data.test.ts` fails if any module
under `lib/ask-aval`, `lib/operations`, `lib/agents` or `lib/pms` references the
fixture payload or imports values (as opposed to types) from it.
