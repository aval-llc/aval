# Aval Durable-Agent Production Runbook

This is the operating contract for Aval's eight agents. It covers production
deployment, health checks, incident response, reconciliation, approvals, and
the exact controls that must remain in place before a real-world action is
enabled.

## Non-negotiable invariants

1. Model output is untrusted input. Only the deterministic policy engine may
   authorize a tool.
2. The browser observes durable work; it never executes or advances it.
3. No mutating tool retries automatically.
4. A financial reservation is written before a provider call. An unknown
   outcome is reconciled or reviewed, never blindly repeated.
5. Every positive financial amount requires a human. There is no automatic
   payment band.
6. Critical actions cannot be approved by their requester. Elevated financial
   actions require two distinct approvers.
7. A financial policy must be active at proposal time and at execution time,
   and the approved policy version must still match.
8. A provider response is not settlement. Settlement requires an independent
   provider read-back matching transaction id, amount, currency, destination,
   and reversal state.
9. Guest workspaces are read-only. Secrets and raw financial destination ids
   never enter prompts, traces, or alert payloads.
10. Release only through Cloudflare, GitHub, and the signed/notarized DMG
    pipeline. `.chatgpt.site` is not a production target.

## Runtime topology

```text
POST /api/agents/tasks
  -> durable D1 task row
  -> request waitUntil fast path
  -> model proposes a tool
  -> policy evaluates identity + persona envelope + tool registry
  -> read executes, or action parks for approval
  -> step/result digests are persisted
  -> task yields or terminates

Cloudflare cron, every minute
  -> expires stale approvals
  -> claims queued/expired-lease tasks
  -> resumes at persisted transcript
  -> reconciles due financial operations
  -> records worker telemetry and payload-free alerts

GET /api/agents/tasks/:id
  -> read-only state + execution trace
```

The worker processes at most eight tasks per batch, two concurrently, and at
most three reasoning steps or 35 seconds per invocation. A lease prevents two
workers from executing the same task. An expired lease is the crash-recovery
mechanism.

## Deployment order

Database first, code second, live proof third:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npx wrangler d1 migrations list aval-production --remote --config wrangler.deploy.jsonc
npx wrangler d1 migrations apply aval-production --remote --config wrangler.deploy.jsonc
npx wrangler deploy --config wrangler.deploy.jsonc
node scripts/smoke-production-readiness.mjs https://YOUR_PRODUCTION_HOST
```

Migrations `0016` through `0019` are additive. They install durable tasks,
approvals, policy, financial/reconciliation journals, worker telemetry, leases,
and explicit model/provider trace fields. Do not deploy code that writes those
fields before the migrations succeed.

The GitHub workflow `.github/workflows/cloudflare-production.yml` performs the
same sequence on every push to `main`. Required production-environment values:

| Kind | Name | Purpose |
|---|---|---|
| GitHub secret | `CLOUDFLARE_API_TOKEN` | Worker/D1 deployment credential |
| GitHub secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account scope |
| GitHub variable | `AVAL_PRODUCTION_URL` | HTTPS target for live smoke |

The Cloudflare Worker itself needs the existing application secrets plus:

| Secret | Requirement |
|---|---|
| `SESSION_SECRET` | Required for authenticated sessions |
| `INTEGRATION_TOKEN_ENCRYPTION_KEY` | Required before storing workspace-owned provider credentials |
| `AGENT_HEALTH_TOKEN` | Required for the external health monitor |
| `AGENT_ALERT_WEBHOOK_URL` | Recommended HTTPS incident destination |
| `AGENT_ALERT_WEBHOOK_TOKEN` | Recommended authentication for that destination |
| `STRIPE_SECRET_KEY` | Set only when the reviewed `issue_payment` adapter is actually enabled |

Set Worker secrets with `npx wrangler secret put NAME --config
wrangler.deploy.jsonc`; never commit their values.

Aval has no shared model-provider API key. Each workspace must connect and
select its own supported provider in Settings -> Intelligence. A missing,
disconnected, or unreadable provider fails closed before any model call.

## Deployment readiness proof

The automatic production smoke is provider-free and must prove all of these:

- the reserved verification account can authenticate;
- integration configuration is readable within that workspace;
- workspace-scoped agent health is readable;
- no model credit is spent and no task or business record is created.

Before enabling model-backed production use for a workspace, run the separate
durable smoke with that workspace's connected provider:

```bash
node scripts/smoke-durable-agent.mjs https://YOUR_PRODUCTION_HOST
```

That manual gate must reach `COMPLETED` and retain both model/provider
provenance and a real read-tool call in its persisted trace.

After smoke, inspect one task row and its ordered steps when authorized:

```bash
npx wrangler d1 execute aval-production --remote --config wrangler.deploy.jsonc \
  --command "SELECT id,status,step_count,execution_attempts,finished_at FROM agent_tasks ORDER BY created_at DESC LIMIT 5"
```

Do not print transcript JSON, approval evidence, or provider results into CI
logs.

## Health and SLOs

Configure an external uptime monitor to call once per minute:

```text
GET https://YOUR_PRODUCTION_HOST/api/agents/health
Authorization: Bearer $AGENT_HEALTH_TOKEN
```

The global endpoint contains counts and timestamps only. It returns `503` for
critical state and `200` otherwise. An authenticated workspace owner can read
workspace-scoped health in the Settings surface without the bearer token.

Current thresholds:

| Check | Degraded | Critical |
|---|---:|---:|
| Last completed worker | over 3 minutes | missing or over 10 minutes |
| Oldest runnable task | over 2 minutes | over 10 minutes |
| Expired running lease | n/a | any |
| Failed tasks, rolling 24h | 3-9 | 10 or more |
| Reconciliation mismatch/manual review | n/a | any |
| Reconciliation overdue by 10 minutes | n/a | any |

Alert webhooks intentionally contain only severity, code, run/task id, count,
and timestamp. They must not contain goals, arguments, results, organization
names, account ids, amounts, or provider response bodies.

### First response

1. Determine whether the alert is worker, queue, task, or reconciliation.
2. Check Cloudflare Workers Logs using `runId` or `taskId`.
3. Do not release a lease manually until its recorded expiry; another worker
   may still own it.
4. For task failures, inspect ordered trace metadata and digests. Do not copy
   sensitive payloads into an incident channel.
5. For reconciliation alerts, suspend the workspace policy before inspecting
   or remediating any external transaction.
6. Record the incident, operator identity, decision, and external provider
   reference in the approved case-management system.

## Financial policy activation

Financial execution fails closed until a workspace owner activates a policy in
Settings -> Financial agent controls. The owner must enter:

- one-approver maximum;
- hard per-transaction ceiling;
- rolling 24-hour committed-spend limit;
- allowed ISO currencies;
- exact provider destination account ids;
- the confirmation phrase `APPROVE FINANCIAL POLICY`.

Only SHA-256 destination fingerprints are stored. Publishing a new version
replaces the complete allowlist and invalidates any approval issued under the
old version. Suspending the policy blocks proposal and execution immediately.

Thresholds must be approved in writing by the business owner, finance owner,
and counsel/compliance owner where applicable. Engineering must not invent or
raise them. The default is a draft, zero-authority policy.

## Approval operations

Approval evidence must show the proposed tool, risk, redacted arguments,
amount/currency where applicable, required decision count, expiry, and policy
version. Decisions are append-only.

- rejection is immediately final and may be made by the requester;
- critical approval may not be made by the requester;
- elevated financial approval requires two distinct users;
- an expired approval cannot execute even if the sweep has not run;
- changing/suspending policy invalidates stale approval authority;
- approval binds to one exact tool-use id, not merely a tool name.

Important current product boundary: Aval's account model still creates one
workspace per user and has no organization-membership/invitation flow. That
means genuine second-person approval cannot yet be operated through the UI.
The runtime therefore fails closed for critical financial actions. Do not
enable a real critical tool until organization membership, approver roles, and
an access review are shipped and tested.

## Reconciliation response

Treat `unknown`, `mismatch`, `manual_review`, and `provider_unavailable` as
different operational states:

| State | Meaning | Operator action |
|---|---|---|
| `unknown` | reservation exists; provider outcome was not trustworthy | do not retry; independently search provider |
| `provider_unavailable` | scheduled independent read failed or adapter is absent | restore provider access; let bounded backoff retry |
| `mismatch` | provider object conflicts with expected transaction | suspend policy; investigate immediately |
| `manual_review` | reversal, invalid provider result, or unresolved after 24h | human resolution required; never auto-retry |
| `matched` | independent read matched all required fields | no action |

The current Stripe adapter independently retrieves a transfer and compares id,
amount, currency, destination fingerprint, and reversal state. Vendor-spend
reconciliation has no provider adapter and therefore cannot be called matched.
That is deliberate.

## Retry and recovery

- Model/transient task failure: maximum four task attempts with exponential
  backoff, capped at ten minutes, plus stable sub-ten-second jitter.
- Read-only tool: descriptor-specific bounded retry and timeout.
- Mutating tool: zero automatic retries.
- Financial action: atomic reservation before provider call; unknown outcome
  goes to reconciliation/manual review.
- Worker crash: another worker may claim only after lease expiry and resumes
  from the persisted transcript.
- Lost lease: the old worker cannot overwrite the new owner's checkpoint.

## Cancellation

Cancellation is accepted until a task is terminal and propagates to child
tasks. It prevents future work; it cannot undo a side effect that already
occurred. Financial cancellation therefore still requires reconciliation of
every reserved/submitted operation.

## Desktop release

`.github/workflows/desktop-release.yml` refuses to publish an unsigned build.
It requires:

- `MAC_CSC_LINK`
- `MAC_CSC_KEY_PASSWORD`
- `APPLE_API_KEY_P8_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

The macOS job uses hardened runtime and explicit entitlements, asks
electron-builder to notarize the app, separately notarizes/staples the DMG,
then verifies `codesign`, `stapler`, and Gatekeeper before publishing. The
rolling GitHub release includes the DMG, ZIP, `SHA256SUMS`, and
`CODESIGN.txt`. If any credential or verification is absent, the job fails;
there is no unsigned fallback.

## Rollback

Worker code may be rolled back through Cloudflare version history or by
redeploying a known-good Git commit. Do not reverse additive D1 migrations as
part of a code rollback. Old code ignores the new tables/nullable columns;
dropping them would destroy audit and recovery state.

Before rollback:

1. suspend active financial policies if the incident touches action safety;
2. preserve logs and task/financial identifiers;
3. confirm no migration rollback is required;
4. deploy the known-good code;
5. verify health, enqueue a read-only smoke task, and reconcile all non-matched
   financial operations.

## Action-enablement gate

The financial tool descriptors remain `unimplemented` and are denied by the
registry. This is intentional. Before the first real payment, lease signature,
destructive action, or external communication is enabled, require all of:

- provider-specific executor and independent reconciliation adapter;
- sandbox and production contract tests;
- organization membership and role-based approver authorization;
- business-approved thresholds and documented destination ownership;
- legal/compliance review;
- incident owner and on-call monitor;
- live canary with a reversible, de minimis action;
- reconciliation evidence retained independently of the general audit chain.

Until every item is complete, Aval is Level 4 for durable analytical agents
with Level 5-style controls built around—but not permission to perform—money
movement.
