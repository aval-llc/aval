# Customer-authorized PMS access — audit

**Date:** 2026-09-20
**Directive:** `AVAL_CUSTOMER_AUTHORIZED_PMS_ACCESS_AUDIT_IMPLEMENT_TEST.md`
**Companion:** `docs/PMS_INTEGRATION.md` (the capability matrix), `lib/pms/types.ts`

The question the directive asks is whether Aval already supports an
Alven-style "add Aval as an authorized user to the customer's PMS" path.

**It does, in vocabulary and in policy, and it executes nowhere.** Every
layer of the customer-authorized path is present and individually correct.
Nothing joins them. A `ui` write is resolved, gated, authorized, and
enqueued onto a table that no code reads.

## The one finding that matters

```
lib/pms/execute.ts:98      mechanism === "api" ? runAdapter : enqueueForRunner
lib/pms/execute.ts:128     activeFlow(...)  -> always null: nothing writes pms_action_flows
lib/pms/execute.ts:140     insert into pms_write_queue -> nothing selects from it
```

`pms_action_flows` is read by `lib/pms/flows.ts` and written by no file in
the repository. `pms_write_queue` is written by `lib/pms/execute.ts` and
read by no file in the repository. There is no runner, no browser adapter,
and no `app/api/pms/` route besides `matrix` and `seat`.

So the honest status of a customer-authorized UI write today is: it is
denied at `activeFlow`, with the message "No approved flow exists for this
action yet." The matrix reports `unlearned`, which is truthful -- that state
exists precisely to say "everything permits this and Aval has not built it
yet" -- but the state is currently unreachable-by-construction rather than
merely unpopulated.

## Where this design already differs from the directive, deliberately

The directive's SS3 and SS5 assume Aval stores the customer's PMS username,
password and TOTP seed and drives the provider from Aval's infrastructure.
This repository refuses that arrangement on purpose:

```
lib/pms/types.ts:26-37
  A `ui` mechanism is always `desktop`. The combination `ui` + `cloud`
  would mean Aval storing a customer's PMS password and driving their PMS
  from a datacenter IP -- the specific arrangement this design exists to
  avoid. An invariant test asserts it can never appear.
```

The `ui` path drives the session the customer is **already signed into**, on
their own machine, through the Electron runner. That reaches the same product
outcome as the directive's SS40 -- customer-authorized software access for an
AI employee -- without Aval ever holding a PMS credential, and it is why
SS5 (secrets) and SS6 (TOTP) are largely moot rather than missing: there is no
credential to encrypt and no seed to protect because none is collected.

Per SS35 ("use Aval's existing stronger architecture") this audit treats the
desktop-session model as the architecture to extend, not to replace. The
credential-holding variant is not implemented and should not be added
without an explicit owner decision, because it would require deleting the
invariant that currently prevents it.

## Current-state matrix

| Area | Status | Evidence |
|---|---|---|
| Access-mode vocabulary | **PARTIAL** -- `ReadMechanism`/`WriteMechanism`/`Runner` are first-class per action; there is no per-connection `access_mode` record | `lib/pms/types.ts:21-38` |
| Customer-authorized browser path | **IMPLEMENTED_NOT_WIRED** -- declared, resolved, gated, enqueued; no author, no drain, no adapter, no runner | `lib/pms/execute.ts:98-160` |
| Provider workflow versioning (SS11) | **IMPLEMENTED_NOT_WIRED** -- `pms_action_flows` has version, digest binding, status lifecycle, replay health, consecutive failures; nothing writes a row | `db/schema.ts:1622-1648`, `lib/pms/flows.ts` |
| Browser provider adapter (SS10) | **ABSENT** -- no playwright, puppeteer or computer-use reference anywhere | repo-wide search |
| Semantic browser interaction (SS12) | **ABSENT** -- no step vocabulary exists to be semantic or otherwise | -- |
| TOTP (SS6) | **ABSENT**, and moot under the desktop-session model | repo-wide search |
| Stored PMS credentials | **ABSENT BY DESIGN**, protected by an invariant test | `tests/pms-descriptors.test.ts` |
| Secret encryption (SS5) | **IMPLEMENTED** -- AES-GCM with a random IV, not base64 | `lib/integrations/crypto.ts:19-31` |
| Terms / authorization gate (SS4) | **IMPLEMENTED** -- `permitted`, `reason`, `override: "signed_authorization"`, `termsVerifiedAt`, and a per-org `pms_write_authorizations` record | `lib/pms/types.ts:92-115` |
| Canonical capabilities (SS7) | **IMPLEMENTED** under a different vocabulary -- `maintenance.work_order.create` rather than `work.create`, and finer-grained | `lib/pms/types.ts:122-142` |
| Capability resolver (SS8) | **PARTIAL** -- resolves state, mechanism and runner per action across supported/permitted/granted/enabled; does not rank several connections or fall back between access modes | `lib/pms/capability-rules.ts` |
| Customer grants (SS33) | **IMPLEMENTED** -- grants are separate from discovered provider capability, with staleness | `lib/pms/grants.ts` |
| Provider-independent employee (SS9) | **IMPLEMENTED** -- employees are rows; tools are assembled per turn | `lib/agents/employees.ts`, `lib/agents/toolset.ts` |
| Work/session states (SS15) | **IMPLEMENTED** for Work (`WAITING_FOR_PROVIDER`, `WAITING_FOR_VENDOR`, `SCHEDULED`, `BLOCKED`, ...); **ABSENT** for provider sessions | `lib/agents/task-state.ts:11-44` |
| External effects are verified (SS13) | **IMPLEMENTED** for the API mechanism -- write, re-read, evidence, `PENDING_VERIFICATION` | `lib/pms/adapters/simulator.ts` |
| Idempotency / crash recovery (SS14) | **PARTIAL** -- external references and reconciliation exist for the API path; nothing covers a browser submit | `supabase/migrations/20260919000500_step_external_reference.sql` |
| Provider simulator (SS20-22) | **PARTIAL** -- `ProviderSimulator` is stateful and wired through the real seams, but simulates an **API**, not a web UI | `lib/pms/adapters/simulator.ts` |
| No-PMS mode (SS17) | **SIMULATOR_TESTED** -- proven against real Postgres | `tests/postgres/no-pms-cases.mjs` |
| Tenancy / RLS (SS28) | **IMPLEMENTED** with a systemic guard after the worker-policy sweep | `supabase/migrations/20260919000700_worker_policy_sweep.sql` |
| Operational facts / provenance (SS29) | **IMPLEMENTED** -- source authority and conflict handling | `lib/agents/provenance.ts` |
| Prompt-injection containment (SS27) | **PARTIAL** -- tool narrowing and policy are injection-aware; no test covers provider **page** text | `lib/agents/toolset.ts`, `lib/agents/policy.ts` |
| Audit events (SS34) | **PARTIAL** -- an audit trail exists; the connection/session/workflow event names are not emitted | -- |
| Connection onboarding UI (SS31-32) | **PARTIAL** -- Connections shows capability and health; no access-mode choice, no connection test | `docs/ONBOARDING_AND_CONNECTIONS.md` |

## Certification

Per SS30, and stated plainly: nothing here has been run against a real
AppFolio or Yardi environment. The only defensible claim for provider work
in this repository is `SIMULATOR_E2E_TESTED`, and for the browser path not
even that until the boundary below exists and is exercised.

| Provider | Access modes declared | Certification |
|---|---|---|
| AppFolio | `ui` / desktop | `UNIMPLEMENTED` (no flow, no adapter) |
| Yardi | `ui` / desktop | `UNIMPLEMENTED` |
| DoorLoop | `api` | `UNIT_TESTED` (adapter registered) |
| Simulator | `api` | `SIMULATOR_E2E_TESTED` |
| Generic email | `notification` | `SIMULATOR_E2E_TESTED` |

## What to build, in order

1. **A declarative step vocabulary** with semantic targets and no
   coordinates, so a flow is reviewable by a person on an approval card
   (SS11, SS12).
2. **A provider-neutral browser boundary** -- `supports`, `preflight`,
   `execute`, `verify`, `recoverSession`, `healthCheck` -- with
   provider-specific workflows strictly below it (SS10).
3. **A stateful simulated PMS web environment** behind that boundary, which
   keeps its own external state and can be made to fail in the ways SS26
   lists (SS20-22).
4. **The drain**: claim a queued write, resolve its flow, bind the approval
   to the flow digest, execute, reconcile duplicates by external reference,
   re-read to verify, record evidence (SS13, SS14).
5. **Adversarial and injection coverage** (SS26, SS27).

Items 1-5 are the join. Everything else in the directive either already
exists, is a UI surface over work that does not exist yet, or is moot under
the desktop-session model.
