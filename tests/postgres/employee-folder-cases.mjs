import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { draftDocuments } from '../../db/postgres/schema.ts';
import { reserveDraft } from '../../lib/ask-aval/draft-store.ts';
import { createTask, listTasks, ownedTaskIds } from '../../lib/agents/tasks.ts';
import { createEmployee } from '../../lib/agents/employees.ts';

export async function runEmployeeFolderCases(t, { session, userA, userB }) {
  await t.test('folder draft ownership persists and historical drafts remain unassigned', async () => {
    const id = randomUUID(), legacy = randomUUID();
    await session(userA, async s => {
      const owner = { organizationId: s.identity.organizationId, userId: userA };
      const input = {title:'Folder report', instructions:'Write a report',format:'docx',documentType:null,moduleLabel:null};
      await reserveDraft(s, owner, id, {...input,personaId:'financial'});
      await reserveDraft(s, owner, legacy, input);
    });
    await session(userA, async s => {
      const rows = await s.db.select().from(draftDocuments);
      assert.equal(rows.find(row=>row.id===id)?.personaId,'financial');
      assert.equal(rows.find(row=>row.id===legacy)?.personaId,null);
    });
    await session(userB, async s => {
      assert.equal((await s.db.select().from(draftDocuments).where(eq(draftDocuments.id,id))).length,0);
    });
  });
  await t.test('folder scope applies before history limits and separates employees from personas', async () => {
    let employeeId, taskId;
    await session(userA, async s => {
      const org=s.identity.organizationId;
      const employee=await createEmployee(s,org,userA,{name:'Folder '+randomUUID(),role:'Maintenance'});
      employeeId=employee.id;
      const task=await createTask(s,{organizationId:org,userId:userA,agentId:'maintenance',employeeId,goal:'Owned folder work',check:{kind:'plan'}});
      taskId=task.id;
      for(let n=0;n<26;n++)await createTask(s,{organizationId:org,userId:userA,agentId:'financial',goal:'Unrelated '+n,check:{kind:'plan'}});
      assert.deepEqual((await listTasks(s,org,1,{id:employeeId,employee:true})).map(task=>task.id),[taskId]);
      assert.ok(!(await listTasks(s,org,100,{id:'maintenance',employee:false})).some(task=>task.id===taskId));
      assert.deepEqual(await ownedTaskIds(s,org,{id:employeeId,employee:true}),[taskId]);
    });
    await session(userB, async s=>{
      assert.deepEqual(await ownedTaskIds(s,s.identity.organizationId,{id:employeeId,employee:true}),[]);
    });
  });
}
