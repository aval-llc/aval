# Task brief — Aval web app

> **Historical document (September 2026).** This brief describes the earlier prototype and is retained as implementation history. Use the root `README.md`, `docs/migration/README.md`, and the current GitHub issues for active setup and delivery work.

Paste this whole file into Claude Code, or save it at `docs/TASKS.md` and say
`read docs/TASKS.md and start with P0`.

---

## Context

This is Aval, an AI property management product. The current build is a demo/prototype at
`aval.onrender.com`. Metrics render as zeroes while showing percentage deltas next to them,
which makes the whole dashboard read as fake. That is the blocking problem. Everything else
below is ordered after it.

Before writing any code: read the repo, map the component tree for the Overview view, and
tell me where the KPI tiles, the funnel, the data-coverage panel, and the "Aval, now" ledger
are defined. Do not start editing until you have reported that map back to me.

## Ground rules

- Do not restyle anything. The dark aesthetic, spacing, radii, and type are approved. Fix
  behaviour and content, not appearance.
- No new runtime dependencies without asking first.
- TypeScript strict. No `any` on anything you touch.
- Every state you introduce must have a defined empty, loading, error, and populated form.
- Work one priority level at a time. Stop and report after each P-level; do not chain into
  the next one unattended.
- Small commits, one task per commit, message format `fix(overview): …` / `feat(i18n): …`.

---

# P0 — Blocking. The demo currently contradicts itself.

## P0.1 Kill the zero-with-a-delta pattern

**The bug.** The Overview shows zeroed values with live-looking comparisons attached:

| Tile | Value shown | Delta shown |
|---|---|---|
| Net operating income | `$0` | `+4.8% month to date` |
| Economic occupancy | `0.0%` | `+1.2% vs prior month` |
| Rent collected | `$0` | `92.6% of August billing` |
| Open work orders | `0` | `4 urgent · 2.7 days avg close` |
| Lead-to-lease funnel | `0 / 0 / 0 / 0` | `55.4% contacted → viewed`, `14.2% contacted → signed` |

A zero with a percentage change next to it tells any viewer the numbers are hardcoded.
Also audit for the same class of problem: `142 units across 6 properties` and
`Updated 4 minutes ago` render while no source is connected.

**The fix.** Introduce one explicit app-level data mode and drive every tile from it.

```ts
type DataMode = 'sample' | 'empty' | 'live';
```

- `sample` — every figure populated with coherent, internally consistent fake data.
  Deltas allowed. A single dismissible chip in the page header reads
  `Sample data · connect a source to see yours`. One chip for the page, not one per tile.
- `empty` — no values, no deltas, no timestamps, no unit counts. Each tile shows its label,
  a one-line description of what it will show, and an inline `Connect` affordance.
- `live` — real values from connected sources.

Default the deployed demo to `sample`. Allow override via `?data=empty` for testing.

**Acceptance**
- Grep the repo for hardcoded `+4.8`, `+1.2`, `92.6`, `2.7`, `55.4`, `14.2`, `142`,
  `4 minutes` and confirm none render outside `sample` mode.
- In `empty` mode no numeral appears anywhere on the Overview except zeros that are
  genuinely zero, and no delta strings render at all.
- In `sample` mode the funnel counts and the stated conversion percentages are arithmetically
  consistent with each other. Compute the percentages from the counts; do not hardcode both.
- The chip appears exactly once and only in `sample` mode.

## P0.2 Make the sample data internally consistent

If the funnel says 148 contacted and 21 signed, the "contacted → signed" figure must be
computed as 14.2%, not stored separately. Same for rent collected vs "% of August billing",
and NOI vs its month-to-date delta.

Put all sample figures in one module (`src/data/sample.ts`) as a single typed object, derive
every displayed percentage from it, and export a `assertSampleConsistency()` unit test that
fails if a derived figure drifts from its inputs.

## P0.3 Remove "live" from the subhead until data flows

The page reads `A calm, live read on leasing, cash, and service.` while nothing is connected.
Make the word conditional on `mode === 'live'`, or cut it.

---

# P1 — Positioning and activation.

## P1.1 Decide and encode the market

The connection targets are currently QuickBooks/Xero, AppFolio/Buildium, and USD. That
positions Aval as a layer on top of a US PMS. If the target market is Mexico/LatAm, the
product is the system of record and there is no PMS to require.

**Ask me which market this demo targets before implementing.** Then:

- *If LatAm:* accounting connectors become CONTPAQi, Alegra, Xero. Remove the PMS requirement
  entirely — leasing data originates in Aval. Currency MXN. Payment methods must include
  `oxxo` and `spei`. Dates `dd/mm/yyyy`. Add `colonia` to any address display.
- *If US:* leave as is, and note in `docs/DECISIONS.md` that the LatAm thesis is deferred.

Do not implement both. Write the choice into `docs/DECISIONS.md` with the date and reasoning.

## P1.2 Unlock tiles progressively

Currently both sources are marked `Required` and the view stays dark until both connect.

Change to per-tile dependency. Declare, for each tile, which source it needs:

```ts
const TILE_SOURCES = {
  noi:                ['accounting'],
  rentCollected:      ['accounting'],
  economicOccupancy:  ['accounting', 'leasing'],
  openWorkOrders:     ['maintenance'],
  funnel:             ['leasing'],
} as const;
```

Connecting accounting alone must light up NOI and rent collected while the funnel stays in
its empty state. Relabel the panel from `Two sources unlock the view` to reflect actual
progress, e.g. `1 of 3 connected`.

**Acceptance:** with only accounting connected, at least two tiles show live values and no
tile shows a value it cannot compute.

## P1.3 Add the language switcher

Set up i18n properly — do not bolt on a toggle.

- `next-intl` (or equivalent for this stack) with ICU MessageFormat. No string concatenation.
- Locale in the URL segment: `/es-mx/...`, `/en/...`.
- Ship `en-US` and `es-MX` at full parity. CI must fail on a missing key in either locale.
- The switcher displays locale names in their own language (`Español (México)`, not
  `Spanish (Mexico)`). No flag icons.
- Verify layout survives ~30% text expansion in Spanish. No fixed-width buttons or nav labels.
- Terminology comes from a `terms.es-mx.json` map, not inline strings: use `renta`,
  `departamento`, `aval`, `inquilino`, `mantenimiento`.

---

# P2 — Make the metrics actionable.

The tiles are currently terminal displays. The ledger ("Nightly delinquency sweep found 4
accounts past due → flags to manager → calls after approval → payment plan") already models
the right pattern. Lift it up into the metrics.

## P2.1 Drill-down

Clicking a KPI tile opens a panel listing the underlying rows — which accounts are past due,
which units are vacant and for how long. Every metric needs a companion evidence query. Show
the rows by default; do not collapse them.

## P2.2 Attribution

For composed metrics, show a contribution breakdown rather than a bare delta:

```
NOI −8.2% (−$34,100)
├─ Rent collected   −$41,000   3 units delinquent at Torre Reforma
├─ Maintenance      −$8,900
└─ Other            +$15,800
```

Contributions must reconcile to the parent delta; render a visible residual row if they do
not. Do not hide rounding gaps.

## P2.3 Bound actions

Every insight terminates in a button that calls a typed tool. If a finding has no executable
action, it is a chart, not an insight — do not surface it in the queue.

Batch actions must expand to a per-recipient preview before approval. "Send reminder (3)"
shows three drafted messages, each individually removable.

## P2.4 Cap the queue

Maximum five active insights. A sixth displaces the lowest-ranked. Rank by money at stake ×
urgency, with actionability as a hard gate rather than a weight.

---

# P3 — Deployment hygiene

- Render's free tier spins down on inactivity, which cold-starts the demo into a long white
  screen. Move to a paid instance or add a keep-warm ping before this link goes to anyone
  external.
- Add a `?data=empty` and `?data=sample` query override so the demo can be shown either way
  without a redeploy.
- Lighthouse pass on the Overview: no layout shift on load, tiles render skeletons rather
  than collapsing.

---

# Final acceptance checklist

Report against each of these when P0–P1 are done:

- [ ] No zero renders next to a percentage delta anywhere in the app.
- [ ] Every displayed percentage is derived from its inputs, not hardcoded alongside them.
- [ ] `?data=empty` produces a screen with no invented numbers and no timestamps.
- [ ] `?data=sample` shows a single "Sample data" chip, once, in the header.
- [ ] Connecting one source lights up only the tiles that source can support.
- [ ] `/es-mx` renders the full Overview with no missing keys and no clipped labels.
- [ ] `docs/DECISIONS.md` records the market decision from P1.1.
- [ ] `npm run typecheck` and `npm run test` pass clean.

# Do not do

- Do not redesign the visual language.
- Do not add a chat box to the Overview. Metrics and actions first; conversational surface later.
- Do not generate financial figures with a model. Owner statements, rent rolls and NOI are
  computed from confirmed payment records. A model may write narrative copy around numbers
  that already exist in the data — never produce the numbers themselves.
- Do not mark a payment as collected unless it has a `confirmed_at`. Recorded ≠ confirmed.
