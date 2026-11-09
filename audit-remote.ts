// Offline authenticated-wallet/session audit, first run against commit c244b53 (where it
// CONFIRMED the bug) and kept as a regression check: revocation must stop a remote MCP
// session from spending. Mock funds and local HTTP only. Run: npx tsx audit-remote.ts
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startApp} from './test/helpers/app-fixture.js';
import {startMockRpc} from './test/helpers/mock-rpc.js';
import {FakeFacilitator} from './test/helpers/fake-facilitator.js';
import {SOLANA_DEVNET} from './src/config.js';
const rpc=await startMockRpc(()=>({result:100}));
const gw=await startApp({PUBLIC_UPSTREAMS:rpc.url},new FakeFacilitator(SOLANA_DEVNET));
const c=new Client({name:'offline-review',version:'1'});
await c.connect(new StreamableHTTPClientTransport(new URL(gw.url+'/mcp')));
try {
 const first=await c.callTool({name:'solana_rpc_economy',arguments:{method:'getSlot'}});
 const pr=first.structuredContent as any;
 const payload={x402Version:2,accepted:pr.accepts[0],payload:{transaction:'fake:reviewwallet:nonce1'},resource:pr.resource};
 const paid=await c.callTool({name:'solana_rpc_economy',arguments:{method:'getSlot'},_meta:{'x402/payment':payload}});
 assert.equal(paid.isError,false);
 const ledger=gw.odometer.deps.ledger;
 const before=ledger.available('reviewwallet');
 ledger.bumpSessionEpoch('reviewwallet');
 const after=await c.callTool({name:'solana_rpc_economy',arguments:{method:'getSlot'}});
 assert.equal(after.isError,true);
 assert.ok(Array.isArray((after.structuredContent as any)?.accepts),'a revoked session is asked to pay again');
 assert.equal(ledger.available('reviewwallet'),before);
 console.log('FIXED: after the wallet session epoch is revoked, remote MCP refuses to spend and asks for a new payment.');
} finally {await c.close();await gw.close();await rpc.close();}
