// Reproductions from the 2026-11-11 review (HEAD fdc5a27, where they showed the bugs), kept as
// regression checks: the assertions require the safe behavior. Fake funds, local HTTP only.
// Run: npx tsx audit-mcp-replay.ts
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startApp } from './test/helpers/app-fixture.js';
import { startMockRpc } from './test/helpers/mock-rpc.js';
import { FakeFacilitator } from './test/helpers/fake-facilitator.js';
import { SOLANA_DEVNET } from './src/config.js';
const pub = await startMockRpc(()=>({result:7,delayMs:150}));
const gw = await startApp({PUBLIC_UPSTREAMS:pub.url, TOPUP_OPTIONS_USD:'0.00002,1',WALLET_RPS:'1000', REMOTE_MCP_SESSIONS_PER_MINUTE:'1000'},new FakeFacilitator(SOLANA_DEVNET));
const client = new Client({name:'review',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(gw.url+'/mcp')));
const call=()=>client.callTool({name:'solana_rpc_economy',arguments:{method:'getSlot'}});
try {
 const wallet='review-voucher'; gw.odometer.deps.ledger.adjust(wallet,1000000,'existing balance');
 const challenge=await call();const pr=challenge.structuredContent as any;
 const paid=await client.callTool({name:'solana_rpc_economy',arguments:{method:'getSlot'},_meta:{'x402/payment':{x402Version:2,accepted:pr.accepts[0],resource:pr.resource,payload:{transaction:'fake:'+wallet+':1'}}}});
 assert.equal(paid.isError,false);
 const before=gw.odometer.deps.ledger.available(wallet);
 const results=await Promise.all([call(),call(),call(),call()]);
 const after=gw.odometer.deps.ledger.available(wallet);
 console.log('MCP_VOUCHER',JSON.stringify({initialWallet:1000000,topup:20,firstCharge:10,voucherRemaining:10,concurrentSuccesses:results.filter(r=>!r.isError).length,debit:before-after,remainingWallet:after}));
 assert.equal(results.filter(r=>!r.isError).length,1,'only the one call the session paid for succeeds');
 assert.equal(before-after,10);
 assert.equal(after,1000000,'older wallet funds are untouched');
 console.log('FIXED: four parallel MCP calls on a 10-micro allowance: one succeeds, older wallet funds are untouched.');
 // An HTTP idempotency receipt must replay with empty balance.
 const w='review-replay';gw.odometer.deps.ledger.adjust(w,10,'one call');
 const token=gw.odometer.deps.sessions.issue(w).token;
 const opts={method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'empty-balance-replay'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSlot'})};
 const first=await fetch(gw.url+'/v1/rpc/economy',opts);await first.text();
 const second=await fetch(gw.url+'/v1/rpc/economy',opts);
 const replayBody=await second.json();
 console.log('HTTP_REPLAY',JSON.stringify({firstStatus:first.status,secondStatus:second.status,replay:second.headers.get('x-odometer-idempotent-replay'),balance:gw.odometer.deps.ledger.available(w),body:replayBody}));
 assert.equal(second.status,200);
 assert.equal(second.headers.get('x-odometer-idempotent-replay'),'true');
 assert.equal(gw.odometer.deps.ledger.available(w),0);
 console.log('FIXED: a paid response replays with an empty balance instead of asking for a top-up.');
} finally {await client.close();await gw.close();await pub.close();}
