// Offline authenticated-wallet/session audit. Mock funds and local HTTP only.
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
 gw.odometer.deps.ledger.bumpSessionEpoch('reviewwallet');
 const after=await c.callTool({name:'solana_rpc_economy',arguments:{method:'getSlot'}});
 assert.equal(after.isError,false);
 console.log('CONFIRMED: remote MCP still spends after wallet session epoch is revoked.');
} finally {await c.close();await gw.close();await rpc.close();}
