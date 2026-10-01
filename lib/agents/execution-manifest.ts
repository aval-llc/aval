import { payloadHash } from './canonical-payload.ts';

declare const __AVAL_BUILD_ID__: string;
export const AGENT_BUILD = typeof __AVAL_BUILD_ID__ === 'undefined' ? 'unversioned-local' : __AVAL_BUILD_ID__;
export interface ExecutionManifest {
  schema_version: 1;
  contract_version: string;
  agent_version: string;
  prompt_version: string;
  model: string;
  model_provider: string;
  tool_schema_version: string;
  retrieval_version: string;
  memory_version: string;
  policy_version: string;
  evidence_digest: string;
  phase: string;
  input_tokens?: number;
  output_tokens?: number;
  inference_duration_ms?: number;
}

/** Hashes describe exact inputs; labels never pretend missing history is known. */
export async function executionManifest(input: {
  phase: string; system?: unknown; tools?: unknown; messages?: unknown;
  policy?: unknown; memory?: unknown; model?: string; provider?: string;
}): Promise<ExecutionManifest> {
  const hash = (value: unknown) => payloadHash(value ?? null);
  return {
    schema_version: 1, contract_version: 'maintenance-contract-v2', agent_version: AGENT_BUILD,
    prompt_version: input.system === undefined ? 'not-invoked' : `sha256:${await hash(input.system)}`,
    model: input.model ?? 'not-invoked', model_provider: input.provider ?? 'not-invoked',
    tool_schema_version: input.tools === undefined ? 'not-invoked' : `sha256:${await hash(input.tools)}`,
    retrieval_version: `context-v1:${AGENT_BUILD}`,
    memory_version: input.memory === undefined ? 'unknown' : `scratchpad-v1:${await hash(input.memory)}`,
    policy_version: input.policy === undefined ? 'unknown' : `policy-v1:${AGENT_BUILD}:${await hash(input.policy)}`,
    evidence_digest: input.messages === undefined ? 'not-invoked' : await hash(input.messages),
    phase: input.phase,
  };
}
