/**
 * The local Aval server.
 *
 * Two ways to get a database underneath it, and the second exists because the
 * first needs Docker:
 *
 *   - **Supabase** (`supabase start`), when a container runtime is installed.
 *     The full stack — Postgres and the Auth API — so signing in works and the
 *     server behaves like the hosted one.
 *   - **A native PostgreSQL cluster**, when no container runtime is present.
 *     `database-harness.mjs` provisions one the same way the integration lane
 *     does, and the checked-in migrations are applied to it directly.
 *
 * The fallback is deliberately a *partial* local build and says so rather than
 * failing later in a way that reads as a bug. Supabase Auth is an API, not a
 * schema, so nothing native can stand in for it: pages render and the database
 * is real, and signing in does not work. That is worth having — it is the
 * difference between no local server at all and one that can exercise
 * everything up to the session boundary — but it is not the hosted behaviour
 * and must not be reported as though it were.
 */

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applySupabaseMigrations } from "./migration/apply-supabase-migrations.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = process.env.AVAL_LOCAL_PORT ?? "3000";
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error("AVAL_LOCAL_PORT must be between 1024 and 65535.");
const config = ["--config", "wrangler.local.jsonc", "--persist-to", ".wrangler/aval-local-state"];
const supabaseCli = "node_modules/supabase/dist/supabase.js";
const runSupabase = (args, capture = false) => spawnSync("node", [supabaseCli, ...args], {
  cwd: root,
  encoding: capture ? "utf8" : undefined,
  stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  env: { ...process.env, CI: "true" },
});

/** Whether a container runtime is actually usable, not merely installed. */
function containerRuntime() {
  for (const binary of ["docker", "podman"]) {
    const probe = spawnSync(binary, ["info"], { stdio: "ignore" });
    if (probe.status === 0) return binary;
  }
  return null;
}

/**
 * A native cluster and the checked-in migrations, with no Supabase Auth.
 *
 * The same provisioning the integration lane uses, in its own database so that
 * running the tests does not drop the server's data.
 */
async function nativeDatabase() {
  process.stderr.write(
    "No container runtime found, so Supabase cannot start.\n"
    + "Falling back to a native PostgreSQL cluster: pages and the database work,\n"
    + "and signing in does NOT — Supabase Auth is an API that nothing local replaces.\n"
    + "Install Docker or Podman for a full local stack.\n",
  );

  const harness = spawnSync("node", ["scripts/database-harness.mjs", "start"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, AVAL_TEST_PG_DATABASE: process.env.AVAL_LOCAL_PG_DATABASE ?? "aval_dev" },
  });
  if (harness.status !== 0) {
    process.stderr.write("Could not provision a local PostgreSQL cluster. Is PostgreSQL installed?\n");
    process.exit(harness.status ?? 1);
  }

  const databaseUrl = String(harness.stdout ?? "").trim();
  await applySupabaseMigrations(databaseUrl);
  // No SUPABASE_URL or SUPABASE_ANON_KEY. `lib/auth/supabase.ts` refuses when
  // they are absent, which is the honest failure — a placeholder would turn a
  // missing service into a confusing authentication error.
  return ["--var", `DATABASE_URL:${databaseUrl}`];
}

async function supabaseDatabase() {
  const started = runSupabase(["start"]);
  if (started.status !== 0) process.exit(started.status ?? 1);
  const migrated = runSupabase(["migration", "up", "--local"]);
  if (migrated.status !== 0) process.exit(migrated.status ?? 1);
  const status = runSupabase(["status", "--output", "env"], true);
  if (status.status !== 0) process.exit(status.status ?? 1);

  const local = Object.fromEntries(String(status.stdout ?? "").split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    return match ? [[match[1], match[2].replace(/"$/, "")]] : [];
  }));
  for (const required of ["API_URL", "ANON_KEY", "DB_URL"]) {
    if (!local[required]) throw new Error(`Supabase status did not provide ${required}`);
  }

  return [
    "--var", `SUPABASE_URL:${local.API_URL}`,
    "--var", `SUPABASE_ANON_KEY:${local.ANON_KEY}`,
    "--var", `DATABASE_URL:${local.DB_URL}`,
  ];
}

const localVars = containerRuntime() ? await supabaseDatabase() : await nativeDatabase();
const child = spawn("node", ["node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--ip", "127.0.0.1", "--port", port, "--test-scheduled", ...localVars, ...config], { cwd: root, stdio: "inherit" });
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try { await fetch(`http://127.0.0.1:${port}/__scheduled?cron=*+*+*+*+*`, { signal: AbortSignal.timeout(55000) }); }
  catch { /* The next minute retries; durable checkpoints stay in local PostgreSQL. */ }
  finally { running = false; }
}, 60000);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { clearInterval(timer); child.kill(signal); });
child.on("exit", code => { clearInterval(timer); process.exitCode = code ?? 0; });
