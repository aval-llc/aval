# PMS integration — discovery

Companion to `docs/PMS_INTEGRATION.md`. Answers the five discovery questions that
brief opens with, plus the decisions taken during P0. Follows the precedent of
`docs/WHATSAPP_AGENT_DISCOVERY.md`, whose findings questions 4 and 5 depend on.

Date: 2026-09-17.

---

## 1. `lib/integrations/catalog.ts` — flat config, and four sources of truth

A single flat array, `integrationCatalog: IntegrationProvider[]`, roughly thirty
providers across one `IntegrationProvider` type, with `getProvider(id)` as the
only accessor. No provider abstraction: no per-provider module, no read/write
mechanism split, no adapter dispatch.

Three findings that shaped P0.1:

- `IntegrationProvider.readOnly` existed and was `true` on all seven PMS
  providers. **Nothing read it** except a label in the connection dialog and a
  copy written into `metadataJson`. It was a comment in data form — and wrong for
  DoorLoop, whose API documents permitted writes.
- Blocker reasons existed twice: `setupBlocker` on the descriptor and a separate
  hardcoded `EXISTING_BLOCKERS` map in `readiness.ts`, joined by
  `connectionBlocker()`.
- `integrationReadiness()` returned `unavailable` for **every** PMS. QuickBooks
  is still the only provider in the codebase with a real sync worker.

**Resolution.** `lib/pms/providers/*` is now authoritative. `readOnly` is gone
from every `Leasing & PMS` catalog entry and from the `key()`/`oauth()` factories
in `additional-providers.ts`, so TypeScript forces callers through
`providerIsReadOnly()`, which computes it from the descriptor.
`EXISTING_BLOCKERS` folded into `lib/pms/derive.ts` as `ADAPTER_BLOCKERS`, and
`readiness.ts` is now four lines.

Note that `adapterBlocker` and `providerWriteBlocker` are deliberately separate.
AppFolio's *write* is blocked by its terms; its *Stack API connection* is blocked
by a partnership Aval does not hold; and notification capture through the seat
needs neither. Collapsing those into one "blocked" would misdescribe all three.

## 2. `lib/ask-aval/tools.ts` — static array, but the registry is already assembled per request

`TOOLS` is a static module-level array. That is not what reaches the model.
`lib/agents/runtime.ts` intersects independent narrowings:

1. `personaTools(TOOLS, persona, …)` — the persona's declared subset (framing)
2. `allowedToolNames(task.agentId, subject)` — the permission envelope from
   `lib/agents/permissions.ts` (the authority ceiling)
3. a contract-kind selection (`plan` / `evidence` / `delivery` / `preference`)

`runtime.ts` comments it as *"the envelope is the ceiling — a persona listing a
tool it has no permission for gets it removed here, not granted."* Separately,
`policy.ts` denies unknown and `unimplemented` names at execution time.

**So the brief's requirement was already the architecture.** "Assemble per
request, don't filter at call time" holds today; the capability matrix became a
fourth narrowing at an existing seam (`lib/pms/assembly.ts`, called from
`runtime.ts`). The two-gate model in the brief's cross-cutting section also
already existed: assembly decides what is possible, `policy.ts` decides what is
allowed right now.

## 3. Org settings — no general table, two precedents, not interchangeable

- `communication_settings` — org PK plus `configJson TEXT NOT NULL DEFAULT '{}'`.
  Free-form nested JSON. Works today.
- `agent_execution_policies` — org PK plus typed columns, `*Json` arrays,
  `version`, `approvedByUserId`, `approvedAt`, `status: draft|approved|suspended`.
- `integration_connections.metadataJson` — per-`(org, provider)` JSON, already
  unique-indexed on exactly that pair.

D1 is SQLite: JSON is TEXT, no `jsonb`, no shape constraints.

**Resolution.** Grants went to `integration_connections.metadataJson` under a
`pmsGrants` key, because a grant's grain *is* (org, provider). Enablement got a
new table shaped like `agent_execution_policies`, not like
`communication_settings` — the spec requires
`override: 'signed_authorization'`, and a loose config blob cannot record who
signed or when. `agent_execution_policies` already solved that problem for spend
ceilings, which are the same family of decision.

## 4. Queues and RLS — inherited from the WhatsApp discovery

From `docs/WHATSAPP_AGENT_DISCOVERY.md`:

- **No row-level security, and it is not available.** D1/SQLite **has no RLS** —
  no policies, no per-connection session variables. Org scoping is enforced in
  application code only. An in-flight **Postgres** + RLS spike exists in-repo and
  is not shipped.
- **No Cloudflare Queues and no Durable Objects.** Not declared in
  `wrangler.jsonc`, `wrangler.deploy.jsonc`, or `wrangler.local.jsonc`. The
  working pattern is an **event log drained by cron**: `"crons": ["* * * * *"]`,
  `integration_events` as the log, `queueInboundTask()` in
  `lib/communications/intake.ts` to enqueue, dedupe on primary key.

**Resolutions.**

The "RLS isolation test" is now `tests/org-scoping-isolation.test.ts`, with
application-level assertions and the same control-case structure. It reads the
`lib/pms` module sources rather than exercising a hand-picked table list, which
answers the discovery doc's own criticism that a per-table test "depends on a
test remembering to cover a table." **It remains weaker than RLS**: RLS holds for
queries nobody thought about; this holds for queries it can see. Postgres with
real RLS is the actual fix, and this test existing must not let that quietly
become permanent — one of its cases asserts this paragraph still exists.

`pms_write_queue` reuses the event-log-drained pattern with no new
infrastructure, with one difference: it is drained by the **desktop runner
polling for its own org's pending rows**, not by the one-minute cron. That is the
whole point of `runner: 'desktop'` — the cron cannot do this work, because the
work requires the customer's own browser session.

## 5. `handleAskAval` — mixed, and already mid-migration

Two generations of tools coexist:

- **`lib/ask-aval/tools.ts`** (older) reads `portfolio_snapshots` /
  `funnel_snapshots` — pre-aggregated metrics a connector pushed. It imports
  `app/data/sample.ts`, and its system prompt still says *"This is a sample-mode
  demo."*
- **`lib/ask-aval/operations-tools.ts`** (newer) reads the real normalized record
  tables through `lib/operations/` — `properties`, `units`, `leases`,
  `residents`, `work_orders`, `ledger_entries`, `vendors`, `leasing_leads`,
  `gl_transactions` — and returns `noDataAvailable` rather than a shape full of
  zeroes. Its header: *"A funnel of zeroes is a performance claim; 'no leasing
  data has been provided' is the truth."*

`sample.ts` is still live for the dashboard demo surface
(`dashboard-client.tsx`, `charts.tsx`) plus `finance/metrics.ts`,
`infrastructure/usage-metrics.ts`, `ask-aval/export.ts` — not for the
record-layer tools.

**This is the most consequential finding: P1.1's shared read envelope
substantially already exists.** `lib/operations/` is that normalized model,
`import-plan.ts` / `import-apply.ts` is the ingestion path, and `provenance.ts`
plus `operations_conflicts` already handle two sources disagreeing. The remaining
work is a PMS-seat *source* feeding it — not a new normalized model.

---

## Decisions taken during P0

Recorded here because the brief did not settle them and the autonomy grant said
to make the call and note it.

**Every PMS in the catalog has a descriptor — but only nine are hand-written.**
`additionalProviders` contributes nineteen more `Leasing & PMS` tiles
(`yardi_breeze`, `reapit`, `arthur`, `propstack`, `street`, `showmojo`,
`tenantcloud`, `joblogic`, …). Hand-writing a `permitted` claim for providers
whose terms nobody has read would manufacture exactly the assertion the brief
forbids: *"if we can't name why, we don't know, and unknown defaults to false."*

So `lib/pms/providers/unassessed.ts` derives a descriptor for each of them that
claims only what is true of any mail-capable system:

- read — `notification`, supported and permitted. This is the universality
  claim, and it does not depend on the provider having an API or a partnership.
- write — `supported: false`, resolving to `unavailable` with *"Aval has not
  assessed a write path"* and the catalog's own blocker text. **Not
  `blocked`**: there is no clause to quote and nobody to blame.

A provider graduates by getting a hand-written file, at which point someone has
actually read its terms.

**`rentvine` already existed.** It is an `AdditionalProviderId` with a `key()`
entry carrying its real Basic-auth fields (subdomain, access key, secret). An
entry added during P0.1 with a guessed single `apiKey` was a duplicate and was
removed; the existing one is correct. `generic_email` is new and was added.

**`termsVerifiedAt` is deliberately unset on AppFolio.** The field exists and the
settings matrix renders *"Provider terms not yet confirmed by counsel"* when it is
absent. Setting a date would assert a verification that has not happened — the
5.4 citations come from secondary research. Someone pulls the live AppFolio Core
terms before any customer enables a flagged path, and sets the date then.

**Mandatory approval is not an availability state.** `MANDATORY_HUMAN_CHECKPOINT`
stamps `mandatoryApproval` on the resolution rather than forcing a non-`allow`
state. Availability and approval are different questions: a Fair Housing-exposed
action can be fully available and still never execute unreviewed. It is enforced
in three independent places — the registry's `requiresApproval`, the resolution
flag, and a refusal in `executePmsWrite` — so no single edit can make it
autonomous.

**Descriptor reasons are not translated.** They quote contract clauses. A
mistranslated terms citation is worse than an untranslated one. The `owner` field
carries the part that needed localising, and it is translated.

**`general` no longer reaches every implemented tool.** The PMS write permissions
belong to the one specialist role whose job each is (`maintenance`, `financial`,
`brokerage`). `tests/agent-policy.test.ts` was updated to assert the exclusion
rather than the old blanket claim — the unspecialized assistant should not be
able to post to a resident ledger because someone asked it a broad question.

---

## Not done, and why

**P0.0 (Cloudflare seat addresses) is blocked.** `CLOUDFLARE_API_TOKEN` lives in
GitHub Actions secrets (`.github/workflows/cloudflare-production.yml`), which are
write-only. It is not in the environment, `.dev.vars`, or a wrangler OAuth
config, and there is no `~/.config/.wrangler`. Token scope could not be verified,
so per the stop conditions nothing was assumed. `scripts/setup-pms-seat-dns.mjs`
performs the whole sequence once a token is present, and
`worker/pms-seat-inbound.ts` is the stub Email Worker it points the catch-all at.

**DoorLoop maintenance writes are implemented and NOT live-validated.** Request
shapes come from DoorLoop's published API documentation and are covered by
fixtures. No call has been made against a real DoorLoop tenant because no
credential exists in this workspace. Per `AGENTS.md`, that means implemented and
unverified.

**Arrears and leasing adapters are not written for any provider.** The shared
machinery, tools, permissions, approval tiers, audit path and settings surface
are complete and tested; the provider-specific request shapes are not. Inventing
a trust-ledger posting shape from documentation without a sandbox is how a
payment lands on the wrong lease. Those actions resolve to `unlearned` — Aval's
work, correctly attributed.

**The agent-to-connection binding is designed but not implemented.** A shape is
proposed for review; nothing was migrated.

---

## Proposed: binding an agent to a connection

Not implemented — proposed for review, per the instruction to propose a shape
first. This is the structural gap the discovery turned up: `agent_personas` is
org-scoped and carries a tool list, but nothing tells an agent *which system it
works inside*.

```
agent_deployments
  id, organizationId
  personaId      → agent_personas.id, or a built-in PersonaId
  provider       → the PMS this deployment works inside
  workflowsJson  → which of the four workflows it owns here
  autonomyMode   → supervised | assisted | autonomous, per deployment
  status         → active | paused
  unique (organizationId, personaId, provider)
```

A join row rather than a `connectionId` column on `agent_personas`, because one
persona should be deployable into several PMSs at different autonomy levels and
one PMS should host several personas. A column forces one-to-one and makes "the
maintenance agent in AppFolio is supervised while the one in DoorLoop is
autonomous" unrepresentable.

It also gives the seat a natural owner: the deployment is what holds the seat
address once P0.0 lands, and what an operator pauses to take one agent out of one
system without disconnecting the integration.

`pmsToolAvailability()` currently resolves across every connected PMS and lets
the tool carry a `provider` argument. With deployments it narrows to that
deployment's provider — strictly tighter, so nothing here has to be rewritten.

## State at handoff — 2026-09-17

Uncommitted, on branch `fix/codex-live-validation` (this work probably wants its
own `feat/` branch). 19 files modified, 14 added.

Validation at handoff:

```
typecheck     clean
i18n parity   1806 keys match
build         clean, /api/pms/matrix registered
unit          539 pass / 0 fail   (+25)
integration   157 pass / 0 fail   (+7)
eslint        0 errors in new files
```

Three pre-existing inventory tests failed when the ten mutating tools landed —
`tests/agent-task-state.test.ts` and two in `tests/agent-policy.test.ts`. They
exist so adding a mutating tool is a deliberate act; they did their job and were
updated, not suppressed.

Next actions, in order:

1. P0.0 — create a Cloudflare token with Zone:DNS:Edit and Zone:Email
   Routing:Edit on `aval.llc`, deploy `worker/pms-seat-inbound.ts` as
   `aval-pms-seat-inbound`, then run `scripts/setup-pms-seat-dns.mjs` (dry run
   first, `--apply` second).
2. Decide on `agent_deployments` above.
3. Verify AppFolio Core 5.4 against the live agreement and set
   `termsVerifiedAt` in `lib/pms/providers/appfolio.ts` — the citations are from
   secondary research and no customer should enable a flagged path before that.
4. Live-validate the DoorLoop adapter against a real tenant before claiming it.
