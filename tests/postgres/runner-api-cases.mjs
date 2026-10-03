import assert from 'node:assert/strict';
import { POST } from '../../app/api/pms/runner/route.ts';

/**
 * The renderer-controlled v1 protocol is intentionally retired, not silently
 * upgraded. Its execution/lease/recovery coverage now lives in the v2 API +
 * main-process tests in pms-browser-protocol.integration.mjs. Generic provider
 * simulator behavior remains covered by browser-write-cases and unit tests.
 */
export async function runRunnerApiCases(t) {
  for(const intent of ['claim','report','heartbeat','execute']) {
    await t.test(`legacy ${intent} cannot bypass the privileged Desktop protocol`,async()=>{
      const response=await POST(new Request('https://app.aval.llc/api/pms/runner',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({intent,runner:'old-desktop',protocol:2}),
      }));
      assert.equal(response.status,426);
      assert.match((await response.json()).error,/update|Update/);
    });
  }
}
