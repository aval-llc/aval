import { checkFaithfulness, extractClaimedNumbers } from '../ask-aval/faithfulness.ts';
import type { ReviewSource } from './semantic-review';

/**
 * Numeric admission for a durable answer that will ALSO receive semantic review.
 * Document numerals stay out of verified portfolio evidence and action authority.
 * Their attribution, units and meaning must still pass the independent reviewer.
 */
export function checkDocumentAnswerNumbers(answer: unknown, verified: Set<number>, sources: ReviewSource[]) {
  const documents = sources.filter(source => source.tool === 'read_document' && !source.failed
    && source.data && typeof source.data === 'object'
    && typeof (source.data as Record<string, unknown>).text === 'string'
    && !String((source.data as Record<string, unknown>).text).includes('[truncated:'));
  const identifiers = documents.flatMap(source => {
    const id = (source.arguments as Record<string, unknown> | null)?.document_id;
    return typeof id === 'string' && /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|upload_[0-9a-f]{64})$/i.test(id) ? [id] : [];
  });
  const withoutIdentifiers = (value: unknown): unknown => {
    if (typeof value === 'string') return identifiers.reduce((text, id) => text.replaceAll(id, '[document reference]'), value);
    if (Array.isArray(value)) return value.map(withoutIdentifiers);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutIdentifiers(item)]));
    return value;
  };
  const gate = checkFaithfulness(withoutIdentifiers(answer), verified);
  if (gate.ok) return gate;
  const quoted = new Set(documents.flatMap(source => extractClaimedNumbers((source.data as Record<string, unknown>).text)));
  const unsupported = gate.unsupported.filter(number => !quoted.has(number));
  return unsupported.length ? { ok: false as const, unsupported } : { ok: true as const };
}
