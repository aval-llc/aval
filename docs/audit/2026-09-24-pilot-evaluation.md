# Aval pilot evaluation v1 — September 24, 2026

Base source: `30f1076` on `khas`, plus the Docker backup-client fix described below. Scope: the signed-in synthetic pilot workspace at `app.aval.llc`, plus local tests against a disposable PostgreSQL 17 database. This is a pilot readiness evaluation, not a certification of real customer integrations or the deployed commit.

## Decision

**Ready for a supervised internal pilot with synthetic data; not ready to claim a live connected integration or a completed hosted AI task.** The live workspace has zero connected integrations and no selected model provider. Its existing read-only investigation task failed at step zero with the actionable message to connect and select a model provider. The current hosted deployment was not identified by commit in this evaluation.

## Cost before and during this run

- Expected and actual external model/provider spend: **$0**. The PostgreSQL and unit suites use local fixtures and mocked HTTP responses. The subscription check read account/model metadata without inference. This run made no OpenAI API inference request and no live business-provider request.
- A separate 16-case live semantic evaluation was already recorded in `codex-semantic-evaluation.json`: GPT-6 Sol passed 16/16 on 148,003 input and 2,171 output tokens. At published standard API rates that token shape would be about **$0.32** on Sol or **$0.016** on Luna, excluding cache writes, other tools, and retries. The recorded run used ChatGPT subscription quota, so it did not incur those API charges. These are illustrative API equivalents, not a bill or a guarantee for the full agent workflow.

## Integration inventory checked before tests

| Surface | Observed state | Pilot consequence |
| --- | --- | --- |
| Live workspace Connections page | **0 connected** | No live PMS, accounting, messaging, knowledge, or model provider can be validated in this workspace. |
| Live Settings → Intelligence | **No provider / Not connected** | Hosted agent tasks cannot make model calls. |
| Existing hosted Ask Aval task | Failed at **0/24 steps** with “Connect and select a model provider in Settings → Intelligence before using Ask Aval or agent tasks.” | Failure is explicit; a successful hosted agent journey remains unproven. |
| Local ChatGPT subscription transport | Connected; metadata check reports no inference run. | Useful for local model evaluations, separate from a model connection in the hosted workspace. |
| Catalog | Many providers shown; several say **Setup required**. | A listed connector is not proof of working authorization, sync, or provider actions. |

The live inventory is specific to the signed-in synthetic workspace. It does not establish connection status for other Aval customers or organizations.

## Evaluation cases and results

| ID | What the case proves | Evidence | Result |
| --- | --- | --- | --- |
| E01 | Code and database migrations remain internally valid | `npm run typecheck`; `npm run test:migration` | **Pass**: typecheck; 10/10 migration checks. |
| E02 | Basic code paths and integration rules behave as expected | `npm run test:unit` | **Pass**: 776 passed, 1 platform skip, 0 failed. |
| E03 | Database, tenant isolation, imports, audit, approvals, leases, and agent persistence work with synthetic data | `npm run test:postgres` using disposable PostgreSQL | **Pass**: 224/224 after fixing Docker backup client paths. |
| E04 | Public task route, planner, child tasks, review, cron recovery, cancellation, child failure, and missing-model behavior work with scripted model replies | `tests/postgres/planner-cases.mjs` within E03 | **Pass in simulation**; does not prove a live model completes the full chain. |
| E05 | Gmail sync is atomic, replay safe, and detects account changes | `tests/postgres/pilot-cases.mjs` within E03 | **Pass with mocked Gmail HTTP**; no Google account was connected. |
| E06 | PMS writes require authority, deduplicate, and are read back or left unverified | `tests/postgres/pms-write-cases.mjs`, `pms-journey-cases.mjs`, `runner-api-cases.mjs` within E03 | **Pass with synthetic provider/runner**; no live PMS was connected. |
| E07 | An encrypted backup restores data, permissions, and tenant isolation; corruption is rejected | `tests/postgres/backup-cases.mjs` within E03 | **Pass**: 89 restored tables verified. This is a local restore, not verification of scheduled R2 backups. |
| E08 | Independent semantic reviewer recognizes misleading evidence and valid answers with a real model | `tests/fixtures/semantic-cases.mjs`; saved `codex-semantic-evaluation.json` | **Pass for GPT-6 Sol: 16/16** in the preceding live subscription run. The earlier Luna run found all 13 bad cases but rejected 3 valid cases; its report was overwritten by the Sol run. |
| E09 | An authenticated user completes the full hosted model + integration journey | Live Aval workspace | **Blocked**: zero connected integrations and no selected model. |

## Changes made during the evaluation

The first PostgreSQL pass had 222/224 passing because `pg_dump` was absent from Windows. The existing Docker fallback called Unix-only `process.getuid()` and passed Windows host file paths into a Linux container. `scripts/backup-database.mjs` now mounts the temporary backup folder at `/backup`, rewrites dump paths for the container, and omits Unix user flags on Windows. The next complete run passed 224/224, including the encrypted restore.

## Pilot gates still open

1. Connect and select a model provider in the **pilot workspace**. For the budget pilot, select `gpt-6-luna`; retain human review because the earlier semantic eval falsely rejected three valid examples. Set an API spending limit in the provider project before hosted testing. A local ChatGPT subscription connection does not configure the hosted app.
2. Pick **one actual pilot data source**. Connect it to a dedicated sandbox or use the supported import path. Record exactly what data the provider exposes, one successful sync/import, and a repeat run with unchanged counts and totals. Do not treat the catalog's Connect button as validation.
3. Execute a browser-started task with that real model and source: planner → child investigation → semantic review → final answer. Refresh and confirm the result persists; let cron resume the task without browser polling. Record the task trace, model, token use, and final status.
4. If the pilot includes outbound communication or a PMS write, test one approved exact action in the provider's sandbox. Verify the effect by reading it back. Do not use a live resident or financial transaction as a test fixture.
5. Verify the deployed commit and scheduled off-site backup/restore workflow separately. The local restore does not prove the live backup schedule or release identity.

The evaluation must be rerun after the model and first real integration are connected. A pilot launch claim should cite that later run, including provider identity, deployment commit, costs, and any failures.
