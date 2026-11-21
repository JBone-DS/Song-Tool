// Tournament page: player profiles, registering players and their locked lists, rounds, results and standings.
// The pairing and scoring maths is in tournament-core.js; list checking reuses the rules in app.js.
//
// Storage: everything lives in one object, `db`. It is kept in this browser (localStorage) and, when cloud-config.js is
// present, saved to the Supabase database too (cloud.js): organisers sign in, and anyone can open a tournament read-only
// with ?view=<id>. Without cloud-config.js the page works from this browser alone, with Export / Import for backup.
//   db = { version: 1, profiles: [ { id, name, club, country, faction } ],
//          tournaments: [ { id, name, date, location, points, plannedRounds, status, rules, players, rounds } ] }
// A player in a tournament is { pid (profile id), listCode (a share-link code), locked, dropped }.

const STORE_TOURNEY = "song-tool-tournaments";
const tstore = {
  load() { return storeGet(STORE_TOURNEY, null) ?? { version: 1, profiles: [], tournaments: [] }; },
  save(db) {
    const ok = storeSet(STORE_TOURNEY, db);
    if (cloud.enabled && cloud.user && !ui.viewer) cloud.schedule(db);   // sent to the database a moment later
    return ok;
  },
};

const emptyDb = () => ({ version: 1, profiles: [], tournaments: [] });
let db = emptyDb();
const ui = { viewer: false, viewerError: "", email: "", authMsg: "", legacy: null, tab: "tournaments", tid: null, sub: "players", msg: "", confirm: null, profileForm: null, listFor: null, openKills: null, newTournament: false, importText: null, drawWarnings: [] };

const uid = newId;   // ids are uuids, as the database needs
const profile = id => db.profiles.find(p => p.id === id);
const current = () => db.tournaments.find(t => t.id === ui.tid);
const nameOf = pid => profile(pid)?.name ?? "(removed player)";
const clubOf = pid => (profile(pid)?.club ?? "").trim().toLowerCase();
const facName = id => data.factionsById.get(id)?.name.replace(/^House /, "") ?? "";
const today = () => new Date().toISOString().slice(0, 10);
// the points of each row of a player's locked list, for scoring destroyed units
function rowPointsOf(t, pid) {
  const info = listInfo(t.players.find(p => p.pid === pid)?.listCode);
  return (info?.rows ?? []).map(r => (r ? r.withAttachments : 0));
}
// what the engine needs to know about each player's list: points per row, which rows are units, and points that start on the table
function ctx(t) {
  const info = pid => listInfo(t.players.find(p => p.pid === pid)?.listCode);
  return {
    rowPoints: pid => rowPointsOf(t, pid),
    unitRows: pid => (info(pid)?.rows ?? []).flatMap((r, i) => (r ? [i] : [])),
    tableStart: pid => { const i = info(pid); return i ? i.points - i.ncuPoints : 0; },   // army total less NCU costs
  };
}
const stand = t => standings(t, ctx(t));

function commit(msg = "") {
  ui.msg = msg;
  if (!tstore.save(db)) ui.msg = "Could not save: browser storage is full or blocked. Use Backup to export your data now.";
  render();
}
// number and result fields redraw after the click has settled, so tabbing between them keeps working
function commitLater() {
  tstore.save(db);
  setTimeout(render, 0);
}
// an action that needs a second click, like deleting
function sure(key, label, action, cls = "row-btn") {
  return el("button", { className: cls, textContent: ui.confirm === key ? "Click again to confirm" : label,
    onclick: () => { if (ui.confirm === key) { ui.confirm = null; action(); } else { ui.confirm = key; render(); } } });
}
const btn = (text, onclick, disabled = false) => el("button", { className: "row-btn", textContent: text, onclick, disabled });
const opt = (v, t, sel) => el("option", { value: v, textContent: t, selected: sel });
const field = (label, node) => el("label", {}, label + " ", node);
const textInput = (value, ph, onchange, w = 160) => el("input", { type: "text", value: value ?? "", placeholder: ph, className: "paste", style: `flex:0 1 ${w}px`, onchange: e => onchange(e.target.value) });

// ---- lists ----------------------------------------------------------------

const listCache = new Map();
// what the page shows about a list code: its faction, commander, points
function listInfo(code) {
  if (!code) return null;
  if (!listCache.has(code)) {
    const l = decodeList(code);
    // one entry per row of the list (null for an empty row): the unit, its points alone and with its attachments
    const rows = l ? l.entries.map((e, i) => {
      if (!e.unit) return null;
      const atts = attachmentCosts(e, l);
      return { unit: data.unitsById.get(e.unit), points: rowCost(l, i), withAttachments: rowCost(l, i) + atts.reduce((n, c) => n + c.cost, 0), attachments: atts.map(c => c.attachment.name) };
    }) : [];
    listCache.set(code, l ? { list: l, name: l.name, faction: facName(l.faction), commander: l.commander ? data.commandersById.get(l.commander)?.name : "", points: totalPoints(l), ncuPoints: l.ncus.reduce((n, id) => n + ncuCost(l, id), 0), rows } : null);
  }
  return listCache.get(code);
}
function codeFromText(text) {
  const t = text.trim();
  return t.includes("#list=") ? t.slice(t.indexOf("#list=") + 6) : t;
}
// problems that stop a list being locked into this tournament
function lockProblems(t, code) {
  const info = listInfo(code);
  if (!info) return ["There is no valid list to lock."];
  const out = validateList(info.list);
  if (info.list.gameSize !== t.points) out.unshift(`The list is built for ${info.list.gameSize} points, the tournament is ${t.points}`);
  return out;
}
const savedLists = () => storeGet(STORE_SAVED, []).map(s => { const l = sanitizeList(s.list); return { name: s.name, code: l ? encodeList(l) : "" }; }).filter(s => s.code);

// ---- profiles -------------------------------------------------------------

function profileRecord(pid) {
  const rec = { events: [], w: 0, d: 0, l: 0 };
  db.tournaments.forEach(t => {
    if (!t.players.some(p => p.pid === pid)) return;
    const s = stand(t).find(x => x.pid === pid);
    rec.events.push({ t, rank: s.rank, of: t.players.length, points: s.points });
    rec.w += s.w; rec.d += s.d; rec.l += s.l;
  });
  return rec;
}
function saveProfile() {
  const f = ui.profileForm;
  if (!f.name.trim()) { ui.msg = "A profile needs a name."; return render(); }
  if (db.profiles.some(p => p.id !== f.id && p.name.trim().toLowerCase() === f.name.trim().toLowerCase())) { ui.msg = "There is already a profile with that name."; return render(); }
  const clean = { id: f.id ?? uid(), name: f.name.trim(), club: f.club.trim(), country: f.country.trim(), faction: f.faction };
  const i = db.profiles.findIndex(p => p.id === clean.id);
  if (i >= 0) db.profiles[i] = clean; else db.profiles.push(clean);
  ui.profileForm = null;
  commit(`Saved ${clean.name}.`);
}
function renderProfiles() {
  const f = ui.profileForm;
  const form = f ? el("div", { className: "an-pick" },
    textInput(f.name, "Name", v => { f.name = v; }, 170), textInput(f.club, "Club", v => { f.club = v; }, 150), textInput(f.country, "Country", v => { f.country = v; }, 120),
    field("Favourite faction", el("select", { onchange: e => { f.faction = e.target.value; } }, opt("", "-", !f.faction), ...data.factions.map(x => opt(x.id, facName(x.id), f.faction === x.id)))),
    btn("Save profile", saveProfile), btn("Cancel", () => { ui.profileForm = null; ui.msg = ""; render(); })) : "";
  const rows = [...db.profiles].sort((a, b) => a.name.localeCompare(b.name)).map(p => {
    const rec = profileRecord(p.id), used = db.tournaments.some(t => t.players.some(x => x.pid === p.id));
    return el("tr", {}, el("td", { textContent: p.name }), el("td", { textContent: p.club || "-" }), el("td", { textContent: p.country || "-" }),
      el("td", { textContent: p.faction ? facName(p.faction) : "-" }), el("td", { textContent: rec.events.length }),
      el("td", { textContent: `${rec.w}-${rec.d}-${rec.l}` }),
      el("td", { className: "meta", textContent: rec.events.map(e => `${e.t.name}: ${e.rank}/${e.of}`).join("; ") || "-" }),
      el("td", { className: "tn-actions" }, btn("Edit", () => { ui.profileForm = { ...p }; ui.msg = ""; render(); }),
        used ? el("span", { className: "meta", textContent: "in an event" }) : sure(`delp:${p.id}`, "Delete", () => { db.profiles = db.profiles.filter(x => x.id !== p.id); commit(`Deleted ${p.name}.`); })));
  });
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Player profiles" }),
    el("p", { className: "meta", textContent: "A profile is a player you can register for any tournament. Club is used to avoid pairing clubmates in round one." }),
    f ? form : btn("New profile", () => { ui.profileForm = { id: null, name: "", club: "", country: "", faction: "" }; ui.msg = ""; render(); }),
    db.profiles.length ? el("div", { className: "table-wrap" }, el("table", { className: "an-table tn" },
      el("thead", {}, el("tr", {}, ...["Name", "Club", "Country", "Faction", "Events", "W-D-L", "Results", ""].map(h => el("th", { textContent: h })))),
      el("tbody", {}, ...rows))) : el("p", { className: "meta", textContent: "No profiles yet." }));
}

// ---- tournaments: list and creation ---------------------------------------

function createTournament(f) {
  if (!f.name.trim()) { ui.msg = "Give the tournament a name."; return render(); }
  const t = { id: uid(), name: f.name.trim(), date: f.date, location: f.location.trim(), points: f.points, plannedRounds: f.rounds, status: "setup",
    rules: { pairing: "swiss", avoidClub: true, win: 3, draw: 1, loss: 0, tiebreakers: ["sos", "vpDiff", "destroyed"],
      margins: { enabled: false, band: 2, marginalWin: 2, majorWin: 3 } }, players: [], rounds: [] };
  db.tournaments.push(t);
  ui.newTournament = false; ui.tid = t.id; ui.sub = "players";
  commit(`Created ${t.name}. Add players next.`);
}
let tform = { name: "", date: today(), location: "", points: 40, rounds: 3 };
function renderTournamentList() {
  const form = ui.newTournament ? el("div", { className: "an-pick" },
    textInput(tform.name, "Tournament name", v => { tform.name = v; }, 220), el("input", { type: "date", value: tform.date, onchange: e => { tform.date = e.target.value; } }),
    textInput(tform.location, "Location", v => { tform.location = v; }, 170),
    field("Points", el("select", { onchange: e => { tform.points = +e.target.value; } }, ...data.season.gameSize.map(n => opt(n, n, tform.points === n)))),
    field("Rounds", el("input", { type: "number", min: 1, max: 12, value: tform.rounds, style: "width:60px", onchange: e => { tform.rounds = Math.max(1, Math.min(12, +e.target.value || 3)); } })),
    btn("Create", () => createTournament(tform)), btn("Cancel", () => { ui.newTournament = false; ui.msg = ""; render(); })) : btn("New tournament", () => { ui.newTournament = true; ui.msg = ""; render(); });
  const rows = [...db.tournaments].reverse().map(t => el("tr", {}, el("td", { textContent: t.name }), el("td", { textContent: t.date || "-" }), el("td", { textContent: t.location || "-" }),
    el("td", { textContent: t.points }), el("td", { textContent: t.players.length }), el("td", { textContent: `${t.rounds.filter(r => r.done).length}/${t.plannedRounds}` }),
    el("td", { className: "cap", textContent: t.status }),
    el("td", { className: "tn-actions" }, btn("Open", () => { ui.tid = t.id; ui.sub = t.status === "setup" ? "players" : "rounds"; ui.msg = ""; ui.drawWarnings = []; render(); }),
      sure(`delt:${t.id}`, "Delete", () => { db.tournaments = db.tournaments.filter(x => x.id !== t.id); commit(`Deleted ${t.name}.`); }))));
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Tournaments" }), form,
    db.tournaments.length ? el("div", { className: "table-wrap" }, el("table", { className: "an-table tn" },
      el("thead", {}, el("tr", {}, ...["Name", "Date", "Location", "Points", "Players", "Rounds", "Status", ""].map(h => el("th", { textContent: h })))),
      el("tbody", {}, ...rows))) : el("p", { className: "meta", textContent: "No tournaments yet. Create one, then add players from your profiles." }));
}

// ---- one tournament: players ----------------------------------------------

const active = t => t.players.filter(p => !p.dropped);
let addForm = { pid: "", source: "", paste: "" };

function addPlayer(t) {
  if (!addForm.pid) { ui.msg = "Choose a player first."; return render(); }
  let code = "";
  if (addForm.source === "paste") {
    code = codeFromText(addForm.paste);
    if (!listInfo(code)) { ui.msg = "That doesn't look like a share link."; return render(); }
  } else if (addForm.source) code = savedLists().find(s => s.name === addForm.source)?.code ?? "";
  t.players.push({ pid: addForm.pid, listCode: code, locked: false, dropped: false });
  addForm = { pid: "", source: "", paste: "" };
  commit(`Added ${nameOf(t.players.at(-1).pid)}.`);
}
function lockList(t, p) {
  const problems = lockProblems(t, p.listCode);
  if (problems.length) { ui.msg = `${nameOf(p.pid)}'s list can't be locked: ${problems.join("; ")}.`; return render(); }
  p.locked = true;
  commit(`Locked ${nameOf(p.pid)}'s list.`);
}
function lockAll(t) {
  const bad = [];
  t.players.filter(p => !p.dropped && !p.locked).forEach(p => { const pr = lockProblems(t, p.listCode); if (pr.length) bad.push(`${nameOf(p.pid)} (${pr[0]})`); else p.locked = true; });
  commit(bad.length ? `Locked every list that could be. Still open: ${bad.join("; ")}.` : "Locked every list.");
}
function renderPlayers(t) {
  const free = db.profiles.filter(p => !t.players.some(x => x.pid === p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const ended = t.status === "finished";
  const add = ended ? "" : el("div", { className: "an-pick" },
    field("Player", el("select", { onchange: e => { addForm.pid = e.target.value; } }, opt("", free.length ? "- choose -" : "(add profiles first)", !addForm.pid), ...free.map(p => opt(p.id, p.name, addForm.pid === p.id)))),
    field("List", el("select", { onchange: e => { addForm.source = e.target.value; render(); } }, opt("", "add later", !addForm.source), opt("paste", "paste a share link", addForm.source === "paste"),
      ...savedLists().map(s => opt(s.name, `${s.name} (saved in this browser)`, addForm.source === s.name)))),
    addForm.source === "paste" ? el("input", { type: "text", className: "paste", placeholder: "Paste the share link", value: addForm.paste, onchange: e => { addForm.paste = e.target.value; } }) : "",
    btn("Add player", () => addPlayer(t)));
  const rows = t.players.map(p => {
    const info = listInfo(p.listCode), editing = ui.listFor === p.pid, started = t.rounds.length > 0;
    return [el("tr", { className: p.dropped ? "dropped" : "" }, el("td", { textContent: nameOf(p.pid) }), el("td", { textContent: profile(p.pid)?.club || "-" }),
      el("td", { textContent: info?.faction ?? "-" }), el("td", { textContent: info?.commander || (info ? "-" : "") }),
      el("td", { textContent: info ? `${info.points}/${info.list.gameSize}` : "-" }),
      el("td", { className: p.locked ? "ok" : "meta", textContent: p.locked ? "Locked" : info ? "Not locked" : "No list" }),
      el("td", { className: "tn-actions" },
        p.locked ? (started ? "" : btn("Unlock", () => { p.locked = false; commit(); })) : btn("Lock list", () => lockList(t, p), !info),
        info ? el("a", { className: "row-btn", href: `index.html#list=${p.listCode}`, target: "_blank", textContent: "View list" }) : "",
        p.locked ? "" : btn(editing ? "Close" : "Set list", () => { ui.listFor = editing ? null : p.pid; ui.msg = ""; render(); }),
        ended ? "" : btn(p.dropped ? "Reinstate" : "Drop", () => { p.dropped = !p.dropped; commit(); }),
        started || ended ? "" : sure(`remp:${p.pid}`, "Remove", () => { t.players = t.players.filter(x => x !== p); commit(); }))),
      editing ? el("tr", {}, el("td", { colSpan: 7 }, el("div", { className: "an-pick" },
        field("Saved list", el("select", { onchange: e => { const s = savedLists().find(x => x.name === e.target.value); if (s) { p.listCode = s.code; p.locked = false; ui.listFor = null; commit(`Set ${nameOf(p.pid)}'s list.`); } } },
          opt("", "- choose -", true), ...savedLists().map(s => opt(s.name, s.name, false)))),
        el("input", { type: "text", className: "paste", placeholder: "or paste a share link", onchange: e => {
          const code = codeFromText(e.target.value);
          if (!listInfo(code)) { ui.msg = "That doesn't look like a share link."; return render(); }
          p.listCode = code; p.locked = false; ui.listFor = null; commit(`Set ${nameOf(p.pid)}'s list.`); } })))) : ""];
  }).flat();
  return el("section", { className: "an-panel" }, el("h2", { textContent: `Players (${active(t).length} playing)` }),
    el("p", { className: "meta", textContent: `Lists must be built for ${t.points} points and pass every rule check. Locking stores the list for the event, so a player cannot change it after the tournament starts.` }),
    add, el("div", { className: "table-wrap" }, el("table", { className: "an-table tn" },
      el("thead", {}, el("tr", {}, ...["Player", "Club", "Faction", "Commander", "Points", "List", ""].map(h => el("th", { textContent: h })))),
      el("tbody", {}, ...rows))),
    t.players.length ? el("div", { className: "an-pick" }, btn("Lock every list", () => lockAll(t), ended)) : "");
}

// ---- one tournament: rules ------------------------------------------------

function renderRules(t) {
  const locked = t.rounds.length > 0, r = t.rules, m = r.margins ?? (r.margins = { enabled: false, band: 2, marginalWin: 2, majorWin: 3 });
  const num = (obj, key, label, off = false) => field(label, el("input", { type: "number", min: 0, value: obj[key], style: "width:60px", disabled: locked || off, onchange: e => { obj[key] = Math.max(0, +e.target.value || 0); commit(); } }));
  const tb = i => el("select", { disabled: locked, onchange: e => { const next = [...r.tiebreakers]; next[i] = e.target.value; r.tiebreakers = next.filter(Boolean).filter((k, j, a) => a.indexOf(k) === j); commit(); } },
    ...(i ? [opt("", "(none)", !r.tiebreakers[i])] : []), ...Object.entries(TIEBREAKERS).map(([k, label]) => opt(k, label, r.tiebreakers[i] === k)));
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Rules" }),
    el("p", { className: "meta", textContent: locked ? "The rules are fixed once the first round is drawn." : "Set these before drawing round one." }),
    el("div", { className: "an-pick" },
      field("Pairing", el("select", { disabled: locked, onchange: e => { r.pairing = e.target.value; commit(); } }, opt("swiss", "Swiss (by standings)", r.pairing === "swiss"), opt("random", "Random every round", r.pairing === "random"))),
      field("Avoid clubmates", el("input", { type: "checkbox", checked: r.avoidClub, disabled: locked, onchange: e => { r.avoidClub = e.target.checked; commit(); } })),
      field("Rounds", el("input", { type: "number", min: 1, max: 12, value: t.plannedRounds, style: "width:60px", onchange: e => { t.plannedRounds = Math.max(Math.max(1, t.rounds.length), Math.min(12, +e.target.value || 3)); commit(); } }))),
    el("h3", { textContent: "Victories" }),
    el("div", { className: "an-pick" },
      field("Marginal and major victories", el("input", { type: "checkbox", checked: m.enabled, disabled: locked, onchange: e => { m.enabled = e.target.checked; commit(); } })),
      m.enabled ? num(m, "band", "A win by this many VP or fewer is marginal") : ""),
    el("h3", { textContent: "Tournament points awarded" }),
    el("div", { className: "an-pick" },
      ...(m.enabled ? [num(m, "majorWin", "Pts per Major Win"), num(m, "marginalWin", "Pts per Marginal Win")] : [num(r, "win", "Pts per Win")]),
      num(r, "draw", "Pts per Draw"), num(r, "loss", "Pts per Loss")),
    el("p", { className: "meta", textContent: "A bye counts as a " + (m.enabled ? "major win" : "win") + ". Bonus points can be added to any game." }),
    el("h3", { textContent: "Tie-breakers" }),
    el("div", { className: "an-pick" }, field("1st", tb(0)), field("2nd", tb(1)), field("3rd", tb(2)), field("4th", tb(3))));
}

// ---- one tournament: rounds -----------------------------------------------

function startTournament(t) {
  const act = active(t);
  if (act.length < 2) { ui.msg = "At least two players are needed."; return render(); }
  const open = act.filter(p => !p.locked).map(p => nameOf(p.pid));
  if (open.length) { ui.msg = `Lock every list first. Not locked: ${open.join(", ")}.`; return render(); }
  t.status = "running"; ui.sub = "rounds";
  drawNext(t);
}
function drawNext(t) {
  const notLocked = active(t).filter(p => !p.locked).map(p => nameOf(p.pid));
  if (notLocked.length) { ui.msg = `Lock every list first. Not locked: ${notLocked.join(", ")}.`; return render(); }
  const tables = drawRound(t, clubOf, Date.now(), ctx(t));
  t.rounds.push({ n: t.rounds.length + 1, done: false, tables });
  ui.drawWarnings = roundWarnings({ ...t, rounds: t.rounds.slice(0, -1) }, tables, clubOf);
  commit(`Round ${t.rounds.length} drawn.`);
}
function redraw(t) {
  const round = t.rounds.at(-1);
  round.tables = drawRound({ ...t, rounds: t.rounds.slice(0, -1) }, clubOf, Date.now(), ctx(t));
  ui.drawWarnings = roundWarnings({ ...t, rounds: t.rounds.slice(0, -1) }, round.tables, clubOf);
  commit(`Redrew round ${round.n}.`);
}
// put a player in a seat; whoever held that seat swaps places with them
function setSeat(round, table, side, pid) {
  const other = side === "a" ? "b" : "a";
  const old = table[side];
  const reset = g => { g.killedByA = []; g.killedByB = []; g.result = null; g.manual = false; };   // a new opponent means the old game record no longer applies
  if (pid === table[other]) { table[other] = old; table[side] = pid; reset(table); return; }
  for (const g of round.tables) for (const s of ["a", "b"]) if (g !== table || s !== side) if (g[s] === pid) { g[s] = old; reset(g); }
  table[side] = pid; reset(table);
}
// The result follows the game record unless the organiser has picked one by hand (table.manual).
function autoResult(t, g) {
  if (g.b !== null && !g.manual) g.result = decideResult(g, ctx(t)).result;
}
function setResult(t, g, value) {
  if (value === "auto") { g.manual = false; autoResult(t, g); }
  else { g.manual = true; g.result = value || null; }
}
function setNum(t, table, key, raw) {
  table[key] = raw === "" ? null : Math.max(0, Math.round(+raw));
  if (key === "vpA" || key === "vpB") autoResult(t, table);
  commitLater();
}
// ---- units destroyed: a checklist of the enemy army's units, crossed off as they die ----
function toggleKill(t, g, key, i) {
  const now = new Set(g[key] ?? []);
  if (now.has(i)) now.delete(i); else now.add(i);
  g[key] = [...now].sort((a, b) => a - b);
  autoResult(t, g);
  commit(ui.msg);
}
const killedPoints = (t, g, side) => {   // points of the enemy army that `side` has destroyed in this game
  const opp = side === "a" ? g.b : g.a, pts = rowPointsOf(t, opp);
  return (g[side === "a" ? "killedByA" : "killedByB"] ?? []).reduce((n, i) => n + (pts[i] ?? 0), 0);
};
function killList(t, g, side, editable) {
  const opp = side === "a" ? g.b : g.a, key = side === "a" ? "killedByA" : "killedByB";
  const info = listInfo(t.players.find(p => p.pid === opp)?.listCode);
  const head = el("h4", { textContent: `${nameOf(side === "a" ? g.a : g.b)} destroyed ${killedPoints(t, g, side)} points of ${nameOf(opp)}'s army` });
  if (!info) return el("div", { className: "kill-box" }, head, el("p", { className: "meta", textContent: "This player has no list on file." }));
  const dead = new Set(g[key] ?? []);
  const tiles = info.rows.map((row, i) => {
    if (!row) return null;
    const shown = row.withAttachments;
    const tile = el("button", { className: "kill-tile" + (dead.has(i) ? " dead" : ""), disabled: !editable, onclick: () => toggleKill(t, g, key, i),
      title: [row.unit.name, ...row.attachments].join(" + ") + ` (${shown} points)${dead.has(i) ? " - destroyed" : ""}` });
    const img = el("img", { src: `images/units/${row.unit.id}.jpg`, alt: "" });
    img.onerror = () => { img.remove(); tile.classList.add("noart"); };
    tile.append(img, el("span", { className: "kill-name", textContent: row.unit.name }), el("span", { className: "kill-pts", textContent: `${shown} pts` }));
    return tile;
  }).filter(Boolean);
  return el("div", { className: "kill-box" }, head, el("div", { className: "kill-grid" }, ...tiles));
}

function renderRound(t, round) {
  const editable = !ui.viewer && !round.done && t.status === "running";
  const players = t.players.map(p => p.pid);
  const seat = (g, side) => editable ? el("select", { id: `seat-${round.n}-${g.id}-${side}`, onchange: e => { setSeat(round, g, side, e.target.value); commit(); } },
    ...players.map(pid => opt(pid, nameOf(pid) + (t.players.find(p => p.pid === pid).dropped ? " (dropped)" : ""), g[side] === pid))) : el("span", { textContent: nameOf(g[side]) });
  const numField = (g, key) => editable ? el("input", { type: "number", min: 0, id: `${key}-${round.n}-${g.id}`, value: g[key] ?? "", style: "width:52px", onchange: e => setNum(t, g, key, e.target.value) }) : el("span", { textContent: g[key] ?? "" });
  const BASIS = { wipeout: "army wiped out", vp: "victory points", table: "points on the table", tied: "level on points on the table" };
  const tierText = g => {
    const tier = winTier(g, t.rules, ctx(t)), basis = g.manual || !g.result ? "" : BASIS[decideResult(g, ctx(t)).basis] ?? "";
    return [tier, basis].filter(Boolean).length ? ` (${[tier, basis].filter(Boolean).join(", ")})` : "";
  };
  const rows = round.tables.flatMap(g => {
    if (g.b === null) return [el("tr", {}, el("td", { textContent: g.id }), el("td", {}, seat(g, "a")), el("td", { colSpan: 6, className: "meta", textContent: "Bye (counts as a win)" }))];
    const key = `${round.n}-${g.id}`, isOpen = ui.openKills === key;
    const c = ctx(t), left = side => (c.tableStart(side === "a" ? g.a : g.b) - killedPoints(t, g, side === "a" ? "b" : "a"));
    const done = `${nameOf(g.a)} destroyed ${killedPoints(t, g, "a")} pts (${left("b")} left on ${nameOf(g.b)}'s table), ${nameOf(g.b)} destroyed ${killedPoints(t, g, "b")} pts (${left("a")} left on ${nameOf(g.a)}'s table)`;
    return [el("tr", {}, el("td", { textContent: g.id }), el("td", {}, seat(g, "a")), el("td", {}, numField(g, "vpA")), el("td", {}, numField(g, "bonusA")),
      el("td", {}, seat(g, "b")), el("td", {}, numField(g, "vpB")), el("td", {}, numField(g, "bonusB")),
      el("td", {}, editable ? el("span", {}, el("select", { id: `res-${round.n}-${g.id}`, onchange: e => { setResult(t, g, e.target.value); commitLater(); } },
        opt("auto", g.manual || !g.result ? "Automatic" : "Automatic (from the game)", !g.manual), opt("", "- no result -", g.manual && !g.result), opt("a", `${nameOf(g.a)} wins`, g.result === "a"), opt("draw", "Draw", g.result === "draw"), opt("b", `${nameOf(g.b)} wins`, g.result === "b")),
        el("span", { className: "meta", textContent: tierText(g) }))
        : el("span", { textContent: (g.result === "a" ? `${nameOf(g.a)} wins` : g.result === "b" ? `${nameOf(g.b)} wins` : g.result === "draw" ? "Draw" : "") + tierText(g) }))),
    el("tr", { className: "kills-row" }, el("td"), el("td", { colSpan: 7 },
      el("button", { className: "row-btn", textContent: `${isOpen ? "Hide" : "Units destroyed"}: ${done}`, onclick: () => { ui.openKills = isOpen ? null : key; render(); } }),
      isOpen ? el("div", { className: "kill-pair" }, killList(t, g, "a", editable), killList(t, g, "b", editable)) : ""))];
  });
  return el("div", { className: "table-wrap" }, el("table", { className: "an-table tn rnd" },
    el("thead", {}, el("tr", {}, ...["Table", "Player A", "VP", "Bonus", "Player B", "VP", "Bonus", "Result"].map(h => el("th", { textContent: h })))), el("tbody", {}, ...rows)));
}
function renderRounds(t) {
  const last = t.rounds.at(-1), parts = [el("h2", { textContent: "Rounds" })];
  const played = t.rounds.filter(r => r.done).length;
  if (t.status === "setup") {
    parts.push(el("p", { className: "meta", textContent: `${active(t).length} players registered. Starting locks the rules and draws round one.` }),
      btn("Start tournament and draw round 1", () => startTournament(t), t.status !== "setup"));
  } else {
    parts.push(el("p", { className: "meta", textContent: `Round ${played} of ${t.plannedRounds} complete${t.status === "finished" ? ". The tournament is finished." : "."}` }));
    const unfinished = last && !last.done ? last.tables.filter(g => g.b !== null && !g.result).length : 0;
    const results = last && !last.done ? last.tables.some(g => g.b !== null && g.result) : false;
    // with marginal / major victories the margin must be known, so both victory point totals are needed for every decided game
    const missingVp = last && !last.done && t.rules.margins?.enabled
      ? last.tables.filter(g => g.b !== null && (g.result === "a" || g.result === "b") && !(Number.isFinite(g.vpA) && Number.isFinite(g.vpB))
        && !(wipedOut(g, "a", ctx(t)) || wipedOut(g, "b", ctx(t)))).length : 0;   // a wipe-out is a major win whatever the VP
    const bar = [];
    if (last && !last.done) {
      bar.push(btn("Finish round", () => {
          if (!drawIsComplete(t, last.tables)) { ui.msg = "Every playing player must be seated exactly once. Check the seats below."; return render(); }
          last.done = true; ui.drawWarnings = []; ui.openKills = null; commit(`Round ${last.n} finished.`); }, unfinished > 0 || missingVp > 0),
        btn("Redraw round", () => redraw(t), results));
      if (unfinished) bar.push(el("span", { className: "meta", textContent: `${unfinished} table${unfinished > 1 ? "s" : ""} still need a result.` }));
      else if (missingVp) bar.push(el("span", { className: "meta", textContent: `Enter both players' victory points on ${missingVp} table${missingVp > 1 ? "s" : ""} so the margin of victory is known.` }));
    } else if (t.status === "running") {
      bar.push(btn(played < t.plannedRounds ? `Draw round ${t.rounds.length + 1}` : `Draw an extra round (${t.rounds.length + 1})`, () => drawNext(t)));
      bar.push(btn("Reopen last round", () => { last.done = false; commit(`Round ${last.n} reopened.`); }, !last));
      if (played >= t.plannedRounds) bar.push(sure("fin", "Finish tournament", () => { t.status = "finished"; ui.sub = "standings"; commit("Tournament finished."); }));
    } else bar.push(btn("Reopen tournament", () => { t.status = "running"; commit("Tournament reopened."); }));
    parts.push(el("div", { className: "an-pick tn-bar" }, ...bar));
    if (ui.drawWarnings.length && last && !last.done) parts.push(el("p", { className: "warn", textContent: ui.drawWarnings.join(" ") + " It could not be avoided with the players available. You can edit the seats below." }));
    if (last && !last.done) parts.push(el("p", { className: "meta", textContent: "Change a seat to swap two players. Enter victory points (the result fills in) or pick the result yourself. Bonus points are added to a player's tournament points. Open \"Units destroyed\" on a table to cross off the enemy units each player destroyed; their points feed the tie-breaker." }));
    [...t.rounds].reverse().forEach((r, i) => parts.push(el("details", { open: i === 0 }, el("summary", { textContent: `Round ${r.n}${r.done ? "" : " (in progress)"}` }), renderRound(t, r))));
  }
  return el("section", { className: "an-panel" }, ...parts);
}

// ---- one tournament: standings --------------------------------------------

function csvOf(t) {
  const q = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = [["Rank", "Player", "Club", "Faction", "Points", "Played", "W", "D", "L", "Major wins", "Strength of schedule", "VP difference", "VP scored", "Points destroyed", "Points lost"].map(q).join(",")];
  stand(t).forEach(s => {
    const info = listInfo(t.players.find(p => p.pid === s.pid)?.listCode);
    lines.push([s.rank, nameOf(s.pid), profile(s.pid)?.club, info?.faction, s.points, s.played, s.w, s.d, s.l, s.majors, s.sos.toFixed(2), s.vpDiff, s.vp, s.destroyed, s.lost].map(q).join(","));
  });
  return lines.join("\r\n");
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function renderStandings(t) {
  const st = stand(t), done = t.rounds.filter(r => r.done).length;
  const rows = st.map(s => {
    const info = listInfo(t.players.find(p => p.pid === s.pid)?.listCode);
    return el("tr", { className: s.dropped ? "dropped" : s.rank === 1 && done ? "hot" : "" }, el("td", { textContent: s.rank }), el("td", { textContent: nameOf(s.pid) }),
      el("td", { textContent: profile(s.pid)?.club || "-" }), el("td", { textContent: info?.faction ?? "-" }), el("td", { textContent: s.points }),
      el("td", { textContent: `${s.w}-${s.d}-${s.l}` }), ...(t.rules.margins?.enabled ? [el("td", { textContent: s.majors })] : []),
      el("td", { textContent: s.sos.toFixed(2) }), el("td", { textContent: s.vpDiff > 0 ? `+${s.vpDiff}` : s.vpDiff }), el("td", { textContent: s.vp }),
      el("td", { textContent: s.destroyed }), el("td", { textContent: s.lost }));
  });
  return el("section", { className: "an-panel" }, el("h2", { textContent: t.status === "finished" ? "Final standings" : "Standings" }),
    el("p", { className: "meta", textContent: done ? `After ${done} round${done > 1 ? "s" : ""}. Open games are not counted yet.` : "No rounds finished yet." }),
    el("div", { className: "table-wrap" }, el("table", { className: "an-table tn stand" },
      el("thead", {}, el("tr", {}, ...["Rank", "Player", "Club", "Faction", "Pts", "W-D-L", ...(t.rules.margins?.enabled ? ["Major wins"] : []), "SoS", "VP diff", "VP", "Destroyed", "Lost"].map(h => el("th", { textContent: h })))), el("tbody", {}, ...rows))),
    btn("Export standings (CSV)", () => download(`${t.name.replace(/[^\w-]+/g, "_")}-standings.csv`, csvOf(t), "text/csv")));
}

function renderTournament(t) {
  const subs = ui.viewer ? [["standings", "Standings"], ["rounds", "Rounds"]] : [["players", "Players"], ["rules", "Rules"], ["rounds", "Rounds"], ["standings", "Standings"]];
  const link = `${location.origin}${location.pathname}?view=${t.id}`;
  const share = cloud.enabled && !ui.viewer ? el("div", { className: "an-pick" },
    el("span", { className: "meta", textContent: t.isPublic === false ? "Private: only you can see this tournament." : `Public link for players: ${link}` }),
    t.isPublic === false ? "" : btn("Copy link", async () => { try { await navigator.clipboard.writeText(link); ui.msg = "Link copied."; } catch { ui.msg = "Could not copy. Select the link and copy it by hand."; } render(); }),
    btn(t.isPublic === false ? "Make public" : "Make private", () => { t.isPublic = t.isPublic === false; commit(t.isPublic ? "Anyone with the link can now view this tournament." : "This tournament is now private."); })) : "";
  const head = el("section", { className: "an-panel" }, el("h2", { textContent: t.name }),
    el("p", { className: "meta", textContent: [t.date, t.location, `${t.points} points`, `${t.plannedRounds} rounds`, t.status].filter(Boolean).join(" - ") }),
    share,
    el("div", { className: "site-nav" }, ...subs.map(([k, label]) => el("a", { href: "#", className: ui.sub === k ? "nav-link current" : "nav-link", textContent: label,
      onclick: e => { e.preventDefault(); ui.sub = k; ui.msg = ""; render(); } })), ui.viewer ? "" : el("a", { href: "#", className: "nav-link", textContent: "All tournaments",
      onclick: e => { e.preventDefault(); ui.tid = null; ui.msg = ""; render(); } })));
  const body = ui.viewer ? (ui.sub === "rounds" ? renderViewerRounds : renderStandings)
    : { players: renderPlayers, rules: renderRules, rounds: renderRounds, standings: renderStandings }[ui.sub];
  return [head, body(t)];
}
// the read-only rounds list for people viewing a public link
function renderViewerRounds(t) {
  const rounds = [...t.rounds].reverse();
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Rounds" }),
    rounds.length ? "" : el("p", { className: "meta", textContent: "No rounds drawn yet." }),
    ...rounds.map((r, i) => el("details", { open: i === 0 }, el("summary", { textContent: `Round ${r.n}${r.done ? "" : " (in progress)"}` }), renderRound(t, r))));
}

// ---- backup ---------------------------------------------------------------

function renderBackup() {
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Backup" }),
    el("p", { className: "meta", textContent: cloud.enabled ? "Your tournaments are saved to your account as you work. A file copy is still handy as an extra backup, and Import restores one (it replaces what is in your account)."
      : "Tournament data is stored only in this browser. Export a file after each round, and use Import to move it to another device or restore it." }),
    el("div", { className: "an-pick" },
      btn("Export everything", () => download(`song-tool-tournaments-${today()}.json`, JSON.stringify(db, null, 1), "application/json")),
      el("label", {}, "Import a file ", el("input", { type: "file", accept: ".json,application/json", onchange: async e => {
        try {
          const parsed = JSON.parse(await e.target.files[0].text());
          if (!Array.isArray(parsed.profiles) || !Array.isArray(parsed.tournaments)) throw new Error("shape");
          ui.importText = parsed; ui.msg = `The file has ${parsed.profiles.length} profiles and ${parsed.tournaments.length} tournaments. Importing replaces what is here now.`;
        } catch { ui.importText = null; ui.msg = "That file is not a Song Tool tournament export."; }
        render(); } })),
      ui.importText ? sure("import", "Replace my data with the file", () => { db = cloud.enabled ? withUuids(ui.importText) : ui.importText; ui.importText = null; ui.tid = null; commit("Imported."); }) : ""),
    el("p", { className: "meta", textContent: `Stored now: ${db.profiles.length} profiles and ${db.tournaments.length} tournaments.` }));
}

// ---- page -----------------------------------------------------------------

// ---- accounts ----

const statusText = () => `Signed in as ${cloud.user?.email ?? ""}. ` + ({ saving: "Saving...", saved: "All changes saved to your account.", offline: "Not saved yet. It will retry when the connection is back." }[cloud.status] ?? "Connected.");
const showStatus = () => { const n = document.getElementById("cloud-status"); if (n) n.textContent = statusText(); };   // updates in place, so typing is not interrupted

function renderSignIn() {
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Organiser sign-in" }),
    el("p", { className: "meta", textContent: "Sign in with your email address to run tournaments. We email you a link, so there is no password. Players do not need an account: share a tournament's public link with them instead." }),
    el("div", { className: "an-pick" },
      el("input", { type: "email", id: "signin-email", className: "paste", placeholder: "you@example.com", value: ui.email, style: "flex:0 1 260px", onchange: e => { ui.email = e.target.value; } }),
      btn("Email me a sign-in link", async () => {
        const email = document.getElementById("signin-email").value.trim();
        if (!email) { ui.authMsg = "Enter your email address."; return render(); }
        ui.email = email; ui.authMsg = "Sending...";  render();
        try { await cloud.signIn(email); ui.authMsg = `Check your email (${email}) and open the link in this browser.`; }
        catch (err) { ui.authMsg = `Could not send the link: ${err.message}`; }
        render(); })),
    ui.authMsg ? el("p", { className: "meta", textContent: ui.authMsg }) : "");
}
async function signOut() {
  try { if (!(await cloud.signOut())) { ui.msg = "Some changes have not reached your account yet. Try again when you are back online."; return render(); } }
  catch (err) { ui.msg = `Could not sign out: ${err.message}`; return render(); }
  db = emptyDb(); ui.tid = null; ui.msg = ""; ui.authMsg = ""; render();
}
// browser-only data from before accounts existed, offered for upload once
function renderLegacy() {
  const old = ui.legacy;
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Data found in this browser" }),
    el("p", { className: "meta", textContent: `This browser holds ${old.profiles.length} profiles and ${old.tournaments.length} tournaments saved before accounts. Upload them to your account to keep and share them.` }),
    el("div", { className: "an-pick" }, btn("Upload to my account", () => {
      const fixed = withUuids(old);
      db = { ...db, profiles: [...db.profiles, ...fixed.profiles], tournaments: [...db.tournaments, ...fixed.tournaments] };
      storeSet(LEGACY_KEY, null); ui.legacy = null;
      commit(`Uploaded ${fixed.profiles.length} profiles and ${fixed.tournaments.length} tournaments.`); }),
      btn("Not now", () => { ui.legacy = null; render(); })));
}

function renderPage() {
  if (ui.viewer) return [...renderNav("tournament"), ui.viewerError ? el("p", { className: "an-panel tn-msg", textContent: ui.viewerError }) : current() ? [...renderTournament(current())] : el("p", { className: "meta", textContent: "Loading..." })].flat();
  if (cloud.enabled && !cloud.user) return [...renderNav("tournament"), renderSignIn()];
  const tabs = [["tournaments", "Tournaments"], ["profiles", "Profiles"], ["backup", "Backup"]];
  const t = ui.tab === "tournaments" && ui.tid ? current() : null;
  if (ui.tab === "tournaments" && ui.tid && !t) ui.tid = null;
  const body = ui.tab === "profiles" ? [renderProfiles()] : ui.tab === "backup" ? [renderBackup()] : t ? renderTournament(t) : [renderTournamentList()];
  return [...renderNav("tournament"),
    cloud.enabled ? el("div", { className: "an-panel tn-account" }, el("span", { id: "cloud-status", className: "meta", textContent: statusText() }), btn("Sign out", signOut)) : "",
    ui.legacy ? renderLegacy() : "",
    el("div", { className: "site-nav" }, ...tabs.map(([k, label]) => el("a", { href: "#", className: ui.tab === k ? "nav-link current" : "nav-link", textContent: label,
      onclick: e => { e.preventDefault(); ui.tab = k; ui.msg = ""; ui.confirm = null; render(); } }))),
    ui.msg ? el("p", { className: "an-panel tn-msg", textContent: ui.msg }) : "", ...body];
}
function render() {
  const focus = document.activeElement?.id, pos = document.activeElement?.selectionStart;
  document.getElementById("app").replaceChildren(...renderPage());
  if (focus) { const n = document.getElementById(focus); if (n) { n.focus(); try { if (pos != null) n.setSelectionRange(pos, pos); } catch { /* number inputs have no selection */ } } }
}

// Load the signed-in organiser's data. If an earlier change never reached the database (the page was closed offline), that local copy wins and is sent now.
async function loadAccount() {
  const local = tstore.load(), hasLocal = local.profiles.length || local.tournaments.length;
  try {
    const remote = await cloud.pull();
    if (cloud.dirty() && hasLocal) { db = local; cloud.schedule(db); }
    else {
      // first sign-in on a browser that already holds pre-account data: keep a copy and offer to upload it
      if (hasLocal && !remote.profiles.length && !remote.tournaments.length && !storeGet(LEGACY_KEY, null)) storeSet(LEGACY_KEY, local);
      db = remote; tstore.save(db); cloud.status = "saved";
    }
  } catch (err) {
    console.error("Could not reach the database:", err);
    db = local; cloud.status = "offline";   // work from this browser's copy; changes upload when the connection returns
    ui.msg = "Could not reach your account, so this is the copy saved in this browser.";
    if (cloud.dirty()) cloud.schedule(db);
  }
  ui.legacy = storeGet(LEGACY_KEY, null);
}
async function onAuth() {
  ui.msg = ""; ui.tid = null;
  if (cloud.user) await loadAccount(); else db = emptyDb();
  render();
}
// the read-only page for a public link, kept up to date as the organiser enters results
async function openViewer(id) {
  ui.viewer = true; ui.tid = id; ui.sub = "standings";
  const show = pub => { db = { version: 1, ...pub }; };
  const pub = await cloud.pullPublic(id);
  if (!pub) ui.viewerError = "This tournament is not available. The link may be wrong, or the organiser may have made it private.";
  else { show(pub); cloud.watch(id, async () => { try { const p = await cloud.pullPublic(id); if (p) { show(p); render(); } } catch { /* keep showing the last copy */ } }); }
  render();
}

async function startTournamentPage() {
  try {
    data = await loadData();
    if (!cloud.enabled) { db = tstore.load(); return render(); }
    cloud.onStatus = showStatus;
    await cloud.init(onAuth);
    const view = new URLSearchParams(location.search).get("view");
    if (view) await openViewer(view);
    else { if (cloud.user) await loadAccount(); render(); }
  } catch (err) {
    console.error("Tournament page failed to start:", err);
    document.getElementById("app").textContent = cloud.enabled ? `Could not start: ${err.message}` : "Could not load the data.";
  }
}
startTournamentPage();
