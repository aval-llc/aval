# Codex live validation — September 8, 2026

> Historical result. The live 16-case semantic evaluation passed again on
> September 24 with the connected ChatGPT subscription. The durable runtime
> has since moved to PostgreSQL and explicit `DbSession` arguments, while the
> validator described below still boots the retired SQLite harness. Do not use
> `validate:runtime:codex` as a current end-to-end gate until it is ported to a
> disposable PostgreSQL database. See `docs/PILOT_CHATGPT_SUBSCRIPTION.md`.

The local Codex App Server, authenticated with the existing ChatGPT login, completed
live inference using `gpt-6-astra` at low reasoning effort. No Anthropic key was used.

## Results

- **16/16 labeled semantic cases matched**, with zero false approvals among 13 negative
  cases and zero false rejections among three positive controls. Mean case latency was
  10.386 seconds. This is a single run on a small synthetic dataset, not a benchmark
  of general reliability or performance against other systems.
- The **durable runtime run passed**: a reviewed root plan allocated a child, the real
  portfolio tool read isolated SQLite rows, the child completed, and the parent saved
  a separately reviewed answer. The final values were NOI 800 and rent collected 1200,
  with no invented currency, period, or cause.
- One answer review failed; completion was withheld, and bounded repair subsequently
  succeeded. Nine successful model requests reported 107,891 tokens altogether. An
  unsuccessful request did not report usage; exact lost-request billing remains open.
- The evaluation explicitly reserved 180,000 shared tokens because fresh Codex sessions
  carried roughly 11,000–12,000 input tokens per request. Production task limits are
  unchanged. This does not demonstrate compatibility with the default 60,000-token
  budget for the same Codex transport.

## Bug found and fixed

The first durable run failed. The planner invented `get_portfolio_summary`, and its
reviewer approved that impossible plan; the executor rejected it and the task exhausted
its budget without creating children. The original report is retained as
`audit/codex-runtime-baseline.json`.

The plan tool previously exposed its completion check only as an unspecified object.
It now describes each supported condition and enumerates real evidence tools. The
runtime structurally validates plan conditions and permissions before spending a model
review call. The executor retains its own checks. A regression test proves an invented
tool cannot reach the reviewer or allocate child work.

## Reproduce

From the repository root, with an existing `codex login`:

```sh
npm run evaluate:semantic:codex
AVAL_CODEX_EVAL_MAX_TOKENS=180000 npm run validate:runtime:codex
```

These commands make real model requests and consume Codex usage. The model defaults to
the account's reported default; `AVAL_CODEX_MODEL` may select another listed model.
Reports are saved incrementally to `docs/audit/codex-semantic-evaluation.json` and
`docs/audit/codex-runtime-validation.json`. Failed classifications are retained.

## Scope

The transport starts a fresh ephemeral App Server thread per actor/reviewer call and
uses schema-constrained JSON tool proposals, translated into Aval's response contract.
Only Aval's runtime executes the proposed business tools. The App Server runs with
shell, patch and web tools disabled, rejects client tool requests, and uses read-only
sandboxing. This is an evaluation transport, not the hosted model-router adapter.
Its token overhead and per-call output controls differ from the hosted API transport.

The existing integration loader supplies isolated SQLite and the Cloudflare environment
shim. Both canned model entry points are replaced by live Codex calls; no actor decision
or review verdict comes from a fixture. Portfolio rows are explicitly synthetic. This
run does not exercise HTTP authentication, production D1 networking, the scheduler's
hosted trigger, a live PMS account, or the desktop question-answering bridge end to end.
The separate 16-case review evaluation does not load the runtime fixture harness.

Credentials are adopted into a private temporary Codex home, never placed in reports,
repository files, or hosted secrets, and removed when the evaluator closes. Account
preferences and production provider selection are unchanged.

The existing hosted smoke check still routes through its configured Anthropic account
and remains blocked by insufficient credit. These local results do not turn it green
or satisfy its signed desktop release dependency. Business-provider live validation
still requires connected accounts. Native desktop sandbox proof, exact lost-request
billing, and a matched real-task comparison remain open.

Protocol reference: [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
