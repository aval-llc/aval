# Build brief — PMS integration layer and the four workflows

Save at `docs/PMS_INTEGRATION.md`. Open Claude Code with:
`read docs/PMS_INTEGRATION.md — do the discovery step and report back before writing code`

Companion to `docs/WHATSAPP_AGENT.md`. That brief covers the messaging channel; this one
covers what the agent can reach inside a customer's property management system, and what it
is allowed to do there.

---

## The core idea

We support many property management systems. They differ in three independent ways, and
conflating them is the mistake:

1. **Capability** — does a write path physically exist for this provider?
2. **Permission** — do this provider's terms allow us to use it?
3. **Grant** — what has this specific customer's PMS role and org settings actually enabled?

A tool is available only when all three say yes. Any one says no, the tool is **absent from
the model's registry** — not refused at runtime, not present-and-erroring. Absent. A tool
that doesn't exist cannot be called by a confused model, a prompt injection, or a bug.

Build every workflow's write path. Gate them per provider and per org. The difference
between a customer who gets full automation and one who gets read-only is configuration, not
a different codebase.

---

## Discovery — do this first, then stop

1. What exists today in `lib/integrations/catalog.ts`? Is there already a provider
   abstraction, or is it flat config?
2. State of `lib/ask-aval/tools.ts` — how are tools declared and passed to the model? Is the
   registry static or assembled per request?
3. Do we have an org settings table, and can it hold nested JSON?
4. What did the WhatsApp brief's discovery turn up for queues and RLS? These reuse it.
5. Is `handleAskAval` currently reading `sampleData`, or real schema?

Report all five. Wait.

---

# P0 — The capability matrix

## P0.1 Provider descriptors

One file per provider under `lib/pms/providers/`. Static, reviewed, checked into git.
This is a legal and architectural document as much as a config file.

```ts
export const appfolio: ProviderDescriptor = {
  id: 'appfolio',
  displayName: 'AppFolio',

  read: {
    mechanisms: ['notification', 'manual_export'],
    supported: true,
    permitted: true,
    note: 'Inbound email to the seat address. AppFolio sends; we receive. No polling.',
  },

  write: {
    mechanisms: ['ui'],
    supported: true,          // technically possible via a staff seat
    permitted: false,         // but not allowed
    reason: 'AppFolio Core terms 5.4(ix) prohibit automated access to the Services. ' +
            '5.4(xi) restricts access by competitors; AppFolio sells Realm-X. ' +
            'VERIFY against current terms before changing this field.',
    override: 'signed_authorization',  // per-org, never a default
  },
};

export const doorloop: ProviderDescriptor = {
  id: 'doorloop',
  displayName: 'DoorLoop',
  read:  { mechanisms: ['api'], supported: true, permitted: true },
  write: { mechanisms: ['api'], supported: true, permitted: true },
};
```

Also describe `buildium`, `rentmanager`, `rentvine`, `yardi`, and `generic_email` (the
fallback: notification capture only, works for any PMS that can send mail).

**`supported` and `permitted` are separate fields and must never be collapsed.** Capability
is an engineering fact. Permission is a legal one. Code that treats them as one thing will
eventually enable a write because an API existed.

Every `permitted: false` carries a `reason` string naming the specific clause. If we can't
name why, we don't know, and unknown defaults to false.

## P0.2 Grant discovery

What a provider allows is static. What a **customer's** connection actually grants is not —
it depends on the PMS role they created or the API scopes on their key.

```ts
discoverGrants(orgId, providerId): Promise<GrantSet>
```

Probe once at connection time, re-probe on a schedule, cache with a timestamp. Probe with
the least destructive operation available; never probe by attempting a real write.

Discovery reports facts. **It never enables anything.** Finding that a seat can create work
orders produces `available: true, enabled: false` and a line in the settings UI reading
"writes are technically available here — enabling requires authorization." A config
inference must never be the thing that puts a customer in breach of their PMS contract.

## P0.3 Resolution

```ts
resolveCapability(orgId, providerId, action): 'allow' | 'blocked' | 'unavailable'
```

Returns `allow` only when: the provider supports the mechanism, the provider permits it, the
discovered grant includes it, and the org has enabled it. Otherwise `blocked` with a reason,
or `unavailable`.

The tool registry is **assembled per request** from this. Not filtered at call time —
assembled. The model's tool list for an AppFolio org simply does not contain
`create_work_order`.

**Acceptance:** a test asserting that for an AppFolio org, the assembled registry contains
zero write tools, and that flipping only `permitted` to true makes them appear.

---

# P1 — The four workflows

All four read from day one. All four have complete write paths. Defaults differ.

```
maintenance   read: on    write: on     (where the provider permits)
arrears       read: on    write: off    flag; requires signed authorization
leasing       read: on    write: off    flag; requires signed authorization + human checkpoint
reporting     read: on    write: n/a
```

Same code path for all four. **The flag is the only difference.** If maintenance writes and
arrears writes go through different machinery, the design is wrong.

## P1.1 Shared read envelope

One ingestion path feeding one normalized model: properties, units, leases, contacts, work
orders, charges, payments, vendors, applications. Every workflow reads from this, which is
what makes the unified view real rather than four features next to each other.

## P1.2 Maintenance — writes on

`tenant reports → capture → triage → create work order → dispatch vendor → update status →
close`

The first write-enabled workflow because it's highest volume (so flows harden fastest),
bounded (a wrong work order costs an apology and a delete), and carries no Fair Housing
exposure.

Reuses the declared `dispatch_vendor` tool.

## P1.3 Arrears — writes flagged off

`nightly gate → overdue accounts → flag to PM → contact in PM-approved order → payment plan
→ reconcile`

Build it completely. Leave it off.

The write half is ledger reconciliation against money that isn't the customer's — a trust
accounting error is a regulated event, not a bug report. The read half is valuable
immediately and carries none of that, and it's what feeds the behavioral feature store.

Nightly sweep uses a **script gate** (see the WhatsApp brief, P4.1): a deterministic SQL
predicate runs first; no crossings means no model call.

## P1.4 Leasing — writes flagged off, human checkpoint mandatory

`inquiry → reply → book viewing → application → lease status`

Highest-value workflow and the one Alven leads with. Also squarely inside Fair Housing: any
AI write to applicant communications or screening without a human checkpoint creates
liability **for the design partner**, not for us.

Even when enabled, every applicant-facing message requires explicit human approval. This is
not an org setting. It is not overridable. Hard-code it.

Never score applicants. Never use or derive familial status, national origin, disability, or
any proxy for them. If a tool's arguments could carry one, the tool is wrong.

## P1.5 Reporting — reads only

`PMS financials → weekly NOI, arrears, occupancy, funnel → hosted on the Aval dashboard →
PM reshapes it in chat`

Purest expression of the unified view pitch, zero write risk, ships fastest.

Every figure comes from a deterministic query. The model narrates; it never computes. The
faithfulness gate applies: any numeral in the output that isn't in the tool results fails
the response closed.

---

# P2 — Org settings surface

The customer sees a matrix, not a toggle list. For each workflow and each action:

```
Maintenance
  Read work orders          ● On          via notification
  Create work orders        ○ Unavailable AppFolio terms prohibit automated writes
  Dispatch vendors          ○ Unavailable AppFolio terms prohibit automated writes

Arrears
  Read ledger               ● On          via notification
  Post payment plans        ○ Off         available — requires authorization
```

Three distinct states, worded differently and never conflated:

- **On** — active.
- **Off** — permitted and granted, customer hasn't enabled it. One click away.
- **Unavailable** — provider doesn't support or doesn't permit. Shows the reason. Not
  clickable.

An operator reading "AppFolio terms prohibit automated writes" learns we read their contract.
That's a better sales artifact than any feature.

---

# Cross-cutting

**Reuse, don't rebuild.** The `BeforeToolCall` hooks, approval tiers, checkpoints/undo, audit
rows, spend ceiling and tracing all come from `docs/WHATSAPP_AGENT.md`. This brief adds a
layer *above* them that decides which tools exist at all. Two gates, different jobs: the
capability matrix decides what's possible, the hooks decide what's allowed right now.

**Partner programs change the world cheaply.** When AppFolio's partner program opens, we flip
`permitted` in one file and every AppFolio org gains writes with no refactor. Design for that
day; don't build anything that assumes it won't come.

**Verify the terms.** The 5.4 citations come from secondary research, not from counsel
reading the current agreement. Before any customer enables a flagged path, someone pulls the
live AppFolio Core terms and confirms the language. Put the retrieval date in the descriptor.

---

# Do not

- Do not collapse `supported` and `permitted` into one field.
- Do not let grant discovery enable anything.
- Do not filter tools at call time. Assemble the registry per request.
- Do not make the leasing human checkpoint configurable.
- Do not score applicants or touch protected-class attributes anywhere.
- Do not build separate machinery per workflow. One path, four flags.
- Do not default any flagged write to on, for any provider, ever.

# Done when

- [ ] Provider descriptors exist for AppFolio, DoorLoop, Buildium, Rent Manager, Rentvine,
      Yardi, and generic email, each with a named reason for every `permitted: false`.
- [ ] `resolveCapability` returns correctly for all four states across all providers.
- [ ] Assembled registry for an AppFolio org contains zero write tools; a test proves it.
- [ ] Flipping `permitted` alone makes those tools appear; a test proves it.
- [ ] Grant discovery reports `available: true, enabled: false` and changes nothing.
- [ ] All four workflows read from the shared envelope.
- [ ] Maintenance writes work end to end on DoorLoop.
- [ ] Arrears and leasing write paths are complete, tested, and off.
- [ ] Leasing applicant messages require human approval with no config path around it.
- [ ] Reporting figures all trace to deterministic queries; faithfulness gate holds.
- [ ] Settings matrix renders all three states with reasons.
- [ ] `npm run typecheck` and tests pass.
