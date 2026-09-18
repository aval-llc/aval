import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

const localVars = [
  "--var", `SUPABASE_URL:${local.API_URL}`,
  "--var", `SUPABASE_ANON_KEY:${local.ANON_KEY}`,
  "--var", `DATABASE_URL:${local.DB_URL}`,
];
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
