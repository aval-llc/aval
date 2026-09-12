# Aval MVP readiness audit

Source reviewed: `d4ea72a` on `khas`, September 12, 2026. This report extends the backend regression audit into product scope, access control, data ingestion, agent journeys, deployment, operations, and desktop delivery. It does not certify the current hosted deployment.

## Decision

Aval has enough architecture for a small, supervised pilot. It is not yet demonstrated ready for a self-service, unattended property-management product. The next work should prove one usable customer journey and close its safety/operating gaps, rather than add another backend service or product domain.

Recommended first promise:

> Import a small property's verified records, ask Aval to investigate an operational question, inspect the evidence, and review the recommended next action. If messaging is included, approve one exact message and see its recorded provider outcome.

Start with trusted members who may see the entire workspace. Use separate organizations for confidential owner groups until scoped content access is fixed. Start in supervised mode, using one supported API-key model, one validated data source, and at most one outbound channel. Do not make payment execution, lease execution, enterprise SSO, or every catalog connector part of the launch promise.

## What exists and how complete it is

| Area | Repository capability | MVP assessment |
| --- | --- | --- |
| Backend | One Worker, Supabase PostgreSQL/Auth, explicit sessions, RLS, transactional writes, leases and cron. | Keep this architecture. Deploy the tested fixes and verify the hosted configuration. |
| Accounts | Email/password signup/login/logout, verified-email checks, refresh cookies, workspace invitations. | Real new-user/verification/refresh/recovery journey needs acceptance testing; no password-recovery or resend flow was found in application routes/UI. |
| Property operations | Property/unit/resident/lease/work-order/accounting records, import planning/application, metrics and source provenance. | Usable substrate; validate a real fixture against expected totals and repeat imports. |
| Integrations | Catalog, credential verification, OAuth flows, readiness blockers, some read/message/listing adapters. | Catalog breadth exceeds implemented ingestion. QuickBooks is the only automatic import provider and currently imports accounts/journals; it does not populate all property/resident/lease data. |
| Agents | Personas, tool policy, planning/delegation, durable tasks, deterministic and semantic checks, approvals, traces, memory. | Promising implementation; public planner-to-children-to-final-result journey is not covered by the six new PostgreSQL workflow tests. |
| External actions | Implemented message/call/listing adapters with approvals and durable delivery records. | Sandbox-test the one selected channel before offering it. Keep other actions unavailable. |
| Money/leases | Reservation/reconciliation code and approval policy exist. | `issue_payment`, `authorize_vendor_spend`, `dispatch_vendor`, and `execute_lease` remain explicitly unimplemented in the agent registry. Do not describe them as working agent actions. |
| Documents | Text storage, text-format uploads, document Q&A/extraction, draft/export tooling. | Supported upload formats are text/Markdown/CSV/JSON/XML/log. A general PDF/OCR/original-file document repository is not implemented. Scope the UI promise accordingly. |
| Frontend | Localized dashboard, setup/preferences, assistant, tasks, approvals, documents and many operational views. | Needs a short first-success path. Preference selection is not provider connection or data import. Ten onboarding preference categories are more than a new pilot user needs before seeing value. |
| Billing | Stripe event deduplication, subscriptions/top-ups, token balance display. | Defer automated paid metering for a free/BYO-key pilot; fix historical entitlement accounting before selling usage credits. |
| Operations | Agent health, traces, optional webhook alerts, deployment workflow and smoke script. | No checked-in scheduled backup/restore workflow found. Alert delivery, retention and operational recovery remain acceptance work. |
| Desktop | Electron wrapper, origin-checked IPC, sandbox/context isolation, packaging/signing configuration and tests. | Web-first pilot can defer a new desktop release. If desktop is promised, verify the released binary separately; source/build checks do not validate signing or updater behavior. |

## Launch blockers and concrete next tasks

### P0 — Prove the user-facing agent journey

The public task endpoint always creates a task with `check: { kind: "plan" }` in [app/api/agents/tasks/route.ts](../../app/api/agents/tasks/route.ts). The six PostgreSQL scenarios create `kind: "evidence"` tasks directly in [tests/postgres/audit-cases.mjs](../../tests/postgres/audit-cases.mjs). They validate important child-runtime behavior, but bypass the public planner, plan review, child creation, dependencies, and final synthesis.

Next: add a PostgreSQL test through the real task route and scheduled worker covering root planning, independent review, child completion, parent resumption and final result. Then execute that journey with the selected real model on synthetic data. Include an approval/rejection branch if messaging is in the pilot.

Done when: an ordinary browser user starts a task, closes the tab, returns, and sees either the correct evidence-backed result or a useful explicit failure; no developer has to edit task rows or press a hidden worker button.

### P0 — Fix or constrain within-workspace confidentiality

The property policies can restrict a user to one property, but the `agent_tasks`, `agent_model_contexts`, `documents`, and `conversations` SELECT policies use organization access alone. See [default RLS policies](../../supabase/migrations/20260910000200_default_deny_rls.sql). No later migration was found narrowing those four SELECT policies by property/owner scope.

A new local probe reproduced this using the restricted `aval_app` role: a synthetic viewer limited to one property saw **1 property, 13 organization-wide tasks, and 1 organization document**. All probe mutations were inside a transaction that was rolled back. This was not a production-data test.

Next: either restrict the pilot to trusted, full-workspace teams in separate organizations, or classify and scope tasks, evidence, documents and conversations and propagate the requesting user's scope into worker execution. The worker currently operates under an organization-wide service role; its tenant isolation does not automatically implement a human's narrower property permissions.

Done when: a property/owner-limited member cannot obtain another property's content through a task result, trace, document, conversation, export, or agent tool. Do not market institutional-owner isolation until these negative tests pass.

### P0 — Establish the actual staging/release state

The prior audit commit includes three new migrations. Source fixes alone do not repair an already deployed database. Verify migration hashes, runtime role, Hyperdrive binding, Auth configuration, and `INTEGRATION_TOKEN_ENCRYPTION_KEY` in the deployment environment without exposing values. Model connections require that encryption key and an explicitly selected connected provider.

The production workflow already orders migrations before deployment. Its post-deploy smoke verifies login and readable integration/health endpoints, **without a model call**. It can report a readable but unhealthy agent state and does not establish successful task completion. See [.github/workflows/cloudflare-production.yml](../../.github/workflows/cloudflare-production.yml), [smoke script](../../scripts/smoke-production-readiness.mjs), and [model router](../../lib/ask-aval/model-router.ts).

Done when: staging passes fresh signup or invitation, verified login, data import, a complete agent task, and a restart/cron-resume test. Record the tested app commit, migration versions and configuration identity.

### P1 — Choose and validate one real data path

[integrationReadiness](../../lib/integrations/readiness.ts) explicitly marks many large PMS integrations as unfinished; [AUTOMATIC_IMPORT_PROVIDERS](../../lib/integrations/sync-worker.ts) contains only QuickBooks. Connecting or verifying credentials is not evidence that tenant/unit/work-order records will appear.

Next: select the actual pilot source. If its adapter is absent, offer an explicit supported import template and a guided import flow. Use a versioned fixture with properties, units and the relevant operational records. Verify row counts, totals, relationships, duplicates, rejected rows and source freshness. Validate QuickBooks in its sandbox if that is the chosen source.

Done when: importing the same dataset twice changes no totals or row counts; incorrect references reject cleanly; the dashboard agrees with the expected fixture; Aval clearly distinguishes missing data from zero.

### P1 — Finish account recovery and first success

No application password-reset, resend-verification, or Supabase social-login callback/UI was found. Business-provider OAuth is a separate feature from signing into Aval. A Supabase dashboard provider setting alone does not prove an Aval sign-in flow exists.

Next: test verification links, login after verification, expiry/refresh, logout, invitation acceptance and disabled/revoked access. Add reset/resend before self-service signup; a small invited pilot can use a documented assisted recovery process initially. Keep social login optional.

Simplify the first-success UI to: **join workspace → connect model → load records → run a suggested task → review result**. Show unavailable integrations explicitly and make reconnect/missing-configuration errors actionable. See [onboarding](../../app/components/onboarding.tsx), [preference options](../../lib/onboarding/preferences.ts), and [Auth implementation](../../lib/auth/supabase.ts).

Done when: a new nontechnical user completes that flow without navigating Intelligence, integrations, setup and task internals by guesswork.

### P1 — Close the remaining background/action failure gaps

[scheduled-sweep.ts](../../lib/workers/scheduled-sweep.ts) wraps import, communications and agent work for an organization in one `try`: an import exception skips its remaining work that sweep. Isolate those job families and test that an import failure does not prevent agent progress.

[executor.ts](../../lib/agents/executor.ts) uses a timeout race that does not cancel the underlying tool. Mutating tool retries are disabled, which helps prevent duplicates, but a late operation can still finish after the task records a timeout. Before enabled external actions, test provider timeouts, ambiguous acceptance, restart, duplicate webhooks, and approval-to-send idempotency. Add cancellation propagation or explicit reconciliation where needed; do not blindly repeat an unknown send.

[model-router.ts](../../lib/ask-aval/model-router.ts) refreshes subscription credentials outside a transaction and updates the connection without a refresh lease or old-token comparison. Concurrent stale-token requests need a regression test and coordination. For the first pilot, a standard API-key path reduces this dependency.

Done when: failures in one job family do not stall another; duplicate/restarted execution cannot produce a second external action; unknown outcomes are visible for review.

### P1 — Add recoverability and operating limits

No backup/restore automation was found among the checked-in workflows. Add an encrypted off-site database backup and complete a restore into a disposable environment before accepting valuable customer data. Connect the existing health alerts to a monitored destination. Define who investigates a stuck task, failed import or expired connection.

Set practical workspace/task/data limits and a retention policy. Full transcripts and model request/response contexts are persisted, while no cleanup process was found. The audit display and usage calculations also read whole histories. Measure a representative pilot dataset and task concurrency before introducing new queue infrastructure.

Done when: a backup restores and a known account can use the restored data; a forced job failure reaches the operator; request latency and database growth are measured within the pilot's chosen limits. Short provider/database work and visible failures align with [Cloudflare's Worker guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

### P1 — Repair clean-checkout CI and expand the right tests

The `khas` PostgreSQL PR workflow now invokes the root unit suite but installs only root dependencies. That suite discovers `desktop/test/package-mac.test.cjs`, which requires `app-builder-lib/scheme.json` from desktop dependencies. The production workflow already runs `npm ci --prefix desktop`; the PR workflow should do the same or explicitly separate web and desktop suites. A local pass with preinstalled desktop dependencies does not prove a clean PR runner will pass.

Expand PostgreSQL coverage for the selected import, public planner, scoped access and selected message adapter. Keep a small realistic model evaluation set initially: successful investigation, insufficient data, conflicting data, injected document instructions, approval/rejection, cancellation, disconnected provider, rate limit, restart and duplicate delivery. Run through the actual HTTP/browser entry points. The old SQLite harness is not a substitute.

Done when: a clean checkout passes the required CI jobs; the pilot's browser journey and failure cases have repeatable acceptance evidence. Avoid building a 100-case platform before these core cases work.

### P1 before charging — Correct billing entitlements

[lib/billing/usage.ts](../../lib/billing/usage.ts) grants today's plan allowance multiplied by months since organization creation. Changing plan therefore recalculates historical entitlement. Billing redesign was intentionally deferred in the migration; this remains a real follow-up. BYO-key usage is recorded with zero billable tokens, so the current billing rows are also not complete model-use telemetry.

For a free/BYO-key pilot, hide purchase/credit promises and retain hard runtime budgets. Before charging usage credits, record grants and usage reservations, reconcile Stripe events, and test plan changes, cancellations, duplicate events and concurrent spending.

## Lean implementation order

1. **Make the review branch releasable:** fix clean-runner CI; apply its migrations in staging; prove verified login and a connected API-key model.
2. **Ship the data-to-answer loop:** one supported dataset/import, one public planner workflow, evidence links, useful error states and simplified onboarding.
3. **Constrain access and side effects:** trusted workspace pilot or fully tested scoped content; supervised mode; one reviewed external action only if it passes sandbox tests.
4. **Prove recovery:** task restart/cancellation, independent cron jobs, backup restore, alerts and bounded costs/growth.
5. **Pilot with a few invited users:** watch them complete the journey without intervention; resolve blockers from their use before opening signup or adding integrations.

## What can wait

More PMS adapters, autonomous money movement, lease signing, SAML, portfolios/owner-facing portals, vector search, full PDF/OCR ingestion, Realtime, PGMQ/new workers, a billing ledger for an explicitly free pilot, and another desktop release if the pilot is web-only. These are scope choices; do not expose unfinished capabilities as working features.

## Evidence and limits

The same reviewed source commit previously passed 504 unit tests (one host-specific skip), 27 PostgreSQL tests and a production build; this turn did not rerun unchanged full suites. This turn added a rollback-only scoped-access probe and inspected source/entry-point coverage across accounts, product UI, data/imports, agents, actions, billing, database security, deployment/CI, recovery and desktop. It did not run live provider actions, browser acceptance, hosted load tests, dependency-advisory scanning, or a production restore. Those are open checks, not assumed passes.

No runtime code, remote configuration or production data was changed for this readiness review.
