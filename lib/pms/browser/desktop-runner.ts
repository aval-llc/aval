/** Renderer is a status/wakeup surface only. Desktop main fetches its own jobs. */
import type { ConnectionHealth, PreflightResult, RecoveryResult } from './adapter.ts';

export interface DesktopOutcome {
  status: 'idle'|'confirmed'|'submission_unknown'|'needs_review'|'evidence_retained'|'denied';
  reason?: string;
  externalId?: string;
}
export interface DesktopProviderBridge {
  run?: () => Promise<DesktopOutcome>;
  status?: () => Promise<DesktopOutcome>;
  supported(input:{provider:string}):Promise<string[]>;
  discoverCapabilities(input:{provider:string}):Promise<{available:string[];error?:string}>;
  sessionStatus(input:{provider:string}):Promise<PreflightResult>;
  recoverSession(input:{provider:string}):Promise<RecoveryResult>;
  healthCheck(input:{provider:string}):Promise<ConnectionHealth>;
  setup?(input:{provider:string}):Promise<RecoveryResult & {discovered?:string[]}>;
}
export function desktopBridge():DesktopProviderBridge|null {
  return (globalThis as {avalDesktop?:{pms?:DesktopProviderBridge}}).avalDesktop?.pms??null;
}
export interface RunnerOptions {
  bridge?:DesktopProviderBridge|null;
  onOutcome?:(outcome:DesktopOutcome)=>void;
}
export async function runOnce(options:RunnerOptions):Promise<DesktopOutcome|null> {
  const bridge=options.bridge??desktopBridge();
  if(!bridge)return null;
  const outcome:DesktopOutcome=bridge.run?await bridge.run():{status:'denied',reason:'Update Aval Desktop to run supervised PMS actions.'};
  options.onOutcome?.(outcome);
  return outcome;
}
/** Retrying this wakeup cannot retry a submitted write: PostgreSQL owns that state. */
export function startRunner(options:RunnerOptions & {setTimeoutImpl?:typeof setTimeout}):()=>void {
  const schedule=options.setTimeoutImpl??setTimeout;
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
  const tick=async()=>{
    if(stopped)return;
    let delay=15_000;
    try {const outcome=await runOnce(options);if(outcome?.status==='confirmed')delay=0;}
    catch {delay=60_000;}
    if(!stopped)timer=schedule(()=>void tick(),delay);
  };
  void tick();
  return()=>{stopped=true;if(timer)clearTimeout(timer);};
}
