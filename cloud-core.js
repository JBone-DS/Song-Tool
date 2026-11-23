// Cloud data mapping: turns database rows into the tournament object the page works with, and back. No network code
// here, so it can be tested in Node (test-cloud.js). The network side is in cloud.js; the tables are in schema.sql.
//
// A tournament as the page sees it:
//   { id, owner, name, date, location, description, points, plannedRounds, status, rules,
//     registrationOpen, maxPlayers, listsLocked, hideListsUntilRound1,
//     players:  [ { pid, dropped, listCode } ]            approved players (listCode is null when the list is not visible to this viewer)
//     requests: [ { pid, status, listCode } ]             people who asked to join and are waiting or were declined
//     rounds:   [ { n, rid, done, tables: [ { id, gid, a, b, result, manual, vpA, vpB, bonusA, bonusB, killedByA, killedByB } ] } ] }
// A person's id (pid) is their account id, which is also their profile's id.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = s => typeof s === "string" && UUID_RE.test(s);
const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));

const int = v => (Number.isFinite(v) ? Math.round(v) : null);

// A profile: { id, firstName, lastName, nickname, club, country, avatarAt } (avatarAt is when the picture was last changed, or null)
const toProfileRow = p => ({ id: p.id, first_name: p.firstName, last_name: p.lastName ?? "", nickname: p.nickname ?? "", club: p.club ?? "", country: p.country ?? "" });
const fromProfileRow = r => ({ id: r.id, firstName: r.first_name ?? "", lastName: r.last_name ?? "", nickname: r.nickname, club: r.club, country: r.country, avatarAt: r.avatar_updated_at ?? null });
// the nickname is the public name (rankings, rosters, standings); real names show only in match-ups, game history and the person's own profile
const fullName = p => (p ? [p.firstName, p.lastName].filter(Boolean).join(" ") : "");
const displayName = p => (p ? p.nickname || fullName(p) : "");
const matchName = p => (p && p.nickname && fullName(p) ? `${p.nickname} (${fullName(p)})` : displayName(p));
// initials for the picture placeholder, from the nickname: "The Kraken" -> TK, "Kraken" -> KR
const initialsOf = p => {
  const w = displayName(p).split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] ?? "").slice(0, 2)).toUpperCase() || "?";
};

const toTournamentRow = t => ({
  id: t.id, name: t.name, date: t.date || null, location: t.location ?? "", description: t.description ?? "", points: t.points,
  planned_rounds: t.plannedRounds, status: t.status, rules: t.rules,
  registration_open: t.registrationOpen !== false, max_players: t.maxPlayers ?? null,
  lists_locked: !!t.listsLocked, hide_lists_until_round1: !!t.hideListsUntilRound1,
  format: t.format ?? "individual", team_size: t.format === "team" ? t.teamSize : null,
});
const toRoundRow = (t, r) => ({ tournament_id: t.id, n: r.n, done: !!r.done });
const toGameRow = (t, r, g, roundId) => ({
  round_id: roundId, tournament_id: t.id, table_no: g.id, a: g.a, b: g.b ?? null, result: g.result ?? null, manual: !!g.manual,
  vp_a: int(g.vpA), vp_b: int(g.vpB), bonus_a: int(g.bonusA) ?? 0, bonus_b: int(g.bonusB) ?? 0,
  killed_by_a: g.killedByA ?? [], killed_by_b: g.killedByB ?? [], match_id: g.mid ?? null, team: g.team ?? null,
});
// a team match-up of a round (team_b is null for a bye)
const toMatchRow = (t, r, m) => ({ id: m.mid, round_id: r.rid, tournament_id: t.id, team_a: m.a, team_b: m.b ?? null });
// the final standings of a finished tournament as rows (st = the engine's standings, one entry per player, with rank)
const toResultRows = (t, st) => st.map(s => ({
  tournament_id: t.id, profile_id: s.pid, rank: s.rank, field_size: st.length, tournament_pts: s.points, played: s.played, wins: s.w, draws: s.d, losses: s.l,
  byes: s.byes, major_wins: s.majors, vp_for: s.vp, vp_against: s.vpAgainst, pts_destroyed: s.destroyed, pts_lost: s.lost,
}));
// the fields a player may report on their own game
const toReportRow = g => ({ vp_a: int(g.vpA), vp_b: int(g.vpB), result: g.result ?? null, killed_by_a: g.killedByA ?? [], killed_by_b: g.killedByB ?? [] });

// rebuild a tournament from its rows (whatever this viewer is allowed to see)
function fromRows(tr, regs, lists, rounds, games, teams = [], matches = [], picks = []) {
  const listOf = pid => lists.find(l => l.profile_id === pid)?.list_code ?? null;
  const list2Of = pid => lists.find(l => l.profile_id === pid)?.list_code_2 ?? null;
  // which list (1 or 2) a player locked in for a game; null until locked in, or while the other player has not and it is hidden from you
  const pickOf = (gid, pid) => picks.find(p => p.game_id === gid && p.profile_id === pid)?.slot ?? null;
  const sortedRounds = rounds.filter(r => r.tournament_id === tr.id).sort((x, y) => x.n - y.n);
  return {
    id: tr.id, owner: tr.owner, name: tr.name, date: tr.date ?? "", location: tr.location, description: tr.description ?? "", points: tr.points,
    plannedRounds: tr.planned_rounds, status: tr.status, rules: tr.rules,
    registrationOpen: tr.registration_open, maxPlayers: tr.max_players, listsLocked: tr.lists_locked, hideListsUntilRound1: tr.hide_lists_until_round1,
    format: tr.format ?? "individual", teamSize: tr.team_size ?? null,
    teams: teams.filter(x => x.tournament_id === tr.id).map(x => ({ id: x.id, name: x.name, captain: x.captain })),
    players: regs.filter(r => r.status === "approved").map(r => ({ pid: r.profile_id, dropped: r.dropped, listCode: listOf(r.profile_id), listCode2: list2Of(r.profile_id), teamId: r.team_id ?? null })),
    requests: regs.filter(r => r.status !== "approved").map(r => ({ pid: r.profile_id, status: r.status, listCode: listOf(r.profile_id), listCode2: list2Of(r.profile_id), teamId: r.team_id ?? null, teamOk: !!r.team_ok })),
    rounds: sortedRounds.map(r => ({
      n: r.n, rid: r.id, done: r.done,
      matches: matches.filter(m => m.round_id === r.id).map(m => ({ mid: m.id, a: m.team_a, b: m.team_b })),
      tables: games.filter(g => g.round_id === r.id).sort((x, y) => x.table_no - y.table_no).map(g => ({
        id: g.table_no, gid: g.id, a: g.a, b: g.b, result: g.result, manual: g.manual, vpA: g.vp_a, vpB: g.vp_b, bonusA: g.bonus_a, bonusB: g.bonus_b,
        killedByA: g.killed_by_a ?? [], killedByB: g.killed_by_b ?? [], mid: g.match_id ?? null, team: g.team ?? null,
        lockedA: !!g.locked_a, lockedB: !!g.locked_b, pickA: pickOf(g.id, g.a), pickB: g.b ? pickOf(g.id, g.b) : null,
      })),
    })),
  };
}

// A fingerprint of each record the organiser edits locally, so only what changed is sent.
// Keys: t:<tournament> (settings, rules, status), r:<tournament>:<round>, g:<tournament>:<round>:<table>
function snapshotOf(t) {
  const snap = new Map();
  snap.set(`t:${t.id}`, JSON.stringify(toTournamentRow(t)));
  for (const r of t.rounds) {
    snap.set(`r:${t.id}:${r.n}`, JSON.stringify(toRoundRow(t, r)));
    snap.set(`m:${t.id}:${r.n}`, JSON.stringify((r.matches ?? []).map(m => [m.mid, m.a, m.b ?? null])));
    for (const g of r.tables) snap.set(`g:${t.id}:${r.n}:${g.id}`, JSON.stringify(toGameRow(t, r, g, "")));
  }
  return snap;
}

// the army list a player enters: its code plus the faction, commander and points, so records can be kept per faction
const toEntryRow = (tid, pid, code, meta = {}) => ({ tournament_id: tid, profile_id: pid, list_code: code,
  faction: meta.faction || null, commander: meta.commander || null, points: Number.isFinite(meta.points) ? meta.points : null });
// the second list of an entry (the first goes with toEntryRow); both are of one faction
const toSecondListRow = (code, meta = {}) => ({ list_code_2: code || null, faction_2: code ? meta.faction || null : null, commander_2: code ? meta.commander || null : null,
  points_2: code && Number.isFinite(meta.points) ? meta.points : null });
// a row of a person's private saved-list library
const toSavedRow = (owner, e) => ({ owner, name: e.name, list_code: e.code, faction: e.faction || null, points: Number.isFinite(e.points) ? e.points : null, updated_at: e.saved });
const fromSavedRow = r => ({ name: r.name, code: r.list_code, saved: r.updated_at });

// what a profile shows about rating: 'provisional' until enough games (5 overall, 3 for a faction)
const PROVISIONAL_GAMES = { overall: 5, faction: 3 };
const isProvisional = (games, scope = "overall") => games < (scope === "overall" ? PROVISIONAL_GAMES.overall : PROVISIONAL_GAMES.faction);
// summarise a person's game history into overall record, per-faction record and record against each opposing faction
function factionRecords(games) {
  const mine = new Map(), versus = new Map();
  const bump = (m, key, outcome) => { const r = m.get(key) ?? { games: 0, wins: 0, draws: 0, losses: 0 }; r.games++; r[outcome === "win" ? "wins" : outcome === "draw" ? "draws" : "losses"]++; m.set(key, r); };
  for (const g of games) {
    if (!g.faction) continue;
    bump(mine, g.faction, g.outcome);
    if (g.opp_faction) bump(versus, `${g.faction}|${g.opp_faction}`, g.outcome);
  }
  return { mine, versus };
}

if (typeof module !== "undefined") module.exports = { toEntryRow, toSecondListRow, toSavedRow, fromSavedRow, isProvisional, factionRecords, isUuid, newId, displayName, fullName, matchName, initialsOf, toResultRows, toProfileRow, fromProfileRow, toTournamentRow, toRoundRow, toGameRow, toMatchRow, toReportRow, fromRows, snapshotOf };
