/**
 * Verifies that Aval's local Codex transport can use the current ChatGPT
 * subscription. This reads account/model metadata only; it does not send an
 * inference request, touch Aval data, or persist copied credentials.
 */
import { startCodexInference } from "./lib/codex-inference.mjs";

let client;
try {
  client = await startCodexInference();
  process.stdout.write(`${JSON.stringify({
    status: "connected",
    transport: "codex-app-server",
    account: "chatgpt",
    model: client.model,
    inferenceRun: false,
  })}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({
    status: "not_connected",
    transport: "codex-app-server",
    error: detail,
    nextStep: "Open Aval Desktop and connect ChatGPT in Settings > Intelligence, or run codex login, then retry.",
  })}\n`);
  process.exitCode = 1;
} finally {
  await client?.close();
}
