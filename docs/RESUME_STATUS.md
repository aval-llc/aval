# Aval resumption — September 7–8, 2026

> **Historical document (September 2026).** These checkpoints preserve earlier local, Sites, and Worker validation evidence. Use the root `README.md`, `docs/migration/README.md`, and `docs/audit/` for the current system and deployment status.

## Current delivery

September 9 completion-review resumption: **all three modes now pass end-to-end completion**. The fresh live `gpt-6-astra` run read evidence, executed exactly two ordered synthetic sends with two/one/zero approvals, and passed independent review in Supervised/Assisted/Autonomous. Review latencies were 18.408/18.704/19.040 seconds; no timeouts, invalid proposals or usage-limit failures occurred. See `docs/AGENT_LLM_COMPARISON.md` and `docs/audit/agent-llm-comparison-completion-review-verification.json`. Earlier failed and supervised-only evidence is preserved.

Final proposals now survive invocation boundaries without consuming another actor step, including at the step limit. Review citations use short packet-local IDs with original provenance, and the Codex evaluation bridge uses direct structured verdicts plus clearer failure diagnostics. Regression tests cover deferred completion, budget/cancellation/deadline/numeric enforcement, and rejected saved answers receiving repair feedback before an independently reviewed replacement.

Validation: full `npm test` passed (506 unit, 147 runtime, typecheck, translation parity, build); the runtime suite passed 148 after the additional repair regression. Desktop: 20 tests. Lint: zero errors, five existing image warnings. Refreshed `desktop/dist/Aval-0.1.12-local-arm64.dmg`, ZIP and SHA-256 checksums target **http://127.0.0.1:3010**; ad-hoc signed and **not notarized**. Signature, DMG integrity, embedded metadata and startup smoke passed. Both local language pages returned HTTP 200; server log: `/tmp/aval-completion-review-server.log`.

All current repository changes and the three pending commits are prepared for the user-requested GitHub push on `fix/codex-live-validation`. This branch push does not trigger the `main`-only Cloudflare/desktop release workflows. The hosted Sites deployment remains at the historical checkpoint below. Real business-provider validation remains separate; these trials used synthetic HTTP and automatic test approvals.

### Previous delivery checkpoint

- Source commit: `5178da1ccc02f43561a881b043b5da7b64c8c2b6` on `fix/codex-live-validation`; pushed to the existing Sites source repository, not GitHub `main`.
- Private Sites version **6** deployed successfully at 2026-09-09 05:28:44 UTC with environment revision **2**. URL: https://portero-operations-mx.evalxnder.chatgpt.site. Owner-only access remains unchanged. Deployment: `appgdep_6aa0ee7f9dd08191ab211d476e52370f`.
- `npm test`: 504 unit tests and 145 runtime tests passed, with typecheck, translation parity and production build. Desktop: 20 tests. Eight synthetic runtime trials passed. Lint: zero errors, five existing image warnings.
- Current installer: `desktop/dist/Aval-0.1.12-local-arm64.dmg`, ZIP and `Aval-0.1.12-local-arm64.sha256`. Embedded URL is http://127.0.0.1:3010. Ad-hoc signed; not notarized. Signature, disk integrity, checksums and Electron startup smoke pass. This smoke check reaches Electron readiness; it does not exercise inference.
- Local server log: `/tmp/aval-resume-sep9-server.log`; both language pages returned HTTP 200. Keep the local server running for the DMG.
- Live comparison remains **incomplete**, with raw failures preserved. Account allowance was exhausted before completing Assisted/Autonomous and independent review. The latest numeric-ID and Assisted prompt fixes have regression coverage but still need a live rerun. See `AGENT_LLM_COMPARISON.md` for the exact command and limitations.
- Native UI confirmed the preferences placement after reload. Full interactive tour verification remains partial because the app window became unavailable. Existing pointer geometry tests pass.


September 8 late-evening resumption: recovered the preceding interrupted session. Mode examples now live in onboarding and Settings preferences; the module tour launcher is in Settings; Setup has no testing module or mode examples. The arrow is outside the tour card and aligned with its highlighted target. The live agent comparison remains **incomplete**, with failed runs preserved and a usage-limit blocker. Fixed UUID citation false positives and clarified Assisted multi-action plan instructions; see [AGENT_LLM_COMPARISON.md](AGENT_LLM_COMPARISON.md). Current local delivery is 0.1.12 at port 3010, ad-hoc signed and not notarized. Older delivery/version details below are historical.

September 8 update: resumed the interrupted requests. Independence controls, regional onboarding, a 17-module tutorial, animated mode examples, real inline chat approvals, spacing fixes, a fading mode notice, and a refreshed **0.1.10** local DMG are complete. Eight isolated runtime trials passed; the current suites pass 500 unit tests, 143 runtime tests, and 20 desktop tests. See [INDEPENDENCE_VALIDATION.md](INDEPENDENCE_VALIDATION.md) for the current artifacts and executed checks. The earlier 0.1.8 delivery below is retained as history.

Resumed the interrupted harness audit in this terminal. The local application runs at
**http://127.0.0.1:3010**. Port 3000 belongs to a running KiraLabs project and was preserved.
Restart Aval with `AVAL_LOCAL_PORT=3010 npm run start:local` from this repository.
The local server log is `/tmp/aval-resume-local-server.log`.

The installer is `desktop/dist/Aval-0.1.8-local-arm64.dmg`, with ZIP and
`Aval-0.1.8-local-SHA256SUMS` alongside it. It targets the local server at port 3010,
is ad-hoc signed, and is **not notarized**. Package metadata, application startup,
code signature, disk-image integrity, and SHA-256 checksums pass. Keep the local
server running while using this installer. Production signing requirements are unchanged.

## Changes recovered and completed

- Preserved the prior communications, inbox, calling, marketing, onboarding, and icon work.
- Completed inherited authority, reserved child budgets, mandatory completion contracts,
  independent stored-result checks, and bounded repair feedback.
- Added persisted goal plans, dependencies, finite replanning, shared deadlines, and parent
  access to completed child evidence without accepting invented figures.
- Added append-only task memory, retrieval of evicted history, bounded model context,
  and immutable records of model requests, responses, and completion checks.
- Refused effects from expired/stopped tasks or parents, including approved sends, and
  required terminal database writes to acknowledge the current worker lease.
- Bound delivery success to the task, operation, conversation destination, channel, and
  required receipt status. Provider acceptance cannot prove delivery.
- Exposed plans and checker outcomes in task details in English and Spanish.
- Wired the existing Yardi logo asset into the shared brand renderer.

## Verification

**613 tests pass:** 486 unit/render/desktop tests and 127 runtime integration tests.
TypeScript passes and 1,554 translation keys match. Lint reports zero errors and five
existing image-element warnings. The final production build passes.

Adversarial probes include an actual SIGKILL/restart, 500,000-character context overflow,
false success, repair feedback, failed dependencies, replan/task ceilings, step/token/time
limits, retry exhaustion, forbidden file/network proposals, lost leases, expired approvals,
wrong-destination receipts, and desktop RPC refusals/input limits/timeouts.

Migrations 0029 and 0030 applied successfully to the local D1 database. HTTP smoke tests
pass for English and Spanish pages, task reads, the 64-provider integration catalog,
communication settings and inbox sources, marketing readiness, and specialist recommendations.
No browser interaction or visual testing was performed.

Provider tests use simulated acknowledgements. The local live validator returned
`blocked_no_connected_providers` with zero connected accounts. No customer messages,
calls, or posts were sent during validation.

## Audit outcome and remaining work

Read `AGENT_HARNESS_AUDIT.md` for the full before/after report and individual verdicts.
The audit report is complete; it explicitly retains unclosed findings for broad semantic
success verification, lost-request billing reconciliation, actual upstream desktop sandbox
proof, and matched real-task correctness/latency evaluation. These are not claimed fixed
or accepted out of scope. The September 8 follow-up adds separate model-session review of plans and answers,
with bounded repairs and recorded evidence. Its live accuracy remains unmeasured;
fixture results do not certify goal coverage or factual correctness.

Peach Software and RM Cloud still need exact vendor identification. Partner-only portals
and other unavailable products listed in `ONBOARDING_AND_CONNECTIONS.md` need their actual
contracts and adapters, beyond API keys. Supported providers still require app approval,
scopes, account setup, public callback configuration, and live validation.

## Hosting

The existing private Sites project is accessible again. Version 5 was published to
https://portero-operations-mx.evalxnder.chatgpt.site from source commit
`427b73f6ad530f3503d35952efa9c664768615d6`. Access remains owner-only.
The hosted page returns HTTP 200; protected APIs return 401 without an Aval session.
The missing `SESSION_SECRET` was generated directly into Sites as a secret, and
`AVAL_PUBLIC_URL` was set to the private Site origin. The existing encryption secret was
preserved. No local environment files were included in the deployment archive.

Company provider credentials are still absent. Scheduled-trigger registration and an
interactive signed-in hosted session have not been live-verified; local scheduling is enabled.
The configuration deployment succeeded on September 8 at 16:41 UTC using environment
revision 2. The hosted D1 inspection confirmed the new harness tables; this private Site
currently has zero stored agent tasks and zero historical tasks without a check. This count
does not cover the separate Cloudflare production database.

At the earlier version-5 handoff, the separate GitHub/Cloudflare deployment was unchanged.
The September 8 delivery below supersedes that state. Scratch helpers in `.local-work/`
remain local, outside the delivery commits.


## September 8 semantic-review delivery resumption

Recovered the exact preceding Codex session through its saved transcript; Terminal UI
access was denied by the computer-use tool. The previous turn ended on a Codex usage
limit after the full test/build and app/ZIP packaging succeeded, before DMG completion.

- Separate plan and answer reviews are implemented. Review requests, responses and
  verdicts are persisted; invalid evidence, unavailable review, and stopped tasks cannot
  complete. Plan allocation requires a matching current-step verdict.
- Recovered final verification: 612 passing tests, successful typecheck, 1,554 matching
  translation keys, successful production build, and zero lint errors (five existing
  image warnings). No application source changed after those checks.
- Refreshed the DMG from the completed desktop package. Embedded metadata confirms
  http://127.0.0.1:3010. Desktop startup, deep code-signature verification, DMG integrity,
  and the refreshed DMG/ZIP SHA-256 checks pass. The installer is not notarized.
- Restarted the local server. Both language pages, integration catalog and task API
  return HTTP 200. The catalog contains 64 providers and zero connected business
  providers. The live validator again returned `blocked_no_connected_providers`.
- The recorded Anthropic evaluation failed with HTTP 400 `insufficient_credits`; no
  labeled case produced a verdict. It was not rerun against the unchanged account.
- Sites now returns `project_not_found` for the existing saved project ID. No duplicate
  Site was created and this semantic-review update has not been published through Sites.
  The earlier version-5 publication above remains historical evidence.

Real-account provider validation and live reviewer accuracy remain blocked on usable
connections and model funding. The remaining audit findings are explicitly retained.

### Final GitHub and Cloudflare result

Implementation commit `9f0361c44138101ea6fc9996b0b988d2d9e31e4d` was pushed to GitHub
`main`. GitHub runners now start normally; the prior billing gate did not recur.
Cloudflare workflow https://github.com/evitxchi/aval/actions/runs/34256644321 passed
tests and migrations and deployed the production Worker.
https://aval.evalxnder.workers.dev/en returns HTTP 200.

The final authenticated agent smoke check failed at the first model request with
HTTP 400 `insufficient_credits`, zero model steps and no answer. The overall workflow
is therefore **failed even though code deployment succeeded**. This confirms the
model-funding blocker in the production runtime as well as the local evaluator.

The desktop workflow https://github.com/evitxchi/aval/actions/runs/34256644512 was
cancelled after that failure because it requires successful matching website validation
before publishing. No new signed/notarized release was published. The refreshed local
DMG remains available and verified. Restore Anthropic API funding, then rerun the
production validation and desktop release; business-provider validation separately
requires usable connected provider accounts.


## Codex live validation follow-up

The user requested Codex for live agent validation. The local ChatGPT-authenticated
Codex App Server (`gpt-6-astra`) passed all 16 labeled semantic cases and a complete
durable root/child task run on isolated synthetic SQLite data. Actor and reviewer
calls were live; business providers and the hosted router were not exercised.

A baseline failed on an invented evidence tool. The planner now receives explicit
check schemas and real tool names, and structural preflight rejects invalid plans
before invoking the reviewer. Production budgets and provider selection are unchanged.
See `CODEX_LIVE_VALIDATION.md` for reproduction, latency, usage and remaining limits.

The final full suite passes 613 tests (486 unit/render/desktop plus 127 runtime),
with a successful production build and no lint errors (five existing image warnings).
The local DMG was refreshed and passed disk-image integrity, checksum, signature
and startup checks. It still targets http://127.0.0.1:3010 and is not notarized.
This follow-up is delivered on `fix/codex-live-validation`; it does not publish new
production code or bypass the hosted live-validation requirement.
