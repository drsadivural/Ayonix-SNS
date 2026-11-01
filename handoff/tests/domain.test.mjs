import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog, customQuote, standardPlan, reserveQuota, settleReservation, transition, validateSchedule, validateTargets} from '../reference/domain.mjs';

test('fixed plans match the requested price/capacity mapping', () => {
  for (const [name, price, posts, products] of [['basic',4900,20,1],['standard',9900,60,3],['premium',19900,120,10]]) {
    const plan=standardPlan(name); assert.equal(plan.priceCents,price); assert.equal(plan.posts,posts); assert.equal(plan.products,products);
  }
  assert.equal(standardPlan('standard').autoLearn,true); assert.equal(standardPlan('premium').similarResearch,true);
  assert.throws(()=>standardPlan('__proto__'));
});
test('all 240 valid custom selections are bounded, monotonic and deterministic', () => {
  let count=0;
  for(const posts of Object.keys(catalog.custom.postTiers).map(Number)) for(const products of Object.keys(catalog.custom.productTiers).map(Number)) for(let bits=0;bits<8;bits++) {
    const q=customQuote({posts,products,autoLearn:!!(bits&1),competitorCheck:!!(bits&2),similarResearch:!!(bits&4)});
    assert.ok(q.priceCents>=4900 && q.priceCents<=100000);
    assert.equal(q.configurationHash,customQuote(q.selection).configurationHash);
    assert.equal(q.configurationHash.length,64);
    if(!q.selection.autoLearn) assert.equal(customQuote({...q.selection,autoLearn:true}).priceCents-q.priceCents,9900);
    count++;
  }
  assert.equal(count,240);
});
test('custom minimum, exact maximum and documented example', () => {
  assert.equal(customQuote().priceCents,4900);
  assert.equal(customQuote({posts:1000,products:50,autoLearn:true,competitorCheck:true,similarResearch:true}).priceCents,100000);
  assert.equal(customQuote({posts:120,products:10,autoLearn:true}).priceCents,27800);
});
test('reject browser price tampering and ambiguous checkbox inputs',()=>{
  for(const x of [{priceCents:1},{posts:'120'},{posts:121},{products:51},{autoLearn:'false'},{competitorCheck:1},{similarResearch:null},{posts:NaN},null,[]]) assert.throws(()=>customQuote(x));
});
test('quote hash unaffected by input field ordering',()=>{
  assert.equal(customQuote({posts:60,autoLearn:true}).configurationHash,customQuote({autoLearn:true,posts:60}).configurationHash);
});
test('atomic-service reference reserves entire multi-target cost or rejects',()=>{
  const q={allowance:20,used:15,reserved:3}; assert.deepEqual(reserveQuota(q,2),{allowance:20,used:15,reserved:5});
  assert.throws(()=>reserveQuota(q,3)); assert.deepEqual(q,{allowance:20,used:15,reserved:3});
});
test('bad quota counters and target counts rejected',()=>{
  for(const count of [0,-1,1.1,'1',NaN]) assert.throws(()=>reserveQuota({allowance:20,used:0,reserved:0},count));
  assert.throws(()=>reserveQuota({allowance:20,used:20,reserved:1},1));
});
test('published commits one reservation; definite failures release; unknown retains',()=>{
  const q={allowance:20,used:2,reserved:3};
  assert.deepEqual(settleReservation(q,'published'),{allowance:20,used:3,reserved:2});
  assert.deepEqual(settleReservation(q,'definite_failure'),{allowance:20,used:2,reserved:2});
  assert.deepEqual(settleReservation(q,'unknown'),q);
  assert.throws(()=>settleReservation({...q,reserved:0},'published'));
});
test('terminal and unknown publication states cannot be blindly replayed',()=>{
  assert.equal(transition('submitting','outcome_unknown'),'outcome_unknown');
  assert.throws(()=>transition('outcome_unknown','queued'));
  assert.throws(()=>transition('outcome_unknown','canceled'));
  assert.throws(()=>transition('published','queued'));
  assert.throws(()=>transition('draft','published'));
  assert.equal(transition('outcome_unknown','published'),'published');
});
test('explicit future UTC and valid zone accepted',()=>{
  assert.equal(validateSchedule({utc:'2026-11-02T22:00:00Z',timezone:'Australia/Melbourne'},new Date('2026-10-30T00:00:00Z')).utc,'2026-11-02T22:00:00.000Z');
});
test('past, normalized invalid calendar, offset-free and unknown-zone inputs fail',()=>{
  const now=new Date('2026-10-30T00:00:00Z');
  for(const utc of ['2026-01-01T00:00:00Z','2027-02-30T10:00:00Z','2026-11-03T09:00:00','bad']) assert.throws(()=>validateSchedule({utc,timezone:'Australia/Melbourne'},now));
  assert.throws(()=>validateSchedule({utc:'2026-11-03T09:00:00Z',timezone:'fake/zone'},now));
});
test('count destination posts, reject duplicate destinations and invalid formats',()=>{
  const one={platform:'linkedin',connectionId:'owned-account',format:'text',hasMedia:false};
  assert.equal(validateTargets([one,{...one,platform:'facebook'}]),2);
  assert.throws(()=>validateTargets([one,one]));
  assert.throws(()=>validateTargets([{...one,platform:'youtube'}]));
  assert.throws(()=>validateTargets([{...one,platform:'instagram',format:'image'}]));
  assert.throws(()=>validateTargets([]));
});
