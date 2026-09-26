import { and, eq } from 'drizzle-orm';
import type { DbSession } from "@/db/postgres/session";
import { agentChecks, agentPlanNodes, agentTasks } from "@/db/postgres/schema";
import { createTask, getTask, type TaskRecord } from './tasks';
import { parseTaskCheck, type TaskCheck } from './checks';
import { digestPayload } from '@/lib/audit/chain';
import { getTool } from './registry';
import { actorHolds, actorOrchestrates, builtInActor, isOrchestrator, resolveActorId } from './organization/index.ts';
import { DELEGATION_POLICY } from './delegation-policy.ts';
import { findDuplicateWork, workCanFundGrants, workIdOf, workSize } from './work-identity.ts';
import { grantFor, type Grant } from './budget-model.ts';
import { requestCancel } from './tasks';
import { resolveAttemptPolicy } from "./attempt-policy.ts";
import { loadAttemptPolicies } from "./attempt-policy-store.ts";
import { delegationRefusal } from "./delegation.ts";
/** Fan-out and total size remain structural caps (delegation-policy.ts). How
 * many times a goal may be rethought is policy — see DEFAULT_ATTEMPT_POLICIES.replan. */
export const MAX_PLAN_NODES = DELEGATION_POLICY.maxFanout, MAX_GOAL_TASKS = 8;
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
    /** Each node's own budget, by key (budget-model.ts). */
    budgets?: Record<string, Grant>;
    /** The per-node split of the model before it; a plan stored mid-build under it still resumes. */
    steps?: number;
    tokens?: number;
};
/** The permissions a completion condition needs its task to hold. */
export function permissionsForCheck(check: TaskCheck) {
    if (check.kind === 'plan')
        return [];
    return check.kind === 'evidence' ? check.tools.map(t => getTool(t)!.requiredPermission) : [getTool(check.kind === 'delivery' ? (check.operation === 'listing' ? 'publish_listing' : check.operation === 'call' ? 'place_call' : 'send_external_message') : 'record_preference')!.requiredPermission];
}
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
        const agentId = resolveActorId(typeof n.agentId === 'string' ? n.agentId : parent.agentId);
        // A Lead may plan for its own team, so a plan node may itself be a
        // plan — as long as its children still fit under the depth limit.
        if (check.kind === 'plan') {
            if (parent.delegationDepth + 2 > DELEGATION_POLICY.maxDepth)
                throw Error('A nested plan here would put its tasks deeper than the delegation limit.');
            if (!builtInActor(agentId) || builtInActor(agentId)?.kind === 'specialist')
                throw Error('Only Aval One or a Lead coordinates a plan. Give a Specialist a checked task instead.');
        }
        else {
            const permission = permissionsForCheck(check);
            // The child must hold every permission its node needs. The parent
            // must hold it or be allowed to route it to that child. An
            // employee's own grant is re-read on every call (task-boundary.ts),
            // so where an employee is the planner only the child is checked
            // here.
            const employeeActing = Boolean(parent.employeeId && isOrchestrator(parent.agentId));
            if (permission.some(p => (!employeeActing && !actorHolds(parent.agentId, p) && !actorOrchestrates(parent.agentId, p)) || !actorHolds(agentId, p)))
                throw Error('A planned task requires permissions outside its parent or specialist.');
        }
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
    // Any active planner may write its plan: the root, or a Lead planning for
    // its team beneath it. The depth limit was checked when that Lead's node
    // was accepted.
    if (!root || root.cancelRequested || ['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(root.status) || JSON.parse(root.checkJson ?? '{}').kind !== 'plan')
        throw Error('Only an active planning task may create a plan.');
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
        // How many times a goal may be rethought is a property of the work, not
        // a constant. The default matches the cap this replaced; a workspace can
        // give slow-moving objectives more room without widening anything else,
        // because the replan budget is resolved separately from verification
        // and repair.
        const replanPolicy = resolveAttemptPolicy('replan', {}, await loadAttemptPolicies(dbSession, org));
        if (replanPolicy.maxAttempts != null && revision > replanPolicy.maxAttempts)
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
        if (await workSize(dbSession, org, workIdOf(root)) + nodes.length > DELEGATION_POLICY.maxTasksPerWork)
            throw Error('This Work reached its total task cap across every level. Finish or replan what is open.');
        const signatures = new Set(nodes.map(n => `${n.agentId}\u0000${n.goal.toLowerCase().replace(/\s+/g, ' ')}\u0000${JSON.stringify(n.check)}`));
        if (signatures.size !== nodes.length)
            throw Error('Two tasks in this plan ask the same actor the same question. Merge them into one.');
        // Who may open work under whom, and whether doing so would close a
        // loop. The live path has never asked either question: it checked that
        // the child held the permissions its node needed, which is a different
        // question from whether this parent may hand work to that child at all.
        for (const node of nodes) {
            // Retaining the current actor is not delegation, so there is no
            // pair or loop to check — the size and depth limits above still
            // applied.
            if (node.agentId === resolveActorId(root.agentId)) continue;
            const refusal = await delegationRefusal(dbSession, org, root, { agentId: node.agentId, employeeId: root.employeeId });
            if (refusal) throw Error(refusal);
        }
        // Each node is funded for its own actor's work (budget-model.ts), from
        // the Work's pool and not from this root: planning cannot starve the
        // planner, and a fourth node gets what the first got. Nodes of the
        // revision being replaced settle below, so only what they actually
        // spent stays committed.
        const budgets = Object.fromEntries(nodes.map((node) => [node.key, grantFor(node.agentId)]));
        const superseded = prior ? prior.nodes.filter(n => !['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(n.status)).map(n => n.id) : [];
        if (!(await workCanFundGrants(dbSession, org, workIdOf(root), Object.values(budgets), superseded)))
            throw Error('This Work has no budget left to fund this plan in full. Reduce it to the work that matters most, or conclude with what you have.');
        plan = { revision, requestKey, state: 'building', nodes, budgets };
        const claimed = await dbSession.db.update(agentTasks).set({ executionScopeJson: JSON.stringify({ ...scope, plan }) }).where(and(eq(agentTasks.id, rootId), eq(agentTasks.executionScopeJson, root.executionScopeJson), eq(agentTasks.cancelRequested, false))).returning({ id: agentTasks.id });
        if (!claimed.length)
            throw Error('The goal changed while allocating its plan. Retry from current state.');
        // An unfinished node of the old revision is superseded, not cancelled:
        // nobody asked for it to stop, a better plan made it unnecessary. Its
        // own descendants — a Lead's team, a peer it asked — are cancelled
        // first, so nothing keeps spending under a node that no longer exists.
        if (prior)
            for (const node of prior.nodes)
                if (!['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(node.status)) {
                    const children = await dbSession.db.select({ id: agentTasks.id }).from(agentTasks).where(and(eq(agentTasks.organizationId, org), eq(agentTasks.parentTaskId, node.id)));
                    for (const child of children)
                        await requestCancel(dbSession, org, child.id);
                    await dbSession.db.update(agentTasks).set({ status: 'SUPERSEDED', cancelRequested: true, finishedAt: new Date() }).where(and(eq(agentTasks.id, node.id), eq(agentTasks.status, node.status)));
                }
        root = (await getTask(dbSession, org, rootId))!;
        scope = JSON.parse(root.executionScopeJson);
    }
    if (!plan)
        throw Error('No plan reservation.');
    if (plan.state === 'ready')
        return goalPlan(dbSession, org, rootId);
    for (const node of plan.nodes) {
        const id = `node_${await digestPayload({ rootId, requestKey, key: node.key })}`;
        // The same question already open elsewhere in this Work is linked, not
        // asked again. Its own node id is kept only when it is the first ask.
        const own = await getTask(dbSession, org, id);
        const duplicate = own ? null : await findDuplicateWork(dbSession, org, workIdOf(root), { agentId: node.agentId, goal: node.goal, check: node.check });
        const taskId = duplicate?.id ?? id;
        if (!duplicate)
            await createTask(dbSession, { id, organizationId: org, userId: root.userId, agentId: node.agentId, employeeId: root.employeeId, goal: node.goal, check: node.check, deadlineAt: root.deadlineAt ?? undefined, maxSteps: (plan.budgets?.[node.key] ?? { steps: plan.steps ?? 2 }).steps, maxTokens: (plan.budgets?.[node.key] ?? { tokens: plan.tokens ?? 2048 }).tokens, parentTaskId: rootId, delegationDepth: root.delegationDepth + 1 });
        await dbSession.db.insert(agentPlanNodes).values({ id: crypto.randomUUID(), organizationId: org, rootTaskId: rootId, revision: plan.revision, nodeKey: node.key, taskId, dependenciesJson: JSON.stringify(node.dependsOn), createdAt: new Date() }).onConflictDoNothing();
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
    let dependencyContext: string | undefined;
    if (task.parentTaskId) {
        const parent = await getTask(dbSession, task.organizationId, task.parentTaskId);
        if (!parent)
            return { wait: false, failure: 'Parent goal is missing.' };
        if (JSON.parse(parent.checkJson ?? '{}').kind === 'plan') {
            const plan = await goalPlan(dbSession, task.organizationId, parent.id);
            const node = plan?.nodes.find(n => n.id === task.id);
            if (parent.cancelRequested || (parent.deadlineAt && parent.deadlineAt.getTime() <= Date.now()) || ['FAILED', 'CANCELLED', 'SUPERSEDED'].includes(parent.status))
                return { wait: false, failure: 'Parent goal stopped.' };
            if (node && plan?.state === 'ready') {
                const deps = JSON.parse(node.dependencies) as string[];
                const sources = plan.nodes.filter(n => deps.includes(n.key));
                if (sources.some(n => ['FAILED', 'CANCELLED', 'SUPERSEDED'].includes(n.status)))
                    return { wait: false, failure: 'A required dependency failed. The root goal must replan.' };
                if (sources.some(n => n.status !== 'COMPLETED'))
                    return { wait: true };
                dependencyContext = sources.length ? JSON.stringify(sources.map(n => ({ key: n.key, result: n.result }))) : undefined;
            }
            else
                return { wait: true };
        }
        // Only a planner has its own plan to wait on. Anything else is ready.
        if (JSON.parse(task.checkJson ?? '{}').kind !== 'plan')
            return { wait: false, context: dependencyContext };
    }
    const scope = JSON.parse(task.executionScopeJson), plan = scope.plan as Plan | undefined;
    if (plan?.state === 'building')
        await writeGoalPlan(dbSession, task.organizationId, task.id, plan.nodes, plan.requestKey);
    const current = await goalPlan(dbSession, task.organizationId, task.id);
    if (!current?.nodes.length)
        return { wait: false, context: dependencyContext };
    if (current.nodes.some(n => ['FAILED', 'CANCELLED'].includes(n.status)) && current.nodes.some(n => ['RUNNING', 'WAITING_FOR_APPROVAL'].includes(n.status)))
        return { wait: true };
    if (current.nodes.some(n => ['FAILED', 'CANCELLED'].includes(n.status)))
        return { wait: false, context: JSON.stringify(current) };
    return { wait: current.nodes.some(n => n.status !== 'COMPLETED'), context: JSON.stringify(current) };
}
