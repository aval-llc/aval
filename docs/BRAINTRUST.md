# Braintrust observability and maintenance evals

Braintrust is a derived observability/evaluation system. Aval PostgreSQL owns
case state, authorization, approvals, work orders and memory. No production
decision reads state back from Braintrust. Definitions and simulator responses
remain in GitHub; `docs/agent-contract.md` defines correctness.

## Access

The selected organization is `141180b7-e499-4e68-9742-bf25526050c5`, project
`3b2d0c23-3eb6-47be-84fd-e4e53c030d2f`, on the US API data plane.
These are identifiers, not credentials. Confirm the project before uploading.

- Local management: use Braintrust's supported CLI OAuth profile. Do not enable
  global coding-session tracing; this integration concerns Aval engine traces.
- Hosted ingestion: a server-side key/service identity with log-write access to
  this project. Store it as `BRAINTRUST_API_KEY` in Cloudflare secrets.
- Eval publishing: dataset/experiment read and write access in this project;
  use a separate CI secret where possible. Organization administration, billing,
  unrelated projects, and model-provider keys are not needed.
- A browser login alone is not proof that CLI, CI or Worker credentials work.
  Verify each path with a synthetic event and read it back before enabling data.

Use the provider's least-privilege roles available to the account. If a personal
API key inherits broader access, use a suitably restricted service identity or
user instead. Never paste keys into chat, source control, logs or a public report.

## Runtime configuration (disabled by default)

In addition to `BRAINTRUST_API_KEY`, configure:

```text
BRAINTRUST_REGION=us
BRAINTRUST_TRACE_ROUTES=[{"organizationId":"<approved Aval workspace>","projectId":"3b2d0c23-3eb6-47be-84fd-e4e53c030d2f","since":"<approved ISO timestamp>"}]
```

Only explicitly routed workspaces and events after `since` are exported. Do not
enable production tenant content in this first phase. The projection contains
opaque task/step IDs, code/config hashes, event/tool names, policy outcomes,
timing and available usage. Prompt/message bodies, tool arguments/results,
tenant names/contact details, raw error strings and secrets are excluded.
It is pseudonymous operational metadata, not a claim of anonymous data.

The minute cron independently consumes immutable task-step evidence, up to 50
rows per configured workspace (at most ten routes per invocation). It uses fixed
US/EU provider hosts, blocks redirects, and times out outbound writes. A separate
RLS-scoped `agent_trace_deliveries` projection records attempts, status and retry
time. Stable provider event IDs make repeated delivery an upsert, not another
maintenance action. A crash after provider acceptance can replay the same IDs.
Failures back off up to one hour; changing credentials does not erase evidence.

Inspect delivery failures with a privileged, workspace-scoped query of
`agent_trace_deliveries`; compare pending evidence against delivered IDs. UI
backlog alerts and retention/pruning of receipts are follow-up work. Do not use
Braintrust availability as a prerequisite for processing a maintenance case.

## Version manifests

New task steps expose `executionManifest` through the trace API. Historical
steps return null; historical versions are not fabricated. Model calls include
hashes of the actual assembled instructions, offered tools and message/evidence
snapshot. Actor and semantic reviewer are distinct phases. Build identity embeds
the source commit and working-tree content hash; test harnesses use the same
build identity function. Non-model events say `not-invoked` rather than pretending
another model call occurred. Responses replayed during resume have their own
event kind, not a new model-call count.

Policy hashes cover RLS-visible task scope, grants, onboarding preferences,
financial policy, employee configuration/scopes, communication settings and PMS
write authorizations. Scratchpad snapshots remain in Aval and are hashed, not
uploaded. Exact source content remains in existing protected task transcripts
and model-context records. This first phase hashes available state; it does not
yet implement a new property-policy retrieval store or full causal links for
every retrieved document. A hash is not an authorization decision.

Desktop jobs capture the server manifest when queued; the completion endpoint
ignores client-provided manifest data. Hosted model calls capture before calling
the provider and append measured usage and actual reported routing afterward.
Desktop inference timing is not fabricated from queue waiting time.

## Evaluations and acceptance

See `evals/maintenance/README.md` and `npm run evaluate:maintenance -- <new private report path>`.
The initial experiment is `integration_fixture` with no model calls. It reuses
the real PostgreSQL engine, scripted model responses and exact-action approval
tests. Keep failed attempts and incomplete reports; publishing errors preserve
the local report and exit nonzero. Braintrust's `runtime_assertions` score is
not a live-agent success-rate claim.

Next gates: verify ingestion in the configured Braintrust project, run live
maintenance evaluations with `gpt-6-luna` after an explicit budget decision,
add the unimplemented emergency/vendor/scheduling scenarios, and compare
experiments only within the same suite/data/model/policy configuration.

References: [Braintrust API](https://www.braintrust.dev/docs/api-reference),
[CLI authentication](https://www.braintrust.dev/docs/reference/cli/quickstart),
[permissions](https://www.braintrust.dev/docs/reference/authentication).
