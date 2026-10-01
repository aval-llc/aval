/** Breadth before repetitions: budget exhaustion must not hide an entire risk class. */
export function maintenanceSchedule(scenarios, override) {
  const counts = scenarios.map(s => Number(override ?? s.repetitions));
  if (counts.some(n => !Number.isInteger(n) || n < 1 || n > 3)) throw Error('Use 1–3 repetitions');
  return Array.from({length:Math.max(0,...counts)}, (_,index) => scenarios.flatMap((scenario,i) => counts[i] > index ? [{scenario,repetition:index+1}] : [])).flat();
}
