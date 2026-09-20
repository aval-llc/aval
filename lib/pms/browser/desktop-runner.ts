/**
 * The desktop runner, as it runs inside the Aval window.
 *
 * Aval's desktop build is the web app in an Electron shell, already
 * authenticated to cloud with the person's own session. That makes the renderer
 * the natural place for this loop: it can call `/api/pms/runner` with the
 * session it already has, and it can reach the provider through a narrow IPC
 * surface the main process exposes. Putting the loop in the Electron main
 * process instead would have meant a second implementation of the rules in
 * plain CommonJS, and two sets of rules about when a duplicate counts is worse
 * than any amount of plumbing.
 *
 * What crosses each boundary is deliberately different in kind:
 *
 *   cloud → renderer   a provider, an action, and the steps of an approved
 *                      flow. Never a browser command.
 *   renderer → main    one of six named step kinds against labelled targets.
 *                      The main process has no "navigate here, run this
 *                      script" entry point, so a compromised renderer cannot
 *                      ask for one.
 *   renderer → cloud   a closed set of report shapes. What happened, never
 *                      what should follow.
 *
 * The loop holds no credential and sees no cookie. The provider session lives
 * in the main process's own partition and is one the customer established by
 * signing in themselves.
 */

import type { PmsAction } from "../types.ts";
import {
  registerBrowserAdapter,
  type BrowserProviderAdapter,
  type ConnectionHealth,
  type ExecutionResult,
  type ExistingRecord,
  type PreflightResult,
  type RecoveryResult,
  type VerificationResult,
} from "./adapter.ts";
import { runInstruction, type DrainOutcome, type RunnerInstruction } from "./drain.ts";
import type { FlowStep } from "./steps.ts";

/**
 * What the Electron main process offers the page.
 *
 * Structured provider actions and nothing else. There is no method here that
 * takes a URL or a script, which is the point: the surface cannot be asked to
 * do something outside a recorded workflow even by code running in the window.
 */
export interface DesktopProviderBridge {
  supported(input: { provider: string }): Promise<string[]>;
  preflight(input: { provider: string }): Promise<PreflightResult>;
  recoverSession(input: { provider: string }): Promise<RecoveryResult>;
  healthCheck(input: { provider: string }): Promise<ConnectionHealth>;
  findExisting(input: { provider: string; action: string; payload: unknown }): Promise<ExistingRecord | null>;
  execute(input: {
    provider: string; action: string; steps: readonly FlowStep[]; payload: unknown;
  }): Promise<ExecutionResult>;
  verify(input: {
    provider: string; action: string; execution: ExecutionResult; payload: unknown;
  }): Promise<VerificationResult>;
}

/** The bridge the desktop preload installs, when the app is running in one. */
export function desktopBridge(): DesktopProviderBridge | null {
  const host = (globalThis as { avalDesktop?: { pms?: DesktopProviderBridge } }).avalDesktop;
  return host?.pms ?? null;
}

/**
 * A provider adapter whose hands are in the Electron main process.
 *
 * Implements the same boundary every other adapter does, so `runInstruction`
 * cannot tell the difference and the duplicate, verification and session rules
 * are the ones already tested.
 */
export function bridgedAdapter(provider: string, bridge: DesktopProviderBridge, supported: readonly string[]): BrowserProviderAdapter {
  const supports = new Set(supported);
  return {
    provider,
    supports: (action: PmsAction) => supports.has(action),
    preflight: () => bridge.preflight({ provider }),
    recoverSession: () => bridge.recoverSession({ provider }),
    healthCheck: () => bridge.healthCheck({ provider }),
    findExisting: (action, payload) => bridge.findExisting({ provider, action, payload }),
    execute: (action, steps, payload) => bridge.execute({ provider, action, steps, payload }),
    verify: (action, execution, payload) => bridge.verify({ provider, action, execution, payload }),
  };
}

export interface RunnerOptions {
  /** Identifies this device for leases and audit. Never an authority. */
  runnerId: string;
  fetchImpl?: typeof fetch;
  bridge?: DesktopProviderBridge | null;
  /** Called with every settled outcome, for the UI to show what happened. */
  onOutcome?: (outcome: DrainOutcome) => void;
}

async function post(fetchImpl: typeof fetch, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetchImpl("/api/pms/runner", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`The runner endpoint answered ${response.status}.`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Claim one write, carry it out, report it.
 *
 * Returns the settled outcome, or null when there was nothing to do. Errors are
 * thrown rather than swallowed: a runner that cannot reach cloud should stop
 * and be retried by the loop, not quietly appear to be working.
 */
export async function runOnce(options: RunnerOptions): Promise<DrainOutcome | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const bridge = options.bridge ?? desktopBridge();
  if (!bridge) return null;

  const claimed = await post(fetchImpl, { intent: "claim", runner: options.runnerId });
  const instruction = claimed.instruction as RunnerInstruction | undefined;
  if (!instruction) {
    const outcome = claimed.outcome as DrainOutcome | undefined;
    if (outcome && outcome.status !== "idle") options.onOutcome?.(outcome);
    return outcome ?? null;
  }

  // Register the adapter for whatever provider cloud named, using the actions
  // the main process says it can drive. An action the device cannot perform
  // produces a `not_ready` report rather than an attempt.
  const supported = await bridge.supported({ provider: instruction.provider });
  registerBrowserAdapter(bridgedAdapter(instruction.provider, bridge, supported));

  const report = await runInstruction(instruction, {
    organizationId: "",
    providerId: instruction.provider,
    runnerId: options.runnerId,
  });

  const reported = await post(fetchImpl, { intent: "result", runner: options.runnerId, ...report });
  const outcome = reported.outcome as DrainOutcome;
  options.onOutcome?.(outcome);
  return outcome;
}

/** Idle polling interval. A queue that had work is drained without waiting. */
const IDLE_MS = 15_000;
/** Backoff after a transport failure, so an offline laptop is not a hot loop. */
const ERROR_MS = 60_000;

/**
 * Poll for authorized provider work until stopped.
 *
 * Returns the stop function. Nothing here retries a *write* — retrying is the
 * queue's job, and it is the queue that counts attempts and stops. This only
 * retries asking.
 */
export function startRunner(options: RunnerOptions & { setTimeoutImpl?: typeof setTimeout }): () => void {
  const schedule = options.setTimeoutImpl ?? setTimeout;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    let delay = IDLE_MS;
    try {
      const outcome = await runOnce(options);
      // Work found means there may be more; an empty queue means wait.
      delay = outcome && outcome.status !== "idle" ? 0 : IDLE_MS;
    } catch {
      delay = ERROR_MS;
    }
    if (!stopped) timer = schedule(() => void tick(), delay);
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
