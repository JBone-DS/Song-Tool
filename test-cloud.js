// Checks the cloud mapping and the organiser upload logic against a small fake database. Run from the repository root:  node test-cloud.js
// (The database's own security rules are in schema.sql and need a real Postgres to test.)
const assert = require("assert");
const K = require("./cloud-core.js");
Object.assign(globalThis, K);
const mem = {};
globalThis.window = { SONG_CLOUD: { url: "x", key: "y" } };
globalThis.storeGet = (k, f) => (mem[k] ?? f);
globalThis.storeSet = (k, v) => { mem[k] = v; return true; };
const { cloud } = require("./cloud.js");

// ---- a fake of the few Supabase calls cloud.js makes ----
const tables = { profiles: [], tournaments: [], registrations: [], entry_lists: [], tournament_results: [], rounds: [], games: [], game_picks: [], teams: [], matches: [], saved_lists: [], player_games: [], player_ratings: [], rating_ranks: [], rating_history: [] };
const calls = [];
function from(name) {
  const rows = name === "profile_names" ? tables.profiles : tables[name]; let filters = [], op = null, payload = null, opts = {}, wantOne = false;
  const q = {
    select() { return q; }, single() { wantOne = true; return q; }, order() { return q; }, range() { return q; }, limit() { return q; },
    upsert(p, o) { op = "upsert"; payload = [].concat(p); opts = o; return q; },
    insert(p) { op = "insert"; payload = [].concat(p); return q; },
    update(p) { op = "update"; payload = p; return q; },
    delete() { op = "delete"; return q; },
    eq(c, v) { filters.push(r => r[c] === v); return q; },
    in(c, v) { filters.push(r => v.includes(r[c])); return q; },
    not(c, _o, v) { const set = v.slice(1, -1).split(","); filters.push(r => !set.includes(String(r[c]))); return q; },
    then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
  };
  function run() {
    const hit = () => rows.filter(r => filters.every(f => f(r)));
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
    if (op === "insert") { calls.push(`insert ${name}`); payload.forEach(p => rows.push({ id: p.id ?? K.newId(), ...p })); return { error: null }; }
    if (op === "update") { calls.push(`update ${name}`); hit().forEach(r => Object.assign(r, payload)); return { error: null }; }
    if (op === "delete") {
      calls.push(`delete ${name}`);
      hit().forEach(d => rows.splice(rows.indexOf(d), 1));
      if (name === "tournaments") for (const t of ["registrations", "entry_lists", "tournament_results", "rounds", "games"]) tables[t] = tables[t].filter(r => rows.some(x => x.id === r.tournament_id));
      return { error: null };
    }
    return { data: hit(), error: null };
  }
  return q;
}
const uploads = [];
cloud.client = { from, rpc: async name => { calls.push(`rpc ${name}`); return { data: null, error: null }; }, storage: { from: () => ({ upload: async (path, blob, o) => { uploads.push(['up', path, o.contentType, o.upsert]); return { error: null }; }, remove: async paths => { uploads.push(['rm', ...paths]); return { error: null }; } }) } };
cloud.user = { id: "u-org" };

(async () => {
  const org = K.newId(), p1 = K.newId(), p2 = K.newId(), p3 = K.newId();
  const tid = K.newId();
  const t = {
    id: tid, owner: org, name: "Cup", date: "2026-11-21", location: "Leeds", description: "Hello", points: 40, plannedRounds: 3, status: "setup",
    rules: { win: 3, margins: { enabled: true } }, registrationOpen: true, maxPlayers: 8, listsLocked: false, hideListsUntilRound1: true,
    players: [], requests: [], rounds: [],
  };

  // creating a tournament, then players asking to join and setting lists (their own calls)
  await cloud.createTournament(t);
  assert.strictEqual(tables.tournaments[0].hide_lists_until_round1, true);
  for (const p of [p1, p2, p3]) { cloud.user = { id: p }; await cloud.requestJoin(tid); await cloud.setList(tid, p, "code-" + p.slice(0, 4)); }
  cloud.user = { id: org };
  await cloud.setRegistration(tid, p1, { status: "approved" });
  await cloud.setRegistration(tid, p2, { status: "approved" });
  await cloud.setRegistration(tid, p3, { status: "declined" });

  // reading it back: approved players vs requests, lists attached
  let { t: back } = await cloud.load(tid);
  assert.deepStrictEqual(back.players.map(p => p.pid).sort(), [p1, p2].sort());
  assert.strictEqual(back.players[0].listCode.startsWith("code-"), true);
  assert.deepStrictEqual(back.requests.map(r => [r.pid, r.status]), [[p3, "declined"]]);
  assert.strictEqual(back.maxPlayers, 8); assert.strictEqual(back.registrationOpen, true); assert.strictEqual(back.description, "Hello");

  // organiser edits: lock lists and draw round 1
  cloud.baseline(back);
  back.listsLocked = true;
  back.rounds.push({ n: 1, done: false, tables: [{ id: 1, a: p1, b: p2, result: null, manual: false, vpA: null, vpB: null, bonusA: 0, bonusB: 0, killedByA: [], killedByB: [] }] });
  cloud._latest = back; calls.length = 0; await cloud.flush();
  assert.deepStrictEqual(calls.filter(c => !c.startsWith("select")), ["upsert tournaments 1", "upsert rounds 1", "upsert games 1", "delete games"]);
  assert(back.rounds[0].tables[0].gid, "new game got its id");
  assert.strictEqual(tables.tournaments[0].lists_locked, true);
  assert.strictEqual(mem["song-tool-pending"], null);   // nothing left pending

  // nothing changed: nothing sent
  calls.length = 0; await cloud._push(back); assert.deepStrictEqual(calls, []);

  // a player reports their own game (an update by game id, only the report fields)
  const g = back.rounds[0].tables[0];
  cloud.user = { id: p1 };
  cloud.reportGame({ ...g, vpA: 7, vpB: 2, result: "a", killedByA: [0, 1] });
  await cloud._sendReports();
  assert.strictEqual(tables.games[0].vp_a, 7); assert.deepStrictEqual(tables.games[0].killed_by_a, [0, 1]);
  assert.strictEqual(tables.games[0].bonus_a, 0);

  // the organiser changes only a different field; the player's report is not overwritten with the organiser's stale copy
  cloud.user = { id: org };
  back.rounds[0].done = true;
  calls.length = 0; await cloud._push(back);
  assert.deepStrictEqual(calls, ["upsert rounds 1"]);
  assert.strictEqual(tables.games[0].vp_a, 7);

  // the organiser edits one game of two: only that game is sent
  back.rounds[0].tables.push({ id: 2, a: p2, b: null, result: "a", manual: false, vpA: null, vpB: null, bonusA: 0, bonusB: 0, killedByA: [], killedByB: [] });
  await cloud._push(back);
  back.rounds[0].tables[1].bonusA = 1; calls.length = 0; await cloud._push(back);
  assert.deepStrictEqual(calls.filter(c => c.startsWith("upsert games")), ["upsert games 1"]);

  // a redraw with fewer tables removes the extra game
  back.rounds[0].tables = [back.rounds[0].tables[0]]; await cloud._push(back);
  assert.strictEqual(tables.games.length, 1);

  // a failed upload leaves `synced` alone, so the retry sends the same changes
  back.status = "running";
  const real = cloud.client; cloud.client = { from: () => { throw new Error("offline"); } };
  await assert.rejects(() => cloud._push(back)); cloud.client = real;
  calls.length = 0; await cloud._push(back); assert.deepStrictEqual(calls, ["upsert tournaments 1"]);

  // withdrawing, and removing a player, drop their list with them
  cloud.user = { id: p2 }; await cloud.withdraw(tid);
  assert.strictEqual(tables.registrations.some(r => r.profile_id === p2), false);

  // directory search and counts
  tables.tournaments.push({ id: K.newId(), owner: org, name: "Other", date: "", location: "York", points: 40, status: "setup", registration_open: true, lists_locked: false, planned_rounds: 3 });
  const dir = await cloud._summaries(tables.tournaments);
  assert.strictEqual(dir.find(d => d.id === tid).players, 1);

  // names and initials
  const sam = { id: p1, firstName: "Sam", lastName: "Reid", nickname: "The Kraken", club: "", country: "", avatarAt: null };
  assert.strictEqual(K.displayName(sam), "The Kraken");                       // public name = nickname
  assert.strictEqual(K.matchName(sam), "The Kraken (Sam Reid)");               // match-ups and game history add the real name
  assert.strictEqual(K.matchName({ ...sam, firstName: "", lastName: "" }), "The Kraken");   // real name not visible to this viewer
  assert.strictEqual(K.displayName({ ...sam, nickname: "" }), "Sam Reid");     // legacy fallback only
  assert.strictEqual(K.initialsOf(sam), "TK");
  assert.strictEqual(K.initialsOf({ ...sam, nickname: "Kraken" }), "KR");
  assert.strictEqual(K.displayName(null), "");
  assert.deepStrictEqual(K.fromProfileRow(K.toProfileRow(sam)), sam);

  // real names come from the profile_names view and are merged in only where the database returned them
  tables.profiles.push({ id: p3, first_name: "Zed", last_name: "Zane", nickname: "Zee", club: "", country: "" });
  const got = await cloud._withNames([{ id: p3, nickname: "Zee" }, { id: "other", nickname: "Hidden" }]);
  assert.deepStrictEqual(got.map(r => [r.nickname, r.first_name]), [["Zee", "Zed"], ["Hidden", undefined]]);
  assert.strictEqual(K.matchName(K.fromProfileRow(got[1])), "Hidden");
  tables.profiles.pop();

  // saving a profile, a picture, and removing it
  cloud.user = { id: p1 };
  await cloud.saveProfile(sam);
  assert.strictEqual(tables.profiles[0].first_name, "Sam");
  const at = await cloud.setAvatar("blob");
  assert.deepStrictEqual(uploads[0], ["up", `${p1}/avatar.jpg`, "image/jpeg", true]);
  assert.strictEqual(tables.profiles[0].avatar_updated_at, at);
  await cloud.saveProfile({ ...sam, nickname: "Kraken" });   // editing the profile must not wipe the picture
  assert.strictEqual(tables.profiles[0].avatar_updated_at, at);
  window.SONG_CLOUD.url = "https://x.supabase.co";
  assert.strictEqual(cloud.avatarUrl({ id: p1, avatarAt: at }), `https://x.supabase.co/storage/v1/object/public/avatars/${p1}/avatar.jpg?v=${Date.parse(at)}`);
  assert.strictEqual(cloud.avatarUrl({ id: p1, avatarAt: null }), "");
  await cloud.removeAvatar();
  assert.deepStrictEqual(uploads[1], ["rm", `${p1}/avatar.jpg`]); assert.strictEqual(tables.profiles[0].avatar_updated_at, null);

  // final results rows from standings, saved and cleared
  cloud.user = { id: org };
  const st = [{ pid: p1, rank: 1, points: 6, played: 2, w: 2, d: 0, l: 0, byes: 0, majors: 1, vp: 12, vpAgainst: 3, destroyed: 40, lost: 5 },
              { pid: p2, rank: 2, points: 0, played: 2, w: 0, d: 0, l: 2, byes: 0, majors: 0, vp: 3, vpAgainst: 12, destroyed: 5, lost: 40 }];
  await cloud.saveResults(back, st);
  assert.strictEqual(tables.tournament_results.length, 2);
  const r1 = tables.tournament_results.find(r => r.profile_id === p1);
  assert.deepStrictEqual([r1.rank, r1.field_size, r1.tournament_pts, r1.wins, r1.major_wins, r1.vp_for, r1.pts_destroyed], [1, 2, 6, 2, 1, 12, 40]);
  await cloud.saveResults(back, st); assert.strictEqual(tables.tournament_results.length, 2);   // saving again replaces, not duplicates
  await cloud.clearResults(back.id); assert.strictEqual(tables.tournament_results.length, 0);

  // faction/commander/points travel with an entry; the organiser can re-sync them
  cloud.user = { id: p1 };
  await cloud.setList(tid, p1, "codeX", { faction: "stark", commander: "c1", points: 39 });
  let e1 = tables.entry_lists.find(r => r.profile_id === p1);
  assert.deepStrictEqual([e1.list_code, e1.faction, e1.commander, e1.points], ["codeX", "stark", "c1", 39]);
  await cloud.setList(tid, p1, "codeY");   // no meta: stored as null, never undefined
  e1 = tables.entry_lists.find(r => r.profile_id === p1); assert.deepStrictEqual([e1.faction, e1.points], [null, null]);
  cloud.user = { id: org };
  await cloud.syncEntryMeta(tid, [{ pid: p1, faction: "lannister", commander: "", points: 40 }]);
  e1 = tables.entry_lists.find(r => r.profile_id === p1); assert.deepStrictEqual([e1.faction, e1.commander, e1.points], ["lannister", null, 40]);

  // two lists: the second goes on the same entry; changing list 1 to another faction can drop it
  cloud.user = { id: p1 };
  await cloud.setList(tid, p1, "codeX", { faction: "stark", commander: "c1", points: 39 });
  await cloud.setList(tid, p1, "codeZ", { faction: "stark", commander: "c9", points: 40 }, 2);
  e1 = tables.entry_lists.find(r => r.profile_id === p1);
  assert.deepStrictEqual([e1.list_code, e1.faction, e1.list_code_2, e1.faction_2, e1.commander_2, e1.points_2], ["codeX", "stark", "codeZ", "stark", "c9", 40]);
  await cloud.setList(tid, p1, "codeW", { faction: "lannister" }, 1, { clearSecond: true });
  e1 = tables.entry_lists.find(r => r.profile_id === p1);
  assert.deepStrictEqual([e1.list_code, e1.faction, e1.list_code_2, e1.faction_2, e1.points_2], ["codeW", "lannister", null, null, null]);
  await cloud.setList(tid, p1, "codeX", { faction: "stark", commander: "c1", points: 39 });
  await cloud.setList(tid, p1, "codeZ", { faction: "stark", commander: "c9", points: 40 }, 2);
  cloud.user = { id: org };
  await cloud.syncEntryMeta(tid, [{ pid: p1, faction: "stark", commander: "c1", points: 40, second: { faction: "stark", commander: "c8", points: 38 } }]);
  e1 = tables.entry_lists.find(r => r.profile_id === p1);
  assert.deepStrictEqual([e1.points, e1.commander_2, e1.points_2, e1.list_code_2], [40, "c8", 38, "codeZ"]);

  // lock-in: a player's secret choice of list for a game; the organiser can clear it
  cloud.user = { id: p1 };
  await cloud.lockIn("game-1", tid, 2);
  const pk = tables.game_picks.at(-1);
  assert.deepStrictEqual([pk.game_id, pk.tournament_id, pk.profile_id, pk.slot], ["game-1", tid, p1, 2]);
  cloud.user = { id: org };
  await cloud.clearLockIn("game-1"); assert.ok(calls.includes("rpc clear_lock_in"));
  await cloud.organiserLockIn("game-1", p2, 1); assert.ok(calls.includes("rpc organiser_lock_in"));   // the organiser locking in for a player
  // the list a player played in a game: their locked-in slot (their first list when there is no pick)
  assert.strictEqual(await cloud.entryList(tid, p1, "game-1"), "codeZ");
  assert.strictEqual(await cloud.entryList(tid, p1), "codeX");
  // reading them back: the second list, the public lock flags, and only the picks the database showed this viewer
  const twoListRead = K.fromRows({ id: "t1", owner: "o", name: "x", points: 40, planned_rounds: 3, status: "running", rules: {}, registration_open: true, lists_locked: true, hide_lists_until_round1: false },
    [{ profile_id: "pa", status: "approved", dropped: false }, { profile_id: "pb", status: "approved", dropped: false }],
    [{ profile_id: "pa", list_code: "A1", list_code_2: "A2" }, { profile_id: "pb", list_code: "B1" }],
    [{ id: "r1", tournament_id: "t1", n: 1, done: false }],
    [{ id: "g1", round_id: "r1", table_no: 1, a: "pa", b: "pb", locked_a: true, locked_b: false, killed_by_a: [], killed_by_b: [] }, { id: "g2", round_id: "r1", table_no: 2, a: "pc", b: null, killed_by_a: [], killed_by_b: [] }],
    [], [], [{ game_id: "g1", profile_id: "pa", slot: 2 }]);
  assert.deepStrictEqual(twoListRead.players.map(p => [p.listCode, p.listCode2]), [["A1", "A2"], ["B1", null]]);
  assert.deepStrictEqual([twoListRead.rounds[0].tables[0].lockedA, twoListRead.rounds[0].tables[0].lockedB, twoListRead.rounds[0].tables[0].pickA, twoListRead.rounds[0].tables[0].pickB], [true, false, 2, null]);
  assert.deepStrictEqual([twoListRead.rounds[0].tables[1].lockedA, twoListRead.rounds[0].tables[1].pickA, twoListRead.rounds[0].tables[1].pickB], [false, null, null]);
  // the organiser's uploads never touch the lock flags (they are the players' to raise)
  assert.ok(!("locked_a" in K.toGameRow({ id: "t1" }, { n: 1 }, { id: 1, a: "pa", b: "pb" }, "r1")));

  // ratings: one call that rebuilds them on the server
  await cloud.recomputeRatings(); assert.ok(calls.includes("rpc recompute_ratings"));

  // the private saved-list library: put, read back, replace by name, delete
  cloud.user = { id: p1 };
  await cloud.putSavedList({ name: "My list", code: "abc", faction: "stark", points: 40, saved: "2026-11-01T10:00:00.000Z" });
  await cloud.putSavedList({ name: "My list", code: "abc2", faction: "stark", points: 39, saved: "2026-11-02T10:00:00.000Z" });
  assert.strictEqual(tables.saved_lists.length, 1);
  assert.deepStrictEqual(await cloud.savedLists(), [{ name: "My list", code: "abc2", saved: "2026-11-02T10:00:00.000Z" }]);
  assert.strictEqual(tables.saved_lists[0].owner, p1);
  await cloud.deleteSavedList("My list"); assert.strictEqual(tables.saved_lists.length, 0);

  // faction records from game history
  const gs = [{ faction: "stark", opp_faction: "lannister", outcome: "win" }, { faction: "stark", opp_faction: "lannister", outcome: "loss" },
              { faction: "stark", opp_faction: null, outcome: "draw" }, { faction: null, opp_faction: "stark", outcome: "win" }];
  const fr = K.factionRecords(gs);
  assert.deepStrictEqual(fr.mine.get("stark"), { games: 3, wins: 1, draws: 1, losses: 1 });
  assert.deepStrictEqual(fr.versus.get("stark|lannister"), { games: 2, wins: 1, draws: 0, losses: 1 });
  assert.strictEqual(K.isProvisional(4), true); assert.strictEqual(K.isProvisional(5), false); assert.strictEqual(K.isProvisional(2, "stark"), true); assert.strictEqual(K.isProvisional(3, "stark"), false);

  // team tournaments: teams, matches and the team of each game travel with the rounds
  {
    const tt = { id: K.newId(), owner: org, name: "Team Cup", date: "", location: "", description: "", points: 40, plannedRounds: 3, status: "running", rules: { win: 3, draw: 1, loss: 0, tiebreakers: [] },
      registrationOpen: true, maxPlayers: null, listsLocked: true, hideListsUntilRound1: false, format: "team", teamSize: 2, teams: [], players: [], requests: [], rounds: [] };
    cloud.user = { id: org }; await cloud.createTournament(tt);
    assert.deepStrictEqual([tables.tournaments.at(-1).format, tables.tournaments.at(-1).team_size], ["team", 2]);
    const tA = K.newId(), tB = K.newId(), m1 = K.newId(), m2 = K.newId();
    tables.teams.push({ id: tA, tournament_id: tt.id, name: "Alpha", captain: p1 }, { id: tB, tournament_id: tt.id, name: "Bravo", captain: p2 });
    tt.rounds.push({ n: 1, done: false, matches: [{ mid: m1, a: tA, b: tB }], tables: [{ id: 1, mid: m1, team: tA, a: p1, b: p2, result: null, vpA: null, vpB: null, bonusA: 0, bonusB: 0 }] });
    await cloud._push(tt);
    assert.strictEqual(tables.matches.length, 1);
    assert.deepStrictEqual([tables.matches[0].id, tables.matches[0].team_a, tables.matches[0].team_b], [m1, tA, tB]);
    assert.deepStrictEqual([tables.games.at(-1).match_id, tables.games.at(-1).team], [m1, tA]);
    tt.rounds[0].matches = [{ mid: m2, a: tB, b: tA }]; tt.rounds[0].tables[0].mid = m2; tt.rounds[0].tables[0].team = tB;   // a redraw
    await cloud._push(tt);
    assert.deepStrictEqual(tables.matches.map(m => m.id), [m2], "the old match is gone");
    const back = (await cloud.load(tt.id)).t;
    assert.strictEqual(back.format, "team"); assert.strictEqual(back.teamSize, 2); assert.strictEqual(back.teams.length, 2);
    assert.deepStrictEqual(back.rounds[0].matches, [{ mid: m2, a: tB, b: tA }]); assert.strictEqual(back.rounds[0].tables[0].team, tB);
    // team entry calls
    cloud.user = { id: p3 }; await cloud.requestJoinTeam(tt.id, tA);
    const rq = tables.registrations.at(-1); assert.deepStrictEqual([rq.tournament_id, rq.profile_id, rq.team_id], [tt.id, p3, tA]);
    cloud.user = { id: p1 }; await cloud.acceptMember(tt.id, p3);
    assert.strictEqual(tables.registrations.find(r => r.tournament_id === tt.id && r.profile_id === p3).team_ok, true);
    const teamId = await cloud.createTeam(tt.id, "Charlie"); assert(tables.teams.some(x => x.id === teamId && x.captain === p1 && x.name === "Charlie"));
  }

  console.log("Cloud sync OK");
})().catch(e => { console.error(e); process.exit(1); });
