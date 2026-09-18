import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { forgetPreference, listPreferenceOptions, listPreferences, setPreferenceFromSetup, PREFERENCE_TOPICS, type PreferenceTopic } from "@/lib/ask-aval/preferences";
import { MIN_CONFIDENCE, TEACHING_SUGGESTIONS, matchPreference } from "@/lib/ask-aval/preference-matching";

/** Suggests only what this workspace hasn't set yet — proposing something already taught is noise. */
function suggestionsFor(taught: { topic: string }[]) {
  const taughtTopics = new Set(taught.map((row) => row.topic));
  return listPreferenceOptions()
    .filter((option) => !taughtTopics.has(option.topic))
    .flatMap((option) => TEACHING_SUGGESTIONS[option.topic].map((text) => ({ topic: option.topic, text })));
}

/**
 * What this workspace has taught Aval. These rows are read back into every
 * future Ask Aval system prompt (getPreferenceContext), so this is the same
 * memory the assistant actually reasons with — not a separate display copy.
 */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);
  const taught = await listPreferences(dbSession, identity.organizationId);
  return Response.json({ taught, options: listPreferenceOptions(), suggestions: suggestionsFor(taught) });
}

/** POST { topic, statement } — teach one fact. Both must come from the fixed taxonomy. */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { topic?: string; statement?: string; text?: string };
  let topic = body.topic;
  let statement = body.statement;

  // A typed instruction is classified into the fixed taxonomy here and the
  // sentence is then discarded — only the resulting tag is ever stored, so
  // free text cannot reach the database no matter what a client posts.
  if (!statement && typeof body.text === "string") {
    const match = matchPreference(body.text);
    if (!match) {
      return Response.json({ error: "no_match", minConfidence: MIN_CONFIDENCE }, { status: 422 });
    }
    topic = match.topic;
    statement = match.statement;
  }

  if (!topic || !statement || !(topic in PREFERENCE_TOPICS)) {
    return Response.json({ error: "Unknown preference" }, { status: 400 });
  }
  await ensureOrganization(dbSession, identity);
  const saved = await setPreferenceFromSetup(dbSession, identity.organizationId, topic as PreferenceTopic, statement);
  if (!saved) return Response.json({ error: "Unknown preference" }, { status: 400 });
  const updated = await listPreferences(dbSession, identity.organizationId);
  return Response.json({ taught: updated, suggestions: suggestionsFor(updated), matched: { topic, statement } });
}

/** DELETE ?topic=… — forget one topic. */
async function DELETEWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const topic = new URL(request.url).searchParams.get("topic");
  if (!topic || !(topic in PREFERENCE_TOPICS)) return Response.json({ error: "Unknown preference" }, { status: 400 });
  await ensureOrganization(dbSession, identity);
  await forgetPreference(dbSession, identity.organizationId, topic);
  const updated = await listPreferences(dbSession, identity.organizationId);
  return Response.json({ taught: updated, suggestions: suggestionsFor(updated) });
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
export const DELETE = withApiSession(DELETEWithSession);
