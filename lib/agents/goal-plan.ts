import { and, eq, sql } from 'drizzle-orm';
import type { DbSession } from "@/db/postgres/session";
import { agentChecks, agentPlanNodes, agentTasks } from "@/db/postgres/schema";
import { createTask, getTask, type TaskRecord } from './tasks';
import { parseTaskCheck, type TaskCheck } from './checks';
import { digestPayload } from '@/lib/audit/chain';
import { getTool } from './registry';
import { hasPermission, roleForPersona } from './permissions';
export const MAX_PLAN_NODES = 4, MAX_PLAN_REVISIONS = 2, MAX_GOAL_TASKS = 8;
type Node = {
    key: string;
    goal: string;
    agentId: string;
    dependsOn: string[];
    check: TaskCheck;
};
type Plan = {
    revision: number;
    requestKey: string;
    state: 'building' | 'ready';
    nodes: Node[];
    steps: number;
    tokens: number;
};
export function validatePlanNodes(value: unknown, parent: TaskRecord, completed: string[] = []): Node[] {
    if (!Array.isArray(value) || !value.length || value.length > MAX_PLAN_NODES)
        throw Error('A plan requires one to four tasks.');
    const keys = new Set<string>(completed);
    return value.map(v => {
        if (!v || typeof v !== 'object')
            throw Error('Invalid plan node.');
        const n = v as Record<string, unknown>;
        if (typeof n.key !== 'string' || !/^[a-z][a-z0-9_-]{0,30}$/.test(n.key) || keys.has(n.key) || typeof n.goal !== 'string' || !n.goal.trim() || n.goal.length > 1200 || !Array.isArray(n.dependsOn) || !n.dependsOn.every(k => typeof k === 'string' && keys.has(k)))
            throw Error('Task keys must be unique; dependencies must name earlier tasks.');
        const check = parseTaskCheck(n.check);
        if (check.kind === 'plan')
            throw Error('Nested goal planning is not supported.');
        const agentId = typeof n.agentId === 'string' ? n.agentId : parent.agentId;
        const permission = check.kind === 'evidence' ? check.tools.map(t => getTool(t)!.requiredPermission) : [getTool(check.kind === 'delivery' ? (check.operation === 'listing' ? 'publish_listing' : check.operation === 'call' ? 'place_call' : 'send_external_message') : 'record_preference')!.requiredPermission];
        if (permission.some(p => !hasPermission(roleForPersona(parent.agentId), p) || !hasPermission(roleForPersona(agentId), p)))
            throw Error('A planned task requires permissions outside its parent or specialist.');
        keys.add(n.key);
        return { key: n.key, goal: n.goal.trim(), agentId, dependsOn: n.dependsOn as string[], check };
    });
}
/** Reject impossible tool names/contracts before spending a reviewer call. */
export async function validateGoalPlanProposal(dbSession: DbSession, parent: TaskRecord, value: unknown) {
    const prior = await goalPlan(dbSession, parent.organizationId, parent.id);
    validatePlanNodes(value, parent, prior?.nodes.filter(n => n.status === 'COMPLETED').map(n => n.key) ?? []);
}
export async function goalPlan(dbSession: DbSession, org: string, rootId: string) {
    const root = await getTask(dbSession, org, rootId);
    if (!root)
        return null;
    const plan = JSON.parse(root.executionScopeJson).plan as Plan | undefined;
    if (!plan)
        return { revision: 0, state: 'absent', nodes: [] };
    const rows = await dbSession.db.select({ revision: agentPlanNodes.revision, key: agentPlanNodes.nodeKey, id: agentTasks.id, goal: agentTasks.goal, agentId: agentTasks.agentId, status: agentTasks.status, error: agentTasks.error, result: agentTasks.resultJson, check: agentTasks.checkJson, dependencies: agentPlanNodes.dependenciesJson }).from(agentPlanNodes).innerJoin(agentTasks, eq(agentTasks.id, agentPlanNodes.taskId)).where(and(eq(agentPlanNodes.organizationId, org), eq(agentPlanNodes.rootTaskId, rootId)));
    const latest = new Map<string, typeof rows[number]>();
    for (const row of rows)
        if (!latest.has(row.key) || latest.get(row.key)!.revision < row.revision)
            latest.set(row.key, row);
    const nodes = [...latest.values()];
    return { revision: plan.revision, state: plan.state, nodes };
}
export async function writeGoalPlan(dbSession: DbSession, org: string, rootId: string, value: unknown, requestKey: string) {
    let root = await getTask(dbSession, org, rootId);
    if (!root || root.cancelRequested || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(root.status) || root.parentTaskId || JSON.parse(root.checkJson ?? '{}').kind !== 'plan')
        throw Error('Only an active root goal may create a plan.');
    let scope = JSON.parse(root.executionScopeJson), plan = scope.plan as Plan | undefined;
    if (plan?.requestKey !== requestKey) {
        const proposalDigest = await digestPayload({ tasks: value });
        const reviews = await dbSession.db.select({ output: agentChecks.outputJson }).from(agentChecks).where(and(eq(agentChecks.organizationId, org), eq(agentChecks.taskId, rootId), eq(agentChecks.stepIndex, root.stepCount - 1), eq(agentChecks.exitCode, 0)));
        if (!reviews.some(row => { const review = JSON.parse(row.output); return review.phase === 'plan' && review.reviewer === 'independent-session-v1' && review.proposalDigest === proposalDigest; }))
            throw Error('A matching independent semantic plan review is required before allocating work.');
        const prior = await goalPlan(dbSession, org, rootId);
        if (plan && prior?.nodes.some(n => n.status === 'RUNNING' || n.status === 'WAITING_FOR_APPROVAL'))
            throw Error('Wait for running or approval-pending work before replanning.');
        const revision = (plan?.revision ?? 0) + 1;
        if (revision > MAX_PLAN_REVISIONS)
            throw Error('The goal reached its replan cap. Review the failed checks.');
        const nodes = validatePlanNodes(value, root, prior?.nodes.filter(n => n.status === 'COMPLETED').map(n => n.key));
        if (prior)
            for (const old of prior.nodes.filter(n => n.status !== 'COMPLETED')) {
                const replacement = nodes.find(n => n.key === old.key);
                if (!replacement || JSON.stringify(replacement.check) !== JSON.stringify(JSON.parse(old.check)))
                    throw Error('Replanning must retain every unfinished completion condition; only the approach may change.');
            }
        const existing = await dbSession.db.select({ id: agentPlanNodes.id }).from(agentPlanNodes).where(eq(agentPlanNodes.rootTaskId, rootId));
        if (existing.length + nodes.length > MAX_GOAL_TASKS)
            throw Error('The goal reached its total task cap.');
        const steps = Math.floor((root.maxSteps - root.stepCount - 2) / (2 * nodes.length)), tokens = Math.floor((root.maxTokens - root.tokensUsed) / (2 * nodes.length));
        if (steps < 2 || tokens < 2048)
            throw Error('Insufficient shared budget for this plan. Reduce its size.');
        plan = { revision, requestKey, state: 'building', nodes, steps, tokens };
        const claimed = await dbSession.db.update(agentTasks).set({ executionScopeJson: JSON.stringify({ ...scope, plan }), maxSteps: sql `${agentTasks.maxSteps}-${steps * nodes.length}`, maxTokens: sql `${agentTasks.maxTokens}-${tokens * nodes.length}` }).where(and(eq(agentTasks.id, rootId), eq(agentTasks.executionScopeJson, root.executionScopeJson), eq(agentTasks.maxSteps, root.maxSteps), eq(agentTasks.maxTokens, root.maxTokens), eq(agentTasks.cancelRequested, false))).returning({ id: agentTasks.id });
        if (!claimed.length)
            throw Error('The goal changed while allocating its plan. Retry from current state.');
        if (prior)
            for (const node of prior.nodes)
                if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(node.status))
                    await dbSession.db.update(agentTasks).set({ status: 'CANCELLED', cancelRequested: true, finishedAt: new Date() }).where(and(eq(agentTasks.id, node.id), eq(agentTasks.status, node.status)));
        root = (await getTask(dbSession, org, rootId))!;
        scope = JSON.parse(root.executionScopeJson);
    }
    if (!plan)
        throw Error('No plan reservation.');
    if (plan.state === 'ready')
        return goalPlan(dbSession, org, rootId);
    for (const node of plan.nodes) {
        const id = `node_${await digestPayload({ rootId, requestKey, key: node.key })}`;
        await createTask(dbSession, { id, organizationId: org, userId: root.userId, agentId: node.agentId, goal: node.goal, check: node.check, deadlineAt: root.deadlineAt ?? undefined, maxSteps: plan.steps, maxTokens: plan.tokens, parentTaskId: rootId, delegationDepth: root.delegationDepth + 1 });
        await dbSession.db.insert(agentPlanNodes).values({ id: crypto.randomUUID(), organizationId: org, rootTaskId: rootId, revision: plan.revision, nodeKey: node.key, taskId: id, dependenciesJson: JSON.stringify(node.dependsOn), createdAt: new Date() }).onConflictDoNothing();
    }
    const finalScope = { ...scope, plan: { ...plan, state: 'ready' } };
    await dbSession.db.update(agentTasks).set({ executionScopeJson: JSON.stringify(finalScope) }).where(and(eq(agentTasks.id, rootId), eq(agentTasks.executionScopeJson, root.executionScopeJson)));
    return goalPlan(dbSession, org, rootId);
}
export async function planReadiness(dbSession: DbSession, task: TaskRecord): Promise<{
    wait: boolean;
    failure?: string;
    context?: string;
}> {
    if (task.cancelRequested || (task.deadlineAt && task.deadlineAt.getTime() <= Date.now()))
        return { wait: false };
    if (task.parentTaskId) {
        const parent = await getTask(dbSession, task.organizationId, task.parentTaskId);
        if (!parent)
            return { wait: false, failure: 'Parent goal is missing.' };
        if (JSON.parse(parent.checkJson ?? '{}').kind !== 'plan')
            return { wait: false };
        const plan = await goalPlan(dbSession, task.organizationId, parent.id);
        const node = plan?.nodes.find(n => n.id === task.id);
        if (parent.cancelRequested || (parent.deadlineAt && parent.deadlineAt.getTime() <= Date.now()) || ['FAILED', 'CANCELLED'].includes(parent.status))
            return { wait: false, failure: 'Parent goal stopped.' };
        if (!node || plan?.state !== 'ready')
            return { wait: true };
        const deps = JSON.parse(node.dependencies) as string[];
        const sources = plan.nodes.filter(n => deps.includes(n.key));
        if (sources.some(n => ['FAILED', 'CANCELLED'].includes(n.status)))
            return { wait: false, failure: 'A required dependency failed. The root goal must replan.' };
        if (sources.some(n => n.status !== 'COMPLETED'))
            return { wait: true };
        return { wait: false, context: sources.length ? JSON.stringify(sources.map(n => ({ key: n.key, result: n.result }))) : undefined };
    }
    const scope = JSON.parse(task.executionScopeJson), plan = scope.plan as Plan | undefined;
    if (plan?.state === 'building')
        await writeGoalPlan(dbSession, task.organizationId, task.id, plan.nodes, plan.requestKey);
    const current = await goalPlan(dbSession, task.organizationId, task.id);
    if (!current?.nodes.length)
        return { wait: false };
    if (current.nodes.some(n => ['FAILED', 'CANCELLED'].includes(n.status)) && current.nodes.some(n => ['RUNNING', 'WAITING_FOR_APPROVAL'].includes(n.status)))
        return { wait: true };
    if (current.nodes.some(n => ['FAILED', 'CANCELLED'].includes(n.status)))
        return { wait: false, context: JSON.stringify(current) };
    return { wait: current.nodes.some(n => n.status !== 'COMPLETED'), context: JSON.stringify(current) };
}
