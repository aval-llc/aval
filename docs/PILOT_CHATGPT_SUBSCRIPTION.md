# ChatGPT subscription pilot setup

Aval supports a ChatGPT Plus or Pro subscription for local pilot testing through the official Codex App Server. Personal ChatGPT credentials stay on the pilot computer and are never stored in GitHub, Supabase, or Cloudflare.

## Two supported test paths

### Interactive Ask Aval

Use the Aval Desktop app:

1. Open Aval Desktop and sign in to the Aval workspace.
2. Open **Settings → Intelligence**.
3. Select **Connect ChatGPT plan**.
4. Complete OpenAI's browser sign-in.
5. Select **Use this** and choose an available model.
6. Open Ask Aval and ask a question based on synthetic pilot data.

The browser version at `app.aval.llc` cannot use a personal ChatGPT subscription by itself. The subscription option appears only inside the trusted desktop shell.

### Full agent workflow evaluation

The local evaluation transport can test the planner, child investigations, review, and final answer with the same ChatGPT subscription:

```powershell
npm run check:subscription:codex
npm run evaluate:semantic:codex
```

Run the readiness check first. It reads ChatGPT account and model metadata without making an inference request. The evaluation commands make real model calls and consume subscription usage.

The old `validate:runtime:codex` command still targets the retired SQLite task harness and is not a valid current-runtime gate. It must be ported to a disposable PostgreSQL database before it is used again. The semantic evaluation validates live reviewer behavior; PostgreSQL integration tests separately validate orchestration mechanics without a live model. Neither alone proves the combined production path.

## Commercial API default

Aval defaults a newly connected OpenAI API account to `gpt-6-luna`. At standard processing rates it costs $0.10 per million input tokens, $0.01 per million cached input tokens, and $0.50 per million output tokens. It supports Aval's structured function tools and is the cost-conscious starting point for pilot traffic. Aval forces `reasoning_effort: "none"` for Luna function calls made through the current Chat Completions adapter, as required by OpenAI.

The September 24 live subscription evaluation found all 13 seeded defects with no false approvals, but Luna rejected three valid examples. That makes it suitable for a supervised, cost-focused pilot while showing that it should not be trusted as an unattended final reviewer yet. Use the saved evaluation in `docs/audit/codex-semantic-evaluation.json` when deciding whether a stronger review model justifies its higher cost. API billing and ChatGPT subscription limits remain separate.

## Hosted agent boundary

Cloudflare cannot safely hold or refresh a pilot user's personal ChatGPT subscription session. Scheduled agents and tasks that must continue after the pilot computer closes therefore require a workspace API key in the hosted environment. Aval does not copy desktop ChatGPT credentials to its servers or silently fall back between the two modes.

For a pilot, use ChatGPT subscription mode to evaluate behavior locally and use a tightly limited API key only when testing unattended hosted tasks. A future Business or Enterprise deployment can replace this split with an organization-managed identity and policy.

Protocol reference: [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
