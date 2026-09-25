/** Employee ownership wins over the underlying persona used to execute work. */
export function belongsToAgent(task: { agentId: string; employeeId?: string | null }, id: string, employee: boolean): boolean {
  return employee ? task.employeeId === id : !task.employeeId && task.agentId === id;
}
