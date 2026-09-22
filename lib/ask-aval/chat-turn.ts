/**
 * How a chat turn is identified, and how a restored conversation joins the one
 * already on screen.
 *
 * Both halves are here because both are places the component and the store
 * quietly disagreed. The reply id is the sharper example: the panel built it
 * with a colon, `/api/assistant/history` accepts `[A-Za-z0-9-]` only, and so
 * every answer the quick-chat path produced was rejected on save and then
 * shown to the person as a failure. Neither piece was wrong on its own — they
 * simply did not share a definition. Deriving the id and the rule it must
 * satisfy from the same file is what makes that disagreement impossible
 * rather than merely unlikely.
 */

/**
 * What `assistant_chat_entries` accepts as an entry id.
 *
 * Deliberately narrow: an entry id reaches SQL and comes back out to the
 * browser, and a UUID with a suffix needs nothing wider than this.
 */
export const STORABLE_TURN_ID = /^[a-zA-Z0-9-]{1,80}$/;

/**
 * The assistant's one reply to a turn.
 *
 * Derived from the question rather than minted fresh, so a retry replaces the
 * attempt that failed instead of stacking beside it.
 */
export function replyTurnId(turnId: string): string {
  return `${turnId}-reply`;
}

/**
 * The agent task a turn dispatched. `/api/agents/tasks` derives the same id
 * when it commits the link, so the two have to agree.
 */
export function runTurnId(turnId: string): string {
  return `${turnId}-run`;
}

export interface ChatTurn {
  id: string;
}

/**
 * Earlier turns joined to the ones on screen.
 *
 * Restored history is always older than anything this session produced, so it
 * goes above — appending it would have put yesterday's conversation below a
 * question asked a moment ago. A turn that appears in both keeps its stored
 * position and its live object: the stored copy knows where it belongs in the
 * conversation, and the live one carries what only this session has — the
 * steps an answer took, a task card already streaming.
 */
export function joinEarlierTurns<T extends ChatTurn>(earlier: readonly T[], current: readonly T[]): T[] {
  return [...new Map([...earlier, ...current].map(turn => [turn.id, turn])).values()];
}
