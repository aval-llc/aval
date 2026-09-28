# Maintenance contract regression evaluation

GitHub owns this harness, scenarios, assertions, fixtures and simulator logic.
Braintrust stores the mirrored dataset, immutable experiment results, scores and
trace projections. Aval PostgreSQL remains authoritative for operational state
and scratchpad memory. Braintrust is never queried to authorize an action.

Run against a migrated **disposable loopback** database:

```sh
AVAL_TEST_DATABASE_URL=postgresql://.../aval_test node --import ./tests/integration/module-hooks.mjs scripts/evaluate-maintenance-contract.mjs /private/tmp/maintenance-eval.json
```

The initial adapter executes the existing PostgreSQL Desktop/durable-maintenance
regressions in `tests/postgres/desktop-inference-cases.mjs`. Model responses are
scripted; actual task transitions, permissions, approvals, database writes and
replay behavior use Aval's engine. It makes **zero model calls** and is labelled
`integration_fixture`, not live-model success. Tests and scripted tool proposals
stay in GitHub, not in a remotely edited Braintrust prompt.

Each case records pass/fail, duration, suite/source revision and an assertion
score. A failed case remains in the report and makes the command exit nonzero.
This score means only that the named assertions passed; it is not an agent
completion, language quality, identity accuracy or provider-certification score.
Safety coverage is incomplete: emergency dispatch, vendor selection/contact,
scheduling, and actual Luna end-to-end quality remain separate future gates.

`--publish` mirrors the synthetic scenario descriptions into a version-named
Braintrust dataset and writes a new experiment. Set `BRAINTRUST_API_KEY`,
`BRAINTRUST_PROJECT_ID`, and `BRAINTRUST_REGION` through a secret store/environment;
do not commit credentials. Without `--publish`, no Braintrust network call occurs.
Do not run subscription evaluations until an explicitly authorized remaining
token budget can accommodate them; never assume a previous cap was increased.

## Phase-two behavior evaluation

`scripts/evaluate-maintenance-behavior.mjs` runs real PostgreSQL intake gates:
unknown/ambiguous resident matching, newsletter filtering, persistent onboarding
deferral and workspace isolation. It uses new synthetic workspaces on the existing
disposable database. Reports must be outside the repository and never overwritten.

```sh
AVAL_TEST_DATABASE_URL=postgresql://.../aval_test node --import ./tests/integration/module-hooks.mjs scripts/evaluate-maintenance-behavior.mjs ../outputs/maintenance-behavior-gates-01.json
```

Live mode uses the same Desktop inference implementation and authenticated queue
routes as Aval, with GPT-6 Luna only. It leaves the product's task limits and
prompts unchanged for the baseline. Synthetic decisions exercise real approvals;
all tenant communication stays draft-only. The case catalog covers routine English
and Mexican Spanish requests, source-text injection and rejection. The routine
case defaults to three repetitions, stopping on failure for inspection.

Set `AVAL_CODEX_MODEL=gpt-6-luna`, `AVAL_CODEX_EXECUTABLE`, an explicitly authorized
`AVAL_MAINTENANCE_BUDGET_ID`, and `AVAL_MAINTENANCE_BUDGET_TOKENS`, then add `--live`.
`AVAL_EVAL_SCENARIO` selects a catalog case; `AVAL_EVAL_REPETITIONS=1` starts with a
single baseline. `--skip-gates` avoids repeating the deterministic intake suite.
`--continue-on-failure` collects the whole selected matrix without stopping for
individual failures; the global token budget still stops new calls. Flooding
tests evaluate internal urgency classification, not emergency dispatch readiness.
Keep all reports for a budget in the same output directory. Prior reported tokens
and reservations for unknown usage count against that budget; unfinished prior
reports must be reconciled before another run. No hosted API fallback exists.

Independent checks inspect actual work-order records, exact property/unit/lease,
priority, approvals, duplicate approval delivery, outbound records and evidence
reads. A blocked action is distinct from a completed request. Successful records
do not by themselves establish factual correctness of all final prose; review the
stored answer and trace. Emergency acknowledgement and vendor/scheduling recovery
remain explicit capability gaps, not passed tests.

Scorer `maintenance-behavior-scorer-v2` requires a clean terminal or human-owned
task state. A rejected mutation followed by budget exhaustion passes the narrow
authorization assertion but fails the workflow. Older measurements are retained;
rescoring publishes a separate versioned experiment with zero new model calls.

Publish a finished synthetic report with `bt eval` and an authorized OAuth profile:
set `AVAL_MAINTENANCE_REPORT`, `BRAINTRUST_PROJECT_ID`, and the project name, then
run `evals/maintenance/publish-report.eval.mjs`. Install the official Braintrust SDK
in isolated eval tooling; optionally supply its file URL as
`AVAL_BRAINTRUST_SDK_MODULE`. Use `--no-auto-instrumentation` to avoid capturing
unrelated activity. The upload imports measured results and makes zero model calls.
Observed execution timings are explicit fields; upload span durations are not
agent latency. No production data or production trace configuration is required.
