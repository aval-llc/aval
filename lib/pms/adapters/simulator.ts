/**
 * A provider that exists only in memory, wired through the real seams.
 *
 * NOT A PROVIDER INTEGRATION. Nothing this file proves says anything about
 * DoorLoop, Yardi, AppFolio or any other real system, and a run against it must
 * never be described as live-provider validation. What it proves is that Aval's
 * own path works end to end: a write goes out through the registered write
 * adapter, the effect is recorded, verification looks the record up through the
 * registered `(provider, tool)` verifier, and evidence settles the objective.
 *
 * It exists because that path could not be exercised at all. No verifier was
 * registered anywhere in production, so `verifyExternalEffects` always fell
 * through to "unproven" and no task carrying an external effect could ever be
 * completed by evidence.
 *
 * The simulator keeps its own state deliberately. A fake that simply returns
 * success cannot answer the questions that matter — whether a record written in
 * one run is still there in the next, whether a provider that has not caught up
 * is distinguishable from one that says the record is absent, and whether a
 * retried action writes twice. Those need something that remembers.
 */

import type { DbSession } from "@/db/postgres/session";
import { registerVerifier } from "@/lib/agents/evidence";
import { registerWriteAdapter } from "../flows.ts";
import { PMS_WRITE_TOOLS } from "../tool-map.ts";
import type { PmsAction } from "../types.ts";

interface SimulatedRecord {
  externalId: string;
  action: PmsAction;
  payload: unknown;
  /** How many times the record has been read back. */
  reads: number;
  /** Reads that must happen before the record becomes visible — eventual consistency. */
  visibleAfterReads: number;
  /** False once the provider no longer has it, which is a contradiction rather than a delay. */
  present: boolean;
}

export interface SimulatedWrite {
  action: PmsAction;
  payload: unknown;
  externalId: string;
}

export class ProviderSimulator {
  readonly providerId: string;
  private readonly records = new Map<string, SimulatedRecord>();
  private readonly writeLog: SimulatedWrite[] = [];
  private reachable = true;
  private consistencyDelay = 0;
  private refuseWrites = false;

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  /* ── what the operator of the fake provider can arrange ─────────────────── */

  /** An unreachable provider answers nothing at all, which is not the same as saying no. */
  setReachable(reachable: boolean): void {
    this.reachable = reachable;
  }

  /** Records written from now on stay invisible for this many reads. */
  becomeConsistentAfter(reads: number): void {
    this.consistencyDelay = Math.max(0, reads);
  }

  /** The provider rejects writes — the effect never happens in the first place. */
  setRefuseWrites(refuse: boolean): void {
    this.refuseWrites = refuse;
  }

  /**
   * The provider no longer has this record.
   *
   * Distinct from a consistency delay: this is the provider positively
   * answering that the record is absent, which is what a contradiction means.
   */
  forget(externalId: string): void {
    const record = this.records.get(externalId);
    if (record) record.present = false;
  }

  /** Every write the simulator received, in order. Proving exactly-once reads this. */
  writes(): readonly SimulatedWrite[] {
    return this.writeLog;
  }

  /** How many times a record was read back, including reads that could not answer. */
  readsOf(externalId: string): number {
    return this.records.get(externalId)?.reads ?? 0;
  }

  /* ── the two real seams ─────────────────────────────────────────────────── */

  /**
   * Registers this simulator as the write adapter and verifier for every PMS
   * write tool, through the same registries a real provider uses.
   *
   * Nothing here is a special case in the runtime: the runtime cannot tell this
   * provider from any other, which is the only way the test proves anything.
   */
  register(): void {
    for (const [toolName, action] of Object.entries(PMS_WRITE_TOOLS)) {
      registerWriteAdapter(this.providerId, action, async (_dbSession, input) => {
        if (!this.reachable || this.refuseWrites) {
          return { ok: false, error: `${this.providerId} is not accepting writes.` };
        }
        const externalId = `SIM-${this.providerId}-${this.writeLog.length + 1}`;
        this.records.set(externalId, {
          externalId,
          action: input.action,
          payload: input.payload,
          reads: 0,
          visibleAfterReads: this.consistencyDelay,
          present: true,
        });
        this.writeLog.push({ action: input.action, payload: input.payload, externalId });
        return { ok: true, externalId };
      });

      registerVerifier(this.providerId, toolName, async (_dbSession: DbSession, request) => {
        // Unreachable is not an answer. Returning null keeps the effect
        // unresolved instead of letting silence be read as absence.
        if (!this.reachable) return null;

        const record = this.records.get(request.externalRecordId);
        if (!record) return { exists: false };

        record.reads += 1;
        // Written, but the provider has not caught up. Also not an answer.
        if (record.reads <= record.visibleAfterReads) return null;
        if (!record.present) return { exists: false };
        return { exists: true, external_id: record.externalId, action: record.action };
      });
    }
  }
}

/** Builds a simulator and wires it into the real write-adapter and verifier registries. */
export function registerSimulatedProvider(providerId: string): ProviderSimulator {
  const simulator = new ProviderSimulator(providerId);
  simulator.register();
  return simulator;
}
