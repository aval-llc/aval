import type { AskProgress } from './progress.ts';

export type VisualActivity = 'idle' | 'listening' | 'connecting' | 'searching' | 'working' | 'solving' | 'weaving' | 'composing' | 'finalizing';
// Keep runtime states distinct; the visual language is deliberately simpler.
export const getThinkingOrbState = (activity: VisualActivity) => activity === 'idle' ? 'solving' : activity === 'listening' ? 'listening' : 'searching';
export type SafeStep = { id: string; kind: string; tool?: string | null; mutates?: boolean; at?: string | number; policy?: string | null };
export const settledRun = (status: string) => ['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(status);
export function visualActivity(input: { voice?: string; busy?: boolean; progress?: AskProgress; status?: string; steps?: SafeStep[] }): VisualActivity {
  if (input.voice === 'live') return 'listening';
  if (input.voice === 'requesting') return 'connecting';
  if (input.voice === 'processing') return 'solving';
  if (input.status && settledRun(input.status)) return 'idle';
  if (input.status === 'WAITING_FOR_PROVIDER') return 'connecting';
  if (input.status?.startsWith('WAITING_') || ['BLOCKED', 'SCHEDULED'].includes(input.status ?? '')) return 'idle';
  if (input.status === 'PENDING_VERIFICATION' || input.progress?.phase === 'checking' && input.busy) return 'finalizing';
  if (input.progress?.phase === 'tool' && input.busy) return 'searching';
  const last = input.steps?.at(-1);
  if (input.status === 'RUNNING' && last?.kind === 'tool_call') return last.mutates ? 'working' : 'searching';
  return input.busy || ['RUNNING', 'QUEUED'].includes(input.status ?? '') ? 'solving' : 'idle';
}

/** Counts only completed tool calls, with mutation metadata from the server registry.
 * Approval requests, reservations and retries are not successful actions. */
export function summarizeActivity(steps: SafeStep[]) {
  const unique = [...new Map(steps.map(step => [step.id, step])).values()];
  return {
    lookups: unique.filter(s => (s.kind === 'tool_call' || s.kind === 'approval_decided' && s.policy === 'allow') && s.mutates === false && s.policy !== 'deny').length,
    actions: unique.filter(s => (s.kind === 'tool_call' || s.kind === 'approval_decided' && s.policy === 'allow') && s.mutates === true && s.policy !== 'deny').length,
    retries: unique.filter(s => s.kind === 'tool_retry').length,
    steps: unique.reduce<(SafeStep & { repetitions: number })[]>((rows, step) => {
      const last = rows.at(-1);
      if (last && last.kind === step.kind && last.tool === step.tool && last.policy === step.policy) last.repetitions++;
      else rows.push({ ...step, repetitions: 1 });
      return rows;
    }, []),
  };
}
