import { and, eq, sql, asc, desc } from 'drizzle-orm';
import type { DbSession } from "@/db/postgres/session";
import { agentChecks, communicationDeliveries, learnedPreferences, agentPlanNodes, agentTasks, conversations, integrationConnections, messages as storedMessages } from "@/db/postgres/schema";
import { implementedTools } from './registry';
import type { TaskRecord } from './tasks';
import type { Message } from '@/lib/ask-aval/model-types';
export type TaskCheck = {
    kind: 'evidence';
    tools: string[];
} | {
    kind: 'delivery';
    operation: 'message' | 'call' | 'listing';
    status: 'accepted' | 'delivered';
    conversationId?: string;
} | {
    kind: 'preference';
    topic: string;
    statement: string;
} | {
    kind: 'plan';
};
/** The repair budget is resolved policy now — see DEFAULT_ATTEMPT_POLICIES.check_repair. */
export const EVIDENCE_TOOL_NAMES = implementedTools().filter(t => !t.mutates && !['plan_goal', 'get_goal_plan', 'read_memory', 'read_task_history', 'request_execution_plan'].includes(t.name)).map(t => t.name);
/** Shared model-facing shape; parseTaskCheck remains the runtime authority. */
export const TASK_CHECK_SCHEMA = {
    type: 'object',
    description: 'Evidence: {"kind":"evidence","tools":["read_document"]}. Delivery: kind, operation and status. Preference: kind, topic and statement. Use exact names from the tool enum. Nested plan checks are forbidden.',
    properties: {
        kind: { type: 'string', enum: ['evidence', 'delivery', 'preference'] },
        tools: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: EVIDENCE_TOOL_NAMES }, description: 'Required for evidence: exact executable read-tool names, not descriptions or search queries.' },
        operation: { type: 'string', enum: ['message', 'call', 'listing'] },
        status: { type: 'string', enum: ['accepted', 'delivered'] },
        conversationId: { type: 'string' },
        topic: { type: 'string', maxLength: 99 },
        statement: { type: 'string', maxLength: 499 },
    },
    required: ['kind'],
    anyOf: [{ required: ['tools'], properties: { kind: { enum: ['evidence'] } } },
        { required: ['operation', 'status'], properties: { kind: { enum: ['delivery'] } } },
        { required: ['topic', 'statement'], properties: { kind: { enum: ['preference'] } } }],
};
export function parseTaskCheck(value: unknown): TaskCheck {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('A machine-checkable completion condition is required.');
    const c = value as Record<string, unknown>;
    if (c.kind === 'plan')
        return { kind: 'plan' };
    if (c.kind === 'evidence' && Array.isArray(c.tools) && c.tools.length > 0 && c.tools.length <= 4 && c.tools.every(t => typeof t === 'string' && EVIDENCE_TOOL_NAMES.includes(t)))
        return { kind: 'evidence', tools: [...new Set(c.tools as string[])] };
    if (c.kind === 'delivery' && ['message', 'call', 'listing'].includes(String(c.operation)) && ['accepted', 'delivered'].includes(String(c.status)) && (c.conversationId === undefined || typeof c.conversationId === 'string'))
        return { kind: 'delivery', operation: c.operation as 'message' | 'call' | 'listing', status: c.status as 'accepted' | 'delivered', ...(typeof c.conversationId === 'string' ? { conversationId: c.conversationId } : {}) };
    if (c.kind === 'preference' && typeof c.topic === 'string' && typeof c.statement === 'string' && c.topic.length < 100 && c.statement.length < 500)
        return { kind: 'preference', topic: c.topic, statement: c.statement };
    throw Error('Choose an evidence, delivery, preference, or plan completion condition. Evidence requires {"kind":"evidence","tools":["exact_read_tool_name"]}; delivery requires operation and status; preference requires topic and statement.');
}
export async function checkTask(dbSession: DbSession, task: TaskRecord, messages: Message[], stepIndex: number, review?: () => Promise<{ exitCode: number; problems: string[]; [key: string]: unknown }>) {
    const problems: string[] = [];
    let check: TaskCheck | undefined;
    try {
        check = parseTaskCheck(JSON.parse(task.checkJson ?? '{}'));
    }
    catch {
        problems.push('This task has no valid completion condition. Recreate it with an explicit check.');
    }
    if (check?.kind === 'evidence') {
        const calls = new Map<string, string>(), observed = new Set<string>();
        for (const m of messages) {
            if (!Array.isArray(m.content))
                continue;
            for (const b of m.content) {
                if (b.type === 'tool_use')
                    calls.set(b.id, b.name);
                if (b.type === 'tool_result' && !b.is_error) {
                    try {
                        const data = JSON.parse(typeof b.content === 'string' ? b.content : 'null');
                        if (data !== null && !data?.error && !JSON.stringify(data).includes('[truncated:')) {
                            const name = calls.get(b.tool_use_id);
                            if (name)
                                observed.add(name);
                        }
                    }
                    catch { /* malformed evidence cannot pass */ }
                }
            }
        }
        for (const tool of check.tools)
            if (!observed.has(tool))
                problems.push(`Read ${tool} successfully before concluding. Missing, failed, or truncated evidence cannot satisfy the task.`);
    }
    if (check?.kind === 'delivery') {
        const statuses = check.status === 'delivered' ? ['delivered'] : ['accepted', 'queued', 'initiated', 'ringing', 'in-progress', 'sent', 'delivered', 'completed'];
        const deliveryRows = await dbSession.db.select({ delivery: communicationDeliveries, provider: integrationConnections.provider }).from(communicationDeliveries).innerJoin(integrationConnections, and(eq(integrationConnections.id, communicationDeliveries.connectionId), eq(integrationConnections.organizationId, task.organizationId))).where(and(eq(communicationDeliveries.organizationId, task.organizationId), sql `substr(${communicationDeliveries.requestKey},1,${task.id.length + 1}) = ${task.id + ":"}`, eq(communicationDeliveries.kind, check.operation)));
        const thread = check.conversationId ? (await dbSession.db.select().from(conversations).where(and(eq(conversations.organizationId, task.organizationId), eq(conversations.id, check.conversationId))).limit(1))[0] : undefined;
        const rows = deliveryRows.map(row => ({ ...row.delivery, provider: row.provider }));
        let destination = thread?.channel === 'whatsapp' && !thread.externalThreadId.startsWith('+') ? '+' + thread.externalThreadId : thread?.externalThreadId;
        if (thread?.channel === 'gmail') {
            const scope = JSON.parse(task.executionScopeJson);
            const [original] = await dbSession.db.select({ payloadJson: storedMessages.payloadJson }).from(storedMessages)
                .where(and(eq(storedMessages.conversationId, thread.id), eq(storedMessages.direction, 'inbound'), scope.messageId ? eq(storedMessages.externalMessageId, scope.messageId) : undefined))
                .orderBy(desc(storedMessages.createdAt), desc(storedMessages.id)).limit(1);
            destination = original ? JSON.parse(original.payloadJson).sender : undefined;
        }
        if (!rows.some(r => statuses.includes(r.status) && (!check.conversationId || (thread && r.destination === destination && (check.operation !== 'message' || r.provider === thread.channel)))))
            problems.push(`No ${check.operation} operation for this task has provider-confirmed ${check.status} status. Do not claim it happened or repeat an unknown send.`);
    }
    if (check?.kind === 'preference') {
        const rows = await dbSession.db.select().from(learnedPreferences).where(and(eq(learnedPreferences.organizationId, task.organizationId), eq(learnedPreferences.topic, check.topic), eq(learnedPreferences.statement, check.statement)));
        if (!rows.length)
            problems.push('The required preference was not saved.');
    }
    if (check?.kind === 'plan') {
        const nodes = await dbSession.db.select({ key: agentPlanNodes.nodeKey, revision: agentPlanNodes.revision, status: agentTasks.status }).from(agentPlanNodes).innerJoin(agentTasks, eq(agentTasks.id, agentPlanNodes.taskId)).where(and(eq(agentPlanNodes.rootTaskId, task.id), eq(agentPlanNodes.organizationId, task.organizationId))).orderBy(asc(agentPlanNodes.revision));
        const latest = new Map<string, typeof nodes[number]>();
        for (const node of nodes)
            latest.set(node.key, node);
        const current = [...latest.values()];
        if (!current.length || current.some(n => n.status !== 'COMPLETED'))
            problems.push('The goal needs a persisted plan whose required tasks all pass their independent checks.');
    }
    const semantic = !problems.length && review ? await review() : undefined;
    if (semantic) problems.push(...semantic.problems);
    if (semantic?.exitCode && !problems.length) problems.push('Semantic review did not pass.');
    const output = { exitCode: problems.length ? 1 : 0, check: check ?? null, problems, ...(semantic ? { semantic } : {}), scope: semantic ? 'Stored outcomes plus independent probabilistic semantic review; not a proof of truth.' : 'Stored task outcomes and evidence access' };
    await dbSession.db.insert(agentChecks).values({ id: crypto.randomUUID(), organizationId: task.organizationId, taskId: task.id, stepIndex, exitCode: output.exitCode, outputJson: JSON.stringify(output), createdAt: new Date() });
    return output;
}
export async function failedCheckCount(dbSession: DbSession, org: string, taskId: string) {
    return (await dbSession.db.select({ id: agentChecks.id }).from(agentChecks).where(and(eq(agentChecks.organizationId, org), eq(agentChecks.taskId, taskId), eq(agentChecks.exitCode, 1)))).length;
}
