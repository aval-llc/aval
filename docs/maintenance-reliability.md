# Maintenance protocol v2

This is a release candidate, not permission to enable autonomous vendor work.
Aval's PostgreSQL engine owns identity, policy, approvals and persisted effects.
Desktop supplies actor/reviewer proposals only; subscription credentials stay local.

## Runtime contract

- One maintenance tool proposal per actor response. Mixed proposals execute nothing, receive one correction, then hand off if repeated.
- The server reconstructs approval/execution receipts from scoped records and the exact canonical approved proposal. Actor assertions never grant authority.
- Approval, execution and narrative verification remain distinct facts. Completing an agent task does not close a maintenance work order.
- A verified effect advances the actor to a draft-only conclusion. Rejection, expiry, repeated reads, verification failure, emergency priority or exhausted allowance can require human review.
- Human handoffs identify the initiating authorized member, or the workspace owner if membership was removed, with review due immediately. They do not schedule automatic model retries.
- Cancellation preserves existing receipts. Historical outcome columns remain null rather than inventing confirmations.
- Full transcripts remain stored. If a maintenance context would evict evidence, stop for human review instead of dropping potentially contradictory facts. A richer compressed evidence projection is deferred.

## Inference accounting

Protocol v2 records request bytes, a labeled input-token estimate, cumulative and last provider usage snapshots, thread/turn IDs, model selection, software versions and server reservation reconciliation. Repeated usage events are deduplicated. One completed job is charged once, including after cancellation.

The current transport starts a fresh thread for each job. Its cumulative total includes internal provider requests; the last notification's `last` value is not the full job cost. Cached and reasoning counts are retained when exposed. Requested/resolved model identity is recorded; an independently attested actual model is not exposed.

The installed transport does not expose a hard per-turn output-token limit. Reservations are admission estimates, **not guaranteed ceilings**. Unknown interrupted usage retains its reservation and pauses the runner. Task allowance, runner allowance, evaluation allowance and context bytes are separate limits. The maintenance review reserve is a versioned heuristic, not a provider-enforced maximum. Do not increase task caps without an explicit experiment.

Old runners receive an update-required response for maintenance actor and reviewer jobs. Protocol capability support must also be verified against the exact packaged App Server version before release.

On timeout Desktop requests interruption and listens for up to ten additional seconds for the terminal event. Confirmed cumulative usage is returned in a serializable IPC envelope, charged once by the server, and never accompanied by executable proposals. Without terminal evidence, the reservation stays charged against available allowance. Both outcomes pause the runner and leave an owned human-review handoff. An expired but still-current claim can report failure; replaced claims cannot.

Admission v2 reserves at least 64,000 tokens for verification and uses the greater of its floor and recent measured actor/reviewer costs before claiming another maintenance request. This does not raise the task cap or guarantee provider usage. The packaged-protocol test validates the installed binary's generated schema without inference; it is not live subscription validation.

## Evaluation and release

Definitions and deterministic assertions live in `evals/maintenance` and `tests`; private synthetic reports stay outside this public repository. The PostgreSQL harness exercises the real durable engine. Braintrust publishing imports measured reports without calling a model, separates workflow completion from correct handoff and incomplete runs, and leaves unreached checks unscored with visible coverage.

Every experiment carries the source-tree fingerprint, dataset fingerprint and scorer version. Raw requests, responses and reviewer evidence are exported only for explicitly synthetic reports. Imported execution spans use measured timestamps. Preserve baseline and failed candidate experiments.

Reports include a separate versioned live-workflow gate with required scenario coverage. Passing a selected subset or deterministic intake tests cannot pass this gate. Unknown usage, missing repetitions, failed attempts and duplicate case rows remain blockers. A passed workflow gate still does not imply that deployment, backup restoration or signing gates passed.

Required release gates include three consecutive English and Mexican Spanish routines, three emergency-triage handoffs, injection/property-conflict/rejection cases, zero observed unsafe or duplicate effects, usage reconciliation, database/migration/Desktop checks, backup restoration, staging, and signed/notarized artifact verification. A safe handoff in a routine case is not a workflow pass. Unknown usage or insufficient evaluation allowance means **incomplete**, not acceptance.

Run unit, migration and Desktop tests; run PostgreSQL tests on a fresh disposable loopback database with `pg_dump` and `pg_restore` available. Use `scripts/evaluate-maintenance-behavior.mjs` for explicitly budgeted subscription evaluations and `evals/maintenance/publish-report.eval.mjs` through the Braintrust CLI to publish completed synthetic reports.

Do not replace the hosted Desktop release or deploy this candidate until its live and staging gates pass. No tenant sending, vendor outreach, spending, scheduling, PMS writes or acknowledged emergency dispatch is added by this protocol.
