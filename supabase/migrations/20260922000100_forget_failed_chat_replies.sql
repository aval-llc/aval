-- Failed assistant replies were never a record worth keeping.
--
-- `assistant_chat_entries` is append only: a stored entry is never rewritten
-- by a later request, which is what stops a client revising the record of what
-- happened. Writing a failed attempt into it was therefore a mistake rather
-- than a detail — the row could never be replaced by the answer a retry
-- produced, so every attempt survived, and reloading the page brought back a
-- column of "couldn't finish" orbs beside one question.
--
-- The application no longer files them. This removes the ones already written.
--
-- The rule is narrow on purpose. An entry carrying `error` is a turn that
-- produced nothing; a successful answer never has that field. So questions,
-- answers and task links are untouched, and nothing is deleted on a guess
-- about what it was.
DO $$
DECLARE forgotten bigint;
BEGIN
  DELETE FROM public.assistant_chat_entries
  WHERE payload ->> 'error' IS NOT NULL
    AND payload ->> 'role' = 'assistant';
  GET DIAGNOSTICS forgotten = ROW_COUNT;
  RAISE NOTICE 'forgot % failed assistant replies', forgotten;
END $$;
