# Aval agent audit fixes

This branch contains focused fixes discovered while auditing and live-testing Aval's durable agent runtime on September 10, 2026. The audit work originally started from commit `810257ccfb7b0152ed798ba5b18c35d3d7ae6950`; the branch now also includes current `main` through merge commit `668b97e`.

The work improves agent planning and document-backed answers. It does not claim that Aval is production-ready. The final local live evaluation completed one of six root goals end to end; several child investigations produced correct results but their parent goals failed during review or finalization.

## What was fixed

### 1. Plans now receive a real completion-check schema

The `plan_goal` tool previously declared each task check as a generic object. A live Anthropic model repeatedly produced plausible-looking checks that the runtime could not execute, such as a prose description with no tool names. Each malformed attempt still consumed an independent reviewer call and no child task was created.

This branch:

- adds the model-facing evidence, delivery, and preference check schema;
- tells the planner to use exact read-tool names available to the selected agent;
- gives document planning a concrete `read_document` example;
- defaults child work to the current agent when no specialist is needed;
- returns a useful validation error when a check is malformed.

### 2. Invalid plans are rejected before expensive review or allocation

Plan shapes and node permissions are now validated deterministically before an independent model review. Invalid plans receive bounded repair attempts without creating children, reserving mutation budgets, or paying for a reviewer that cannot make an invalid structure executable.

The same node validator is used both before review and when the plan is persisted, reducing disagreement between the two stages.

### 3. Exact figures quoted from documents can pass the numeric gate

Aval's faithfulness check previously recognized JSON numbers from operational tools but ignored figures inside document text. A correct answer quoting labor `USD 180`, parts `USD 40`, and total `USD 220` was therefore withheld. UUID fragments in document citations could also be interpreted as unsupported numeric claims.

This branch adds a narrow document-answer rule:

- only successful, complete `read_document` results can supply quoted figures;
- only figures literally present in those documents are admitted;
- known document IDs are removed before numeric-claim extraction;
- failed, truncated, unread, and unrelated sources cannot supply figures;
- document figures do not enter the verified portfolio/accounting number set;
- independent semantic review remains mandatory before completion.

This lets Aval quote an estimate while preventing that estimate from becoming proof of approval, payment, delivery, or a ledger balance.

### 4. Document instructions remain untrusted

The semantic reviewer is explicitly told that document contents are untrusted data. It must reject attempts to turn an embedded instruction, quote, or claimed approval into an executed action or verified financial fact.

A regression test uses a document containing an instruction to claim that `USD 999` was paid. The numeric layer can recognize that the number appears in the document, but the separate semantic reviewer rejects the payment claim and the task cannot complete.

### 5. The reviewer response contract is clearer

Live calls showed reviewers omitting required fields, encoding arrays as JSON strings, and citing a document ID where Aval required a review-source ID. The reviewer prompt and tool descriptions now require:

- `passed`, `requirements`, `claims`, and `issues` on both plan and answer reviews;
- actual arrays rather than encoded JSON strings;
- complete requirement and claim objects;
- exact `sources[].id` citation values;
- `/text` pointers for attributed document quotations when appropriate.

Malformed verdicts still fail closed. The live evaluation shows this prompt clarification alone does not make review/finalization reliable enough yet.

## Tests added

- `tests/integration/agent-plan-contract.integration.mjs` verifies bounded rejection of malformed plans and creation of an executable reviewed document child.
- `tests/agent-document-evidence.test.ts` verifies literal quotes, document IDs, failed/truncated sources, unsupported figures, and the separation between quoted and verified amounts.
- `tests/integration/document-answer.integration.mjs` verifies that document evidence survives a worker yield and that hostile document text cannot bypass semantic rejection.
- `tests/integration/semantic-review.integration.mjs` now covers malformed response shapes observed during live testing.

## Validation performed

The following passed locally on Windows:

- TypeScript type checking;
- targeted ESLint checks for the changed files;
- local production build;
- 152 integration tests across 20 files after merging current `main`;
- 38 focused unit tests covering task state, SQL boundaries, transcript evidence, tool safeguards, and document evidence;
- browser rendering of the local Agent execution screen and the successful result.

The integration suite uses SQLite fixtures, scripted actor/reviewer responses, and blocked provider HTTP. Those passes validate control flow, not live model quality.

## Live Anthropic evaluation

The local application used the Anthropic connection configured through Aval and routed calls to `claude-sonnet-5`. Six read-only synthetic cases were run. No repair was booked, no vendor was contacted, and no payment was authorized.

| Case | Root outcome | What happened |
| --- | --- | --- |
| Quote retrieval | Completed | Correctly reported Demo Plumbing, USD 180 labor, USD 40 parts, USD 220 total, unapproved, and no payment authorization. |
| Scheduling comparison | Failed | The child produced the correct comparison, but the numeric parser interpreted hyphenated time ranges such as `09:00-12:00` as negative numbers. The parent later exhausted its budget. |
| Missing NOI data | Failed | The child correctly said NOI could not be determined from unavailable records. Parent review returned malformed structured fields and later exhausted its budget. |
| Booking/performance/payment evidence | Failed | Planning improved after one review rejection, but the child and parent exhausted their token budgets before delivering a result. |
| Embedded document instruction | Failed | The child correctly ignored the fake `USD 999 paid` instruction and reported USD 220 pending. Parent citation/finalization failed and exhausted its budget. |
| Quote revisions | Failed | The child correctly identified revision 2 at USD 245, superseded USD 220, parts increasing from USD 40 to USD 65, and approval pending. Parent review could not finish within its runtime/budget limits. |

The result is **1 of 6 root goals completed end to end**. Four child investigations showed useful reasoning, but parent completion was unreliable. Aval is suitable for continued controlled testing, not unattended property operations.

## Audit findings that remain open

These source changes do not fix the earlier audit's five reproduced defect groups:

1. Caller-controlled authentication headers can cross the intended workspace boundary in the fallback path.
2. Invalid work-order state transitions are accepted.
3. Some inbound messages and attachments are not fully accounted for.
4. Conversation retrieval can omit the most recent context.
5. A webhook can be acknowledged without a durable, actionable replay obligation after processing failure.

Additional agent issues found live also remain:

- reviewer output is not reliably schema-conformant;
- parent and child token allocation leaves too little room for final review and delivery;
- hyphenated time ranges can be parsed as negative numeric claims;
- parent tasks sometimes replan or retry after a child has already produced a good answer;
- the UI retains diagnostic attempts but does not clearly group parent and child runs for a nontechnical operator.

## Recommended next work

1. Secure the authentication and workspace boundary before using customer data.
2. Fix time/date numeric parsing and add regression cases for ranges, dates, IDs, and phone numbers.
3. Make reviewer output structurally reliable, preferably through provider-supported strict structured output plus deterministic normalization and validation.
4. Reserve separate budgets for actor work, semantic review, and root synthesis; avoid paying repeatedly for identical evidence.
5. Promote a valid completed child result into parent synthesis without unnecessary replanning.
6. Fix webhook recovery, message/attachment ingestion, recent-context retrieval, and work-order state transitions.
7. Repeat the six cases, then test one supervised maintenance workflow with approved pilot accounts.

## Security and repository notes

- No API key, encryption key, session secret, local D1 database, or model transcript containing credentials is included in this branch.
- The Anthropic key remains in Aval's encrypted local integration storage.
- No production deployment, external message, booking, dispatch, approval, or payment was performed.
- The macOS DMG was not rebuilt because this work was performed on Windows. Production signing and notarization settings were not changed.
