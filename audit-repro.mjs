// Offline audit reproductions, first run against commit c244b53 (where each one
// CONFIRMED a bug) and kept as regression checks: every assertion now requires the
// safe behavior. No network or funds used. Build first: npm run build && node audit-repro.mjs
import assert from 'node:assert/strict';
import { OdometerClient } from './dist/client/index.js';
import { Ledger } from './dist/ledger/ledger.js';

// 1. Concurrent top-ups must stay within the client's total signing budget.
const c = new OdometerClient({baseUrl:'http://localhost',signer:{address:'11111111111111111111111111111111'},maxSpendUsd:1,maxTopupUsd:1});
c.payer.createPaymentPayload = async () => { await new Promise(r=>setTimeout(r,20)); return {}; };
c.http.encodePaymentSignatureHeader = () => ({});
const pr={accepts:[{scheme:'exact',network:'solana:test',amount:'1000000',asset:'test',payTo:'operator',maxTimeoutSeconds:120}]};
const results = await Promise.allSettled([c.paymentHeaders(pr),c.paymentHeaders(pr)]);
assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
assert.equal(results.find(r=>r.status==='rejected')?.reason?.code,'spend_limit_reached');
assert.equal(c.spentOnTopupsMicros,1000000);
console.log('FIXED: maxSpendUsd=1 signs one $1 top-up; the concurrent second is refused (spend_limit_reached).');

// 2. Reconciliation must not report ok while a top-up's outcome is unknown.
const l=new Ledger({path:':memory:',defaultDailyCap:0,now:()=>1000000});
l.beginTopup({payloadHash:'h',network:'n',asset:'a',amount:1000000});
l.markTopupNeedsReview('h','settlement unknown',{wallet:'w',txSignature:'sig'});
const report = l.reconcile();
assert.equal(report.ok,false);
assert.equal(report.arithmeticOk,true);
assert.deepEqual(report.unresolvedTopups,{count:1,amountMicros:1000000});
assert.equal(report.topupsNeedingReview,1);
console.log('FIXED: reconcile().ok is false while a top-up is unresolved (on-chain custody is checked by GET /admin/readiness).');

// 3. Recovering a payment must credit it once, even if the original completion arrives later.
assert.throws(() => l.adjust('w',1000000,'manual recovery per runbook for sig'), (e) => e.code === 'unresolved_topups');
const topupId = l.unresolvedTopups()[0].id;
l.resolveTopup({topupId,action:'credit',wallet:'w',txSignature:'sig',note:'verified on-chain'});
const late = l.completeTopup({payloadHash:'h',wallet:'w',txSignature:'sig',amount:1000000,network:'n',asset:'a'});
assert.equal(late.credited,false);
assert.equal(l.available('w'),1000000);
console.log('FIXED: a manual credit is refused while the top-up is unresolved; resolving it then a late completion credits $1 for a $1 payment.');
l.close();

// 4. A wallet cap of zero stops spending and never removes the operator's ceiling.
const capLedger = new Ledger({path:':memory:',defaultDailyCap:1000000});
capLedger.adjust('w',10000000,'offline test funding');
assert.equal(capLedger.reserve({wallet:'w',amount:2000000,tier:'fast',methods:['getSlot'],requestId:'before'}).ok,false);
capLedger.setDailyCap('w',0);
const zero = capLedger.reserve({wallet:'w',amount:2000000,tier:'fast',methods:['getSlot'],requestId:'after'});
assert.equal(zero.ok,false);
assert.equal(zero.reason,'daily_cap_exceeded');
assert.equal(capLedger.reserve({wallet:'w',amount:1,tier:'fast',methods:['getSlot'],requestId:'tiny'}).ok,false);
capLedger.setDailyCap('w',null);
assert.equal(capLedger.reserve({wallet:'w',amount:2000000,tier:'fast',methods:['getSlot'],requestId:'removed'}).ok,false);
console.log('FIXED: dailyCap=0 refuses all spending, and removing the wallet cap leaves the operator $1 ceiling in force.');
capLedger.close();
