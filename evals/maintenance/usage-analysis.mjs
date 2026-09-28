/** Diagnostic comparison only. Notification count is NOT an inference-attempt count. */
export function maintenanceUsageAnalysis(calls) {
  return calls.map(call => {
    const snapshots = call.diagnostics?.usage_snapshots ?? [];
    const last = snapshots.at(-1);
    const known = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
    const input = known(call.usage?.input_tokens), output = known(call.usage?.output_tokens);
    const lastInput = known(last?.last?.inputTokens), lastOutput = known(last?.last?.outputTokens);
    return { job_id: call.job_id, phase: call.phase, request_bytes: call.request_bytes,
      reported_input_tokens: input, reported_output_tokens: output,
      cached_input_tokens: known(last?.total?.cachedInputTokens), reasoning_output_tokens: known(last?.total?.reasoningOutputTokens),
      last_notification_input_tokens: lastInput, last_notification_output_tokens: lastOutput,
      input_before_last_snapshot: input !== null && lastInput !== null && input >= lastInput ? input-lastInput : null,
      unique_usage_snapshots: snapshots.length, usage_basis: call.diagnostics?.usage_basis ?? 'unknown',
      interpretation: 'Cumulative totals and last-request counters are distinct. Bytes are not tokens. Snapshot count does not establish retries or explain transport overhead.' };
  });
}
