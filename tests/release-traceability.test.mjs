import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("desktop and production release target Aval's canonical host", async () => {
  const [desktopMain, desktopWorkflow] = await Promise.all([
    read("desktop/main.cjs"),
    read(".github/workflows/desktop-release.yml"),
  ]);
  assert.match(desktopMain, /const DEFAULT_APP_URL = "https:\/\/app\.aval\.llc";/);
  assert.match(desktopWorkflow, /Target: https:\/\/app\.aval\.llc\./);
});

test("Cloudflare deployments record the source commit", async () => {
  const workflow = await read(".github/workflows/cloudflare-production.yml");
  assert.match(workflow, /--tag "\$GITHUB_SHA"/);
  assert.match(workflow, /--message "GitHub Actions \$GITHUB_SHA"/);
});
