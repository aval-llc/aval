import type { Message } from '@/lib/ask-aval/model-types';
export const MAX_CONTEXT_BYTES = 48000;
export const byteCount = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
/** Whole tool-call/result groups are evicted from model context; full history stays in D1. */
export function assembleContext(history: Message[], budget = MAX_CONTEXT_BYTES): {
    messages: Message[];
    evicted: number;
} {
    if (byteCount(history) <= budget)
        return { messages: history, evicted: 0 };
    const groups: Message[][] = [];
    for (const m of history) {
        if (m.role === 'assistant' || !groups.length)
            groups.push([m]);
        else
            groups[groups.length - 1].push(m);
    }
    const kept: Message[][] = [];
    let used = 1000;
    for (let i = groups.length - 1; i >= 0; i--) {
        const n = byteCount(groups[i]);
        if (used + n > budget)
            break;
        kept.unshift(groups[i]);
        used += n;
    }
    const retained = kept.flat();
    const evicted = history.length - retained.length;
    const goal = typeof history[0]?.content === 'string' ? history[0].content.slice(0, 1200) : 'Continue the stored task goal.';
    const notice: Message = { role: 'user', content: `${goal}\nContext budget: ${evicted} older messages were evicted from this model request. The full transcript remains stored in this task. Use read_task_history with an offset to retrieve it, and read_memory to pull scratchpad observations. Do not assume missing evidence.` };
    if (byteCount([notice, ...retained]) > budget)
        throw Error('Context budget is too small for the task instructions.');
    return { messages: [notice, ...retained], evicted };
}
