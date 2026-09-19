import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Demo content must not become a production dependency.
 *
 * `app/data/sample.ts` holds the marketing surface's fixture alongside shared
 * derivation helpers, which makes it easy to import for the helpers and end up
 * reading the fixture. The agent tool path in particular once did read it, and
 * the header comment in `lib/ask-aval/tools.ts` still said so long after it had
 * stopped being true. This fails the moment it becomes true again.
 */

const AGENT_PATH_DIRS = ["lib/ask-aval", "lib/operations", "lib/agents", "lib/pms"];

/** Named exports of the fixture payload, as opposed to the pure helpers. */
const FIXTURE_EXPORTS = ["sampleData", "sampleInfrastructure"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("no agent-path module reads the demo fixture", () => {
  const offenders: string[] = [];
  for (const dir of AGENT_PATH_DIRS) {
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, "utf8");
      // Comments may discuss the fixture; only real references count.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const symbol of FIXTURE_EXPORTS) {
        if (new RegExp(`\\b${symbol}\\b`).test(code)) offenders.push(`${file} references ${symbol}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `demo fixture reached the agent path:\n${offenders.join("\n")}`);
});

test("a type-only import of the fixture module stays type-only", () => {
  // Importing a type is harmless; importing the payload is not. This keeps the
  // distinction explicit rather than relying on the reader to notice.
  for (const dir of AGENT_PATH_DIRS) {
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, "utf8");
      const imports = source.match(/^import\s+(?!type\b)[^;]*from\s+"[^"]*data\/sample[^"]*";/gm) ?? [];
      assert.deepEqual(imports, [], `${file} imports values from the demo fixture`);
    }
  }
});
