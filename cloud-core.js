// Cloud data mapping: turns the tournament page's `db` object into database rows and back. No network code here,
// so it can be tested in Node (test-cloud.js). The network side is in cloud.js.
//
// Local shape (see tournament.js):  db = { profiles: [...], tournaments: [ { ..., players: [...], rounds: [ { n, done, tables: [...] } ] } ] }
// Database tables (see schema.sql): profiles, tournaments, tournament_players, rounds, games.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = s => typeof s === "string" && UUID_RE.test(s);
const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));

// Browser data made before the database used short ids. Give everything a proper uuid, keeping every link between records.
function withUuids(db) {
  const map = new Map();
  const fix = id => (id === null || id === undefined || isUuid(id) ? id : map.get(id) ?? (map.set(id, newId()), map.get(id)));
  return {
    ...db,
    profiles: db.profiles.map(p => ({ ...p, id: fix(p.id) })),
    tournaments: db.tournaments.map(t => ({
      ...t, id: fix(t.id),
      players: t.players.map(p => ({ ...p, pid: fix(p.pid) })),
      rounds: t.rounds.map(r => ({ ...r, tables: r.tables.map(g => ({ ...g, a: fix(g.a), b: fix(g.b) })) })),
    })),
  };
}

const int = v => (Number.isFinite(v) ? Math.round(v) : null);

const toProfileRow = p => ({ id: p.id, name: p.name, club: p.club ?? "", country: p.country ?? "", faction: p.faction ?? "" });
const fromProfileRow = r => ({ id: r.id, name: r.name, club: r.club, country: r.country, faction: r.faction });

const toTournamentRow = t => ({
  id: t.id, name: t.name, date: t.date || null, location: t.location ?? "", points: t.points, planned_rounds: t.plannedRounds,
  status: t.status, rules: t.rules, is_public: t.isPublic !== false,
});
const toPlayerRows = t => t.players.map(p => ({ tournament_id: t.id, profile_id: p.pid, list_code: p.listCode ?? "", locked: !!p.locked, dropped: !!p.dropped }));
const toRoundRow = (t, r) => ({ tournament_id: t.id, n: r.n, done: !!r.done });
const toGameRows = (t, r, roundId) => r.tables.map(g => ({
  round_id: roundId, tournament_id: t.id, table_no: g.id, a: g.a, b: g.b ?? null, result: g.result ?? null, manual: !!g.manual,
  vp_a: int(g.vpA), vp_b: int(g.vpB), bonus_a: int(g.bonusA) ?? 0, bonus_b: int(g.bonusB) ?? 0,
  killed_by_a: g.killedByA ?? [], killed_by_b: g.killedByB ?? [],
}));

// rebuild one tournament from its rows
function fromRows(tr, playerRows, roundRows, gameRows) {
  const rounds = roundRows.filter(r => r.tournament_id === tr.id).sort((x, y) => x.n - y.n).map(r => ({
    n: r.n, done: r.done,
    tables: gameRows.filter(g => g.round_id === r.id).sort((x, y) => x.table_no - y.table_no).map(g => ({
      id: g.table_no, a: g.a, b: g.b, result: g.result, manual: g.manual, vpA: g.vp_a, vpB: g.vp_b, bonusA: g.bonus_a, bonusB: g.bonus_b,
      killedByA: g.killed_by_a ?? [], killedByB: g.killed_by_b ?? [],
    })),
  }));
  return {
    id: tr.id, name: tr.name, date: tr.date ?? "", location: tr.location, points: tr.points, plannedRounds: tr.planned_rounds, status: tr.status,
    rules: tr.rules, isPublic: tr.is_public,
    players: playerRows.filter(p => p.tournament_id === tr.id).map(p => ({ pid: p.profile_id, listCode: p.list_code, locked: p.locked, dropped: p.dropped })),
    rounds,
  };
}

// A fingerprint of every record, so only what changed is sent. Keys: p:<profile>, t:<tournament>, tp:<tournament players>, r:<tournament>:<round>
function snapshotOf(db) {
  const snap = new Map();
  for (const p of db.profiles) snap.set(`p:${p.id}`, JSON.stringify(toProfileRow(p)));
  for (const t of db.tournaments) {
    snap.set(`t:${t.id}`, JSON.stringify(toTournamentRow(t)));
    snap.set(`tp:${t.id}`, JSON.stringify(toPlayerRows(t)));
    for (const r of t.rounds) snap.set(`r:${t.id}:${r.n}`, JSON.stringify([toRoundRow(t, r), toGameRows(t, r, "")]));
  }
  return snap;
}

if (typeof module !== "undefined") module.exports = { isUuid, newId, withUuids, toProfileRow, fromProfileRow, toTournamentRow, toPlayerRows, toRoundRow, toGameRows, fromRows, snapshotOf };
