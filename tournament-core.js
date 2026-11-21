// Tournament engine: scoring, standings and pairings. No page code here, so it can be tested in Node.
//
// A tournament (see tournament.js for how it is stored) looks like this:
//   {
//     rules:   { pairing: "swiss" | "random", avoidClub, win, draw, loss, tiebreakers: ["sos", "vpDiff", "destroyed"],
//                margins: { enabled, band, marginalWin, majorWin } },   // optional: a win by band VP or fewer is marginal, more is major
//     players: [ { pid, dropped, ... } ],                    // pid = the player's profile id
//     rounds:  [ { n, done, tables: [ { a, b, result, vpA, vpB, bonusA, bonusB, killedByA, killedByB } ] } ],
//   }
// A table with b === null is a bye. result is "a", "b", "draw", or null while the game is unplayed.
// killedByA lists which units of B's army A destroyed, as positions in B's list (killedByB likewise).
// Standings take optional { rowPoints(pid) -> [points of each row of that player's list], unitRows(pid) -> [positions of its unit rows],
// tableStart(pid) -> army points less NCUs } to turn kills into points, spot a wiped-out army and work out points left on the table.

const TIEBREAKERS = {
  sos: "Strength of schedule (opponents' average points)",
  vpDiff: "Victory point difference",
  vp: "Victory points scored",
  destroyed: "Enemy points destroyed",
  destroyedDiff: "Points destroyed minus points lost",
};

// ---- results ------------------------------------------------------------

// the result a table's victory points imply, or null when they are not both entered
function resultFromVp(t) {
  if (!Number.isFinite(t.vpA) || !Number.isFinite(t.vpB)) return null;
  return t.vpA > t.vpB ? "a" : t.vpA < t.vpB ? "b" : "draw";
}

// points of the enemy army this side destroyed (killed = positions in the enemy list)
function killedWorth(pid, killed, opts) {
  const pts = (opts.rowPoints ?? (() => []))(pid);
  return (killed ?? []).reduce((n, i) => n + (pts[i] ?? 0), 0);
}
// Has this side lost its whole army off the table? True when it has units and the enemy destroyed every one.
// opts.unitRows(pid) gives the positions of a player's unit rows (not NCUs, not commanders).
function wipedOut(g, side, opts = {}) {
  if (g.b === null || !opts.unitRows) return false;
  const rows = opts.unitRows(side === "a" ? g.a : g.b);
  const killed = new Set(side === "a" ? g.killedByB : g.killedByA);
  return rows.length > 0 && rows.every(i => killed.has(i));
}
// Points still on the table: the army total, less NCU costs, less what the enemy destroyed. null if unknown.
function tableLeft(g, side, opts = {}) {
  if (!opts.tableStart) return null;
  const pid = side === "a" ? g.a : g.b;
  return opts.tableStart(pid) - killedWorth(pid, side === "a" ? g.killedByB : g.killedByA, opts);
}

// Decide a game: { result: "a" | "b" | "draw" | null, basis: "wipeout" | "vp" | "table" | "tied" | null }.
// A wiped-out army loses automatically; otherwise victory points decide; if those are level, points left on the table
// decide; if those are level too it is a draw.
function decideResult(g, opts = {}) {
  if (g.b === null) return { result: "a", basis: null };
  const wa = wipedOut(g, "a", opts), wb = wipedOut(g, "b", opts);
  if (wa !== wb) return { result: wa ? "b" : "a", basis: "wipeout" };
  const vp = resultFromVp(g);
  if (!vp) return wa && wb ? { result: "draw", basis: "tied" } : { result: null, basis: null };
  if (vp !== "draw") return { result: vp, basis: "vp" };
  const ta = tableLeft(g, "a", opts), tb = tableLeft(g, "b", opts);
  if (ta !== null && tb !== null && ta !== tb) return { result: ta > tb ? "a" : "b", basis: "table" };
  return { result: "draw", basis: "tied" };
}

// Was this win marginal or major? Only when the tournament uses margins. A win by `band` victory points or fewer is
// marginal, more is major; a win over a wiped-out army is always major.
function winTier(g, rules, opts = {}) {
  const m = rules.margins;
  if (!m?.enabled || g.b === null || (g.result !== "a" && g.result !== "b")) return null;
  if (wipedOut(g, g.result === "a" ? "b" : "a", opts)) return "major";
  const n = v => (Number.isFinite(v) ? v : 0);
  return Math.abs(n(g.vpA) - n(g.vpB)) <= m.band ? "marginal" : "major";
}
// tournament points a win is worth in this game (a bye counts as the biggest win)
function winPoints(g, rules, opts = {}) {
  const m = rules.margins;
  if (!m?.enabled) return rules.win;
  return g.b === null || winTier(g, rules, opts) === "major" ? m.majorWin : m.marginalWin;
}

// every finished game as one row per player: { pid, opp, points, vp, vpAgainst, destroyed, lost, bye, outcome, major }
function gameRows(t, opts = {}) {
  const rows = [];
  const bonus = n => (Number.isFinite(n) ? n : 0);
  const rowPoints = opts.rowPoints ?? (() => []);
  const worth = (pid, killed) => { const pts = rowPoints(pid); return (killed ?? []).reduce((n, i) => n + (pts[i] ?? 0), 0); };
  for (const round of t.rounds) {
    for (const g of round.tables) {
      if (g.b === null) {   // a bye counts as a win, with no victory points
        rows.push({ pid: g.a, opp: null, points: winPoints(g, t.rules, opts) + bonus(g.bonusA), vp: 0, vpAgainst: 0, destroyed: 0, lost: 0, bye: true, outcome: "w", major: false });
        continue;
      }
      if (!g.result) continue;
      const pts = o => (o === "w" ? null : o === "d" ? t.rules.draw : t.rules.loss);
      const oa = g.result === "a" ? "w" : g.result === "draw" ? "d" : "l";
      const ob = g.result === "b" ? "w" : g.result === "draw" ? "d" : "l";
      const vpA = Number.isFinite(g.vpA) ? g.vpA : 0, vpB = Number.isFinite(g.vpB) ? g.vpB : 0;
      const tier = winTier(g, t.rules, opts), win = winPoints(g, t.rules, opts);
      const dA = worth(g.b, g.killedByA), dB = worth(g.a, g.killedByB);   // points of B's army A destroyed, and the reverse
      rows.push({ pid: g.a, opp: g.b, points: (oa === "w" ? win : pts(oa)) + bonus(g.bonusA), vp: vpA, vpAgainst: vpB, destroyed: dA, lost: dB, bye: false, outcome: oa, major: oa === "w" && tier === "major" });
      rows.push({ pid: g.b, opp: g.a, points: (ob === "w" ? win : pts(ob)) + bonus(g.bonusB), vp: vpB, vpAgainst: vpA, destroyed: dB, lost: dA, bye: false, outcome: ob, major: ob === "w" && tier === "major" });
    }
  }
  return rows;
}

// ---- standings ----------------------------------------------------------

// one row per player, best first. Players who dropped stay in the table.
function standings(t, opts = {}) {
  const rows = gameRows(t, opts);
  const base = new Map(t.players.map(p => [p.pid, { pid: p.pid, dropped: !!p.dropped, played: 0, w: 0, d: 0, l: 0, byes: 0, majors: 0, points: 0, vp: 0, vpAgainst: 0, destroyed: 0, lost: 0, opps: [] }]));
  for (const r of rows) {
    const s = base.get(r.pid);
    if (!s) continue;
    s.played++; s.points += r.points; s.vp += r.vp; s.vpAgainst += r.vpAgainst; s.destroyed += r.destroyed; s.lost += r.lost;
    s[r.outcome]++;
    if (r.major) s.majors++;
    if (r.bye) s.byes++; else s.opps.push(r.opp);
  }
  for (const s of base.values()) {
    s.vpDiff = s.vp - s.vpAgainst;
    s.destroyedDiff = s.destroyed - s.lost;
    // strength of schedule: the average points of everyone this player has met (byes do not count)
    s.sos = s.opps.length ? s.opps.reduce((n, id) => n + (base.get(id)?.points ?? 0), 0) / s.opps.length : 0;
  }
  const order = ["points", ...t.rules.tiebreakers];
  const out = [...base.values()].sort((x, y) => {
    for (const k of order) if (y[k] !== x[k]) return y[k] - x[k];
    return 0;
  });
  // equal on every measure shares a rank
  out.forEach((s, i) => { s.rank = i && order.every(k => s[k] === out[i - 1][k]) ? out[i - 1].rank : i + 1; });
  return out;
}

// ---- pairings -----------------------------------------------------------

// small seedable random generator so pairings can be reproduced in tests
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function shuffle(a, rng) {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

// who has already played whom, and who has had a bye
function gamesPlayed(t) {
  const met = new Set(), byes = new Set();
  for (const round of t.rounds) for (const g of round.tables) {
    if (g.b === null) byes.add(g.a); else { met.add(`${g.a}|${g.b}`); met.add(`${g.b}|${g.a}`); }
  }
  return { met, byes };
}

// Pair the given players (best first). Tries to avoid rematches and, if asked, same-club games, and gives up
// each rule in turn only when no pairing exists without breaking it. Returns [{ a, b }] with a bye as b: null.
// clubOf(pid) gives a player's club ("" for none).
function pairPlayers(order, met, byes, avoidClub, clubOf) {
  const list = [...order];
  let bye = null;
  if (list.length % 2) {   // the bye goes to the lowest-ranked player who has not had one (lowest of all if everyone has)
    const idx = [...list.keys()].reverse().find(i => !byes.has(list[i])) ?? list.length - 1;
    bye = list.splice(idx, 1)[0];
  }
  const clash = (a, b, level) => (level < 2 && met.has(`${a}|${b}`)) || (level < 1 && avoidClub && clubOf(a) && clubOf(a) === clubOf(b));
  for (let level = 0; level <= 2; level++) {
    let budget = 200000;   // stop a hopeless search and relax a rule instead
    const used = new Array(list.length).fill(false), pairs = [];
    const solve = () => {
      if (--budget < 0) return false;
      const i = used.indexOf(false);
      if (i < 0) return true;
      used[i] = true;
      for (let j = i + 1; j < list.length; j++) {
        if (used[j] || clash(list[i], list[j], level)) continue;
        used[j] = true; pairs.push({ a: list[i], b: list[j] });
        if (solve()) return true;
        pairs.pop(); used[j] = false;
      }
      used[i] = false;
      return false;
    };
    if (solve()) return [...pairs, ...(bye !== null ? [{ a: bye, b: null }] : [])];
  }
  return [...Array(list.length / 2).keys()].map(i => ({ a: list[2 * i], b: list[2 * i + 1] }))
    .concat(bye !== null ? [{ a: bye, b: null }] : []);   // unreachable in practice: level 2 always succeeds
}

// the tables for the next round
function drawRound(t, clubOf, seed = Date.now(), opts = {}) {
  const rng = makeRng(seed);
  const active = t.players.filter(p => !p.dropped).map(p => p.pid);
  const { met, byes } = gamesPlayed(t);
  let order;
  if (t.rules.pairing === "swiss" && t.rounds.length) {
    const rank = new Map(standings(t, opts).map((s, i) => [s.pid, i]));
    // players level on every measure are shuffled among themselves so pairings are not decided by sign-up order
    order = shuffle(active, rng).sort((x, y) => rank.get(x) - rank.get(y));
  } else order = shuffle(active, rng);
  return pairPlayers(order, met, byes, t.rules.avoidClub, clubOf).map((g, i) => ({
    id: i + 1, a: g.a, b: g.b, result: g.b === null ? "a" : null, vpA: null, vpB: null, bonusA: 0, bonusB: 0,
  }));
}

// problems with a drawn round the organiser may want to know about (rematches, same club, a second bye)
function roundWarnings(t, tables, clubOf) {
  const { met, byes } = gamesPlayed(t);
  const out = [];
  for (const g of tables) {
    if (g.b === null) { if (byes.has(g.a)) out.push("A player is getting a second bye."); continue; }
    if (met.has(`${g.a}|${g.b}`)) out.push("A rematch is on the draw.");
    if (t.rules.avoidClub && clubOf(g.a) && clubOf(g.a) === clubOf(g.b)) out.push("Two players from the same club are paired.");
  }
  return [...new Set(out)];
}

// does every player appear exactly once?
function drawIsComplete(t, tables) {
  const seen = tables.flatMap(g => [g.a, g.b]).filter(x => x !== null);
  const active = t.players.filter(p => !p.dropped).map(p => p.pid);
  return seen.length === active.length && new Set(seen).size === seen.length && active.every(id => seen.includes(id));
}

if (typeof module !== "undefined") module.exports = { TIEBREAKERS, resultFromVp, wipedOut, tableLeft, decideResult, winTier, winPoints, gameRows, standings, makeRng, shuffle, gamesPlayed, pairPlayers, drawRound, roundWarnings, drawIsComplete };
