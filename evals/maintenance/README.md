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
Do not run subscription evaluations until an explicit remaining token budget can
accommodate them; the existing initial cap has not been increased.
