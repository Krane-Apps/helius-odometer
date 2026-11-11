// Reproductions from the 2026-11-11 review (HEAD fdc5a27, where they showed the bugs), kept as
// regression checks: the assertions require the safe behavior. Fake funds, local HTTP only.
// Run: npx tsx audit-rest-cap.ts
import assert from 'node:assert/strict';
import { startApp } from './test/helpers/app-fixture.js';
import { startMockRpc } from './test/helpers/mock-rpc.js';
import { FakeFacilitator } from './test/helpers/fake-facilitator.js';
import { SOLANA_DEVNET } from './src/config.js';
const upstream=await startMockRpc((method)=>method==='getLatestBlockhash'?{result:{value:{blockhash:'11111111111111111111111111111111',lastValidBlockHeight:1}}}:{status:401,raw:'{"error":"Invalid API key"}'});
const gw=await startApp({PUBLIC_UPSTREAMS:upstream.url,HELIUS_RPC_URL:upstream.url,HELIUS_API_BASE:upstream.url,HELIUS_API_KEY:'fake-test-key'},new FakeFacilitator(SOLANA_DEVNET));
try {
 const w='rest-review';gw.odometer.deps.ledger.adjust(w,10000,'mock balance');const token=gw.odometer.deps.sessions.issue(w).token;
 const response=await fetch(gw.url+'/v1/helius/v0/transactions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({transactions:['fake-signature']})});
 const restBody=await response.json();
 console.log('REST_AUTH_FAILURE',JSON.stringify({status:response.status,chargedMicros:response.headers.get('x-odometer-charged'),balance:gw.odometer.deps.ledger.available(w),body:restBody}));
 assert.equal(response.status,502);
 assert.equal(response.headers.get('x-odometer-charged'),'0');
 assert.equal(gw.odometer.deps.ledger.available(w),10000);
 assert.equal(restBody.error,'upstream_auth_failed');
 console.log('FIXED: a Helius 401 about the operator key is not charged to the customer.');
 const capwallet='cap-review';gw.odometer.deps.ledger.setDailyCap(capwallet,0);const captoken=gw.odometer.deps.sessions.issue(capwallet).token;
 const blocked=await fetch(gw.url+'/v1/rpc/economy',{method:'POST',headers:{authorization:'Bearer '+captoken,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSlot'})});
 const capBody=await blocked.json();
 console.log('CAP_ZERO_UNFUNDED',JSON.stringify({status:blocked.status,body:capBody}));
 assert.equal(blocked.status,429);
 assert.equal(blocked.headers.get('payment-required'),null);
 assert.equal(capBody.error,'daily_cap_exceeded');
 assert.equal(capBody.accepts,undefined);
 console.log('FIXED: a wallet with spending stopped is refused without being asked to deposit.');
} finally {await gw.close();await upstream.close();}
