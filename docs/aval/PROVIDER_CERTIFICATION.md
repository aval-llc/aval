# Provider certification

**Date:** 2026-09-21
**Companion:** `docs/aval/PMS_ACCESS_AUDIT.md`

What Aval can actually do with each property management system, and how far
each claim has been proven. The rule this document exists to enforce: a
simulator resembling a provider is not that provider, and nothing here says
otherwise.

## The ladder

`unimplemented` → `unit_tested` → `simulator_e2e_tested` →
`customer_authorized_ui_tested` → `sandbox_tested` → `live_provider_tested`

Only the last three involve a real provider. `simulator_e2e_tested` means
Aval's own path was exercised end to end against something that keeps its own
state and can be made to fail — it says nothing whatever about the vendor.

`lib/pms/browser/certification.ts` caps what a run may claim: a driver that
declares `simulated` cannot produce anything above `simulator_e2e_tested`,
however well the run went. The cap lives in the harness rather than with the
caller, because the caller is who would be tempted.

## Browser path — customer-authorized desktop session

| Provider | Capability | Driver | Workflow active | Session tested | Simulator E2E | Customer UI | Sandbox | Live | Blocker |
|---|---|---|---|---|---|---|---|---|---|
| AppFolio | `maintenance.work_order.create` | yes, incomplete | no — ships as **draft** | no | **yes** | no | no | no | no AppFolio account; `UNRESOLVED` in `desktop/providers/appfolio.cjs` lists the five facts nobody has observed |
| Simulator (`appfolio` shape) | `maintenance.work_order.create` | yes | n/a | yes | **yes** | n/a | n/a | n/a | — |

AppFolio is the only provider declaring a `ui` write mechanism
(`lib/pms/providers/appfolio.ts`), so it is the only candidate for this path
today. Its driver implements the whole contract and refuses every
capability-bearing operation while `UNRESOLVED` is non-empty — `reconcile`
throws rather than reporting "none found", because a duplicate check that did
not happen must never look like one that found nothing.

## API path — cloud

| Provider | Capability | Adapter | Grant probe | Simulator E2E | Sandbox | Live | Blocker |
|---|---|---|---|---|---|---|---|
| DoorLoop | `maintenance.work_order.create` | yes | yes | no | no | no | no DoorLoop credentials |
| DoorLoop | `maintenance.work_order.update_status` | yes | yes | no | no | no | as above |
| DoorLoop | `maintenance.work_order.close` | yes | yes | no | no | no | as above |
| DoorLoop | `maintenance.vendor.dispatch` | yes | yes | no | no | no | as above |
| Buildium, Entrata, RealPage, Rent Manager, Rentvine, Yardi | all | no | no | no | no | no | no adapter implemented |
| Simulator (API) | registered actions | yes | n/a | **yes** | n/a | n/a | — |

`lib/pms/adapters/doorloop.ts` registers four write adapters and a grant probe.
Nothing has run against a DoorLoop tenancy.

## Inbound mail

| Provider | Capability | Status | Blocker |
|---|---|---|---|
| Generic email | seat intake, sender adjudication | **simulator/fixture tested** against real Postgres | a real PMS forwarding to a live seat address |

## What no provider has

- **`customer_authorized_ui_tested`** — requires a real customer signing into
  their own PMS and Aval reading it. The harness for this exists
  (`runReadOnlyCertification`) and has never been run against a real session.
- **`sandbox_tested`** — requires vendor sandbox access.
- **`live_provider_tested`** — requires a verified write at a real provider.
  The harness refuses to attempt one until reads are certified, somebody is
  named as authorizing it, and the action was observed reachable by that login.

## External blockers

These are the only items on this page that Aval cannot resolve by building
something:

1. An AppFolio account or authorized customer session, to empty `UNRESOLVED`.
2. DoorLoop API credentials, to exercise the four registered adapters.
3. Vendor sandbox access, for `sandbox_tested` on any provider.
4. Partnership or terms approval where a vendor's terms prohibit automation —
   AppFolio's write path already carries a `signed_authorization` override for
   exactly this reason (`lib/pms/types.ts`).

Every one of them gates *certification*, not implementation. Nothing else in
the PMS work is waiting on a credential.
