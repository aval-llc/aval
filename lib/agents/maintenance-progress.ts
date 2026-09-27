import type { Message } from '@/lib/ask-aval/model-types';
import { canonicalize } from './canonical-payload.ts';

/** Count identical consecutive observations, resetting whenever evidence or action changes. */
export function repeatedMaintenanceReads(messages: Message[]) {
  const calls = new Map<string, { name: string; input: unknown }>();
  let previous = '', repeats = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const b of message.content) {
      if (b.type === 'tool_use') calls.set(b.id, b);
      if (b.type !== 'tool_result') continue;
      const call = calls.get(b.tool_use_id);
      if (!call) continue;
      if (!['read_maintenance_context', 'read_conversation'].includes(call.name) || b.is_error) { previous = ''; repeats = 0; continue; }
      let observation: unknown = b.content;
      try { observation = JSON.parse(b.content); } catch { /* Preserve non-JSON results verbatim. */ }
      const signature = canonicalize([call.name, call.input, observation]);
      repeats = signature === previous ? repeats + 1 : 0;
      previous = signature;
    }
  }
  return repeats;
}
