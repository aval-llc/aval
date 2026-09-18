import { createServer } from "node:http";
import worker from "../../infra/benchmark/worker.ts";
import { spikeSourceHash } from "./spike-source.mjs";

if (!process.env.AVAL_BENCHMARK_DATABASE_URL || !process.env.AVAL_BENCHMARK_TOKEN) throw new Error("Load the private migration environment file first");
const env = { LOCAL_DATABASE_URL: process.env.AVAL_BENCHMARK_DATABASE_URL,
  BENCHMARK_TOKEN: process.env.AVAL_BENCHMARK_TOKEN, BENCHMARK_SOURCE_HASH: await spikeSourceHash(), BENCHMARK_PROJECT_REF: "local" };
const server = createServer(async (incoming, outgoing) => {
  try {
    const request = new Request(new URL(incoming.url ?? "/", "http://127.0.0.1:8789"), { method: incoming.method, headers: incoming.headers });
    const response = await worker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500); outgoing.end("Local benchmark failed"); }
});
server.listen(8789, "127.0.0.1", () => console.log("Local PostgreSQL benchmark on http://127.0.0.1:8789 (synthetic fixture only)"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
