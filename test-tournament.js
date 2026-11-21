// Checks the tournament engine (pairings, byes, standings). Run from the repository root:  node test-tournament.js
const C=require('./tournament-core.js');
const assert=require('assert');
function mk(n,rules={}){return {rules:{pairing:'swiss',avoidClub:true,win:3,draw:1,loss:0,tiebreakers:['sos','vpDiff','vp'],...rules},players:Array.from({length:n},(_,i)=>({pid:'p'+i})),rounds:[]};}
const club=id=>'c'+(+id.slice(1)%4);
function play(t,rounds,seed){const rng=C.makeRng(seed);
 for(let r=1;r<=rounds;r++){const tables=C.drawRound(t,club,seed+r);assert(C.drawIsComplete(t,tables),'complete');
  tables.forEach(g=>{if(g.b!==null){g.vpA=Math.floor(rng()*7);g.vpB=Math.floor(rng()*7);g.result=C.resultFromVp(g);}});
  t.rounds.push({n:r,done:true,tables});}}
let rematches=0,secondByes=0,clubClashes=0;
for(const n of [8,16,15,7,32,31]){for(let s=1;s<=20;s++){const t=mk(n);play(t,n>=16?5:Math.min(4,n-1),s*17);
  const seen=new Set(),byeSeen=new Set();
  for(const r of t.rounds)for(const g of r.tables){if(g.b===null){if(byeSeen.has(g.a))secondByes++;byeSeen.add(g.a);continue}
    const k=[g.a,g.b].sort().join('|');if(seen.has(k))rematches++;seen.add(k);if(club(g.a)===club(g.b))clubClashes++;}
  const st=C.standings(t);assert.strictEqual(st.length,n);
  for(let i=1;i<st.length;i++)assert(st[i-1].points>=st[i].points,'sorted');
  assert.strictEqual(st.reduce((a,x)=>a+x.w,0)+0,st.reduce((a,x)=>a+x.l,0)+st.reduce((a,x)=>a+x.byes,0),'wins=losses+byes');
 }}
console.log({rematches,secondByes,clubClashes});
// scoring example
const t=mk(4);t.rounds.push({n:1,done:true,tables:[{a:'p0',b:'p1',result:'a',vpA:5,vpB:2,bonusA:1,bonusB:0},{a:'p2',b:'p3',result:'draw',vpA:3,vpB:3,bonusA:0,bonusB:0}]});
const s=C.standings(t);console.log(s.map(x=>[x.pid,x.rank,x.points,x.vpDiff,x.sos]));
assert.strictEqual(s[0].pid,'p0');assert.strictEqual(s[0].points,4);
// ties share rank
assert.strictEqual(s.find(x=>x.pid==='p2').rank,s.find(x=>x.pid==='p3').rank);
// dropped players are not drawn
const t2=mk(5);t2.players[0].dropped=true;const dr=C.drawRound(t2,club,1);assert(!dr.some(g=>g.a==='p0'||g.b==='p0'));assert(C.drawIsComplete(t2,dr));
// club avoidance when possible
const t3=mk(8);const d3=C.drawRound(t3,club,3);console.log('club clash r1',d3.filter(g=>g.b&&club(g.a)===club(g.b)).length);
// everyone in same club: still pairs
const t4=mk(6);console.log('same club still pairs',C.drawIsComplete(t4,C.drawRound(t4,()=>'x',1)));
// 2 players, 3 rounds forced rematch is allowed with warning
const t5=mk(2);play(t5,1,1);const d5=C.drawRound(t5,club,2);console.log('rematch draw',C.roundWarnings(t5,d5,club));
// ---- marginal / major victories and units destroyed
{
  const t = mk(5, { margins: { enabled: true, band: 2, marginalWin: 2, majorWin: 4 }, tiebreakers: ['destroyed', 'vpDiff'] });
  t.rounds.push({ n: 1, done: true, tables: [
    { a: 'p0', b: 'p1', result: 'a', vpA: 5, vpB: 3, killedByA: [0, 2], killedByB: [1] },   // a win by 2: marginal
    { a: 'p2', b: 'p3', result: 'b', vpA: 1, vpB: 6, killedByA: [], killedByB: [0, 1] },    // a win by 5: major
    { a: 'p4', b: null },                                                                    // bye
  ] });
  assert.strictEqual(C.winTier(t.rounds[0].tables[0], t.rules), 'marginal');
  assert.strictEqual(C.winTier(t.rounds[0].tables[1], t.rules), 'major');
  assert.strictEqual(C.winTier({ a: 'x', b: 'y', result: 'draw', vpA: 3, vpB: 3 }, t.rules), null);
  assert.strictEqual(C.winTier({ a: 'x', b: 'y', result: 'a', vpA: 4, vpB: 2 }, { margins: { enabled: false } }), null);
  const pts = { p0: [3, 4, 5], p1: [6, 7, 8], p2: [2, 2], p3: [9, 1] };   // points of each row of a player's list
  const s = C.standings(t, { rowPoints: pid => pts[pid] ?? [] });
  const get = id => s.find(x => x.pid === id);
  assert.strictEqual(get('p0').points, 2); assert.strictEqual(get('p1').points, 0);
  assert.strictEqual(get('p3').points, 4); assert.strictEqual(get('p4').points, 4);      // major win and a bye are both worth the major score
  assert.strictEqual(get('p3').majors, 1); assert.strictEqual(get('p0').majors, 0);
  assert.strictEqual(get('p0').destroyed, 6 + 8); assert.strictEqual(get('p0').lost, 4);    // killed p1's rows 0 and 2; lost p0's own row 1
  assert.strictEqual(get('p3').destroyed, 2 + 2);                                             // p3 destroyed p2's two rows
  // equal points are separated by the tie-breaker "destroyed": p3 (4 pts destroyed) and p4 (bye, 0) both have 4 points
  assert.strictEqual(s.findIndex(x => x.pid === 'p3') < s.findIndex(x => x.pid === 'p4'), true);
  // without margins a win is the plain win score
  const plain = mk(2); plain.rounds.push({ n: 1, done: true, tables: [{ a: 'p0', b: 'p1', result: 'a', vpA: 9, vpB: 0 }] });
  assert.strictEqual(C.standings(plain).find(x => x.pid === 'p0').points, 3);
}

// deciding a game: wipe-out, then victory points, then points on the table, then a draw
{
  // p0 has units at rows 0,1,2 worth 30/20/10 (+ 10 of NCUs, so 70 total, 60 on the table); p1 the same
  const opts = { rowPoints: () => [30, 20, 10], unitRows: () => [0, 1, 2], tableStart: () => 60 };
  const g = (x) => ({ a: 'p0', b: 'p1', vpA: null, vpB: null, killedByA: [], killedByB: [], ...x });
  const d = x => C.decideResult(g(x), opts);
  assert.deepStrictEqual(d({}), { result: null, basis: null });
  assert.deepStrictEqual(d({ vpA: 5, vpB: 3 }), { result: 'a', basis: 'vp' });
  assert.deepStrictEqual(d({ vpA: 3, vpB: 3 }), { result: 'draw', basis: 'tied' });
  assert.deepStrictEqual(d({ vpA: 3, vpB: 3, killedByA: [0] }), { result: 'a', basis: 'table' });   // B has 30 left, A has 60
  assert.deepStrictEqual(d({ vpA: 3, vpB: 3, killedByA: [0], killedByB: [0] }), { result: 'draw', basis: 'tied' });
  assert.deepStrictEqual(d({ vpA: 0, vpB: 9, killedByB: [0, 1, 2] }), { result: 'b', basis: 'wipeout' });   // wipe-out beats VP
  assert.deepStrictEqual(d({ killedByA: [0, 1, 2] }), { result: 'a', basis: 'wipeout' });                    // no VP needed
  assert.strictEqual(d({ killedByA: [0, 1, 2], killedByB: [0, 1, 2] }).result, 'draw');                      // both wiped out
  assert.strictEqual(C.wipedOut(g({ killedByA: [0, 1] }), 'b', opts), false);
  // a wipe-out is a major win even when the VP gap is small
  const rules = { win: 3, draw: 1, loss: 0, tiebreakers: [], margins: { enabled: true, band: 2, marginalWin: 2, majorWin: 3 } };
  assert.strictEqual(C.winTier({ ...g({ vpA: 4, vpB: 4, killedByA: [0, 1, 2] }), result: 'a' }, rules, opts), 'major');
  assert.strictEqual(C.winTier({ ...g({ vpA: 5, vpB: 4 }), result: 'a' }, rules, opts), 'marginal');
}
console.log('Tournament engine OK');
