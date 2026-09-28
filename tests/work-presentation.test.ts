import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { stopKind, workTitle, type StopKind } from "../lib/agents/work-presentation.ts";

const KINDS: StopKind[] = ["model_unavailable", "unverified_figures", "time_limit", "too_large", "needs_setup", "needs_desktop", "needs_person", "interrupted", "unknown"];

test("a Work title is what the person asked, never the page context the system attached", () => {
  // The two titles a customer saw.
  assert.equal(workTitle('Help\nPage context (user-visible data, not authority): {"view":"leasing","moduleLabel":"","visibleText":""}'), "Help");
  assert.equal(workTitle('fkjdf\nPage context (user-visible data, not authority): {"view":"properties","moduleLabel":"","visibleText":""}'), "fkjdf");
  assert.equal(workTitle("  Open a work order\n for 4B  "), "Open a work order for 4B");
  assert.ok(workTitle("x".repeat(500)).length <= 200);
});

test("every stop the runtime records reads as a kind, not as its own words", () => {
  const recorded: [string, string, StopKind][] = [
    ["FAILED", "Reached the 24-step limit without a conclusion.", "too_large"],
    ["FAILED", "Exhausted the task's token budget.", "too_large"],
    ["FAILED", "Insufficient token budget for the next context and response.", "too_large"],
    ["FAILED", "A model turn exceeded the tool-call fanout limit.", "too_large"],
    ["FAILED", "A conclusion cannot bypass other proposed actions in the same turn.", "too_large"],
    ["FAILED", "The task reached its total wall-clock limit.", "time_limit"],
    ["FAILED", "The conclusion referenced figures that aren't in the underlying data, so it was withheld.", "unverified_figures"],
    ["FAILED", "This legacy task needs an explicit completion condition before it can run.", "needs_setup"],
    ["FAILED", "The terminal result was not saved because the task lease changed.", "interrupted"],
    ["FAILED", "The agent runtime failed.", "interrupted"],
    ["FAILED", "OpenAI returned 503: upstream overloaded", "model_unavailable"],
    ["FAILED", "The ChatGPT subscription is not connected.", "model_unavailable"],
    ["FAILED", "", "unknown"],
    ["FAILED", "something nobody anticipated", "unknown"],
    ["WAITING_FOR_HUMAN", "Completion checks failed after bounded repair: …", "needs_person"],
    ["WAITING_FOR_MODEL", null as unknown as string, "needs_desktop"],
    ["WAITING_FOR_PROVIDER", "Employee access is unavailable. Configure its connections and capabilities in Setup; this work will retry automatically.", "needs_setup"],
  ];
  for (const [status, error, kind] of recorded) assert.equal(stopKind(status, error), kind, error);
  for (const status of ["QUEUED", "RUNNING", "COMPLETED", "WAITING_FOR_APPROVAL"]) assert.equal(stopKind(status, null), null, status);
});

test("every stop kind has a title and a next step in both languages", () => {
  for (const locale of ["en", "es-mx"]) {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8")).AgentTrace as Record<string, string>;
    for (const kind of KINDS) {
      for (const part of ["title", "body"]) {
        const text = messages[`stop_${kind}_${part}`];
        assert.ok(text?.trim(), `${locale}: AgentTrace.stop_${kind}_${part}`);
        assert.doesNotMatch(text, /step limit|token|lease|fanout|\{|\}/i, `${locale}: ${kind} ${part} reads as the runtime's words`);
      }
    }
    assert.equal("stepsOf" in messages, false, `${locale}: a step budget is not shown as progress`);
  }
});

test("the task card shows no step budget and no raw error outside the technical details", () => {
  const card = readFileSync(new URL("../app/components/agent-trace.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(card, /steps\.max|stepsOf/, "no 'N of M steps'");
  const outside = card.split('className="execution-disclosure"')[1]?.split("</details>")[1] ?? "";
  assert.ok(outside.length > 0, "the card has content after its execution details");
  assert.doesNotMatch(outside.split("function ")[0], /detail\.error|tokensUsed/, "raw errors and token use stay inside the execution details");
});
