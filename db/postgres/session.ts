import { Client } from "pg";
import type { ClientConfig } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type DbIdentity = Readonly<{
  principalId: string;
  organizationId: string;
  actorId: string;
  requestId: string;
  auth?: Readonly<{
    userId: string;
    email: string;
    displayName: string;
    source: "password" | "chatgpt" | "local";
  }>;
}>;

/** Resolved by authentication before opening a transaction; never accept these from a request body. */
export type DbSession = Readonly<{
  db: NodePgDatabase<typeof schema>;
  identity: DbIdentity;
  /**
   * Run a database unit behind a PostgreSQL savepoint. A failure rolls back
   * every write made by the callback while keeping the outer request
   * transaction usable for recording a rejected job or import attempt.
   */
  atomic<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Commit the current database phase, run one network/provider operation,
   * then open a fresh transaction with the same RLS identity. This keeps a
   * pooled Postgres transaction from sitting open while an external service
   * responds and gives callers an explicit three-stage boundary:
   * reserve/outbox -> provider -> confirm/reconcile.
   */
  outsideTransaction<T>(work: () => Promise<T>): Promise<T>;
  /** Schedule detached work only after the route transaction commits. */
  afterCommit<T>(work: () => Promise<T>): Promise<T>;
}>;

export type DatabaseRole = "aval_app" | "aval_worker" | "aval_benchmark_app";
const roleSql: Record<DatabaseRole, string> = {
  aval_app: "SET LOCAL ROLE aval_app",
  aval_worker: "SET LOCAL ROLE aval_worker",
  aval_benchmark_app: "SET LOCAL ROLE aval_benchmark_app",
};

/**
 * One request-scoped client; Hyperdrive owns the physical connection pool.
 * Return data/outbox commands from work, commit, THEN call a model/provider.
 * A DbSession must not escape its callback or be shared across requests.
 * No automatic retry: a lost COMMIT acknowledgement has an unknown outcome.
 */
export async function withDbSession<T>(
  config: ClientConfig,
  identity: DbIdentity,
  work: (session: DbSession) => Promise<T>,
  options: {
    role?: DatabaseRole;
    readOnly?: boolean;
    verifyCleanContext?: boolean;
    initializeIdentity?: (client: Client, identity: DbIdentity) => Promise<DbIdentity>;
  } = {},
): Promise<T> {
  for (const key of ["principalId", "organizationId", "actorId", "requestId"] as const) {
    const value = identity[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) throw new Error("Invalid database identity");
  }
  const role = options.role ?? "aval_app";
  if (!Object.hasOwn(roleSql, role)) throw new Error("Invalid database role");
  const client = new Client({ ...config, connectionTimeoutMillis: 5000, query_timeout: 12000, application_name: "aval-session" });
  let inTransaction = false;
  let outsideTransaction = false;
  let savepointDepth = 0;
  let savepointSequence = 0;
  let initialized = false;
  let sessionIdentity = Object.freeze({ ...identity });
  const afterCommitWork: Array<{
    work: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];

  const commit = async () => {
    const result = await client.query("COMMIT");
    inTransaction = false;
    // PostgreSQL answers COMMIT with ROLLBACK after a swallowed SQL error.
    // Never run a provider or report success for a reservation that vanished.
    if (result.command !== "COMMIT") throw new Error("Database transaction was rolled back before commit");
  };

  const begin = async () => {
    await client.query(options.readOnly ? "BEGIN READ ONLY" : "BEGIN");
    inTransaction = true;
    if (options.verifyCleanContext) {
      const { rows } = await client.query(`SELECT
        nullif(current_setting('aval.principal_id', true), '') AS principal,
        nullif(current_setting('aval.organization_id', true), '') AS organization,
        nullif(current_setting('aval.actor_id', true), '') AS actor,
        nullif(current_setting('aval.request_id', true), '') AS request`);
      if (Object.values(rows[0]).some((value) => value !== null)) throw new Error("Leaked database transaction context");
    }
    await client.query(roleSql[role]);
    await client.query(`SELECT
      set_config('aval.principal_id', $1, true), set_config('aval.organization_id', $2, true),
      set_config('aval.actor_id', $3, true), set_config('aval.request_id', $4, true),
      set_config('statement_timeout', '8000', true), set_config('lock_timeout', '5000', true),
      set_config('idle_in_transaction_session_timeout', '10000', true),
      set_config('search_path', 'pg_catalog, public', true)`,
    [sessionIdentity.principalId, sessionIdentity.organizationId, sessionIdentity.actorId, sessionIdentity.requestId]);
    if (!initialized && options.initializeIdentity) {
      sessionIdentity = Object.freeze({ ...(await options.initializeIdentity(client, sessionIdentity)) });
      await client.query(`SELECT
        set_config('aval.principal_id', $1, true), set_config('aval.organization_id', $2, true),
        set_config('aval.actor_id', $3, true), set_config('aval.request_id', $4, true)`,
      [sessionIdentity.principalId, sessionIdentity.organizationId, sessionIdentity.actorId, sessionIdentity.requestId]);
      initialized = true;
    }
  };

  try {
    await client.connect();
    await begin();
    const session: DbSession = Object.freeze({
      db: drizzle(client, { schema }),
      identity: sessionIdentity,
      async atomic<R>(atomicWork: () => Promise<R>): Promise<R> {
        if (!inTransaction || outsideTransaction) throw new Error("Invalid atomic-operation boundary");
        const savepoint = `aval_sp_${++savepointSequence}`;
        const queuedWorkStart = afterCommitWork.length;
        await client.query(`SAVEPOINT ${savepoint}`);
        savepointDepth += 1;
        try {
          const result = await atomicWork();
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          try {
            await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          } finally {
            const discarded = afterCommitWork.splice(queuedWorkStart);
            for (const queued of discarded) queued.reject(error);
          }
          throw error;
        } finally {
          savepointDepth -= 1;
        }
      },
      async outsideTransaction<R>(externalWork: () => Promise<R>): Promise<R> {
        if (!inTransaction || outsideTransaction || savepointDepth > 0) throw new Error("Invalid external-operation boundary");
        outsideTransaction = true;
        await commit();
        let result: R | undefined;
        let externalError: unknown;
        let externalFailed = false;
        try {
          result = await externalWork();
        } catch (error) {
          externalFailed = true;
          externalError = error;
        }
        try {
          await begin();
        } catch (resumeError) {
          if (externalFailed) throw new AggregateError([externalError, resumeError], "Provider operation failed and the database session could not resume");
          throw resumeError;
        } finally {
          outsideTransaction = false;
        }
        if (externalFailed) throw externalError;
        return result as R;
      },
      afterCommit<R>(committedWork: () => Promise<R>): Promise<R> {
        return new Promise<R>((resolve, reject) => {
          afterCommitWork.push({
            work: committedWork,
            resolve: resolve as (value: unknown) => void,
            reject,
          });
        });
      },
    });
    const result = await work(session);
    await commit();
    for (const queued of afterCommitWork) {
      Promise.resolve().then(queued.work).then(queued.resolve, queued.reject);
    }
    return result;
  } catch (error) {
    if (inTransaction) {
      try { await client.query("ROLLBACK"); } catch { /* Discard the broken connection below. */ }
    }
    for (const queued of afterCommitWork) queued.reject(error);
    throw error;
  } finally {
    await client.end();
  }
}
