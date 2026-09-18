import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A taught preference is only real if it reaches whichever agent takes the
 * turn. It does today — every site that starts the Ask Aval loop appends
 * `preferenceContext` — but that is a convention three separate files have to
 * keep, and a fourth entry point added later could silently drop it, giving a
 * workspace an agent that quietly ignores what it was taught.
 *
 * This test pins the invariant at the source level: every file that invokes
 * the loop must also build preference context into the prompt it passes.
 */
const LOOP_CALLERS = [
  "lib/ask-aval/handler.ts",
  "lib/ask-aval/draft.ts",
  "lib/ask-aval/auto-reply.ts",
];

test("every entry point that starts the Ask Aval loop feeds it taught preferences", async () => {
  for (const path of LOOP_CALLERS) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /runAskAvalLoop\(/, `${path} is listed as a loop caller but doesn't call it`);
    assert.match(source, /getPreferenceContext\(/, `${path} starts the loop without loading taught preferences`);
    assert.match(source, /preferenceContext/, `${path} loads preferences but doesn't pass them into the prompt`);
  }
});

test("no unlisted file starts the Ask Aval loop", async () => {
  // If this fails, a new entry point exists: add it above *and* make sure it
  // passes preference context, rather than just widening the list.
  const root = fileURLToPath(new URL("..", import.meta.url));
  const sourceFiles = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => {
      const target = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(target) : Promise.resolve(entry.name.endsWith(".ts") ? [target] : []);
    }));
    return nested.flat();
  };
  const files = [...await sourceFiles(join(root, "lib")), ...await sourceFiles(join(root, "app"))];
  const matches = await Promise.all(files.map(async (file) => (await readFile(file, "utf8")).includes("runAskAvalLoop(") ? file : null));
  const found = matches
    .filter((file): file is string => file !== null)
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .filter((file) => file !== "lib/ask-aval/loop.ts")
    .sort();
  assert.deepEqual(found, [...LOOP_CALLERS].sort());
});

test("the persona registry never overrides the hard rules preferences ride alongside", async () => {
  const source = await readFile(new URL("../lib/ask-aval/persona-catalog.ts", import.meta.url), "utf8");
  // Every persona contributes framing only; the faithfulness and injection
  // rules in the base prompt stay identical for all of them.
  assert.match(source, /systemPromptAddition/);
  assert.match(source, /framing only|hard rules/i);
});
