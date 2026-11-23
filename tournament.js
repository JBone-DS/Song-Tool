// Tournament page: a directory of tournaments, player profiles, joining and approving, army lists, rounds, results and standings.
// The pairing and scoring maths is in tournament-core.js; list checking reuses the rules in app.js.
//
// Everything is stored in a Supabase database (cloud.js, schema.sql). People sign in with an email link and have one profile each.
//  - Anyone can browse the directory and open a tournament (read-only) without an account.
//  - A signed-in player asks to join; the organiser approves or declines. Players set their army list; the organiser locks lists,
//    which stops changes; an opponent sees both lists once they are matched, and everyone does when the tournament finishes.
//  - The organiser runs the rounds and can change anything; the two players in a game can report its victory points and
//    destroyed units while the round is open.
// The page works on one tournament at a time, `ui.t` (see cloud-core.js for its shape). The organiser's edits to it are saved
// with `commit`; a player's reports with `cloud.reportGame`.

let me = null;                      // my profile once I have made one
const people = new Map();           // profile id -> profile, for everyone seen on screen
const ui = {
  tab: "directory", tid: null, t: null, sub: "overview", msg: "", confirm: null, email: "", authMsg: "",
  dir: null, dirQ: "", dirOpen: false, mine: null, loading: false, profileForm: null, newTournament: false,
  openKills: null, drawWarnings: [], stopWatching: null, renderPending: false, pasteList: "",
};

const profile = id => people.get(id);
// the profile page shows me, or another player when ui.viewing is set (?player=<id>, from the Rankings search)
const subjectId = () => ui.viewing ?? myId();
const viewingMe = () => !ui.viewing || ui.viewing === myId();
const ofSubject = (mine, other) => (viewingMe() ? mine : other(nameOf(subjectId())));
const current = () => ui.t;
const nameOf = pid => displayName(profile(pid)) || "(unknown player)";        // the public name: the nickname
const matchOf = pid => matchName(profile(pid)) || "(unknown player)";          // nickname plus real name, for match-ups and game history
const clubOf = pid => (profile(pid)?.club ?? "").trim().toLowerCase();
const facName = id => data.factionsById.get(id)?.name.replace(/^House /, "") ?? "";
const today = () => new Date().toISOString().slice(0, 10);
const myId = () => cloud.user?.id ?? null;
const isOrganiser = t => !!t && !!myId() && t.owner === myId();
const myEntry = t => (myId() ? t.players.find(p => p.pid === myId()) ?? t.requests.find(p => p.pid === myId()) ?? null : null);
const active = t => t.players.filter(p => !p.dropped);
// ---- team events (see the team section of tournament-core.js)
const isTeam = t => t?.format === "team";
const teamOf = (t, pid) => (t.players.find(p => p.pid === pid) ?? t.requests.find(p => p.pid === pid))?.teamId ?? null;
const teamById = (t, id) => (t.teams ?? []).find(x => x.id === id);
const teamLabel = (t, id) => teamById(t, id)?.name ?? "(team)";
const myTeam = t => { const e = myEntry(t); return e?.teamId ? teamById(t, e.teamId) ?? null : null; };
// the people on a team: approved players still playing and people still waiting (not declined)
const teamMembers = (t, id) => [...t.players.filter(p => !p.dropped).map(p => ({ ...p, status: "approved", teamOk: true })), ...t.requests.filter(r => r.status !== "declined")].filter(p => p.teamId === id);
const teamNote = t => (isTeam(t) ? el("p", { className: "team-note", textContent: `This is a team event (teams of up to ${t.teamSize}). Players are to assign a team captain, and that player applies for entry for the squad as a whole.` }) : "");
// a tournament counts for ratings if it has at least this many players (the database decides for real; the site
// administrator can override it)
const MIN_RATED_PLAYERS = 16;
const PROVISIONAL = PROVISIONAL_GAMES;
const ratedNow = t => t.players.length >= MIN_RATED_PLAYERS;
// the plain message from a database error
const problem = err => (err?.message ?? String(err)).replace(/^.*?:\s*(?=[A-Z])/, "");

// the points of each row of a player's locked list, for scoring destroyed units
function rowPointsOf(t, pid, g) {
  const info = infoFor(t, pid, g);
  return (info?.rows ?? []).map(r => (r ? r.withAttachments : 0));
}
// what the engine needs to know about each player's list: points per row, which rows are units, and points that start on the table
function ctx(t) {
  const info = (pid, g) => infoFor(t, pid, g);   // the list that player played in that game
  return {
    rowPoints: (pid, g) => rowPointsOf(t, pid, g),
    unitRows: (pid, g) => (info(pid, g)?.rows ?? []).flatMap((r, i) => (r ? [i] : [])),
    tableStart: (pid, g) => { const i = info(pid, g); return i ? i.points - i.ncuPoints : 0; },   // army total less NCU costs
  };
}
const stand = t => standings(t, ctx(t));


function commit(msg = "", g) {
  ui.msg = msg;
  persist(g);
  render();
}
// number and result fields redraw after the click has settled, so tabbing between them keeps working
function commitLater(g) {
  persist(g);
  setTimeout(render, 0);
}
// save what was just changed: the organiser's edits to the tournament, or a player's report of their game
function persist(g) {
  const t = ui.t;
  if (!t) return;
  if (isOrganiser(t)) cloud.schedule(t); else if (g) cloud.reportGame(g);
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
// faction, commander and points of a list code, stored with the tournament entry so records can be kept per faction
function listMeta(code) {
  const l = code ? decodeList(code) : null;
  return l ? { faction: l.faction, commander: l.commander || null, points: totalPoints(l) } : {};
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
// ---- two lists per player ---------------------------------------------------
// Every player enters two lists of one faction (they may be the same list twice) and, for each game, secretly locks in one of them.
const entryCodes = p => [p?.listCode ?? null, p?.listCode2 ?? null];
const listCodeOf = (p, slot) => (slot === 2 ? p?.listCode2 : p?.listCode) ?? null;
// the list a player plays in a game: the one they locked in (their first list until they have)
function gameListCode(t, g, pid) {
  const p = t.players.find(x => x.pid === pid);
  return listCodeOf(p, (g.a === pid ? g.pickA : g.pickB) ?? 1);
}
const infoFor = (t, pid, g) => listInfo(g ? gameListCode(t, g, pid) : t.players.find(p => p.pid === pid)?.listCode);
const bothLocked = g => g.b === null || !!(g.lockedA && g.lockedB);
// what is wrong with a player's pair of lists (empty when fine)
function entryProblems(t, p) {
  const [c1, c2] = entryCodes(p), out = [];
  if (!c1) return ["no list"];
  if (!c2) out.push("no second list");
  for (const [n, c] of [[1, c1], [2, c2]]) if (c) out.push(...lockProblems(t, c).map(x => (c2 ? `List ${n}: ` : "") + x));
  const f1 = listInfo(c1)?.list.faction, f2 = c2 ? listInfo(c2)?.list.faction : f1;
  if (f1 && f2 && f1 !== f2) out.push("both lists must be of the same faction");
  return out;
}
// "View list" links: one when both lists are the same list, otherwise one for each
function listLinks(p) {
  const [c1, c2] = entryCodes(p), link = (code, label) => el("a", { className: "row-btn", href: `index.html#list=${code}`, target: "_blank", textContent: label });
  if (!c1) return [];
  return c2 && c2 !== c1 ? [link(c1, "View list 1"), link(c2, "View list 2")] : [link(c1, "View list")];
}
const listsSummary = p => {
  const [c1, c2] = entryCodes(p);
  if (!c1) return "No list yet";
  if (!c2) return `${listSummary(c1)} (second list missing)`;
  return c2 === c1 ? `${listSummary(c1)} (both lists)` : `1: ${listSummary(c1)}; 2: ${listSummary(c2)}`;
};
const commandersOf = p => [...new Set(entryCodes(p).map(c => listInfo(c)?.commander).filter(Boolean))].join(" / ");
const savedLists = () => storeGet(STORE_SAVED, []).map(s => { const l = sanitizeList(s.list); return { name: s.name, code: l ? encodeList(l) : "" }; }).filter(s => s.code);


// ---- my profile -----------------------------------------------------------

async function saveMyProfile() {
  const f = ui.profileForm;
  if (!f.firstName.trim() || !f.lastName.trim()) { ui.msg = "Please enter your first and last name."; return render(); }
  if (!f.nickname.trim().replace(/"/g, "")) { ui.msg = "Please choose a nickname. It is the name shown publicly next to your rankings."; return render(); }
  const clean = { id: myId(), firstName: f.firstName.trim(), lastName: f.lastName.trim(), nickname: f.nickname.trim().replace(/"/g, ""), club: f.club.trim(), country: f.country.trim(), avatarAt: me?.avatarAt ?? null };
  try {
    await cloud.saveProfile(clean);
    const first = !me;
    me = clean; people.set(clean.id, clean); ui.profileForm = null;
    ui.msg = first ? "Profile created. You can now join tournaments or run your own." : "Profile saved.";
    history.replaceState(null, "", first ? location.pathname : location.pathname + "?profile=me"); ui.editProfile = false;
    if (first) { ui.tab = "directory"; await enterTab(); return; }
    ui.tab = "profile"; await enterTab(); return;
  } catch (err) { ui.msg = `Could not save your profile: ${problem(err)}`; }
  render();
}
// a profile picture is cropped to a square and shrunk to 256 pixels before upload
async function shrinkImage(file, size) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height), sx = (bmp.width - side) / 2, sy = (bmp.height - side) / 2;
  const cv = document.createElement("canvas"); cv.width = cv.height = size;
  cv.getContext("2d").drawImage(bmp, sx, sy, side, side, 0, 0, size, size);
  return new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error("That image could not be read."))), "image/jpeg", 0.85));
}
async function pickAvatar(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) { ui.msg = "Choose an image file (JPEG, PNG or WebP)."; return render(); }
  try {
    const at = await cloud.setAvatar(await shrinkImage(file, 256));
    me = { ...me, avatarAt: at }; people.set(me.id, me); ui.msg = "Picture updated.";
  } catch (err) { ui.msg = `Could not upload the picture: ${problem(err)}`; }
  render();
}
async function dropAvatar() {
  try { await cloud.removeAvatar(); me = { ...me, avatarAt: null }; people.set(me.id, me); ui.msg = "Picture removed."; }
  catch (err) { ui.msg = `Could not remove the picture: ${problem(err)}`; }
  render();
}
// a round picture of a player, or their initials until (or unless) a picture loads
function avatar(p, size = 28) {
  const box = el("span", { className: "avatar", style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`, textContent: initialsOf(p) });
  const url = cloud.avatarUrl(p);
  if (url) { const img = new Image(); img.alt = ""; img.onload = () => box.replaceChildren(img); img.src = url; }
  return box;
}
// a player in a table; real names are added only where the organiser manages players
const personCell = (pid, withReal = false) => el("td", {}, avatar(profile(pid)), withReal ? matchOf(pid) : nameOf(pid));

// the profile is shown read-only; "Edit profile" opens a separate page (address ?profile=edit) with the form
function setEditProfile(on) {
  ui.editProfile = on; ui.profileForm = null; ui.msg = "";
  history.pushState(null, "", location.pathname + (on ? "?profile=edit" : "?profile=me"));
  render();
}
const playerParam = () => new URLSearchParams(location.search).get("player");   // another player's page (from the Rankings search)
const profileParam = () => new URLSearchParams(location.search).get("profile");   // "me" (view) or "edit"

// nickname in bold with the real name beneath (or the real name in bold when there is no nickname)
function profileNames(p) {
  const real = `${p.firstName} ${p.lastName}`.trim();
  return p.nickname ? [el("h2", { textContent: p.nickname }), el("p", { className: "real-name", textContent: real })] : [el("h2", { textContent: real })];
}
function renderProfileEdit() {
  const f = ui.profileForm ?? { firstName: "", lastName: "", nickname: "", club: "", country: "", ...(me ?? {}) };
  ui.profileForm = f;
  return [el("section", { className: "an-panel" }, el("h2", { textContent: me ? "Edit profile" : "Create your profile" }),
    el("p", { className: "meta", textContent: "Your nickname is your public name: it is what everyone sees next to your rating, rankings and results. Your real name is shown only in tournament match-ups, to opponents and organisers, in your game history and on your own profile. Your email address will never be publicly displayed." }),
    me ? el("div", { className: "avatar-row" }, avatar(me, 72),
      el("label", { className: "row-btn" }, me.avatarAt ? "Change picture " : "Add a picture ", el("input", { type: "file", accept: "image/*", style: "display:none", onchange: e => pickAvatar(e.target.files[0]) })),
      me.avatarAt ? btn("Remove picture", dropAvatar) : "") : "",
    el("div", { className: "an-pick" },
      textInput(f.firstName, "First name (required)", v => { f.firstName = v; }, 170), textInput(f.lastName, "Last name (required)", v => { f.lastName = v; }, 170), textInput(f.nickname, "Nickname (required)", v => { f.nickname = v; }, 170)),
    el("div", { className: "an-pick" },
      textInput(f.club, "Club (optional)", v => { f.club = v; }, 190), field("Country (optional)", el("select", { id: "profile-country", onchange: e => { f.country = e.target.value; } },
        opt("", "- not set -", !f.country), ...(f.country && !countryInfo(f.country) ? [opt(f.country, `${f.country} (not in the list)`, true)] : []),
        ...COUNTRIES.map(([n]) => opt(n, n, f.country === n))))),
    el("div", { className: "an-pick" }, btn(me ? "Save profile" : "Create profile", saveMyProfile), me ? btn("Back to my profile", () => setEditProfile(false)) : ""),
    el("p", { className: "meta", textContent: "Publicly you will appear as " + (f.nickname.trim().replace(/"/g, "") || "your nickname") + (f.firstName.trim() ? `. In match-ups: ${f.nickname.trim().replace(/"/g, "") || "nickname"} (${[f.firstName.trim(), f.lastName.trim()].filter(Boolean).join(" ")})` : "") }))];
}

function renderProfile() {
  if (!ui.viewing && (!me || ui.editProfile)) return renderProfileEdit();
  const who = ui.viewing ? profile(ui.viewing) : me;
  if (!who) return el("p", { className: "meta", textContent: ui.loading ? "Loading..." : "That player was not found." });
  const st = ui.stats, stat = (n, label) => el("div", { className: "stat" }, el("b", { textContent: n }), el("span", { textContent: label }));
  return [el("section", { className: "an-panel profile-head" }, avatar(who, 72),
      el("div", {}, ...profileNames(who), el("p", { className: "meta", textContent: [who.club, who.country].filter(Boolean).join(" - ") || "No club or country set" })),
      viewingMe() ? btn("Edit profile", () => setEditProfile(true)) : ""),
    el("section", { className: "an-panel" }, el("h2", { textContent: ofSubject("My record", n => `${n}'s record`) }),
      st ? el("div", { className: "stat-grid" }, stat(st.games_played, "Games played"), stat(`${st.game_wins}-${st.game_draws}-${st.game_losses}`, "Won-drawn-lost"), stat(st.tournaments_played, "Tournaments played"),
        stat(st.tournament_wins, "Tournament wins"), stat(st.podium_finishes, "Podium finishes"))
        : el("p", { className: "meta", textContent: ofSubject("Your record appears once you have played.", () => "Their record appears once they have played.") }),
      el("p", { className: "meta", textContent: "Counted from finished rounds and finished tournaments." })),
    ...renderRatings()];
}

// ---- rating, faction records and game history (my profile) -------------------------------------

const pct = (w, n) => (n ? `${Math.round((100 * w) / n)}%` : "-");
const wdl = r => `${r.wins}-${r.draws}-${r.losses}`;
function renderRatings() {
  const R = ui.rating, games = ui.games;
  if (!R || !games) return [el("section", { className: "an-panel" }, el("h2", { textContent: "Rating" }), el("p", { className: "meta", textContent: "Loading..." }))];
  const overall = R.rows.find(r => r.scope === "overall"), rank = R.ranks.find(r => r.scope === "overall");
  const rated = games.filter(g => g.rated);
  const big = el("div", { className: "stat-grid" },
    el("div", { className: "stat" }, el("b", { textContent: overall ? Math.round(overall.rating) : "1500" }), el("span", { textContent: overall ? `Rating (\u00b1${Math.round(overall.rd)})` : "Rating (unrated)" })),
    el("div", { className: "stat" }, el("b", { textContent: rank ? `#${rank.position}` : "-" }), el("span", { textContent: rank ? `of ${rank.ranked_players} ranked players` : `Ranked after ${PROVISIONAL.overall} rated games` })),
    el("div", { className: "stat" }, el("b", { textContent: rated.length }), el("span", { textContent: "Rated games" })),
    el("div", { className: "stat" }, el("b", { textContent: rated.length ? wdl(factionRecords(rated.map(g => ({ ...g, faction: "x" }))).mine.get("x")) : "-" }), el("span", { textContent: "Rated won-drawn-lost" })));
  const panel = el("section", { className: "an-panel" }, el("h2", { textContent: "Rating" }), big,
    overall && isProvisional(overall.games) ? el("p", { className: "meta", textContent: `Provisional: fewer than ${PROVISIONAL.overall} rated games, so the rating can still move a lot.` }) : "",
    renderRatingChart(R.history),
    el("p", { className: "meta", textContent: `Glicko-2 rating (start 1500). Only finished tournaments with ${MIN_RATED_PLAYERS} or more players count. The \u00b1 figure is how uncertain the rating is.` }));
  return [panel, renderFactionPanel(R, games), renderHistory(games)];
}
// the rating after each rated tournament, as a line chart: overall or any one faction; hover a point for the tournament
const escapeHtml = x => String(x ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function ratingChartSvg(points, w = 640, h = 240) {
  const L = 46, R = 14, T = 12, B = 30;   // room for the axes
  const all = [{ rating: 1500, label: "Starting rating" }, ...points];
  const v = all.map(p => p.rating), step = Math.max(10, Math.ceil((Math.max(...v, 1500) - Math.min(...v, 1500) + 30) / 4 / 10) * 10);
  const lo = Math.floor((Math.min(...v, 1500) - 10) / step) * step, hi = lo + step * Math.ceil((Math.max(...v, 1500) + 10 - lo) / step), span = hi - lo;
  const x = i => L + (all.length === 1 ? 0 : (i / (all.length - 1)) * (w - L - R)), y = r => T + (1 - (r - lo) / span) * (h - T - B);
  const ticks = Array.from({ length: Math.round(span / step) + 1 }, (_, k) => lo + k * step);
  const grid = ticks.map(t => `<line x1="${L}" x2="${w - R}" y1="${y(t)}" y2="${y(t)}" stroke="currentColor" opacity=".15"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="currentColor" opacity=".7">${t}</text>`).join("");
  const base = `<line x1="${L}" x2="${w - R}" y1="${y(1500)}" y2="${y(1500)}" stroke="currentColor" opacity=".4" stroke-dasharray="4 4"/>`;
  const line = `<polyline fill="none" stroke="var(--accent, #E6C34A)" stroke-width="2.5" stroke-linejoin="round" points="${all.map((p, i) => `${x(i)},${y(p.rating)}`).join(" ")}"/>`;
  const dots = all.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.rating)}" r="${i ? 4 : 3}" fill="var(--accent, #E6C34A)" stroke="var(--bg, #1C2127)" stroke-width="1.5"><title>${escapeHtml(p.label)}: ${Math.round(p.rating)}${p.rd ? ` (\u00b1${Math.round(p.rd)})` : ""}</title></circle>`).join("");
  const first = points[0], last = points.at(-1);
  const xl = `<text x="${L}" y="${h - 8}" font-size="11" fill="currentColor" opacity=".7">Start</text><text x="${w - R}" y="${h - 8}" text-anchor="end" font-size="11" fill="currentColor" opacity=".7">${escapeHtml(last?.date || last?.name || "")}</text>`;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Rating after each rated tournament">${grid}${base}${line}${dots}${xl}</svg>`;
}
function renderRatingChart(hist) {
  if (!hist?.length) return el("p", { className: "meta", textContent: ofSubject("Your rating graph appears after your first rated tournament.", () => "The rating graph appears after a first rated tournament.") });
  const scopes = ["overall", ...[...new Set(hist.map(h => h.scope))].filter(s => s !== "overall").sort((a, b) => (facName(a) || a).localeCompare(facName(b) || b))];
  if (!scopes.includes(ui.chartScope)) ui.chartScope = "overall";
  const pts = hist.filter(h => h.scope === ui.chartScope).map(h => ({ rating: h.rating, rd: h.rd, date: h.date, label: `${h.name || "Tournament"}${h.date ? ` (${h.date})` : ""}` }));
  const box = el("div", { className: "rating-chart" });
  box.innerHTML = pts.length ? ratingChartSvg(pts) : "";
  const first = pts[0], last = pts.at(-1), change = pts.length ? Math.round(last.rating - 1500) : 0;
  return el("div", {},
    scopes.length > 1 ? el("div", { className: "an-pick" }, el("span", { className: "meta", textContent: "Graph:" }),
      ...scopes.map(sc => btn(sc === "overall" ? "Overall" : facName(sc) || sc, () => { ui.chartScope = sc; render(); }, sc === ui.chartScope))) : "",
    box,
    pts.length ? el("p", { className: "meta", textContent: `${pts.length} rated tournament${pts.length === 1 ? "" : "s"}. ${ui.chartScope === "overall" ? "Overall" : facName(ui.chartScope) || ui.chartScope} rating now ${Math.round(last.rating)} (${change >= 0 ? "+" : ""}${change} since the start).` }) : "");
}
function renderFactionPanel(R, games) {
  const { mine, versus } = factionRecords(games), byRating = ui.facView === "rating";
  const toggle = el("div", { className: "an-pick" }, btn("Record", () => { ui.facView = "record"; render(); }, !byRating), btn("Faction rating", () => { ui.facView = "rating"; render(); }, byRating));
  const name = id => facName(id) || id;
  let table;
  if (!byRating) {
    const rows = [...mine].sort((a, b) => b[1].games - a[1].games);
    table = rows.length ? el("div", { className: "table-wrap" }, el("table", { className: "an-table" },
      el("thead", {}, el("tr", {}, ...["Faction", "Games", "Won-drawn-lost", "Win %"].map(h => el("th", { textContent: h })))),
      el("tbody", {}, ...rows.map(([f, r]) => el("tr", {}, el("td", { textContent: name(f) }), el("td", { textContent: r.games }), el("td", { textContent: wdl(r) }), el("td", { textContent: pct(r.wins, r.games) }))))))
      : el("p", { className: "meta", textContent: ofSubject("Faction records appear once your games are in tournaments whose lists are public.", () => "Faction records appear once games are in tournaments whose lists are public.") });
  } else {
    const rows = R.rows.filter(r => r.scope !== "overall").sort((a, b) => b.rating - a.rating), rk = f => R.ranks.find(r => r.scope === f);
    table = rows.length ? el("div", { className: "table-wrap" }, el("table", { className: "an-table" },
      el("thead", {}, el("tr", {}, ...["Faction", "Rating", "Rated games", "Faction rank"].map(h => el("th", { textContent: h })))),
      el("tbody", {}, ...rows.map(r => el("tr", {}, el("td", { textContent: name(r.scope) }), el("td", { textContent: `${Math.round(r.rating)} \u00b1${Math.round(r.rd)}${isProvisional(r.games, r.scope) ? " (provisional)" : ""}` }),
        el("td", { textContent: r.games }), el("td", { textContent: rk(r.scope) ? `#${rk(r.scope).position} of ${rk(r.scope).ranked_players}` : "-" }))))))
      : el("p", { className: "meta", textContent: "Faction ratings appear after rated games with a faction." });
  }
  const vs = [...versus].sort((a, b) => b[1].games - a[1].games);
  return el("section", { className: "an-panel" }, el("h2", { textContent: "By faction" }), toggle, table,
    byRating ? el("p", { className: "meta", textContent: `A faction rating is earned only with that faction's games, against opponents' overall ratings. Ranked after ${PROVISIONAL.faction} rated games with it.` }) : "",
    !byRating && vs.length ? el("details", {}, el("summary", { textContent: "Record against each faction" }), el("div", { className: "table-wrap" }, el("table", { className: "an-table" },
      el("thead", {}, el("tr", {}, ...["You played", "Against", "Games", "Won-drawn-lost"].map(h => el("th", { textContent: h })))),
      el("tbody", {}, ...vs.map(([k, r]) => { const [a, b] = k.split("|"); return el("tr", {}, el("td", { textContent: name(a) }), el("td", { textContent: name(b) }), el("td", { textContent: r.games }), el("td", { textContent: wdl(r) })); }))))) : "");
}
function renderHistory(games) {
  const rows = [...games].sort((a, b) => (b.tournament_date ?? "").localeCompare(a.tournament_date ?? "") || b.round_n - a.round_n).slice(0, ui.historyAll ? 500 : 30);
  const lbl = { win: "Win", draw: "Draw", loss: "Loss" };
  const open = (g, pid, who) => viewGameList(g, pid, who);
  return el("section", { className: "an-panel" }, el("h2", { textContent: ofSubject("My games", n => `${n}'s games`) }),
    rows.length ? el("div", { className: "table-wrap" }, el("table", { className: "an-table" },
      el("thead", {}, el("tr", {}, ...["Date", "Tournament", "Round", "Opponent", "Factions", "VP", "Result", "Lists"].map(h => el("th", { textContent: h })))),
      el("tbody", {}, ...rows.map(g => el("tr", {}, el("td", { textContent: g.tournament_date ?? "-" }), el("td", { textContent: g.tournament_name + (g.rated ? "" : " (not rated)") }), el("td", { textContent: g.round_n }),
        el("td", { textContent: matchOf(g.opp_id) }), el("td", { textContent: g.faction ? `${facName(g.faction)}${g.opp_faction ? " v " + facName(g.opp_faction) : ""}` : "-" }),
        el("td", { textContent: g.vp_for == null ? "-" : `${g.vp_for}-${g.vp_against ?? 0}` }), el("td", { textContent: lbl[g.outcome] }),
        el("td", { className: "tn-actions" }, btn(viewingMe() ? "Mine" : "Theirs", () => open(g, subjectId(), ofSubject("My list", n => `${n}'s list`))), btn("Opponent's", () => open(g, g.opp_id, `${nameOf(g.opp_id)}'s list`))))))))
      : el("p", { className: "meta", textContent: "Games appear here once a round you played in has finished." }),
    games.length > 30 && !ui.historyAll ? btn("Show all games", () => { ui.historyAll = true; render(); }) : "",
    ui.viewList ? el("div", { className: "an-panel" }, el("h3", { textContent: ui.viewList.title }),
      ...(ui.viewList.code ? [el("p", { textContent: listSummary(ui.viewList.code) }), el("a", { href: `index.html#list=${ui.viewList.code}`, target: "_blank", rel: "noopener", textContent: "Open this list in the builder" })]
        : [el("p", { className: "meta", textContent: ui.viewList.reason })])) : "",
    "");
}
async function viewGameList(g, pid, who) {
  ui.viewList = { title: `${who} - ${g.tournament_name}, round ${g.round_n}`, code: null, reason: "Loading..." }; render();
  try {
    const code = await cloud.entryList(g.tournament_id, pid, g.game_id);
    ui.viewList.code = code; ui.viewList.reason = code ? "" : "This list is not visible to you (lists are private until you are matched with the player, and public once a tournament has finished).";
  } catch (err) { ui.viewList.reason = `Could not load it: ${problem(err)}`; }
  render();
}

// ---- directory of tournaments -----------------------------------------------

const regLabel = s => s.status === "finished" ? "Finished" : s.status === "running" ? "In progress"
  : s.listsLocked || !s.registrationOpen ? "Closed" : s.maxPlayers && s.players >= s.maxPlayers ? "Full" : "Open";
const playersLabel = s => `${s.maxPlayers ? `${s.players}/${s.maxPlayers}` : s.players} Players`;

async function searchDirectory() {
  ui.loading = true; render();
  try { ui.dir = await cloud.directory({ q: ui.dirQ, openOnly: ui.dirOpen }); }
  catch (err) { ui.dir = []; ui.msg = `Could not load the directory: ${problem(err)}`; }
  ui.loading = false; render();
}
function tournamentTable(rows, extra = () => "", extraHead = []) {
  return el("div", { className: "table-wrap" }, el("table", { className: "an-table tn" },
    el("thead", {}, el("tr", {}, ...["Name", "Format", "Date", "Location", "Points", "Players", "Registration", ...extraHead, ""].map(h => el("th", { textContent: h })))),
    el("tbody", {}, ...rows.map(s => el("tr", {}, el("td", { textContent: s.name }), el("td", { textContent: s.format === "team" ? `Team (${s.teamSize}s)` : "Individual" }), el("td", { textContent: s.date || "-" }), el("td", { textContent: s.location || "-" }),
      el("td", { textContent: s.points }), el("td", { textContent: playersLabel(s) }), el("td", { textContent: regLabel(s) }), ...extra(s),
      el("td", { className: "tn-actions" }, btn("Open", () => openTournament(s.id)), ...[].concat(extra.actions?.(s) ?? [])))))));
}
function renderDirectory() {
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Find a tournament" }),
    el("p", { className: "meta", textContent: "Anyone can browse and view tournaments. Sign in to ask to join one or to run your own." }),
    el("div", { className: "an-pick" },
      el("input", { type: "search", id: "dir-q", className: "paste", placeholder: "Search by name or place", value: ui.dirQ, style: "flex:0 1 260px", onchange: e => { ui.dirQ = e.target.value; searchDirectory(); } }),
      field("Open for registration only", el("input", { type: "checkbox", checked: ui.dirOpen, onchange: e => { ui.dirOpen = e.target.checked; searchDirectory(); } })),
      btn("Search", () => { ui.dirQ = document.getElementById("dir-q").value; searchDirectory(); })),
    ui.loading && !ui.dir ? el("p", { className: "meta", textContent: "Loading..." })
      : ui.dir?.length ? tournamentTable(ui.dir) : el("p", { className: "meta", textContent: ui.dir ? "No tournaments match." : "" }));
}

// ---- my tournaments: the ones I run and the ones I have joined ---------------

async function loadMine() {
  ui.loading = true; render();
  try { ui.mine = await cloud.mine(); } catch (err) { ui.mine = { owned: [], joined: [] }; ui.msg = `Could not load your tournaments: ${problem(err)}`; }
  ui.loading = false; render();
}
let tform = { name: "", date: today(), location: "", description: "", points: 40, maxPlayers: "", hideLists: false, draft: null, format: "individual", teamSize: 3 };
async function createTournament(f) {
  if (!f.name.trim()) { ui.msg = "Give the tournament a name."; return render(); }
  const t = { id: newId(), owner: myId(), name: f.name.trim(), date: f.date, location: f.location.trim(), description: f.description.trim(), points: f.points, plannedRounds: f.draft?.plannedRounds ?? 3,
    status: "setup", registrationOpen: true, maxPlayers: f.maxPlayers ? Math.max(2, +f.maxPlayers) : null, listsLocked: false, hideListsUntilRound1: !!f.draft?.hideListsUntilRound1,
    rules: JSON.parse(JSON.stringify(f.draft?.rules ?? defaultRules())),
    format: f.format === "team" ? "team" : "individual", teamSize: f.format === "team" ? f.teamSize : null, teams: [],
    players: [], requests: [], rounds: [] };
  try { await cloud.createTournament(t); } catch (err) { ui.msg = `Could not create the tournament: ${problem(err)}`; return render(); }
  ui.newTournament = false; tform = { ...tform, name: "", description: "" };
  ui.msg = isTeam(t) ? `Created ${t.name}. Team captains can now enter their squads.` : `Created ${t.name}. Players can now ask to join.`;
  await openTournament(t.id, { sub: "players" });
}
function renderMine() {
  const f = tform;
  f.draft ??= { rules: defaultRules(), plannedRounds: 3, rounds: [] };   // the rules the organiser is choosing for the new tournament
  f.draft.format = f.format;
  const form = ui.newTournament ? el("div", {},
    el("div", { className: "an-pick" },
      textInput(f.name, "Tournament name", v => { f.name = v; }, 240), el("input", { type: "date", value: f.date, onchange: e => { f.date = e.target.value; } }),
      textInput(f.location, "Location", v => { f.location = v; }, 190),
      field("Points", el("select", { onchange: e => { f.points = +e.target.value; } }, ...data.season.gameSize.map(n => opt(n, n, f.points === n)))),
      field("Player limit", el("input", { type: "number", min: 2, value: f.maxPlayers, placeholder: "none", style: "width:70px", onchange: e => { f.maxPlayers = e.target.value; } }))),
    el("div", { className: "an-pick" },
      field("Format", el("select", { onchange: e => { f.format = e.target.value; render(); } },
        opt("individual", "Individual", f.format === "individual"), opt("team", "Teams", f.format === "team"))),
      f.format === "team" ? field("Players per team", el("select", { onchange: e => { f.teamSize = +e.target.value; } }, ...[2, 3, 4].map(n => opt(n, n, f.teamSize === n)))) : "",
      f.format === "team" ? el("span", { className: "meta", textContent: "Teams sign up under a captain. Each round pairs team against team, and the players within each match-up are paired one-to-one." }) : ""),
    el("h3", { textContent: "Rules" }),
    ...rulesFields(f.draft, false, render),
    el("div", { className: "an-pick" }, el("textarea", { className: "paste", rows: 2, placeholder: "Description (venue, time, anything players should know)", style: "flex:1 1 360px", onchange: e => { f.description = e.target.value; } }, f.description)),
    el("div", { className: "an-pick" }, btn("Create", () => createTournament(tform)), btn("Cancel", () => { ui.newTournament = false; ui.msg = ""; render(); })))
    : btn("New tournament", () => { ui.newTournament = true; ui.msg = ""; render(); });
  const m = ui.mine;
  const owned = m ? el("div", {}, el("h3", { textContent: "Tournaments I run" }),
    m.owned.length ? tournamentTable(m.owned, Object.assign(s => [el("td", { className: "cap", textContent: s.status })],
      { actions: s => sure(`delt:${s.id}`, "Delete", async () => {
        try { await cloud.deleteTournament(s.id); ui.msg = `Deleted ${s.name}.`; await loadMine(); } catch (err) { ui.msg = `Could not delete: ${problem(err)}`; render(); } }) }), ["Status"])
      : el("p", { className: "meta", textContent: "You are not running any tournaments yet." })) : "";
  const joined = m ? el("div", {}, el("h3", { textContent: "Tournaments I have asked to join" }),
    m.joined.length ? tournamentTable(m.joined, s => [el("td", { className: "cap", textContent: s.myStatus === "approved" ? "Approved" : s.myStatus === "declined" ? "Declined" : "Waiting for approval" })], ["My place"])
      : el("p", { className: "meta", textContent: "You have not asked to join any tournaments. Find one in the directory." })) : "";
  return el("section", { className: "an-panel" }, el("h2", { textContent: "My tournaments" }), form, ui.loading && !m ? el("p", { className: "meta", textContent: "Loading..." }) : "", owned, joined);
}

// ---- opening a tournament -------------------------------------------------

const urlFor = id => `${location.pathname}${id ? `?t=${id}` : ""}`;
function stopWatching() { ui.stopWatching?.(); ui.stopWatching = null; }
function absorb(list) { list.forEach(p => people.set(p.id, p)); }

async function openTournament(id, { push = true, sub } = {}) {
  stopWatching();
  ui.tid = id; ui.t = null; ui.loading = true; ui.openKills = null; ui.drawWarnings = []; ui.confirm = null;
  if (push) history.pushState({}, "", urlFor(id));
  render();
  try {
    const r = await cloud.load(id);
    if (!r) { ui.tid = null; ui.msg = "That tournament is not available. The link may be wrong."; history.replaceState({}, "", urlFor(null)); ui.loading = false; return render(); }
    absorb(r.people);
    ui.t = r.t;
    if (isOrganiser(r.t)) {
      cloud.baseline(r.t);
      const pending = storeGet(PENDING_KEY, null);   // changes made offline that never reached the database
      if (pending?.t?.id === id) { ui.t = pending.t; ui.msg = "Restored changes that had not been saved yet."; cloud.schedule(ui.t); }
    }
    ui.sub = sub ?? (isOrganiser(ui.t) ? (ui.t.status === "setup" ? "players" : "rounds") : "overview");
    ui.stopWatching = cloud.watch(id, refresh);
  } catch (err) { ui.tid = null; ui.msg = `Could not open the tournament: ${problem(err)}`; }
  ui.loading = false; render();
}
function closeTournament(push = true) {
  stopWatching(); ui.t = null; ui.tid = null; ui.openKills = null;
  if (push) history.pushState({}, "", urlFor(null));
}
// bring the open tournament up to date after someone else changed it
async function refresh() {
  const t = ui.t;
  if (!t || cloud._reports.size) return;   // my own report is still on its way
  try {
    if (cloud.dirty()) { await cloud.flush(); if (cloud.dirty()) return; }
    const r = await cloud.load(t.id);
    if (!r || ui.t?.id !== t.id || cloud.dirty()) return;
    absorb(r.people);
    ui.t = r.t;
    if (isOrganiser(r.t)) cloud.baseline(r.t);
    renderSoon();
  } catch { /* the next change tries again */ }
}
// redraw, but not while someone is typing in a field (it would lose what they typed)
function renderSoon() {
  const a = document.activeElement;
  if (a && a.closest?.("#app") && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { ui.renderPending = true; return; }
  render();
}
document.addEventListener("focusout", () => { if (ui.renderPending) { ui.renderPending = false; setTimeout(render, 50); } });

// ---- my entry: asking to join and choosing a list ----------------------------

async function askToJoin(t) {
  try { await cloud.requestJoin(t.id); t.requests.push({ pid: myId(), status: "pending", listCode: null, listCode2: null }); ui.msg = "Request sent. The organiser will approve it. You can choose your list now."; }
  catch (err) { ui.msg = `Could not send the request: ${problem(err)}`; }
  render();
}
async function startTeam(t) {
  const name = (ui.teamName ?? "").trim();
  if (!name) { ui.msg = "Give your team a name."; return render(); }
  try {
    const id = await cloud.createTeam(t.id, name);
    t.teams.push({ id, name, captain: myId() }); t.requests.push({ pid: myId(), status: "pending", listCode: null, listCode2: null, teamId: id, teamOk: true });
    ui.teamName = ""; ui.msg = `${name} is entered. You are the captain: ask your teammates to join it here, then accept them. The organiser approves the squad.`;
  } catch (err) { ui.msg = `Could not create the team: ${problem(err)}`; }
  render();
}
async function joinTeam(t, team) {
  try { await cloud.requestJoinTeam(t.id, team.id); t.requests.push({ pid: myId(), status: "pending", listCode: null, listCode2: null, teamId: team.id, teamOk: false }); ui.msg = `Asked to join ${team.name}. Their captain needs to accept you.`; }
  catch (err) { ui.msg = `Could not join the team: ${problem(err)}`; }
  render();
}
async function acceptMember(t, pid) {
  try { await cloud.acceptMember(t.id, pid); const r = t.requests.find(x => x.pid === pid); if (r) r.teamOk = true; ui.msg = `${nameOf(pid)} is on the team.`; }
  catch (err) { ui.msg = `Could not accept: ${problem(err)}`; }
  render();
}
async function removeMember(t, pid) {
  try { await cloud.removeRegistration(t.id, pid); t.requests = t.requests.filter(r => r.pid !== pid); t.players = t.players.filter(p => p.pid !== pid); ui.msg = `${nameOf(pid)} has been removed from the team.`; }
  catch (err) { ui.msg = `Could not remove them: ${problem(err)}`; }
  render();
}
async function disband(t, team) {
  try { await cloud.disbandTeam(team.id); t.teams = t.teams.filter(x => x.id !== team.id); t.requests = t.requests.filter(r => r.teamId !== team.id); t.players = t.players.filter(p => p.teamId !== team.id); ui.msg = `${team.name} has been disbanded.`; }
  catch (err) { ui.msg = `Could not disband the team: ${problem(err)}`; }
  render();
}
async function withdraw(t) {
  try { await cloud.withdraw(t.id); t.players = t.players.filter(p => p.pid !== myId()); t.requests = t.requests.filter(p => p.pid !== myId()); ui.msg = "You have left this tournament."; }
  catch (err) { ui.msg = `Could not withdraw: ${problem(err)}`; }
  render();
}
async function chooseList(t, code, slot = 1) {
  if (!listInfo(code)) { ui.msg = "That doesn't look like a share link."; return render(); }
  const e = myEntry(t), meta = listMeta(code);
  try {
    let note = "";
    if (slot === 2) {
      if (!e?.listCode) { ui.msg = "Choose your first list before your second."; return render(); }
      const first = listInfo(e.listCode);
      if (first && listInfo(code).list.faction !== first.list.faction) { ui.msg = `Both lists must be of the same faction. Your first list is ${first.faction}.`; return render(); }
      await cloud.setList(t.id, myId(), code, meta, 2);
      if (e) e.listCode2 = code;
    } else {
      const second = e?.listCode2 ? listInfo(e.listCode2) : null;
      const drop = !!second && second.list.faction !== listInfo(code).list.faction;
      await cloud.setList(t.id, myId(), code, meta, 1, { clearSecond: drop });
      if (e) { e.listCode = code; if (drop) { e.listCode2 = null; note = " Your second list was a different faction, so it has been cleared. Choose it again."; } }
    }
    const problems = lockProblems(t, code);
    ui.msg = `List ${slot} saved.` + (problems.length ? ` It does not pass yet: ${problems.join("; ")}.` : " It passes every check.") + note;
    ui[slot === 2 ? "pasteList2" : "pasteList"] = "";
  } catch (err) { ui.msg = `Could not save the list: ${problem(err)}`; }
  render();
}
function listSummary(code) {
  const info = listInfo(code);
  return info ? `${info.name ? info.name + ": " : ""}${info.faction}${info.commander ? `, ${info.commander}` : ""}, ${info.points}/${info.list.gameSize} points` : "";
}
function renderEntry(t) {
  const title = el("h2", { textContent: isOrganiser(t) ? "Your own entry" : "Joining" });
  if (!cloud.user) return el("section", { className: "an-panel" }, title, el("p", { className: "meta", textContent: "Sign in to ask to join this tournament." }),
    btn("Sign in", () => { closeTournament(); ui.tab = "signin"; render(); }));
  if (!me) return el("section", { className: "an-panel" }, title, el("p", { className: "meta", textContent: "Create your profile first, then you can ask to join." }),
    btn("Create profile", () => { closeTournament(); ui.tab = "profile"; render(); }));
  const e = myEntry(t), approved = t.players.some(p => p.pid === myId());
  if (isTeam(t) && !e) {
    const closed = !t.registrationOpen || t.listsLocked || t.status !== "setup";
    if (closed) return el("section", { className: "an-panel" }, title, el("p", { className: "meta", textContent: "Registration for this tournament is closed." }));
    const open = t.teams.filter(x => teamMembers(t, x.id).length < t.teamSize);
    return el("section", { className: "an-panel" }, title,
      el("p", { className: "meta", textContent: "Players cannot enter on their own. Your team captain enters the squad as a whole; teammates then ask to join that team." }),
      el("h3", { textContent: "I am the captain" }),
      el("div", { className: "an-pick" }, el("input", { type: "text", className: "paste", placeholder: "Team name", value: ui.teamName ?? "", style: "flex:0 1 240px", onchange: e2 => { ui.teamName = e2.target.value; } }),
        btn("Enter a team", () => startTeam(t))),
      el("h3", { textContent: "I am joining a team" }),
      open.length ? el("div", { className: "an-pick" }, ...open.map(x => btn(`Join ${x.name} (captain ${nameOf(x.captain)})`, () => joinTeam(t, x))))
        : el("p", { className: "meta", textContent: "No teams have entered yet, or all of them are full." }));
  }
  if (!e) {
    const full = t.maxPlayers && t.players.length >= t.maxPlayers;
    const closed = !t.registrationOpen || t.listsLocked || t.status !== "setup";
    return el("section", { className: "an-panel" }, title,
      closed ? el("p", { className: "meta", textContent: "Registration for this tournament is closed." })
        : el("div", {}, el("p", { className: "meta", textContent: full ? "The tournament is at its player limit. You can still ask; the organiser decides." : "Ask to join. The organiser approves each request." }), btn("Ask to join", () => askToJoin(t))));
  }
  const team = isTeam(t) ? myTeam(t) : null, captain = !!team && team.captain === myId();
  const status = e.status === "declined" ? "The organiser has declined your request." : approved ? "You are in this tournament."
    : team && !e.teamOk ? `You have asked to join ${team.name}. Their captain needs to accept you.` : "Your request is waiting for the organiser's approval.";
  const editable = !t.listsLocked && e.status !== "declined";
  const teamBox = team ? el("div", {}, el("h3", { textContent: `Team: ${team.name}${captain ? " (you are the captain)" : ""}` }),
    el("ul", { className: "meta" }, ...teamMembers(t, team.id).map(m => el("li", {},
      `${nameOf(m.pid)}${m.pid === team.captain ? " - captain" : ""}${m.status === "approved" ? " - approved" : m.teamOk ? " - accepted, waiting for the organiser" : " - waiting for the captain"} `,
      captain && !m.teamOk ? btn("Accept", () => acceptMember(t, m.pid)) : "",
      captain && m.pid !== myId() && !t.listsLocked ? btn("Remove to replace", () => removeMember(t, m.pid)) : ""))),
    teamMembers(t, team.id).length < t.teamSize ? el("p", { className: "meta", textContent: `Room for ${t.teamSize - teamMembers(t, team.id).length} more. Teammates find this tournament and choose "Join ${team.name}". To swap a player before the organiser locks the lists, remove them and let their replacement join. After that, ask the organiser.` }) : "") : "";
  return el("section", { className: "an-panel" }, title, el("p", { textContent: status }), teamBox,
    el("p", { className: "meta", textContent: "Every player enters two lists of the same faction (the same list twice is fine). After each round is drawn you secretly lock in one of them for that game." }),
    entryListBlock(t, e, 1, editable), entryListBlock(t, e, 2, editable),
    t.listsLocked ? el("p", { className: "meta", textContent: "Lists are locked. They can no longer be changed." }) : "",
    el("div", { className: "an-pick" },
      t.listsLocked && e.status !== "declined" ? "" : sure("withdraw", e.status === "declined" ? "Remove my request" : captain ? "Disband my team and leave" : "Leave this tournament", () => withdraw(t))));
}
// one of the two list slots on the sign-up panel
function entryListBlock(t, e, slot, editable) {
  const code = listCodeOf(e, slot), problems = code ? lockProblems(t, code) : [], key = slot === 2 ? "pasteList2" : "pasteList";
  return el("div", { className: "list-slot" }, el("h3", { textContent: `List ${slot}` }),
    code ? el("p", { className: problems.length ? "warn" : "meta", textContent: `${listSummary(code)}.${problems.length ? ` Not valid yet: ${problems.join("; ")}.` : " It passes every check."}` })
      : el("p", { className: "meta", textContent: e.status === "declined" ? "" : slot === 2 ? (e.listCode ? "You have not chosen your second list yet. It can be your first list again." : "Choose your first list, then your second.") : "You have not chosen a list yet." }),
    editable && (slot === 1 || e.listCode) ? el("div", { className: "an-pick" },
      field("Saved list", el("select", { onchange: e2 => { const sv = savedLists().find(x => x.name === e2.target.value); if (sv) chooseList(t, sv.code, slot); } },
        opt("", savedLists().length ? "- choose one saved in this browser -" : "(none saved in this browser)", true), ...savedLists().map(sv => opt(sv.name, sv.name, false)))),
      el("input", { type: "text", className: "paste", placeholder: "or paste a share link", value: ui[key] ?? "", onchange: e2 => { ui[key] = e2.target.value; chooseList(t, codeFromText(e2.target.value), slot); } }),
      slot === 2 && e.listCode ? btn("Use list 1 again", () => chooseList(t, e.listCode, 2)) : "") : "",
    code ? el("div", { className: "an-pick" }, el("a", { className: "row-btn", href: `index.html#list=${code}`, target: "_blank", textContent: `View list ${slot}` })) : "");
}

// the people taking part, shown to everyone
function renderRoster(t) {
  const team = isTeam(t), ordered = team ? [...t.players].sort((x, y) => teamLabel(t, x.teamId).localeCompare(teamLabel(t, y.teamId))) : t.players;
  const rows = ordered.map(p => {
    const info = listInfo(p.listCode);
    return el("tr", { className: p.dropped ? "dropped" : "" }, ...(team ? [el("td", { textContent: teamLabel(t, p.teamId) + (teamById(t, p.teamId)?.captain === p.pid ? " (captain)" : "") })] : []), personCell(p.pid), el("td", { textContent: profile(p.pid)?.club || "-" }), el("td", { textContent: profile(p.pid)?.country || "-" }),
      el("td", { textContent: info?.faction ?? "" }), el("td", { textContent: commandersOf(p) }),
      el("td", {}, ...listLinks(p)));
  });
  const hidden = t.status === "finished" ? "" : "Army lists stay private until you are matched with an opponent, who then sees both of your lists. Everyone can see them once the tournament has finished.";
  return el("section", { className: "an-panel" }, el("h2", { textContent: `Players (${t.players.length}${t.maxPlayers ? `/${t.maxPlayers}` : ""})` }),
    hidden ? el("p", { className: "meta", textContent: hidden }) : "",
    t.players.length ? el("div", { className: "table-wrap" }, el("table", { className: "an-table tn" },
      el("thead", {}, el("tr", {}, ...[...(team ? ["Team"] : []), "Player", "Club", "Country", "Faction", "Commander", ""].map(h => el("th", { textContent: h })))), el("tbody", {}, ...rows)))
      : el("p", { className: "meta", textContent: "No players have been approved yet." }));
}
// does this tournament count for ratings?
function ratedNote(t) {
  const n = t.players.length;
  const text = n >= MIN_RATED_PLAYERS ? `Counts for player ratings (${n} players).`
    : `Counts for player ratings once it has ${MIN_RATED_PLAYERS} or more players (it has ${n}).`;
  return el("p", { className: "meta", textContent: text });
}
function renderOverview(t) {
  return [el("section", { className: "an-panel" }, ratedNote(t)), t.description ? el("section", { className: "an-panel" }, el("h2", { textContent: "About this tournament" }), el("p", { textContent: t.description, style: "white-space:pre-wrap" })) : "", lockInReminder(t), renderEntry(t), renderRoster(t)];
}

// ---- organiser: players -----------------------------------------------------

// approve, decline, remove or drop: each is saved straight away
async function applyPlayer(t, pid, patch) {
  await cloud.setRegistration(t.id, pid, patch);
  const inPlayers = t.players.find(p => p.pid === pid), inReqs = t.requests.find(p => p.pid === pid);
  if (patch.status === "approved" && inReqs) { t.requests = t.requests.filter(r => r !== inReqs); t.players.push({ pid, dropped: false, listCode: inReqs.listCode, listCode2: inReqs.listCode2 ?? null, teamId: inReqs.teamId ?? null }); }
  else if (patch.status === "declined" && inPlayers) { t.players = t.players.filter(p => p !== inPlayers); t.requests.push({ pid, status: "declined", listCode: null, listCode2: null, teamId: inPlayers.teamId ?? null, teamOk: true }); }
  else if (patch.status && inReqs) inReqs.status = patch.status;
  else if ("dropped" in patch && inPlayers) inPlayers.dropped = patch.dropped;
}
// organiser: bring in a substitute for a player (a teammate or anyone else with a profile). A game still open takes the substitute's seat.
async function findSubs() {
  const t = ui.t, q = (ui.subQ ?? "").trim();
  if (q.length < 2) { ui.subResults = []; ui.msg = "Type at least two letters of a nickname."; return render(); }
  try { ui.subResults = await cloud.findProfiles(t.id, q); ui.msg = ui.subResults.length ? "" : "Nobody found. They need to have created a profile."; } catch (err) { ui.msg = `Could not search: ${problem(err)}`; }
  render();
}
async function substitute(t, oldPid, sub) {
  const code = codeFromText(ui.subList ?? "");
  if (ui.subList?.trim() && !listInfo(code)) { ui.msg = "That doesn't look like a share link. Leave it empty to add the list later."; return render(); }
  try {
    const old = t.players.find(p => p.pid === oldPid);
    await cloud.substitute(t.id, oldPid, sub.id);
    people.set(sub.id, sub);
    const code2 = codeFromText(ui.subList2 ?? "") || code;
    if (code2 && code2 !== code && listInfo(code2)?.list.faction !== listInfo(code)?.list.faction) throw new Error("Both lists must be of the same faction.");
    if (code) { await cloud.setList(t.id, sub.id, code, listMeta(code)); await cloud.setList(t.id, sub.id, code2, listMeta(code2), 2); }
    if (old) old.dropped = true;
    t.requests = t.requests.filter(r => r.pid !== sub.id);
    t.players = t.players.filter(p => p.pid !== sub.id).concat({ pid: sub.id, dropped: false, listCode: code || null, listCode2: code ? code2 : null, teamId: old?.teamId ?? null });
    const open = t.rounds.at(-1) && !t.rounds.at(-1).done ? t.rounds.at(-1) : null;
    let seated = false;
    for (const g of open?.tables ?? []) for (const s of ["a", "b"]) if (g[s] === oldPid) {
      g[s] = sub.id; seated = true; g.killedByA = []; g.killedByB = []; g.result = g.b === null ? "a" : null; g.manual = false; g.vpA = g.vpB = null;
      g.lockedA = g.lockedB = false; g.pickA = g.pickB = null;   // the substitute locks in their own list (the database clears the old lock-ins)
    }
    ui.replacing = null; ui.subQ = ""; ui.subList = ""; ui.subList2 = ""; ui.subResults = [];
    commit(`${nameOf(sub.id)} is in for ${nameOf(oldPid)}${seated ? " and has taken their seat in the open round (that game's record was cleared)" : ""}${code ? "" : ". Add their list in the Players tab, then lock lists again if needed"}.`);
  } catch (err) { ui.msg = `Could not substitute: ${problem(err)}`; render(); }
}
function renderReplace(t) {
  const old = ui.replacing; if (!old) return "";
  return el("section", { className: "an-panel" }, el("h2", { textContent: `Replace ${nameOf(old)}` }),
    el("p", { className: "meta", textContent: "Find the substitute by nickname. They do not have to be on the team or in the tournament; they only need a profile. They join " + (isTeam(t) ? "the same team" : "in the same place") + ", and an open game of the player they replace is handed over to them." }),
    el("div", { className: "an-pick" },
      el("input", { type: "search", id: "sub-q", className: "paste", placeholder: "Nickname", value: ui.subQ ?? "", style: "flex:0 1 220px", onchange: e => { ui.subQ = e.target.value; findSubs(); } }),
      btn("Search", () => { ui.subQ = document.getElementById("sub-q").value; findSubs(); }),
      el("input", { type: "text", className: "paste", placeholder: "Their first list's share link (optional)", value: ui.subList ?? "", style: "flex:1 1 240px", onchange: e => { ui.subList = e.target.value; } }),
      el("input", { type: "text", className: "paste", placeholder: "Second list's link (blank = the same list twice)", value: ui.subList2 ?? "", style: "flex:1 1 240px", onchange: e => { ui.subList2 = e.target.value; } })),
    el("div", { className: "an-pick" }, ...(ui.subResults ?? []).map(p => btn(`Use ${p.nickname}${p.club ? ` (${p.club})` : ""}`, () => { people.set(p.id, p); substitute(t, old, p); }))),
    btn("Cancel", () => { ui.replacing = null; ui.subResults = []; render(); }));
}
async function setPlayer(t, pid, patch, message) {
  try { await applyPlayer(t, pid, patch); ui.msg = message; } catch (err) { ui.msg = `Could not save that: ${problem(err)}`; }
  render();
}
// team events: approve every accepted member of a squad in one go
async function approveTeam(t, team) {
  const todo = t.requests.filter(r => r.teamId === team.id && r.status === "pending" && r.teamOk);
  try { for (const r of todo) await applyPlayer(t, r.pid, { status: "approved" }); ui.msg = `Approved ${team.name} (${todo.length} player${todo.length === 1 ? "" : "s"}).`; }
  catch (err) { ui.msg = `Could not approve the whole team: ${problem(err)}`; }
  render();
}
function lockLists(t) {
  const bad = active(t).map(p => [p, entryProblems(t, p)]).filter(([, pr]) => pr.length);
  if (bad.length) { ui.msg = `Lists cannot be locked yet: ${bad.map(([p, pr]) => `${nameOf(p.pid)} (${pr[0]})`).join("; ")}.`; return render(); }
  t.listsLocked = true;
  cloud.syncEntryMeta(t.id, active(t).map(p => ({ pid: p.pid, ...listMeta(p.listCode), second: p.listCode2 ? listMeta(p.listCode2) : null }))).catch(err => { ui.msg = `Lists locked, but faction records could not be updated: ${problem(err)}`; render(); });
  commit("Lists locked. Each player's opponent sees both of their lists once they are matched; everyone can see them when the tournament finishes.");
}
function renderPlayers(t) {
  const full = !!t.maxPlayers && t.players.length >= t.maxPlayers, started = t.rounds.length > 0, ended = t.status === "finished";
  const waiting = t.requests.filter(r => r.status === "pending"), declined = t.requests.filter(r => r.status === "declined");
  const reqRows = [...waiting, ...declined].map(r => {
    const pr = profile(r.pid), info = listInfo(r.listCode);
    return el("tr", { className: r.status === "declined" ? "dropped" : "" }, ...(isTeam(t) ? [el("td", { textContent: teamLabel(t, r.teamId) + (r.teamOk ? "" : " (not accepted by captain)") })] : []), personCell(r.pid, true), el("td", { textContent: pr?.club || "-" }), el("td", { textContent: pr?.country || "-" }),
      el("td", { textContent: listsSummary(r) }), el("td", { className: "cap", textContent: r.status }),
      el("td", { className: "tn-actions" }, btn("Approve", () => setPlayer(t, r.pid, { status: "approved" }, `Approved ${nameOf(r.pid)}.`), full || t.listsLocked || (isTeam(t) && !r.teamOk) || !(r.listCode && r.listCode2)),
        r.status === "pending" && !(r.listCode && r.listCode2) ? el("span", { className: "meta", textContent: "Needs two lists" }) : "",
        r.status === "pending" ? btn("Decline", () => setPlayer(t, r.pid, { status: "declined" }, `Declined ${nameOf(r.pid)}.`)) : ""));
  });
  const rows = t.players.map(p => {
    const info = listInfo(p.listCode), problems = entryProblems(t, p);
    return el("tr", { className: p.dropped ? "dropped" : "" }, ...(isTeam(t) ? [el("td", { textContent: teamLabel(t, p.teamId) })] : []), personCell(p.pid, true), el("td", { textContent: profile(p.pid)?.club || "-" }),
      el("td", { textContent: info?.faction ?? "-" }), el("td", { textContent: commandersOf(p) || (info ? "-" : "") }), el("td", { textContent: info ? `${info.points}/${info.list.gameSize}` : "-" }),
      el("td", { className: problems.length ? "meta" : "ok", textContent: problems.length ? (info ? `Problem: ${problems[0]}` : "No list") : "OK" }),
      el("td", { className: "tn-actions" }, ...listLinks(p),
        ended ? "" : btn("Replace", () => { ui.replacing = p.pid; ui.subResults = []; ui.subQ = ""; ui.subList = ""; ui.subList2 = ""; render(); }),
        ended ? "" : btn(p.dropped ? "Reinstate" : "Drop", () => setPlayer(t, p.pid, { dropped: !p.dropped }, p.dropped ? `${nameOf(p.pid)} is back in.` : `${nameOf(p.pid)} has dropped out.`)),
        started ? "" : sure(`remp:${p.pid}`, "Remove", () => setPlayer(t, p.pid, { status: "declined" }, `Removed ${nameOf(p.pid)}.`))));
  });
  const lockBar = ended ? "" : el("div", { className: "an-pick" },
    t.listsLocked ? btn("Unlock lists", () => { t.listsLocked = false; commit("Lists unlocked. Players can change them again."); }, started) : btn("Lock lists", () => lockLists(t), !t.players.length),
    el("span", { className: "meta", textContent: t.listsLocked ? (started ? "Lists are locked for the tournament." : "Lists are locked and cannot be changed by players.") : "Both lists of every player must be valid and built for the tournament's points. Locking stops players changing them. Opponents see each other's lists once matched." }));
  const teamsPanel = !isTeam(t) ? "" : el("section", { className: "an-panel" }, el("h2", { textContent: `Teams (${t.teams.length})` }),
    t.teams.length ? el("div", { className: "table-wrap" }, el("table", { className: "an-table tn" },
      el("thead", {}, el("tr", {}, ...["Team", "Captain", "Members", "Status", ""].map(h => el("th", { textContent: h })))),
      el("tbody", {}, ...t.teams.map(x => {
        const mem = teamMembers(t, x.id), ready = mem.filter(m => m.status === "pending" && m.teamOk).length, inN = mem.filter(m => m.status === "approved").length;
        return el("tr", {}, el("td", { textContent: x.name }), el("td", { textContent: nameOf(x.captain) }),
          el("td", { textContent: mem.map(m => nameOf(m.pid) + (m.status === "approved" ? "" : m.teamOk ? " (waiting)" : " (not accepted)")).join(", ") }),
          el("td", { textContent: `${inN}/${t.teamSize} approved${mem.length < t.teamSize ? " - team is short" : ""}` }),
          el("td", { className: "tn-actions" }, btn("Approve team", () => approveTeam(t, x), !ready || t.listsLocked),
            started ? "" : sure(`dis:${x.id}`, "Disband", () => disband(t, x))));
      }))))
      : el("p", { className: "meta", textContent: "No teams have entered yet. Captains enter their squads from the tournament page; the teammates then ask to join and the captain accepts them." }),
    el("p", { className: "meta", textContent: "A short team is allowed: the empty seats are forfeit wins for the other team and are not counted against any player." }));
  return [renderEntry(t), teamsPanel, renderReplace(t),
    waiting.length || declined.length ? el("section", { className: "an-panel" }, el("h2", { textContent: `Requests to join (${waiting.length} waiting)` }),
      el("div", { className: "table-wrap" }, el("table", { className: "an-table tn" },
        el("thead", {}, el("tr", {}, ...[...(isTeam(t) ? ["Team"] : []), "Player", "Club", "Country", "List", "Status", ""].map(h => el("th", { textContent: h })))), el("tbody", {}, ...reqRows))),
      full ? el("p", { className: "meta", textContent: "The player limit is reached. Raise it in Details to approve more." }) : "") : "",
    el("section", { className: "an-panel" }, el("h2", { textContent: `Players (${active(t).length} playing${t.maxPlayers ? `, limit ${t.maxPlayers}` : ""})` }), lockBar,
      t.players.length ? el("div", { className: "table-wrap" }, el("table", { className: "an-table tn" },
        el("thead", {}, el("tr", {}, ...[...(isTeam(t) ? ["Team"] : []), "Player", "Club", "Faction", "Commander", "Points", "List", ""].map(h => el("th", { textContent: h })))), el("tbody", {}, ...rows)))
        : el("p", { className: "meta", textContent: "Nobody is approved yet. Players find this tournament in the directory (or through its link) and ask to join." }))];
}

// ---- organiser: details -----------------------------------------------------

function renderDetails(t) {
  const link = `${location.origin}${location.pathname}?t=${t.id}`, set = (key, v, msg) => { t[key] = v; commit(msg); };
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Details" }), ratedNote(t),
    el("div", { className: "an-pick" },
      field("Name", el("input", { type: "text", className: "paste", value: t.name, style: "flex:0 1 260px", onchange: e => { if (e.target.value.trim()) set("name", e.target.value.trim(), ""); else render(); } })),
      field("Date", el("input", { type: "date", value: t.date, onchange: e => set("date", e.target.value, "") })),
      field("Location", el("input", { type: "text", className: "paste", value: t.location, style: "flex:0 1 200px", onchange: e => set("location", e.target.value.trim(), "") })),
      field("Points", el("select", { disabled: t.listsLocked, onchange: e => set("points", +e.target.value, "") }, ...data.season.gameSize.map(n => opt(n, n, t.points === n))))),
    el("div", { className: "an-pick" }, el("textarea", { className: "paste", rows: 3, placeholder: "Description", style: "flex:1 1 420px", onchange: e => set("description", e.target.value, "") }, t.description)),
    el("h3", { textContent: "Registration" }),
    el("div", { className: "an-pick" },
      field("Registration open", el("input", { type: "checkbox", checked: t.registrationOpen, onchange: e => set("registrationOpen", e.target.checked, "") })),
      field("Player limit", el("input", { type: "number", min: 2, value: t.maxPlayers ?? "", placeholder: "none", style: "width:70px", onchange: e => set("maxPlayers", e.target.value ? Math.max(2, +e.target.value) : null, "") }))),
    el("div", { className: "an-pick" },
      el("span", { className: "meta", textContent: `Link to share: ${link}` }),
      btn("Copy link", async () => { try { await navigator.clipboard.writeText(link); ui.msg = "Link copied."; } catch { ui.msg = "Could not copy. Select the link and copy it by hand."; } render(); })));
}

// ---- one tournament: rules ------------------------------------------------

// the rule options, used both when creating a tournament and on its Rules tab; onChange redraws
function rulesFields(t, locked, onChange) {
  const r = t.rules, m = r.margins ?? (r.margins = { enabled: false, band: 2, marginalWin: 2, majorWin: 3 });
  const num = (obj, key, label, off = false) => field(label, el("input", { type: "number", min: 0, value: obj[key], style: "width:60px", disabled: locked || off, onchange: e => { obj[key] = Math.max(0, +e.target.value || 0); onChange(); } }));
  const tb = i => el("select", { disabled: locked, onchange: e => { const next = [...r.tiebreakers]; next[i] = e.target.value; r.tiebreakers = next.filter(Boolean).filter((k, j, a) => a.indexOf(k) === j); onChange(); } },
    ...(i ? [opt("", "(none)", !r.tiebreakers[i])] : []), ...Object.entries(TIEBREAKERS).map(([k, label]) => opt(k, label, r.tiebreakers[i] === k)));
  return [
    el("div", { className: "an-pick" },
      field(isTeam(t) ? "Team pairing" : "Pairing", el("select", { disabled: locked, onchange: e => { r.pairing = e.target.value; onChange(); } }, opt("swiss", "Swiss (by standings)", r.pairing === "swiss"), opt("random", "Random every round", r.pairing === "random"))),
      ...(isTeam(t) ? [field("Player pairing in a match-up", el("select", { disabled: locked, onchange: e => { r.seatPairing = e.target.value; onChange(); } },
        opt("swiss", "Swiss (by individual standing)", r.seatPairing !== "random"), opt("random", "Random", r.seatPairing === "random")))] : []),
      field("Avoid clubmates", el("select", { disabled: locked, onchange: e => { r.avoidClub = e.target.value === "round1"; onChange(); } },
        opt("round1", "Avoid clubmates in round 1 only", !!r.avoidClub), opt("off", "Off", !r.avoidClub))),
      field("Rounds", el("input", { type: "number", min: 1, max: 12, value: t.plannedRounds, style: "width:60px", onchange: e => { t.plannedRounds = Math.max(Math.max(1, t.rounds.length), Math.min(12, +e.target.value || 3)); onChange(); } }))),
    el("h3", { textContent: "Victories" }),
    el("div", { className: "an-pick" },
      field("Marginal and major victories", el("input", { type: "checkbox", checked: m.enabled, disabled: locked, onchange: e => { m.enabled = e.target.checked; onChange(); } })),
      m.enabled ? num(m, "band", "A win by this many VP or fewer is marginal") : ""),
    el("h3", { textContent: "Tournament points awarded" }),
    el("div", { className: "an-pick" },
      ...(m.enabled ? [num(m, "majorWin", "Pts per Major Win"), num(m, "marginalWin", "Pts per Marginal Win")] : [num(r, "win", "Pts per Win")]),
      num(r, "draw", "Pts per Draw"), num(r, "loss", "Pts per Loss")),
    el("p", { className: "meta", textContent: "Organisers can add bonus points to any game." }),
    isTeam(t) ? el("p", { className: "meta", textContent: "In a team event the points above are for the team's match: more individual games won than lost is a team win, fewer is a loss, level is a draw (a drawn game is not a win). With marginal and major victories on, a major win is a clean sweep (every game won). Players' own games still count for their individual results and ratings." }) : "",
    el("h3", { textContent: "Tie-breakers" }),
    el("div", { className: "an-pick" }, field("1st", tb(0)), field("2nd", tb(1)), field("3rd", tb(2)), field("4th", tb(3)))];
}

function renderRules(t) {
  const locked = t.rounds.length > 0;
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Rules" }),
    el("p", { className: "meta", textContent: locked ? "The rules are fixed once the first round is drawn." : "Set these before drawing round one." }),
    ...rulesFields(t, locked, commit));
}
const defaultRules = () => ({ pairing: "swiss", avoidClub: true, win: 3, draw: 1, loss: 0, tiebreakers: ["sos", "vpDiff", "vp", "destroyedDiff"], margins: { enabled: true, band: 2, marginalWin: 2, majorWin: 3 } });

// ---- one tournament: rounds -----------------------------------------------

function startTournament(t) {
  const act = active(t);
  if (isTeam(t) && new Set(act.map(p => p.teamId)).size < 2) { ui.msg = "At least two teams are needed."; return render(); }
  if (!isTeam(t) && act.length < 2) { ui.msg = "At least two players are needed."; return render(); }
  if (!t.listsLocked) { ui.msg = "Lock the army lists first (Players tab)."; return render(); }
  t.status = "running"; ui.sub = "rounds";
  drawNext(t);
}
// a team round: { matches, tables }; `prior` is the tournament as it stood before the round
const teamOpts = t => ({ ...ctx(t), newId, clubOfTeam: id => clubOf(teamById(t, id)?.captain) });
function drawTeams(t, prior) {
  const r = drawTeamRound(prior, Date.now(), teamOpts(prior));
  return { ...r, warnings: teamRoundWarnings(prior, r.matches) };
}
function drawNext(t) {
  if (!t.listsLocked) { ui.msg = "Lock the army lists first (Players tab)."; return render(); }
  if (isTeam(t)) {
    const r = drawTeams(t, t);
    t.rounds.push({ n: t.rounds.length + 1, done: false, matches: r.matches, tables: r.tables });
    ui.drawWarnings = r.warnings; commit(`Round ${t.rounds.length} drawn.`); return;
  }
  const tables = drawRound(t, clubOf, Date.now(), ctx(t));
  t.rounds.push({ n: t.rounds.length + 1, done: false, tables });
  ui.drawWarnings = roundWarnings({ ...t, rounds: t.rounds.slice(0, -1) }, tables, clubOf);
  commit(`Round ${t.rounds.length} drawn.`);
}
function redraw(t) {
  const round = t.rounds.at(-1);
  if (isTeam(t)) {
    const r = drawTeams(t, { ...t, rounds: t.rounds.slice(0, -1) });
    round.matches = r.matches; round.tables = r.tables; ui.drawWarnings = r.warnings; commit(`Redrew round ${round.n}.`); return;
  }
  round.tables = drawRound({ ...t, rounds: t.rounds.slice(0, -1) }, clubOf, Date.now(), ctx(t));
  ui.drawWarnings = roundWarnings({ ...t, rounds: t.rounds.slice(0, -1) }, round.tables, clubOf);
  commit(`Redrew round ${round.n}.`);
}
// put a player in a seat; whoever held that seat swaps places with them
function setSeat(round, table, side, pid) {
  const other = side === "a" ? "b" : "a";
  const old = table[side];
  const reset = g => { g.killedByA = []; g.killedByB = []; g.result = null; g.manual = false; g.lockedA = g.lockedB = false; g.pickA = g.pickB = null; };   // a new opponent means the old game record no longer applies
  if (pid === table[other]) { table[other] = old; table[side] = pid; reset(table); return; }
  for (const g of round.tables) for (const s of ["a", "b"]) if (g !== table || s !== side) if (g[s] === pid) { g[s] = old; reset(g); }
  table[side] = pid; reset(table);
}
// team events: a seat can be left empty (the other team's player wins it by forfeit; nobody is charged with a loss)
function emptySeat(round, g, side) {
  if (g.b === null) { round.tables = round.tables.filter(x => x !== g); return; }   // both seats empty: the table goes
  const opp = (round.matches ?? []).find(m => m.mid === g.mid);
  if (side === "a") { g.a = g.b; g.team = opp ? (g.team === opp.a ? opp.b : opp.a) : g.team; }
  g.b = null; g.killedByA = []; g.killedByB = []; g.manual = false; g.vpA = g.vpB = null; g.result = "a";
}
function setTeamSeat(round, g, side, value) {
  if (value === "") emptySeat(round, g, side);
  else if (g[side] !== value) {
    const old = g[side], wipe = x => { x.killedByA = []; x.killedByB = []; x.result = null; x.manual = false; x.vpA = x.vpB = null; };
    let where = null;
    for (const x of round.tables) for (const sd of ["a", "b"]) if ((x !== g || sd !== side) && x[sd] === value) where = [x, sd];
    if (where && old !== null) { where[0][where[1]] = old; wipe(where[0]); }
    else if (where) emptySeat(round, where[0], where[1]);
    g[side] = value; wipe(g);
  }
  for (const x of round.tables) if (x.b === null) x.result = "a";   // a forfeit seat is always a win for the player present
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
  commitLater(table);
}
// ---- lock-in: each player secretly picks one of their two lists for a game ----
// The choice is sent straight to the database, which hides it from the opponent (and everybody else) until both have locked in.
async function lockIn(t, g, slot) {
  if (!g.gid) { ui.msg = "The draw is still being saved. Try again in a moment."; return render(); }
  try {
    await cloud.lockIn(g.gid, t.id, slot);
    if (g.a === myId()) { g.lockedA = true; g.pickA = slot; } else { g.lockedB = true; g.pickB = slot; }
    ui.msg = `Locked in list ${slot}.`;
  } catch (err) { ui.msg = `Could not lock in: ${problem(err)}`; }
  render();
}
// organiser: lock in a list for a player who cannot (the same rules as their own lock-in)
async function lockFor(t, g, pid, slot) {
  try {
    await cloud.organiserLockIn(g.gid, pid, slot);
    if (g.a === pid) g.lockedA = true; else g.lockedB = true;
    ui.msg = `Locked in list ${slot} for ${nameOf(pid)}.`;
    await refresh();
  } catch (err) { ui.msg = `Could not lock in for them: ${problem(err)}`; }
  render();
}
// organiser: clear both lock-ins of a table (a mistake, or the wrong list)
async function clearLocks(t, g) {
  try { await cloud.clearLockIn(g.gid); g.lockedA = g.lockedB = false; g.pickA = g.pickB = null; ui.msg = "The lock-ins on that table have been cleared. Both players lock in again."; }
  catch (err) { ui.msg = `Could not clear them: ${problem(err)}`; }
  render();
}
// a reminder for a player whose game in the open round still needs their lock-in
function myLockInDue(t) {
  const last = t.rounds.at(-1), me = myId();
  if (!me || t.status !== "running" || !last || last.done) return null;
  return last.tables.find(g => g.b !== null && (g.a === me ? !g.lockedA : g.b === me ? !g.lockedB : false)) ?? null;
}
function lockInReminder(t) {
  const g = myLockInDue(t);
  if (!g) return "";
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Lock in your list" }),
    el("p", { textContent: `Round ${t.rounds.at(-1).n}, table ${g.id}: you play ${nameOf(g.a === myId() ? g.b : g.a)}. Choose which of your two lists you are using before you play. Your choice stays secret until both of you have locked in.` }),
    btn("Go to my table", () => { ui.sub = "rounds"; render(); }));
}

// ---- units destroyed: a checklist of the enemy army's units, crossed off as they die ----
function toggleKill(t, g, key, i) {
  const now = new Set(g[key] ?? []);
  if (now.has(i)) now.delete(i); else now.add(i);
  g[key] = [...now].sort((a, b) => a - b);
  autoResult(t, g);
  commit(ui.msg, g);
}
const killedPoints = (t, g, side) => {   // points of the enemy army that `side` has destroyed in this game
  const opp = side === "a" ? g.b : g.a, pts = rowPointsOf(t, opp, g);
  return (g[side === "a" ? "killedByA" : "killedByB"] ?? []).reduce((n, i) => n + (pts[i] ?? 0), 0);
};
function killList(t, g, side, editable) {
  const opp = side === "a" ? g.b : g.a, key = side === "a" ? "killedByA" : "killedByB";
  const info = infoFor(t, opp, g);
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
  const org = isOrganiser(t), open = !round.done && t.status === "running";
  const editable = org && open;   // the organiser changes anything
  const reports = g => !org && open && !!myId() && (g.a === myId() || g.b === myId());   // a player reports victory points and destroyed units of their own game
  const canScore = g => editable || reports(g);
  const scoreable = g => canScore(g) && bothLocked(g);   // victory points and destroyed units wait for both lock-ins
  const players = t.players.map(p => p.pid);
  const oppTeamOf = g => { const m = (round.matches ?? []).find(x => x.mid === g.mid); return m ? (g.team === m.a ? m.b : m.a) : null; };
  const teamSeat = (g, side) => {   // team events: a seat holds a member of that side's team, or is left empty (forfeit)
    const team = side === "a" ? g.team : oppTeamOf(g), mem = t.players.filter(p => p.teamId === team);
    return editable ? el("select", { id: `seat-${round.n}-${g.id}-${side}`, onchange: e => { setTeamSeat(round, g, side, e.target.value); commit(); } },
      opt("", "- empty (forfeit) -", g[side] === null), ...mem.map(p => opt(p.pid, matchOf(p.pid) + (p.dropped ? " (dropped)" : ""), g[side] === p.pid)))
      : el("span", { textContent: g[side] === null ? "(empty)" : matchOf(g[side]) });
  };
  const seat = (g, side) => isTeam(t) ? teamSeat(g, side) : editable ? el("select", { id: `seat-${round.n}-${g.id}-${side}`, onchange: e => { setSeat(round, g, side, e.target.value); commit(); } },
    ...players.map(pid => opt(pid, matchOf(pid) + (t.players.find(p => p.pid === pid).dropped ? " (dropped)" : ""), g[side] === pid))) : el("span", { textContent: matchOf(g[side]) });
  const numField = (g, key) => (key.startsWith("vp") ? scoreable(g) : editable) ? el("input", { type: "number", min: 0, id: `${key}-${round.n}-${g.id}`, value: g[key] ?? "", style: "width:52px", onchange: e => setNum(t, g, key, e.target.value) }) : el("span", { textContent: g[key] ?? "" });
  const BASIS = { wipeout: "army wiped out", vp: "victory points", table: "points on the table", tied: "level on points on the table" };
  const tierText = g => {
    const tier = winTier(g, t.rules, ctx(t)), basis = g.manual || !g.result ? "" : BASIS[decideResult(g, ctx(t)).basis] ?? "";
    return [tier, basis].filter(Boolean).length ? ` (${[tier, basis].filter(Boolean).join(", ")})` : "";
  };
  // the lock-in line under a table: pick a list, wait for the opponent, or (once both have locked) see who plays what
  const lockRow = g => {
    const me = myId(), side = g.a === me ? "a" : g.b === me ? "b" : null, live = open && !round.done;
    const mine = side === "a" ? g.lockedA : side === "b" ? g.lockedB : false, theirs = side === "a" ? g.lockedB : side === "b" ? g.lockedA : false;
    const opp = side === "a" ? g.b : g.a, who = pid => t.players.find(p => p.pid === pid);
    const played = pid => {
      const p = who(pid), slot = pid === g.a ? g.pickA : g.pickB, code = slot ? listCodeOf(p, slot) : null;
      return el("span", { className: "lock-played" }, `${matchOf(pid)} plays ${slot ? `list ${slot}` : "a list that is not shown"}${code ? `: ${listSummary(code)} ` : " "}`,
        ...(code ? [el("a", { className: "row-btn", href: `index.html#list=${code}`, target: "_blank", textContent: "View" })] : []));
    };
    let parts;
    if (bothLocked(g)) parts = [el("span", { className: "ok lock-note", textContent: "Both locked in." }), played(g.a), " ", played(g.b)];
    else if (!live && !g.lockedA && !g.lockedB) return null;   // a game from before lock-ins existed
    else if (side && !mine && live) {
      const p = who(me), c1 = p?.listCode, c2 = p?.listCode2;
      const pick = n => sure(`lock:${g.gid ?? g.id}:${n}`, c1 && c2 && c1 !== c2 ? `Lock in list ${n}: ${listSummary(listCodeOf(p, n))}` : "Lock in my list", () => lockIn(t, g, n));
      const o = who(opp), [o1, o2] = entryCodes(o), oLink = (code, label) => code ? [`${label}: ${listSummary(code)} `, el("a", { className: "row-btn", href: `index.html#list=${code}`, target: "_blank", textContent: "View" }), " "] : [];
      parts = [el("span", { className: "lock-note" }, `${nameOf(opp)}'s lists: `, ...(!o1 ? ["not shown"] : o2 && o2 !== o1 ? [...oLink(o1, "1"), ...oLink(o2, "2")] : [...oLink(o1, "both lists")])),
        el("span", { className: "meta lock-note", textContent: `Choose one of your two lists (final, and secret until ${nameOf(opp)} has locked in too${theirs ? "; they already have" : ""}): ` }),
        ...(c1 ? [pick(1)] : []), ...(c2 && c2 !== c1 ? [pick(2)] : [])];
    }
    else if (side && mine) parts = [el("span", { className: "meta", textContent: `You locked in list ${side === "a" ? g.pickA : g.pickB}. Waiting for ${nameOf(opp)} to lock in; you will both see the lists then.` })];
    else {   // the organiser (or a visitor): the organiser also sees which list each player locked in, on tables they do not play at
      const state = (locked, pick) => (locked ? `has locked in${pick ? ` list ${pick}` : ""}` : "has not yet");
      parts = [el("span", { className: "meta", textContent: `Waiting for lock-ins: ${nameOf(g.a)} ${state(g.lockedA, g.pickA)}, ${nameOf(g.b)} ${state(g.lockedB, g.pickB)}.` })];
    }
    if (org && live && g.gid) {   // the organiser can lock in for a player who has not (they are shown the player's lists)
      for (const sd of ["a", "b"]) {
        const pid = g[sd], done = sd === "a" ? g.lockedA : g.lockedB;
        if (done || pid === me) continue;
        const p = who(pid), [c1, c2] = entryCodes(p), two = c2 && c2 !== c1;
        parts.push(el("span", { className: "lock-note" }, el("span", { className: "meta", textContent: `${nameOf(pid)} has not locked in. Lock in for them: ` }),
          ...(c1 ? [sure(`ol:${g.gid}:${pid}:1`, two ? `List 1: ${listSummary(c1)}` : "Their list", () => lockFor(t, g, pid, 1))] : []),
          ...(two ? [sure(`ol:${g.gid}:${pid}:2`, `List 2: ${listSummary(c2)}`, () => lockFor(t, g, pid, 2))] : [])));
      }
    }
    if (org && live && (g.lockedA || g.lockedB) && g.gid) parts.push(" ", sure(`clr:${g.gid}`, "Clear lock-ins", () => clearLocks(t, g)));
    return el("tr", { className: "lock-row" }, el("td"), el("td", { colSpan: 7 }, ...parts));
  };
  const rowsOf = tables => tables.flatMap(g => {
    if (g.b === null && isTeam(t)) return [el("tr", {}, el("td", { textContent: g.id }), el("td", {}, seat(g, "a")),
      el("td", { colSpan: 2, className: "meta", textContent: "Forfeit win (empty seat)" }), el("td", {}, seat(g, "b")), el("td", { colSpan: 3 }))];
    if (g.b === null) return [el("tr", {}, el("td", { textContent: g.id }), el("td", {}, seat(g, "a")), el("td", { colSpan: 6, className: "meta", textContent: "Bye (counts as a win)" }))];
    const key = `${round.n}-${g.id}`, isOpen = ui.openKills === key;
    const c = ctx(t), left = side => (c.tableStart(side === "a" ? g.a : g.b, g) - killedPoints(t, g, side === "a" ? "b" : "a"));
    const done = `${nameOf(g.a)} destroyed ${killedPoints(t, g, "a")} pts (${left("b")} left on ${nameOf(g.b)}'s table), ${nameOf(g.b)} destroyed ${killedPoints(t, g, "b")} pts (${left("a")} left on ${nameOf(g.a)}'s table)`;
    return [el("tr", {}, el("td", { textContent: g.id }), el("td", {}, seat(g, "a")), el("td", {}, numField(g, "vpA")), el("td", {}, numField(g, "bonusA")),
      el("td", {}, seat(g, "b")), el("td", {}, numField(g, "vpB")), el("td", {}, numField(g, "bonusB")),
      el("td", {}, editable && bothLocked(g) ? el("span", {}, el("select", { id: `res-${round.n}-${g.id}`, onchange: e => { setResult(t, g, e.target.value); commitLater(); } },
        opt("auto", g.manual || !g.result ? "Automatic" : "Automatic (from the game)", !g.manual), opt("", "- no result -", g.manual && !g.result), opt("a", `${nameOf(g.a)} wins`, g.result === "a"), opt("draw", "Draw", g.result === "draw"), opt("b", `${nameOf(g.b)} wins`, g.result === "b")),
        el("span", { className: "meta", textContent: tierText(g) }))
        : el("span", { textContent: (g.result === "a" ? `${nameOf(g.a)} wins` : g.result === "b" ? `${nameOf(g.b)} wins` : g.result === "draw" ? "Draw" : "") + tierText(g) }))),
    lockRow(g) ?? "",
    el("tr", { className: "kills-row" }, el("td"), el("td", { colSpan: 7 },
      el("button", { className: "row-btn", textContent: `${isOpen ? "Hide" : "Units destroyed"}: ${done}`, onclick: () => { ui.openKills = isOpen ? null : key; render(); } }),
      isOpen ? el("div", { className: "kill-pair" }, killList(t, g, "a", scoreable(g)), killList(t, g, "b", scoreable(g))) : ""))];
  });
  const matchRows = isTeam(t) ? (round.matches ?? []).flatMap(m => {
    const o = matchOutcome(t, round, m, ctx(t)), A = teamLabel(t, m.a), B = m.b ? teamLabel(t, m.b) : "";
    const text = m.b === null ? `${A}: bye (counts as a win)`
      : `${A} ${o.winsA} - ${o.winsB} ${B}${o.draws ? ` (${o.draws} drawn)` : ""}: ` + (o.result === null ? "in progress" : o.result === "draw" ? "team draw" : `${o.result === "a" ? A : B} win${o.major ? " (major)" : ""}`);
    return [el("tr", { className: "match-row" }, el("th", { colSpan: 8, textContent: text })), ...rowsOf(round.tables.filter(g => g.mid === m.mid))];
  }) : rowsOf(round.tables);
  return el("div", { className: "table-wrap" }, el("table", { className: "an-table tn rnd" },
    el("thead", {}, el("tr", {}, ...["Table", "Player A", "VP", "Bonus", "Player B", "VP", "Bonus", "Result"].map(h => el("th", { textContent: h })))), el("tbody", {}, ...matchRows)));
}
// team rounds: nobody may sit twice (absent players simply have no seat)
const teamSeatsOk = tables => { const seen = tables.flatMap(g => [g.a, g.b]).filter(x => x !== null); return new Set(seen).size === seen.length; };
function renderRounds(t) {
  const last = t.rounds.at(-1), parts = [el("h2", { textContent: "Rounds" })];
  const played = t.rounds.filter(r => r.done).length;
  if (t.status === "setup") {
    parts.push(el("p", { className: "meta", textContent: isTeam(t) ? `${new Set(active(t).map(p => p.teamId)).size} teams (${active(t).length} players) registered. Starting locks the rules and draws round one.` : `${active(t).length} players registered. Starting locks the rules and draws round one.` }),
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
          if (isTeam(t) ? !teamSeatsOk(last.tables) : !drawIsComplete(t, last.tables)) { ui.msg = isTeam(t) ? "A player is seated twice. Check the seats below." : "Every playing player must be seated exactly once. Check the seats below."; return render(); }
          last.done = true; ui.drawWarnings = []; ui.openKills = null; commit(`Round ${last.n} finished.`); }, unfinished > 0 || missingVp > 0),
        btn("Redraw round", () => redraw(t), results));
      if (unfinished) bar.push(el("span", { className: "meta", textContent: `${unfinished} table${unfinished > 1 ? "s" : ""} still need a result.` }));
      else if (missingVp) bar.push(el("span", { className: "meta", textContent: `Enter both players' victory points on ${missingVp} table${missingVp > 1 ? "s" : ""} so the margin of victory is known.` }));
    } else if (t.status === "running") {
      bar.push(btn(played < t.plannedRounds ? `Draw round ${t.rounds.length + 1}` : `Draw an extra round (${t.rounds.length + 1})`, () => drawNext(t)));
      bar.push(btn("Reopen last round", () => { last.done = false; commit(`Round ${last.n} reopened.`); }, !last));
      if (played >= t.plannedRounds) bar.push(sure("fin", "Finish tournament", () => { t.status = "finished"; ui.sub = "standings"; commit("Tournament finished."); saveResults(t); }));
    } else bar.push(btn("Reopen tournament", () => { t.status = "running"; commit("Tournament reopened."); cloud.clearResults(t.id).then(() => cloud.recomputeRatings()).catch(err => { ui.msg = `Reopened, but the saved results could not be cleared: ${problem(err)}`; render(); }); }));
    parts.push(el("div", { className: "an-pick tn-bar" }, ...bar));
    if (ui.drawWarnings.length && last && !last.done) parts.push(el("p", { className: "warn", textContent: ui.drawWarnings.join(" ") + " It could not be avoided with the players available. You can edit the seats below." }));
    if (last && !last.done) parts.push(el("p", { className: "meta", textContent: (isTeam(t) ? "Change a seat to swap two players of the same team, to sub in a teammate, or to leave it empty if someone is absent (the other team's player then wins the seat by forfeit and nobody is charged with a loss). " : "Change a seat to swap two players. ") + "Enter victory points (the result fills in) or pick the result yourself. Bonus points are added to a player's tournament points. Open \"Units destroyed\" on a table to cross off the enemy units each player destroyed; their points feed the tie-breaker." }));
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
    lines.push([s.rank, matchOf(s.pid), profile(s.pid)?.club, info?.faction, s.points, s.played, s.w, s.d, s.l, s.majors, s.sos.toFixed(2), s.vpDiff, s.vp, s.destroyed, s.lost].map(q).join(","));
  });
  return lines.join("\r\n");
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function renderStandings(t) {
  if (!isTeam(t)) return renderIndividualStandings(t, t.status === "finished" ? "Final standings" : "Standings");
  const st = teamStandings(t, ctx(t)), done = t.rounds.filter(r => r.done).length, major = t.rules.margins?.enabled;
  const rows = st.map(s => {
    const x = teamById(t, s.team), caps = x ? nameOf(x.captain) : "";
    return el("tr", { className: s.rank === 1 && done ? "hot" : "" }, el("td", { textContent: s.rank }), el("td", { textContent: s.name + (caps ? ` (captain ${caps})` : "") }), el("td", { textContent: s.points }),
      el("td", { textContent: `${s.w}-${s.d}-${s.l}` }), ...(major ? [el("td", { textContent: s.majors })] : []), el("td", { textContent: s.gameWins }),
      el("td", { textContent: s.sos.toFixed(2) }), el("td", { textContent: s.vpDiff > 0 ? `+${s.vpDiff}` : s.vpDiff }), el("td", { textContent: s.destroyed }));
  });
  return [el("section", { className: "an-panel" }, el("h2", { textContent: t.status === "finished" ? "Final team standings" : "Team standings" }),
    el("p", { className: "meta", textContent: done ? `After ${done} round${done > 1 ? "s" : ""}. Open matches are not counted yet. A team wins a match by winning more individual games than it loses.` : "No rounds finished yet." }),
    el("div", { className: "table-wrap" }, el("table", { className: "an-table tn stand" },
      el("thead", {}, el("tr", {}, ...["Rank", "Team", "Pts", "W-D-L", ...(major ? ["Major wins"] : []), "Games won", "SoS", "VP diff", "Destroyed"].map(h => el("th", { textContent: h })))), el("tbody", {}, ...rows)))),
    renderIndividualStandings(t, "Individual standings")];
}
function renderIndividualStandings(t, heading) {
  const st = stand(t), done = t.rounds.filter(r => r.done).length;
  const rows = st.map(s => {
    const info = listInfo(t.players.find(p => p.pid === s.pid)?.listCode);
    return el("tr", { className: s.dropped ? "dropped" : s.rank === 1 && done ? "hot" : "" }, el("td", { textContent: s.rank }), personCell(s.pid),
      el("td", { textContent: profile(s.pid)?.club || "-" }), el("td", { textContent: info?.faction ?? "-" }), el("td", { textContent: s.points }),
      el("td", { textContent: `${s.w}-${s.d}-${s.l}` }), ...(t.rules.margins?.enabled ? [el("td", { textContent: s.majors })] : []),
      el("td", { textContent: s.sos.toFixed(2) }), el("td", { textContent: s.vpDiff > 0 ? `+${s.vpDiff}` : s.vpDiff }), el("td", { textContent: s.vp }),
      el("td", { textContent: s.destroyed }), el("td", { textContent: s.lost }));
  });
  return el("section", { className: "an-panel" }, el("h2", { textContent: heading }),
    el("p", { className: "meta", textContent: done ? `After ${done} round${done > 1 ? "s" : ""}. Open games are not counted yet.` : "No rounds finished yet." }),
    el("div", { className: "table-wrap" }, el("table", { className: "an-table tn stand" },
      el("thead", {}, el("tr", {}, ...["Rank", "Player", "Club", "Faction", "Pts", "W-D-L", ...(t.rules.margins?.enabled ? ["Major wins"] : []), "SoS", "VP diff", "VP", "Destroyed", "Lost"].map(h => el("th", { textContent: h })))), el("tbody", {}, ...rows))),
    btn("Export standings (CSV)", () => download(`${t.name.replace(/[^\w-]+/g, "_")}-standings.csv`, csvOf(t), "text/csv")));
}


// ---- one tournament -------------------------------------------------------

// the final standings are saved when a tournament is finished: they are what wins and podium finishes are counted from
async function saveResults(t) {
  try {
    await cloud.flush(); await cloud.saveResults(t, stand(t)); await cloud.recomputeRatings();
    ui.msg = "Tournament finished. The final results are saved to the players' records" + (ratedNow(t) ? " and the ratings are updated." : `. It had fewer than ${MIN_RATED_PLAYERS} players, so it does not count for ratings.`);
  }
  catch (err) { ui.msg = `Tournament finished, but the final results could not be saved to the records: ${problem(err)}. Reopen and finish it again to retry.`; }
  render();
}

function renderTournamentView(t) {
  const org = isOrganiser(t);
  const subs = org ? [["players", "Players"], ["details", "Details"], ["rules", "Rules"], ["rounds", "Rounds"], ["standings", "Standings"]] : [["overview", "Overview"], ["rounds", "Rounds"], ["standings", "Standings"]];
  if (!subs.some(([k]) => k === ui.sub)) ui.sub = subs[0][0];
  const head = el("section", { className: "an-panel" }, el("h2", { textContent: t.name }),
    el("p", { className: "meta", textContent: [t.date, t.location, `${t.points} points`, isTeam(t) ? `teams of ${t.teamSize}` : "", `${t.plannedRounds} rounds`, t.status, org ? "you are the organiser" : ""].filter(Boolean).join(" - ") }),
    teamNote(t),
    el("div", { className: "site-nav" }, ...subs.map(([k, label]) => el("a", { href: "#", className: ui.sub === k ? "nav-link current" : "nav-link", textContent: label,
      onclick: e => { e.preventDefault(); ui.sub = k; ui.msg = ""; render(); } })),
      ...(org ? [] : [el("a", { href: "#", className: "nav-link", textContent: "Back", onclick: async e => { e.preventDefault(); closeTournament(); ui.msg = ""; await enterTab(); } })])));
  const body = org ? { players: renderPlayers, details: renderDetails, rules: renderRules, rounds: renderRounds, standings: renderStandings }[ui.sub]
    : { overview: renderOverview, rounds: renderPlayerRounds, standings: renderStandings }[ui.sub];
  return [head, ...[].concat(body(t))];
}
// the rounds as a player or visitor sees them (a player can report their own games)
function renderPlayerRounds(t) {
  const rounds = [...t.rounds].reverse();
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Rounds" }),
    rounds.length ? el("p", { className: "meta", textContent: myId() && t.players.some(p => p.pid === myId()) ? "First lock in one of your two lists on your table. Then you can enter the victory points and tick off destroyed units for your own games while a round is open. The organiser can correct anything." : "" }) : el("p", { className: "meta", textContent: "No rounds have been drawn yet." }),
    ...rounds.map((r, i) => el("details", { open: i === 0 }, el("summary", { textContent: `Round ${r.n}${r.done ? "" : " (in progress)"}` }), renderRound(t, r))));
}

// ---- accounts ---------------------------------------------------------------

const statusText = () => `Signed in as ${displayName(me) || cloud.user?.email || ""}. ` + ({ saving: "Saving...", saved: "All changes saved.", offline: "Not saved yet. It will retry when the connection is back." }[cloud.status] ?? "");
const showStatus = () => { const n = document.getElementById("cloud-status"); if (n) n.textContent = statusText(); };   // updates in place, so typing is not interrupted

function renderSignIn() {
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Sign in or create an account" }),
    el("p", { className: "meta", textContent: "Enter your email address and we send you a link. There is no password. The same link creates your account the first time. You only need an account to join or run tournaments; anyone can browse and view them." }),
    el("div", { className: "an-pick" },
      el("input", { type: "email", id: "signin-email", className: "paste", placeholder: "you@example.com", value: ui.email, style: "flex:0 1 260px", onchange: e => { ui.email = e.target.value; } }),
      btn("Email me a link", async () => {
        const email = document.getElementById("signin-email").value.trim();
        if (!email) { ui.authMsg = "Enter your email address."; return render(); }
        ui.email = email; ui.authMsg = "Sending..."; render();
        try { await cloud.signIn(email); ui.authMsg = `Check your email (${email}) and open the link in this browser.`; }
        catch (err) { ui.authMsg = `Could not send the link: ${problem(err)}`; }
        render(); })),
    ui.authMsg ? el("p", { className: "meta", textContent: ui.authMsg }) : "");
}
async function signOut() {
  try { if (!(await cloud.signOut())) { ui.msg = "Some changes have not reached the database yet. Try again when you are back online."; return render(); } }
  catch (err) { ui.msg = `Could not sign out: ${problem(err)}`; return render(); }
  me = null; closeTournament(); ui.mine = null; ui.tab = "directory"; ui.msg = "Signed out."; ui.authMsg = "";
  await enterTab();
}

// ---- page -----------------------------------------------------------------

function renderPage() {
  const needsProfile = !!cloud.user && !me;   // a new account must create its profile before anything else
  const tabs = needsProfile ? [] : cloud.user ? [["directory", "Find a tournament"], ["mine", "My tournaments"]] : [["directory", "Find a tournament"], ["signin", "Sign in"]];
  const body = needsProfile ? renderProfileEdit()
    : ui.t ? renderTournamentView(ui.t)
    : ui.loading && ui.tid ? el("p", { className: "meta", textContent: "Loading..." })
    : !cloud.user && (ui.tab === "mine" || ui.tab === "profile") ? renderSignIn()
    : ui.tab === "player" ? renderProfile()
    : ui.tab === "signin" ? (cloud.user ? renderProfile() : renderSignIn())
    : ui.tab === "profile" ? renderProfile() : ui.tab === "mine" ? renderMine() : renderDirectory();
  return [...renderNav(!ui.t && ui.tab === "profile" ? "profile" : !ui.t && ui.tab === "player" ? "rankings" : "tournament"),
    cloud.user ? el("div", { className: "an-panel tn-account" }, el("span", { id: "cloud-status", className: "meta", textContent: statusText() }), btn("Sign out", signOut)) : "",
    !tabs.length ? "" : el("div", { className: "site-nav" }, ...tabs.map(([k, label]) => el("a", { href: "#", className: !ui.t && ui.tab === k ? "nav-link current" : "nav-link", textContent: label,
      onclick: async e => { e.preventDefault(); closeTournament(); if (ui.viewing) { ui.viewing = null; history.replaceState(null, "", location.pathname); } if (ui.editProfile) { ui.editProfile = false; history.replaceState(null, "", location.pathname); } ui.tab = k; ui.msg = ""; ui.confirm = null; await enterTab(); } }))),
    ui.msg ? el("p", { className: "an-panel tn-msg", textContent: ui.msg }) : "", ...[].concat(body)].flat();
}
function render() {
  const focus = document.activeElement?.id, pos = document.activeElement?.selectionStart;
  document.getElementById("app").replaceChildren(...renderPage());
  if (focus) { const n = document.getElementById(focus); if (n) { n.focus(); try { if (pos != null) n.setSelectionRange(pos, pos); } catch { /* number inputs have no selection */ } } }
}
// load what the current tab shows
async function enterTab() {
  if (ui.tab === "directory") return searchDirectory();
  if (ui.tab === "mine" && cloud.user) return loadMine();
  if (ui.tab === "profile" || ui.tab === "player") {
    if (ui.tab === "profile") ui.viewing = null;
    ui.profileForm = null; ui.stats = null; ui.rating = null; ui.games = null; ui.viewList = null; ui.historyAll = false;
    const pid = ui.viewing ?? me?.id;
    if (pid) {
      ui.loading = true; render();
      try { if (ui.viewing && !people.has(pid)) for (const p of await cloud.profiles([pid])) people.set(p.id, p); } catch { /* shown as not found */ }
      ui.loading = false;
      if (!people.has(pid)) return render();
      try { ui.stats = await cloud.stats(pid); } catch { /* the record is optional */ }
      try {
        const [R, games] = await Promise.all([cloud.ratings(pid), cloud.gamesOf(pid)]);
        const ids = [...new Set(games.map(g => g.opp_id))].filter(id => !people.has(id));
        for (const p of await cloud.profiles(ids)) people.set(p.id, p);
        ui.rating = R; ui.games = games;
      } catch (err) { ui.rating = { rows: [], ranks: [], history: [] }; ui.games = []; ui.msg = `Could not load the rating and games: ${problem(err)}`; }
    }
  }
  render();
}

// who is signed in, and do they have a profile?
async function loadAccount() {
  me = null;
  if (!cloud.user) return;
  try { me = await cloud.myProfile(); if (me) people.set(me.id, me); } catch (err) { ui.msg = `Could not load your profile: ${problem(err)}`; }
}
async function onAuth() {
  await loadAccount();
  if (cloud.user && !me) { ui.tab = "profile"; ui.msg = "Welcome! Please create your profile before using the tools."; }
  else if (cloud.user && ui.tab === "signin") ui.tab = "mine";
  if (cloud.user && !me) { closeTournament(false); await enterTab(); return; }
  if (ui.t) await openTournament(ui.t.id, { push: false }); else await enterTab();
}
// the address names the tournament: ?t=<id>
const routeId = () => { const q = new URLSearchParams(location.search); return q.get("t") ?? q.get("view"); };
async function route() {
  if (playerParam()) { closeTournament(false); ui.viewing = playerParam(); ui.tab = "player"; return enterTab(); }
  ui.viewing = null;
  if (profileParam() && cloud.user) { ui.editProfile = profileParam() === "edit"; closeTournament(false); ui.tab = "profile"; return enterTab(); }
  ui.editProfile = false;
  const id = routeId();
  if (id) await openTournament(id, { push: false }); else { closeTournament(false); await enterTab(); }
}
window.addEventListener("popstate", () => route());

async function startTournamentPage() {
  try {
    data = await loadData();
    if (!cloud.enabled) { document.getElementById("app").textContent = "The tournament service is not set up (cloud-config.js is missing)."; return; }
    cloud.onStatus = showStatus;
    await cloud.init(onAuth);
    await loadAccount();
    const id = routeId(), pending = storeGet(PENDING_KEY, null);
    ui.editProfile = !!cloud.user && !!me && profileParam() === "edit";
    if (cloud.user && !me) { ui.tab = "profile"; ui.msg = "Welcome! Please create your profile before using the tools."; }
    else if (playerParam()) { ui.viewing = playerParam(); ui.tab = "player"; }
    else ui.tab = profileParam() ? "profile" : cloud.user ? "mine" : "directory";
    if (cloud.user && !me) { ui.tab = "profile"; await enterTab(); return; }
    if (id) await openTournament(id, { push: false });
    else if (cloud.user && pending?.t?.id) await openTournament(pending.t.id, { push: false });   // resume unsaved organiser changes
    else await enterTab();
  } catch (err) {
    console.error("Tournament page failed to start:", err);
    document.getElementById("app").textContent = `Could not start: ${problem(err)}`;
  }
}
startTournamentPage();
