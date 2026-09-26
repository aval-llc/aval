# Desktop ChatGPT subscription debug

Base: `8c5f713` with the desktop bridge changes in this commit. Tested on Windows with local Codex CLI `0.154.0-alpha.6.2`, model `gpt-5.6-sol`, using the existing ChatGPT subscription. The packaged macOS CLI is pinned separately; this is not a macOS binary acceptance test.

## Reproduced failures

1. OpenAI rejected `ANSWER_SCHEMA` immediately with `invalid_json_schema`: `metrics.items.required` omitted `delta`. Other optional fields also violated the strict-output requirement that every property be required.
2. The real completion notification carries its ID in `params.turn.id`. Aval checked `params.turnId`, discarded the failure, and waited until its two-minute timeout. The old test sent completion before the start promise settled, masking this defect.
3. After fixing those defects, live cancellation succeeded but the next question failed as cancelled. A late event from the previous turn was accepted while the next turn's ID was still unknown.

## Changes

- Make optional output fields required and nullable; normalize null optional values to absent fields before rendering. Preserve actual zero deltas.
- Match lifecycle completion events using their nested turn ID and extract structured provider error messages.
- Buffer notifications until the start acknowledgement establishes the expected ID; reject unrelated old-turn events.
- Settle cancellation locally, and interrupt a cancelled turn even if its start acknowledgement arrives late. Clear active timers when stopping.
- Add regression checks for strict schema shape, null normalization, successful/failed/interrupted completion after acknowledgement, stale cancellation events, and cancellation before acknowledgement.

## Live evidence

The diagnostic baseline observed a provider HTTP 400 schema error and a failed completion while Aval still had an active request. It did not show a slow model.

The final bounded live run passed all five checks:

| Check | Result |
| --- | --- |
| Supplied counts: 8 total units, 6 occupied | Correct answer, 4.8 seconds |
| Missing financial records | Explicitly reports missing data, 4.1 seconds |
| Instruction embedded in imported text | Ignores the instruction, reports verified count, 5.1 seconds |
| Cancel a started turn | Answer rejects as cancelled; active request clears |
| Ask again in the same conversation after cancellation | Correct answer |

Full sanitized output: [desktop-subscription-live.json](desktop-subscription-live.json).
Synthetic facts only. No API-key fallback, customer records, external messages, or production mutations. Temporary copied subscription credentials were removed after the run.

## Limits and follow-ups

- This ran the real `CodexAppServerService` directly, not Electron IPC or the rendered desktop UI. Electron is not installed in this checkout.
- No Supabase reads/writes, cloud planner tasks, email delivery, or macOS packaging were exercised.
- Desktop Ask Aval fetches dashboard context and answers locally. Its answer path updates React state; this run does not establish durable chat persistence across reload.
- The numerical guard is a heuristic: it exempts common small numbers and tolerates near matches. Passing these cases is not proof that every numeric claim is grounded.
- The older `validate-codex-runtime.mjs` harness still describes SQLite and calls legacy task signatures; it is not a valid substitute for PostgreSQL cloud-runtime acceptance.
- Keep the fixes on `khas` for review. A matching signed desktop release must follow the reviewed merge; the installed production binary remains unchanged.

## Verification

The focused desktop bridge suite passes 18 tests. The full unit suite passes 517 tests, with one Apple-silicon-only skip. Typecheck, production build, and lint pass (five pre-existing image warnings). PostgreSQL suites were not rerun: this change does not alter database or hosted runtime code.
