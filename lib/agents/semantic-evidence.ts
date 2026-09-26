import { and, eq, sql } from 'drizzle-orm';
import type { DbSession } from "@/db/postgres/session";
import { communicationDeliveries } from "@/db/postgres/schema";
import type { Message } from '@/lib/ask-aval/model-types';
import { goalPlan } from './goal-plan';
import { DELEGATION_POLICY } from './delegation-policy';
import { getTask, type TaskRecord } from './tasks';
import { reviewSources, type ReviewPacket } from './semantic-review';

export async function semanticPacket(dbSession: DbSession, task: TaskRecord, messages: Message[], phase: ReviewPacket['phase'], proposal: unknown): Promise<ReviewPacket> {
    const sources = reviewSources(messages, task.id);
    const completedTasks: unknown[] = [];
    const evidenceTasks = [task.id];
    // A planner is judged on its own plan — the root's, or a Lead's for its
    // team. Anything else is judged on the dependencies it was given in its
    // parent's plan.
    const planner = JSON.parse(task.checkJson ?? '{}').kind === 'plan';
    const plan = await goalPlan(dbSession, task.organizationId, planner ? task.id : task.parentTaskId ?? task.id);
    const own = plan?.nodes.find(n => n.id === task.id);
    const dependencies: string[] = own ? JSON.parse(own.dependencies) : [];
    for (const node of plan?.nodes ?? []) {
        if (node.status !== 'COMPLETED' || (!planner && task.parentTaskId && !dependencies.includes(node.key))) continue;
        const child = await getTask(dbSession, task.organizationId, node.id);
        if (!child) continue;
        sources.push(...reviewSources(JSON.parse(child.transcriptJson), child.id));
        evidenceTasks.push(child.id);
        // A child that planned for its own team — a Lead — holds no evidence of
        // its own; its team does. Their evidence is what its answer stands on.
        for (const descendant of await plannedEvidenceTasks(dbSession, child)) {
            sources.push(...reviewSources(JSON.parse(descendant.transcriptJson), descendant.id));
            evidenceTasks.push(descendant.id);
        }
        completedTasks.push({ key: node.key, goal: child.goal, check: JSON.parse(child.checkJson ?? '{}'), answer: JSON.parse(child.resultJson ?? 'null') });
    }
    for (const id of evidenceTasks) {
        const receipts = await dbSession.db.select().from(communicationDeliveries).where(and(eq(communicationDeliveries.organizationId, task.organizationId), sql`substr(${communicationDeliveries.requestKey},1,${id.length + 1}) = ${id + ':'}`));
        for (const receipt of receipts) sources.push({ id: `receipt:${receipt.id}`, tool: 'stored_delivery_receipt', arguments: {}, data: receipt, failed: false });
    }
    // Citations repeat these IDs many times. Use packet-local keys to avoid
    // spending the review's output budget on UUIDs; retain exact provenance.
    return { phase, goal: task.goal, check: JSON.parse(task.checkJson ?? '{}'), proposal,
        sources: sources.map((source, index) => ({ ...source, id: `s${index}`, originId: source.id })), completedTasks };
}

/**
 * The completed tasks beneath a planner's plan, walked through nested planners.
 * Bounded by the delegation depth, so a malformed tree ends the walk.
 */
export async function plannedEvidenceTasks(dbSession: DbSession, planner: TaskRecord, depth = 0): Promise<TaskRecord[]> {
    if (depth >= DELEGATION_POLICY.maxDepth || JSON.parse(planner.checkJson ?? '{}').kind !== 'plan') return [];
    const plan = await goalPlan(dbSession, planner.organizationId, planner.id);
    const found: TaskRecord[] = [];
    for (const node of plan?.nodes ?? []) {
        if (node.status !== 'COMPLETED') continue;
        const task = await getTask(dbSession, planner.organizationId, node.id);
        if (!task) continue;
        found.push(task, ...await plannedEvidenceTasks(dbSession, task, depth + 1));
    }
    return found;
}
