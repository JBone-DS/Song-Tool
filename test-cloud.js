// Checks the cloud mapping and the upload logic against a small fake database. Run from the repository root:  node test-cloud.js
const assert = require("assert");
const K = require("./cloud-core.js");
Object.assign(globalThis, K);
const mem = {};
globalThis.window = { SONG_CLOUD: { url: "x", key: "y" } };
globalThis.storeGet = (k, f) => (k in mem ? mem[k] : f);
globalThis.storeSet = (k, v) => { mem[k] = v; return true; };
const { cloud } = require("./cloud.js");

// ---- a fake of the few Supabase calls cloud.js makes ----
const tables = { profiles: [], tournaments: [], tournament_players: [], rounds: [], games: [] };
const keys = { profiles: ["id"], tournaments: ["id"], tournament_players: ["tournament_id", "profile_id"], rounds: ["tournament_id", "n"], games: ["round_id", "table_no"] };
const calls = [];
function from(name) {
  const rows = tables[name]; let filters = [], op = null, payload = null, opts = {}, wantOne = false;
  const q = {
    select() { return q; }, single() { wantOne = true; return q; }, order() { return q; }, range() { return q; },
    upsert(p, o) { op = "upsert"; payload = [].concat(p); opts = o; return q; },
    delete() { op = "delete"; return q; },
    eq(c, v) { filters.push(r => r[c] === v); return q; },
    in(c, v) { filters.push(r => v.includes(r[c])); return q; },
    not(c, _o, v) { const set = v.slice(1, -1).split(","); filters.push(r => !set.includes(String(r[c]))); return q; },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
  };
  function run() {
    if (op === "upsert") {
      calls.push(`upsert ${name} ${payload.length}`);
      let last;
      for (const p of payload) {
        const ks = opts.onConflict.split(",");
        let row = rows.find(r => ks.every(k => r[k] === p[k]));
        if (row) Object.assign(row, p); else rows.push(row = { id: p.id ?? K.newId(), ...p });
        last = row;
      }
      return { data: wantOne ? { id: last.id } : null, error: null };
    }
    if (op === "delete") {
      calls.push(`delete ${name}`);
      const del = rows.filter(r => filters.every(f => f(r)));
      del.forEach(d => rows.splice(rows.indexOf(d), 1));
      if (name === "tournaments") for (const t of ["tournament_players", "rounds", "games"]) tables[t] = tables[t].filter(r => rows.some(x => x.id === r.tournament_id));
      return { error: null };
    }
    return { data: rows.filter(r => filters.every(f => f(r))), error: null };
  }
  return q;
}
cloud.client = { from };
cloud.user = { id: "u1" };

(async () => {
  const P = n => ({ id: K.newId(), name: n, club: "", country: "", faction: "" });
  const a = P("A"), b = P("B"), c = P("C");
  const t = {
    id: K.newId(), name: "T", date: "2026-11-21", location: "", points: 40, plannedRounds: 3, status: "running", rules: { win: 3, margins: { enabled: true } },
    players: [a, b, c].map(p => ({ pid: p.id, listCode: "abc", locked: true, dropped: false })),
    rounds: [{ n: 1, done: false, tables: [
      { id: 1, a: a.id, b: b.id, result: "a", manual: false, vpA: 5, vpB: 3, bonusA: 0, bonusB: 0, killedByA: [0, 2], killedByB: [] },
      { id: 2, a: c.id, b: null, result: "a", vpA: null, vpB: null, bonusA: 0, bonusB: 0 }] }],
  };
  const db = { version: 1, profiles: [a, b, c], tournaments: [t] };

  // first upload sends everything, and what comes back is identical
  await cloud._push(db);
  assert.strictEqual(tables.games.length, 2);
  const back = await (async () => { cloud.user = { id: "u1" }; return { version: 1, ...(await cloud._tournamentsFrom(tables.tournaments, tables.profiles)) }; })();
  const norm = x => JSON.parse(JSON.stringify(x, (k, v) => (v === undefined ? null : v)));
  const want = norm(db); want.tournaments[0].isPublic = true;
  want.tournaments[0].rounds[0].tables.forEach(g => { g.manual = !!g.manual; g.killedByA ??= []; g.killedByB ??= []; });
  assert.deepStrictEqual(norm(back).tournaments[0].rounds, want.tournaments[0].rounds);
  assert.deepStrictEqual(norm(back).tournaments[0].players, want.tournaments[0].players);
  assert.strictEqual(back.profiles.length, 3);

  // nothing changed: nothing sent
  calls.length = 0; await cloud._push(db); assert.deepStrictEqual(calls, []);

  // one result changed: only that round goes
  t.rounds[0].tables[0].vpA = 9; calls.length = 0; await cloud._push(db);
  assert.deepStrictEqual(calls, ["upsert rounds 1", "upsert games 2", "delete games"]);   // the delete prunes games no longer in the round
  assert.strictEqual(tables.games.find(g => g.table_no === 1).vp_a, 9);

  // a redrawn round with fewer tables removes the extra game
  t.rounds[0].tables = [t.rounds[0].tables[0]]; await cloud._push(db);
  assert.strictEqual(tables.games.length, 1);

  // a player removed, a round added
  t.players = t.players.slice(0, 2); t.rounds.push({ n: 2, done: false, tables: [{ id: 1, a: b.id, b: a.id, result: null }] });
  await cloud._push(db);
  assert.strictEqual(tables.tournament_players.length, 2); assert.strictEqual(tables.rounds.length, 2);

  // deleting a tournament and then its profile
  db.tournaments = []; db.profiles = db.profiles.filter(p => p.id !== c.id); await cloud._push(db);
  assert.strictEqual(tables.tournaments.length, 0); assert.strictEqual(tables.games.length, 0); assert.strictEqual(tables.profiles.length, 2);

  // a failed upload leaves `synced` alone, so the retry sends the same changes
  const t2 = { ...t, id: K.newId(), players: [], rounds: [] };
  db.tournaments = [t2];
  const real = cloud.client; cloud.client = { from: () => { throw new Error("offline"); } };
  await assert.rejects(() => cloud._push(db)); cloud.client = real;
  calls.length = 0; await cloud._push(db); assert.strictEqual(calls[0], "upsert tournaments 1");

  // old browser data gets proper uuids and keeps its links
  const old = { version: 1, profiles: [{ id: "abc12345", name: "X" }, { id: "def67890", name: "Y" }], tournaments: [{ id: "tt111111", players: [{ pid: "abc12345" }, { pid: "def67890" }],
    rounds: [{ n: 1, tables: [{ id: 1, a: "abc12345", b: "def67890" }, { id: 2, a: "abc12345", b: null }] }] }] };
  const fixed = K.withUuids(old);
  assert(K.isUuid(fixed.tournaments[0].id) && fixed.profiles.every(p => K.isUuid(p.id)));
  assert.strictEqual(fixed.tournaments[0].rounds[0].tables[0].a, fixed.profiles[0].id);
  assert.strictEqual(fixed.tournaments[0].rounds[0].tables[1].b, null);
  assert.strictEqual(fixed.tournaments[0].players[1].pid, fixed.profiles[1].id);
  console.log("Cloud sync OK");
})().catch(e => { console.error(e); process.exit(1); });
