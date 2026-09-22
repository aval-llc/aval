import test from 'node:test';
import assert from 'node:assert/strict';
import { STORABLE_TURN_ID, joinEarlierTurns, replyTurnId, runTurnId } from '../lib/ask-aval/chat-turn.ts';

test('every id the chat mints is one the history store will accept', () => {
  const turn = '0f8fad5b-d9cb-469f-a165-70867728950e';
  for (const id of [turn, replyTurnId(turn), runTurnId(turn)]) assert.ok(STORABLE_TURN_ID.test(id), id);
  // The rule that caught the real bug: a separator outside the pattern is
  // rejected on save, and a rejected save was displayed as a failed answer.
  assert.ok(!STORABLE_TURN_ID.test(`${turn}:reply`));
});

test('restoring an earlier conversation puts it above the live turns and keeps the live copy', () => {
  const live = [{ id: 'b', text: 'streaming' }, { id: 'c', text: 'asked just now' }];
  const earlier = [{ id: 'a', text: 'yesterday' }, { id: 'b', text: 'stored' }];
  assert.deepEqual(joinEarlierTurns(earlier, live), [
    { id: 'a', text: 'yesterday' },
    { id: 'b', text: 'streaming' },
    { id: 'c', text: 'asked just now' },
  ]);
  assert.deepEqual(joinEarlierTurns([], live), live);
});
