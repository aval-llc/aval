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

**P0.0 (Cloudflare seat addresses) is partly unblocked and not applied.** A
scoped `CF_API_TOKEN` now exists. Run against the live zone it showed that the
earlier "blocked" reading had been hiding the real state:

- Email Routing on `aval.llc` is **already enabled** — the apex publishes
  `route1/2/3.mx.cloudflare.net` and forwards `evan@aval.llc`. The script had
  reported it disabled, because it computed `routing.ok && enabled === true` and
  the token (scoped to Email Routing *Rules*) cannot read Email Routing
  *settings*. A 403 became a fact. Fixed: it now infers from published MX, which
  the DNS scope can read, and stops if neither is readable.
- The catch-all is `{all} → drop`, disabled. Nothing reaches the seat.
- `aval-pms-seat-inbound` is not deployed, and the token has no Workers scope to
  confirm it either way.

Two further silent failures were fixed in the same pass: step 4 chose the
address format for every customer from a failed zone read, and step 6 wrote
SPF/DMARC to `agents.aval.llc` whatever path it took.

That last one is not a coding slip but a design collision, recorded below.

**The seat cannot carry an anti-spoofing record on the apex-prefix path.** SPF
and DMARC scope to a domain, never to a local-part, so there is no way to say
"`agent-*@aval.llc` never sends". And `aval.llc` does send
(`v=spf1 include:_spf.mx.cloudflare.net ~all`), so publishing `-all` there would
fail every legitimate message the company sends. Writing the assertion to
`agents.aval.llc` instead — which the script did — publishes it on a name no
receiving server consults for those addresses: a passing check protecting
nothing.

Decided 2026-09-17: **delegate `agents.aval.llc` as its own Cloudflare zone**, so
addresses become `{orgSlug}@agents.aval.llc` and the receive-only assertion lands
on a domain that genuinely never sends. Until that zone exists the script stops
at step 6 rather than reporting a success it did not achieve. Creating the zone
is an account-level action a zone-scoped token cannot perform.

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

**The ten PMS write tools have no executor.** `executePmsWrite()` is exported and
has no caller: `runTool()` in `lib/ask-aval/tools.ts` has no branch for any of
the ten, and they are not marked `unimplemented` in the registry, so `policy.ts`
does not deny them either. A model that calls `create_work_order` today reaches
`runTool`'s default case and gets `Unknown tool "create_work_order"`. It fails
safe — no write happens — but two claims made elsewhere are wrong as shipped:
the write path is not reachable end to end, and mandatory approval is enforced
in *two* independent places, not three, because the refusal inside
`executePmsWrite` is not on any live path. Wiring the dispatch is the next
substantive piece of P0.3.

---

## Binding an agent to a connection — implemented 2026-09-17

Approved as proposed and shipped in migration `0033_silent_kang.sql`. This was
the structural gap the discovery turned up: `agent_personas` is org-scoped and
carries a tool list, but nothing told an agent *which system it works inside*.

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

`pmsToolAvailability()` used to resolve across every connected PMS and let the
tool carry a `provider` argument. It now takes the agent and narrows twice: to
the providers that agent is deployed into, and within each, to the workflows
that deployment owns — owning a PMS is not owning every workflow inside it.
Strictly tighter, so nothing downstream was rewritten.

**What an undeployed agent gets was the one decision the proposal did not
settle.** Failing closed matches every other gate in `lib/pms`, where absence
never reads as permission. But this table ships empty, so failing closed on it
would revoke PMS writes from every already-configured workspace on the
migration, silently. So the opt-in is per workspace: an empty table behaves
exactly as before, and the first deployment row is the workspace saying it
governs agents this way, after which an agent without a row gets nothing.

The consequence has to reach the operator: **creating a workspace's first
deployment narrows every other agent in it at the same time.** The settings
surface must say so before writing that row. It does not yet — that surface is
not built.

Paused rows are excluded at the read rather than filtered later, so pausing
removes the tools instead of refusing them afterwards. One gap remains: a
deployment paused *mid-turn* is not re-checked, because `pmsWriteAllowed()` —
the execution-time re-resolve that makes same-day revocation real for
authorizations — does not know about deployments. It is not reachable today
either way (see the executor note above), but it must be closed when the
dispatch is wired.

## State at handoff — 2026-09-17

Committed on `feat/pms-integration`, branched from `fix/codex-live-validation`
rather than from `main`. That is not a preference: migration `0032`'s
`prevId` is `0031_snapshot.id`, and `0031` exists only on the chat branch, so
branching off `main` would have broken the migration chain.

```
096d4ed  feat(pms): add PMS capability matrix, descriptors, and write path
ff21b3c  fix(pms): stop the seat DNS script reporting failed reads as facts
da24b7b  feat(pms): bind an agent to the system it works inside
```

Validation:

```
typecheck     clean
i18n parity   1806 keys match
build         clean, /api/pms/matrix registered
unit          543 pass / 0 fail   (+29)
integration   163 pass / 0 fail   (+13)
eslint        0 errors in new files
```

Three pre-existing inventory tests failed when the ten mutating tools landed —
`tests/agent-task-state.test.ts` and two in `tests/agent-policy.test.ts`. They
exist so adding a mutating tool is a deliberate act; they did their job and were
updated, not suppressed.

Next actions, in order:

1. **Wire the executor.** The ten write tools have no dispatch to
   `executePmsWrite()` (see above). Until that lands the write path is not
   reachable end to end, and the third enforcement point for mandatory approval
   does not exist. Close the mid-turn pause gap in `pmsWriteAllowed()` in the
   same change.
2. **P0.0.** Delegate `agents.aval.llc` as its own Cloudflare zone (an
   account-level action; the current token is zone-scoped and cannot), deploy
   `worker/pms-seat-inbound.ts` as `aval-pms-seat-inbound`, then run
   `scripts/setup-pms-seat-dns.mjs` — dry run first, `--apply` second. Email
   Routing is already on; only the catch-all and the assertions are missing.
3. **Build the deployments settings surface**, and make it state before the
   workspace's first deployment row that creating it narrows every other agent
   in the workspace at once.
4. Verify AppFolio Core 5.4 against the live agreement and set
   `termsVerifiedAt` in `lib/pms/providers/appfolio.ts` — the citations are from
   secondary research and no customer should enable a flagged path before that.
5. Live-validate the DoorLoop adapter against a real tenant before claiming it.
   Needs a DoorLoop API key (self-serve, from DoorLoop account settings)
   connected to a workspace; none exists here.
