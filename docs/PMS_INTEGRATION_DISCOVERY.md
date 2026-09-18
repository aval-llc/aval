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

Decided 2026-09-17: give the seats **their own subdomain**, so addresses become
`{orgSlug}@agents.aval.llc` and the receive-only assertion lands on a name that
genuinely never sends, while the apex keeps its real sending records.

*Corrected the same day.* The first attempt at this said "delegate
`agents.aval.llc` as its own Cloudflare zone", and step 4 probed `/zones?name=`
to detect it. That is DNS **subdomain setup**, which is Enterprise-only
(Free/Pro/Business: No) — and `aval.llc` is on Free Website, so the probe could
never be true and the script was pinned to apex-prefix permanently. The second
attempt corrected it to Email Routing **subdomains**, an ordinary subdomain of
the same zone, available on every plan.

**Reversed 2026-09-17 — the subdomain is not being built.** Both corrections
above were fixes to the mechanism of a decision whose premise was wrong. The
address format was never an open question: Aval's inbound agent format is
`agent-{orgSlug}@aval.llc`, so inbound seat mail belongs to the existing
`aval.llc` Email Routing configuration and always did. The subdomain was
reasoned backwards from a constraint — "SPF/DMARC cannot scope to a local part,
therefore the seats need a domain of their own" — and that reasoning treated an
anti-spoofing record as a requirement the address format had to satisfy, rather
than as one mitigation among others.

It is not a requirement, because it does not defend the thing that matters.
A receive-only SPF/DMARC record on a seat domain would tell *other people's*
mail servers that the seat never sends, which limits someone spoofing a seat
address outward. It does nothing about mail arriving *at* the seat, which is the
actual exposure: the Worker's input is whatever a stranger chose to send. That
threat is answered by inbound verification (P1 — SPF/DKIM/DMARC alignment
against a per-org allowlist, checked before anything is parsed), and by the
Worker storing every message unparsed until then. The subdomain would have bought
an outward assertion at the cost of a second name, a second routing
configuration, and an address format inconsistent with the rest of the product.

So: **no `agents.aval.llc`.** No A, AAAA, CNAME, Worker custom domain, or
separate zone for that name, and `scripts/setup-pms-seat-dns.mjs` now stops if it
finds records there. The accepted consequence, recorded rather than discovered
later: seat addresses carry no record asserting they never send, and the apex
DMARC is `p=none`, so outward spoofing of a seat address is currently detected
rather than blocked. Tightening apex DMARC is worth doing on its own merits and
is not a seat problem.

**The apex catch-all is the delivery mechanism, and the Worker is the filter.**
Email Routing matches literal local parts or nothing — there is no `agent-*`
wildcard rule. Seats are created per customer without a Cloudflare write, so the
catch-all is the only rule that can deliver an address nobody pre-registered.
That hands `worker/pms-seat-inbound.ts` every unmatched message to the domain,
which moves a boundary: under the subdomain design Cloudflare's rule engine kept
non-seat mail away from the Worker, and on the apex the Worker's own recipient
check is the only thing that does. It runs before the body is read, matches
`agent-{orgSlug}@aval.llc` on the envelope recipient, and returns a permanent
SMTP rejection for anything else — which is what the zone already does today with
the catch-all disabled, so non-seat mail sees no change.

Rejecting rather than silently dropping is deliberate. A bounce lets someone
enumerate which seat addresses exist, and that is acceptable: seat addresses are
handed to customers to type into a PMS, so they are not secret. Silently
discarding a colleague's typo of a human address, on a domain that carries real
company mail, is the worse failure.

Literal rules match ahead of the catch-all, so the existing `evan@aval.llc`
forward is untouched by this. Verified against the live zone 2026-09-17: one
active literal rule, catch-all `{all} → drop` and disabled.

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

**The ten PMS write tools have no executor.** ~~Resolved 2026-09-17.~~
`executePmsWrite()` was exported and had no caller: `runTool()` in
`lib/ask-aval/tools.ts` had no branch for any of the ten, and they were not
marked `unimplemented` in the registry, so `policy.ts` did not deny them either.
A model that called `create_work_order` reached `runTool`'s default case and got
`Unknown tool "create_work_order"`.

**The gap was larger than that entry recorded.** Wiring it turned up that the
ten tools had no model-facing schema at all — they were in
`lib/agents/registry.ts` (permissions, risk, approval), in `tool-map.ts`
(tool → action) and in the `runtime.ts` filter, but never in `TOOLS`. So the
capability-matrix filter at `runtime.ts` was narrowing a set the tools were
never in, and no request could have included one however the matrix resolved.
Four layers were each individually correct and the path was not connected.

That is the failure mode worth naming, because every test passed throughout.
`tests/integration/pms-tools.integration.mjs` now asserts the join itself —
every write tool is in `TOOLS` and in `TOOL_SCHEMAS` — rather than asserting
each layer separately, which is what let this hide.

Shipped:

- `lib/pms/tool-schemas.ts` — the ten schemas and their payload mappings, pure
  and storage-free, following the `capability-rules.ts` / `capability.ts` split.
  Schema and mapping are one object per tool because they are one decision:
  apart, they drift silently and the model's `property_id` never reaches the
  adapter's `propertyId`.
- `lib/pms/tools.ts` — the dispatch. Refuses outside a durable task, because the
  idempotency key comes from the task row and there is no safe way to invent
  one. Reports `queued` as queued.
- `runTool` dispatches PMS writes ahead of every other branch.
- **The mid-turn pause gap is closed.** `pmsWriteAllowed()` now takes the
  persona and re-resolves deployments, so pausing a deployment stops a turn
  already in flight rather than only the next one. The persona reaches it
  through `ExecutionRequest.context.personaId`, which all three `executeTool`
  call sites already carried.

Mandatory approval is now enforced in the three independent places the design
claimed: the registry's `requiresApproval`, the resolution flag, and the refusal
inside `executePmsWrite` — which is on a live path at last.

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

## P1 — decisions taken 2026-09-17

**Seat slugs are operator-chosen, and permanent.** Decided by the user when the
alternatives were put side by side. Deriving `slugify(org.name)` was rejected
because the address goes into a customer's PMS configuration by hand: they should
see and own it before that happens, not discover that "Acme Properties, LLC"
became `agent-acme-properties-llc@` and that their second workspace is
`agent-acme-properties-2@`. An opaque token (`agent-k7m2x9@`) would make the seat
unguessable and cut probe traffic, and was rejected as unreadable — nobody,
including support, could tell whose address it is.

**A slug belongs to one workspace forever, and renaming adds an alias.**
`organization_seat_slugs` has `slug` as its primary key and never deletes a row,
so a slug cannot be reissued — the guarantee is structural rather than enforced
by a check somebody can forget. `organizations.seatSlug` names the current one to
display. The reasoning is that a seat address lives in a customer's PMS
configuration, outside Aval's control, and may still be in use years after they
stopped thinking about it; mail they send must never arrive at a stranger's
workspace. Migration 0034.

**`seat-address.ts` is shared by the Worker and the app.** Not a convenience: an
address the app issues that the Worker rejects presents as a PMS that
mysteriously sends nothing, and the customer's first conclusion is that their
PMS is broken. The module has no dependencies so wrangler can bundle it into an
isolate handling unverified mail. Adopting it tightened the Worker's rule, which
was 1–40 characters and had no reserved list.

**Verification reads the raw message, not the stored header.** The Worker records
`headers.get("authentication-results")`, and that string is not evidence:
`Headers.get` joins duplicates with a comma, and the *sender* controls the headers
in the message they send, so a forged `Authentication-Results` claiming
`dmarc=pass header.from=appfolio.com` is stored alongside the real one with
nothing to distinguish them. `lib/pms/inbound/authentication.ts` parses the raw
header block and takes the topmost result bearing the expected authserv-id —
topmost being the one the receiving MTA added last. The residual assumption
(Cloudflare adds a result to everything Email Routing accepts) is stated in the
module rather than left implicit.

**SPF alone never verifies.** It authenticates the envelope sender, which need
not relate to the `From:` a person or a parser reads, so a message can be
SPF-clean for `bounces.somewhere.example` and display as AppFolio. Passing means
DMARC pass on an allowlisted `header.from`, or a DKIM signature by an allowlisted
domain. An empty allowlist verifies nothing — a workspace that has not said who
may write to its seat has not consented, the same rule as `enablement.ts`.

**Still open in P1.** No storage for the per-org sender allowlist yet
(`verifySender` takes one; nothing persists one). No bridge from verified seat
mail into `lib/operations/` — that is P1.1's remaining work, and the read
envelope itself already exists. The four workflows' read paths (P1.2–P1.5) are
untouched.

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

1. ~~**Wire the executor.**~~ **Done 2026-09-17** — see above. The write path is
   reachable end to end, and the mid-turn pause gap in `pmsWriteAllowed()` is
   closed. Still true: only DoorLoop maintenance has an adapter, so the other
   six actions resolve to `unlearned` and are never assembled.
2. ~~**P0.0.**~~ **Applied 2026-09-17 18:16 UTC.** The seat path is live:
   `aval-pms-seat-inbox` R2 bucket created, `aval-pms-seat-inbound` deployed from
   `wrangler.seat.jsonc` with `env.PMS_SEAT_INBOX` bound and `workers_dev: false`
   (the first deploy published a workers.dev URL; disabled and reverified 404),
   and the apex catch-all switched from `{all} → drop, disabled` to
   `{all} → worker aval-pms-seat-inbound, enabled`. Verified after the change by
   reading the zone: `evan@aval.llc → evchau@berkeley.edu` still active at
   priority 0, 17 DNS records unchanged, no `agents.*` records.

   **The path is deployed, not exercised.** No real message has reached the
   Worker. Until one does and is confirmed in R2 under
   `unverified/<recipient>/<sha256>`, this is implemented and unverified in the
   sense `AGENTS.md` means.
3. **Build the deployments settings surface**, and make it state before the
   workspace's first deployment row that creating it narrows every other agent
   in the workspace at once.
4. Verify AppFolio Core 5.4 against the live agreement and set
   `termsVerifiedAt` in `lib/pms/providers/appfolio.ts` — the citations are from
   secondary research and no customer should enable a flagged path before that.
5. Live-validate the DoorLoop adapter against a real tenant before claiming it.
   Needs a DoorLoop API key (self-serve, from DoorLoop account settings)
   connected to a workspace; none exists here.
