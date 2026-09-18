import { env } from "cloudflare:workers";
import type { ClientConfig } from "pg";
import type { SupabaseAuthBindings } from "@/lib/auth/supabase";

export interface AvalRuntimeBindings extends SupabaseAuthBindings {
  HYPERDRIVE?: { connectionString: string };
  /** Local Supabase fallback. Never configure this in browser-exposed vars. */
  DATABASE_URL?: string;
  INTEGRATION_TOKEN_ENCRYPTION_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  AGENT_HEALTH_TOKEN?: string;
  AGENT_ALERT_WEBHOOK_URL?: string;
  AGENT_ALERT_WEBHOOK_TOKEN?: string;
  AVAL_PUBLIC_URL?: string;
  AI_DAILY_CALL_CAP?: string;
  [key: string]: unknown;
}

export function runtimeBindings(): AvalRuntimeBindings {
  return env as unknown as AvalRuntimeBindings;
}

export function postgresClientConfig(bindings: AvalRuntimeBindings = runtimeBindings()): ClientConfig {
  const connectionString = bindings.HYPERDRIVE?.connectionString ?? bindings.DATABASE_URL;
  if (!connectionString) throw new Error("PostgreSQL is unavailable: configure HYPERDRIVE or DATABASE_URL");
  return { connectionString };
}
