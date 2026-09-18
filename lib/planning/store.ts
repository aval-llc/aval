import { and, desc, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { planningItems, planningProjects } from "@/db/postgres/schema";
import type { ItemInput, PlanningItem, Project, ProjectColor } from "./types";

export async function readPlanning(dbSession: DbSession, organizationId: string): Promise<{ projects: Project[]; items: PlanningItem[] }> {
  const [projectRows, itemRows] = await Promise.all([
    dbSession.db.select({
      id: planningProjects.id,
      title: planningProjects.title,
      description: planningProjects.description,
      color: planningProjects.color,
      createdAt: planningProjects.createdAt,
    }).from(planningProjects).where(eq(planningProjects.organizationId, organizationId)).orderBy(desc(planningProjects.createdAt)),
    dbSession.db.select({
      id: planningItems.id,
      title: planningItems.title,
      description: planningItems.description,
      kind: planningItems.kind,
      status: planningItems.status,
      projectId: planningItems.projectId,
      assigneeId: planningItems.assigneeId,
      startsAt: planningItems.startsAt,
      endsAt: planningItems.endsAt,
      version: planningItems.version,
    }).from(planningItems).where(eq(planningItems.organizationId, organizationId)).orderBy(planningItems.startsAt, planningItems.id),
  ]);
  return { projects: projectRows as Project[], items: itemRows as PlanningItem[] };
}

export async function hasProject(dbSession: DbSession, organizationId: string, id: string) {
  const [row] = await dbSession.db.select({ id: planningProjects.id }).from(planningProjects)
    .where(and(eq(planningProjects.organizationId, organizationId), eq(planningProjects.id, id))).limit(1);
  return Boolean(row);
}

export async function createProject(dbSession: DbSession, organizationId: string, title: string, description: string, color: ProjectColor) {
  const row = { id: crypto.randomUUID(), title, description, color, createdAt: Date.now() };
  await dbSession.db.insert(planningProjects).values({ ...row, organizationId });
  return row;
}

export async function createItem(dbSession: DbSession, organizationId: string, createdBy: string, input: ItemInput) {
  const row = { ...input, id: crypto.randomUUID(), version: 1 };
  await dbSession.db.insert(planningItems).values({ ...row, organizationId, createdBy, updatedAt: Date.now() });
  return row;
}

export async function updateItem(dbSession: DbSession, organizationId: string, id: string, version: number, input: ItemInput) {
  const updated = await dbSession.db.update(planningItems).set({
    ...input,
    version: version + 1,
    updatedAt: Date.now(),
  }).where(and(
    eq(planningItems.organizationId, organizationId),
    eq(planningItems.id, id),
    eq(planningItems.version, version),
  )).returning({ id: planningItems.id });
  return updated.length === 1 ? { ...input, id, version: version + 1 } : null;
}

export async function deleteItem(dbSession: DbSession, organizationId: string, id: string, version: number) {
  const deleted = await dbSession.db.delete(planningItems).where(and(
    eq(planningItems.organizationId, organizationId),
    eq(planningItems.id, id),
    eq(planningItems.version, version),
  )).returning({ id: planningItems.id });
  return deleted.length === 1;
}
