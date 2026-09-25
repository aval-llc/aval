#!/usr/bin/env node
/**
 * Provisions a disposable local PostgreSQL cluster for the integration lane.
 *
 * Named `database-harness` rather than `test-database` because Node's test
 * runner collects `test-*.mjs` by default. Under the old name it was run as a
 * test suite: it passed on a machine with PostgreSQL installed and failed on CI,
 * where there is none — green locally and red on main, which is the worst place
 * for a difference like that to live.
 *
 * `tests/postgres/*.integration.mjs` refuse to run without
 * `AVAL_TEST_DATABASE_URL`, and refuse any host that is not loopback. That is
 * the right default — the fixtures are destructive — but it left the suite
 * unrunnable on a machine with no database, which is how it came to be skipped.
 *
 * This creates a cluster that belongs to nothing else: its own data directory
 * under the OS temp area, its own port, trust auth on loopback only. It never
 * touches an existing cluster, an existing database, or port 5432.
 *
 * Usage:
 *   node scripts/database-harness.mjs start   # prints the URL on stdout
 *   node scripts/database-harness.mjs stop
 *   node scripts/database-harness.mjs reset   # drop and recreate the database
 *
 * `AVAL_TEST_PG_DATABASE` picks the database within that cluster, so the local
 * dev server can keep its own beside the one the tests destroy.
 *
 * The printed URL carries no password: the cluster trusts loopback and listens
 * nowhere else.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.AVAL_TEST_PG_PORT ?? "55433";
const SUPERUSER = "avaltest";
// Overridable so a second consumer can share the cluster without sharing the
// database. `reset` drops whatever this names, and the local dev server asks
// for its own — otherwise running the tests would wipe the server's data, and
// the two would look like flakiness in each other.
const DATABASE = process.env.AVAL_TEST_PG_DATABASE ?? "aval_test";
if (!/^[a-z_][a-z0-9_]*$/.test(DATABASE)) throw new Error("AVAL_TEST_PG_DATABASE must be a plain identifier");
const ROOT = join(tmpdir(), "aval-test-pg");
const PGDATA = join(ROOT, "data");
// The socket path has a 103-byte ceiling, which a long data directory breaks.
const SOCKET = join(tmpdir(), "avpg");

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...options });

const psql = (database, statement) =>
  run("psql", ["-h", "127.0.0.1", "-p", PORT, "-U", SUPERUSER, "-d", database, "-tAc", statement]).trim();

const url = () => `postgresql://${SUPERUSER}@127.0.0.1:${PORT}/${DATABASE}`;

function running() {
  try {
    run("pg_isready", ["-h", "127.0.0.1", "-p", PORT]);
    return true;
  } catch {
    return false;
  }
}

// Bringing the cluster up is separate from announcing it: `reset` needs the
// first without the second, or a cold `reset` prints the URL twice and the
// caller's `$(...)` captures both lines as one unusable connection string.
function ensureStarted() {
  mkdirSync(SOCKET, { recursive: true });
  if (!existsSync(PGDATA)) {
    mkdirSync(ROOT, { recursive: true });
    run("initdb", ["-D", PGDATA, "-U", SUPERUSER, "--auth=trust", "-E", "UTF8"]);
  }
  if (!running()) {
    run("pg_ctl", [
      "-D", PGDATA,
      "-o", `-p ${PORT} -k ${SOCKET} -c listen_addresses=127.0.0.1`,
      "-l", join(ROOT, "server.log"),
      "-w", "start",
    ]);
  }
  // The fixtures assert that escalating to `postgres` is refused, so the role
  // has to exist for the assertion to mean anything.
  if (psql("postgres", "SELECT 1 FROM pg_roles WHERE rolname='postgres'") !== "1") {
    psql("postgres", "CREATE ROLE postgres LOGIN SUPERUSER");
  }
  if (psql("postgres", `SELECT 1 FROM pg_database WHERE datname='${DATABASE}'`) !== "1") {
    run("createdb", ["-h", "127.0.0.1", "-p", PORT, "-U", SUPERUSER, DATABASE]);
  }
}

function start() {
  ensureStarted();
  process.stdout.write(`${url()}\n`);
}

function reset() {
  ensureStarted();
  // The suite asserts a fresh database; a previous run's schema fails it.
  psql("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DATABASE}' AND pid <> pg_backend_pid()`);
  run("dropdb", ["-h", "127.0.0.1", "-p", PORT, "-U", SUPERUSER, "--if-exists", DATABASE]);
  run("createdb", ["-h", "127.0.0.1", "-p", PORT, "-U", SUPERUSER, DATABASE]);
  process.stdout.write(`${url()}\n`);
}

function stop() {
  if (!running()) {
    // Already down, or the cluster on this port is not one this script made.
    // Either way there is nothing here to stop, and reporting a missing-binary
    // error for it sends the reader after the wrong problem.
    process.stdout.write("no disposable cluster running on this port\n");
    return;
  }
  if (!existsSync(PGDATA)) {
    process.stderr.write(`A server is listening on ${PORT} but was not started by this script; leaving it alone.\n`);
    process.exit(1);
  }
  run("pg_ctl", ["-D", PGDATA, "-m", "fast", "-w", "stop"]);
  // Only what this script created.
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(SOCKET, { recursive: true, force: true });
  process.stdout.write("stopped and removed\n");
}

const command = process.argv[2] ?? "start";
try {
  if (command === "start") start();
  else if (command === "reset") reset();
  else if (command === "stop") stop();
  else {
    process.stderr.write(`Unknown command ${command}. Use start, reset or stop.\n`);
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write("PostgreSQL client binaries are required (brew install postgresql@16).\n");
  process.exit(1);
}
