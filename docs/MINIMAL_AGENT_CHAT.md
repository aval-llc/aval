# Minimal Ask Aval

The default composer starts durable work through the existing task runtime. Ask
Aval is the orchestrator; the searchable employee menu sends `employeeId` to the
same task API. The policy menu uses saved user policy or the employee PATCH API;
it never changes permissions in frontend state alone. Quick answers remain in
the plus menu, including the existing desktop ChatGPT path. Document drafting
and current-page context remain available there too.

## Migration map

| Previous surface | Replacement | Runtime source |
| --- | --- | --- |
| Black chat button | 64px Thinking Orb | Canonical visual selector |
| Window/drawer chrome | Inline conversation with expand/popout | Existing window hook |
| Persona picker | Searchable employee directory | Employees API |
| Chat/task pill | Durable work default; quick answer in plus menu | Existing task/ask APIs |
| Settings disclosure | Composer autonomy selector | Saved policy mutations |
| Expanded progress cards | Activity rail; collapsed terminal summary | Persisted task trace |
| Component-only history | Private persisted chat entries | User/workspace RLS |
| No voice input | User-initiated capture and editable transcript | Workspace OpenAI transcription |

Apply `20260920000300_assistant_chat_entries.sql` before deploying the UI. History
is append-only through the API. Task creation locks the saved user message and
atomically saves the task link, making a repeated request return the same task.
Workers do not receive access to private chat history. Closing the UI keeps
task observers mounted and does not send cancellation requests.

Counts include successful read/mutating calls only, using server registry
metadata. Successful approved execution is recorded by the existing runtime as
`approval_decided` with policy `allow`; merely requesting approval does not count
as an executed action. Replayed trace IDs are deduplicated and repeated adjacent
rows coalesce. Chat never receives the runtime's private model transcript.

The visual packages are thinking-orbs 0.3.1, border-beam 1.3.0,
liquid-gooey 0.2.1 and voice-glow 0.2.0. Installed typings take precedence over
older examples (ThinkingOrb now takes `theme`, not `dark`). Decorative layers
are separate from the real composer so their clipping cannot hide the plus menu.
Reduced motion pauses effects; the orb library observes visibility. Error
boundaries preserve the functional controls if decoration fails.

## Voice

Audio stays in memory, is capped at 60 seconds / 8 MB, and is released on stop,
hide, cancellation, device loss and unmount. The transcript remains editable and
uses the same send path. The authenticated transcription route uses only the
workspace's connected OpenAI API credential, never subscription credentials.
It validates origin, rate limits and file size/type, and does not store audio.
The desktop prompts before granting audio-only capture to its trusted origin;
camera and other permissions remain denied. Production signing and notarization
requirements remain enabled.

## Verification

`scripts/check-minimal-chat.mjs` bundles the actual chat component and checks it
in Chromium with controlled APIs and microphone input. Set
`AVAL_PLAYWRIGHT_MODULE` to a Playwright module path when it is not installed in
this repository. It writes screenshots to an isolated temporary directory.
These tests prove UI behavior, not live provider access. PostgreSQL tests cover
history tenancy, append-only writes, atomic task linking, retry idempotency,
actual employee ownership and invalid voice uploads. Existing policy and
approval suites remain authoritative for execution boundaries.

Physical microphone/device switching, Safari, desktop sleep/resume, and a live
transcription-provider round trip still require an authenticated manual pass.
The local-server DMG is ad-hoc signed and not notarized. A local build using the
native PostgreSQL fallback does not supply a Supabase Auth service; use a
configured Supabase stack for authenticated use.
