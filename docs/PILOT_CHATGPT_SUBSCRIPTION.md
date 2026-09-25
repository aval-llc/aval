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
$env:AVAL_CODEX_EVAL_MAX_TOKENS = "180000"
npm run validate:runtime:codex
Remove-Item Env:AVAL_CODEX_EVAL_MAX_TOKENS
```

Run the readiness check first. It reads ChatGPT account and model metadata without making an inference request. The evaluation commands make real model calls and consume subscription usage.

The current durable-runtime validator uses an isolated synthetic SQLite fixture. It validates agent reasoning and orchestration but does not prove the production Supabase, authentication, scheduler, or PMS paths. Production PostgreSQL tests remain a separate required gate.

## Hosted agent boundary

Cloudflare cannot safely hold or refresh a pilot user's personal ChatGPT subscription session. Scheduled agents and tasks that must continue after the pilot computer closes therefore require a workspace API key in the hosted environment. Aval does not copy desktop ChatGPT credentials to its servers or silently fall back between the two modes.

For a pilot, use ChatGPT subscription mode to evaluate behavior locally and use a tightly limited API key only when testing unattended hosted tasks. A future Business or Enterprise deployment can replace this split with an organization-managed identity and policy.

Protocol reference: [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
