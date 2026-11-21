// Analysis page: compares lists (saved in the Build page) and unit / faction averages.
// It loads app.js without its Build screen (window.SONG_NO_UI) and reuses its rules and data helpers.
//
// The simple model used throughout (see the "How the numbers work" box on the page):
//   hit chance        = (7 - X) / 6 for an "X+" roll on one die
//   hits per attack   = attack dice at full strength x hit chance
//   save chance       = (7 - Defense) / 6
//   effective wounds  = wound pool / (1 - save chance)      (a relative toughness number, not an exact one)
//   control           = how many times a card says a target "becomes" Vulnerable, Weakened or Panicked

const AN_SEL = "song-tool-analysis-selection";
let sourcesExtra = [];            // lists pasted from share links this visit: { label, list }
let selection = storeGet(AN_SEL, { a: "current", b: "" });
let baseline = "list";            // "list" = faction of list A, "all" = every unit, or a faction id
let factionMetric = "damagePerPoint";
let typeFaction = "all";
let pasteMsg = "";
let healRounds = 3;               // rounds of healing counted into resilience (0 = ignore healing)
let attackMode = "full";          // "full" = dice at full strength, "avg" = average over the unit's ranks
let lab = { faction: "all", type: "all", text: "", minPts: "", maxPts: "", sort: "damagePerPoint", dir: -1, picks: [] };

const hitP = x => Math.max(0, Math.min(1, (7 - x) / 6));
// morale: two dice must total at least the Morale number (lower is better)
const moraleP = m => { let ok = 0; for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) if (a + b >= m) ok++; return ok / 36; };
const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;
const pct = n => `${Math.round(n * 100)}%`;
const sum = (xs, f = x => x) => xs.reduce((s, x) => s + f(x), 0);
const mean = (xs, f = x => x) => (xs.length ? sum(xs, f) / xs.length : 0);
const modelName = id => (data.unitsById.get(id) ?? data.commandersById.get(id))?.name ?? id;
const cap = s => s.replace(/-/g, " ").replace(/^\w/, c => c.toUpperCase());

function tokensOf(id) {
  return data.combat.tokens[id] ?? { vulnerable: 0, weakened: 0, panicked: 0, total: 0 };
}

// one combat unit's numbers
// ---- healing -------------------------------------------------------------
// data/healing.json lists every model that restores Wounds. Each ability becomes an expected number of Wounds per round:
// amount (+ a rank bonus where the card says "+1 per destroyed rank") x how often its trigger happens in a round.
function healOf(id) {
  const out = { self: 0, other: 0 };
  (data.healing.sources[id] ?? []).forEach(s => {
    const v = (s.amount + (s.rank ? data.healing.rankBonus : 0)) * data.healing.when[s.when].perRound;
    out[s.who] += v;
  });
  return out;
}
const healOfAll = ids => ({ self: sum(ids, id => healOf(id).self), other: sum(ids, id => healOf(id).other) });

const profileCache = new Map();   // "mode:id" -> profile; data never changes after load, so only the attack mode matters
function unitProfile(id) {
  const key = `${attackMode}:${healRounds}:${id}`;
  if (!profileCache.has(key)) profileCache.set(key, buildProfile(id));
  return profileCache.get(key);
}
function buildProfile(id) {
  const u = data.unitsById.get(id), c = data.combat.units[id];
  if (!u || !c) return null;
  const hits = type => sum(c.plates.filter(p => p.type === type), p => (attackMode === "avg" ? mean(p.dice) : p.dice[0]) * hitP(p.tohit));
  const melee = hits("melee"), ranged = hits("ranged");
  const save = hitP(u.stats.defense);
  const pool = c.woundsTotal ?? (c.woundsPerModel ?? 1) * c.ranks;
  const t = tokensOf(id), h = healOf(id);
  return {
    id, name: u.name, nickname: u.nickname, faction: u.faction, type: u.type, points: u.points,
    speed: u.stats.speed, defense: u.stats.defense, morale: u.stats.morale, ranks: c.ranks,
    melee, ranged, damage: melee + ranged, pool, heal: h.self, support: h.other, effWounds: (pool + h.self * healRounds) / (1 - save), save,
    resolve: moraleP(u.stats.morale), tokens: t.total, vulnerable: t.vulnerable, weakened: t.weakened, panicked: t.panicked,
    orders: (u.traits ?? []).filter(x => x.startsWith("order-")).length,
  };
}

// averages over a set of unit profiles; per-point numbers are pooled (total over total) so 0-point units cannot break them
function averages(ps) {
  const pts = sum(ps, p => p.points) || 1;
  return {
    n: ps.length,
    points: mean(ps, p => p.points), melee: mean(ps, p => p.melee), ranged: mean(ps, p => p.ranged), damage: mean(ps, p => p.damage),
    effWounds: mean(ps, p => p.effWounds), speed: mean(ps, p => p.speed), defense: mean(ps, p => p.defense), resolve: mean(ps, p => p.resolve),
    save: mean(ps, p => p.save), tokens: mean(ps, p => p.tokens), heal: mean(ps, p => p.heal), support: mean(ps, p => p.support),
    damagePerPoint: sum(ps, p => p.damage) / pts, woundsPerPoint: sum(ps, p => p.effWounds) / pts, tokensPerPoint: sum(ps, p => p.tokens) / pts,
  };
}

const allUnits = () => data.units.filter(u => u.class === "combat_unit").map(u => unitProfile(u.id)).filter(Boolean);

// every model of a list that is not a combat unit but adds control or orders (attachments, commander, NCUs)
function listProfile(l) {
  const rows = [];
  const uc = unitCommander(l), fc = fieldCommander(l);
  l.entries.forEach((e, i) => {
    const p = e.unit ? unitProfile(e.unit) : null;
    const asCommander = uc && l.commanderUnit === i;
    const costs = attachmentCosts(e, l);
    const extraIds = [...e.attachments, ...(l.commander && l.commanderUnit === i && !uc ? [l.commander, ...(fc ? [fc.id] : [])] : [])];
    rows.push({
      p, index: i, points: p ? rowCost(l, i) : 0,
      attachmentPoints: sum(costs, c => c.cost),
      attachments: e.attachments.map(id => data.unitsById.get(id)?.name).filter(Boolean),
      commander: l.commander && l.commanderUnit === i && !uc ? commanderOf(l) : null,
      extraTokens: sum(extraIds, id => tokensOf(id).total),
      extraHeal: healOfAll(extraIds).self, extraSupport: healOfAll(extraIds).other,
      extraOrders: sum(extraIds, id => (modelById(id)?.traits ?? []).filter(x => x.startsWith("order-")).length),
    });
  });
  const units = rows.filter(r => r.p);
  const ps = units.map(r => r.p);
  const ncuIds = l.ncus.filter(id => data.unitsById.has(id));
  const total = totalPoints(l);
  const unitPoints = sum(units, r => r.points) || 1;
  const tokens = sum(ps, p => p.tokens) + sum(rows, r => r.extraTokens) + sum(ncuIds, id => tokensOf(id).total)
    + sum(l.enemyAttachments, id => tokensOf(id).total);
  const cond = k => sum(ps, p => p[k]);
  const orders = sum(ps, p => p.orders) + sum(rows, r => r.extraOrders)
    + sum(ncuIds, id => (data.unitsById.get(id).traits ?? []).filter(x => x.startsWith("order-")).length);
  const acts = activations(l);
  // healing: what a unit's attachments and commander restore to it, and what the army can restore to other units
  const ownHeal = sum(rows.filter(r => r.p), r => r.p.heal + r.extraHeal);
  const support = sum(ps, p => p.support) + sum(rows, r => r.extraSupport) + healOfAll(ncuIds).other;
  const extraWounds = sum(rows.filter(r => r.p), r => (r.extraHeal * healRounds) / (1 - r.p.save));
  const supportWounds = (support * healRounds) / (1 - (mean(ps, p => p.save) || 0));
  const types = {};
  ps.forEach(p => { types[p.type] = (types[p.type] ?? 0) + 1; });
  return {
    rows, units, ps, total, size: l.gameSize, acts, ncus: ncuIds.length,
    attachments: sum(l.entries, e => e.attachments.length) + (l.commander && !uc ? 1 : 0) + l.enemyAttachments.length,
    unitPoints, types,
    melee: sum(ps, p => p.melee), ranged: sum(ps, p => p.ranged), damage: sum(ps, p => p.damage),
    effWounds: sum(ps, p => p.effWounds) + extraWounds + supportWounds, heal: ownHeal, support, healTotal: ownHeal + support,
    damagePerPoint: sum(ps, p => p.damage) / unitPoints, woundsPerPoint: (sum(ps, p => p.effWounds) + extraWounds + supportWounds) / unitPoints,
    speed: mean(ps, p => p.speed), save: mean(ps, p => p.save), resolve: mean(ps, p => p.resolve),
    tokens, tokensPerActivation: tokens / (acts || 1), tokensPerUnit: tokens / (ps.length || 1),
    vulnerable: cond("vulnerable"), weakened: cond("weakened"), panicked: cond("panicked"),
    orders, ordersPerActivation: orders / (acts || 1),
    neutral: hasNeutralLimit(l) ? neutralPoints(l) : null,
  };
}

// ---- where lists come from ---------------------------------------------
function sources() {
  const out = [];
  const cur = sanitizeList(storeGet(STORE_CURRENT, null));
  if (cur) out.push({ id: "current", label: `Current list in Build - ${cur.name}`, list: cur });
  storeGet(STORE_SAVED, []).forEach(s => {
    const l = sanitizeList(s.list);
    if (l) out.push({ id: `saved:${s.name}`, label: `${s.name} (saved)`, list: l });
  });
  sourcesExtra.forEach((s, i) => out.push({ id: `pasted:${i}`, label: s.label, list: s.list }));
  return out;
}
function pick(all, id) { return all.find(s => s.id === id) ?? null; }

function addPasted(text) {
  const t = text.trim();
  const hash = t.includes("#list=") ? t.slice(t.indexOf("#list=") + 6) : t;
  const l = decodeList(hash);
  if (!l) { pasteMsg = "That doesn't look like a share link."; return; }
  sourcesExtra.push({ label: `${l.name} (pasted)`, list: l });
  selection.b = `pasted:${sourcesExtra.length - 1}`;
  pasteMsg = `Added "${l.name}" as List B.`;
}

// ---- small drawing helpers ----------------------------------------------
const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVG, tag);
  Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
  n.append(...kids);
  return n;
}

// radar: axes [{label}], series [{name, color, values (100 = baseline), dashed}]
function radar(axes, series, max = 200) {
  const S = 380, C = S / 2, R = 150, n = axes.length;
  const pt = (i, v) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n, r = (Math.min(v, max) / max) * R;
    return [C + r * Math.cos(a), C + r * Math.sin(a)];
  };
  const root = svg("svg", { viewBox: `-50 6 ${S + 100} ${S - 20}`, class: "radar", role: "img", "aria-label": "Radar chart comparing the lists" });
  [50, 100, 150, 200].forEach(level => {
    const ring = axes.map((_, i) => pt(i, level).join(",")).join(" ");
    root.append(svg("polygon", { points: ring, class: level === 100 ? "ring base" : "ring" }));
  });
  axes.forEach((a, i) => {
    const [x, y] = pt(i, max), la = -Math.PI / 2 + (i * 2 * Math.PI) / n, lx = C + (R + 24) * Math.cos(la), ly = C + (R + 20) * Math.sin(la);
    root.append(svg("line", { x1: C, y1: C, x2: x, y2: y, class: "spoke" }));
    const t = svg("text", { x: lx, y: ly, class: "axis-label", "text-anchor": Math.abs(lx - C) < 8 ? "middle" : lx > C ? "start" : "end", "dominant-baseline": "middle" });
    t.textContent = a.label;
    root.append(t);
  });
  series.forEach(s => {
    root.append(svg("polygon", {
      points: s.values.map((v, i) => pt(i, v).join(",")).join(" "),
      fill: s.dashed ? "none" : s.color, "fill-opacity": 0.18, stroke: s.color, "stroke-width": 2.5,
      "stroke-dasharray": s.dashed ? "6 4" : "none",
    }));
    if (!s.dashed) s.values.forEach((v, i) => { const [x, y] = pt(i, v); root.append(svg("circle", { cx: x, cy: y, r: 3.5, fill: s.color })); });
  });
  return root;
}

function bars(items, fmt, highlight) {
  const top = Math.max(...items.map(i => i.value), 0.0001);
  return el("div", { className: "bars" }, ...items.map(i =>
    el("div", { className: i.id === highlight ? "bar-row hot" : "bar-row" },
      el("span", { className: "bar-label", textContent: i.label }),
      el("span", { className: "bar-track" }, el("span", { className: "bar-fill", style: `width:${(i.value / top) * 100}%` })),
      el("span", { className: "bar-val", textContent: fmt(i.value) }))));
}

// ---- the page --------------------------------------------------------------
const METRICS = [
  { group: "The list" },
  { key: "total", label: "Points", fmt: n => n, },
  { key: "acts", label: "Activations", fmt: n => n, more: true },
  { key: "units", label: "Combat units", fmt: (n, p) => p.units.length, raw: p => p.units.length },
  { key: "ncus", label: "Non-combatant units", fmt: n => n },
  { key: "attachments", label: "Attachments (including commander)", fmt: n => n },
  { key: "orders", label: "Orders available", fmt: n => n, more: true },
  { group: "Damage (per activation)" },
  { key: "melee", label: "Melee hits", fmt: r1, more: true },
  { key: "ranged", label: "Ranged hits", fmt: r1, more: true },
  { key: "damage", label: "Total hits", fmt: r1, more: true },
  { key: "damagePerPoint", label: "Hits per unit point", fmt: r2, more: true, base: "damagePerPoint" },
  { group: "Defence" },
  { key: "effWounds", label: "Effective wounds (total)", fmt: r1, more: true },
  { key: "woundsPerPoint", label: "Effective wounds per unit point", fmt: r2, more: true, base: "woundsPerPoint" },
  { key: "heal", label: "Healing per round (to their own unit)", fmt: r2, more: true, base: "heal" },
  { key: "support", label: "Healing per round (to other units)", fmt: r2, more: true },
  { key: "save", label: "Average save chance", fmt: pct, more: true, base: "save" },
  { key: "resolve", label: "Average morale pass chance", fmt: pct, more: true, base: "resolve" },
  { group: "Mobility and control" },
  { key: "speed", label: "Average speed", fmt: r1, more: true, base: "speed" },
  { key: "tokens", label: "Condition applications (Vulnerable / Weakened / Panicked)", fmt: r1, more: true },
  { key: "tokensPerUnit", label: "Condition applications per combat unit", fmt: r2, more: true, base: "tokens" },
];

function baselineUnits(a) {
  const all = allUnits();
  if (baseline === "all") return { label: "All units", ps: all };
  const f = baseline === "list" ? (a?.list.faction ?? "all") : baseline;
  if (f === "all") return { label: "All units", ps: all };
  return { label: `${data.factionsById.get(f)?.name.replace(/^House /, "") ?? f} average`, ps: all.filter(p => p.faction === f) };
}

function renderPicker(all) {
  const opt = (id, label, sel) => el("option", { value: id, textContent: label, selected: sel });
  const sel = (which, withNone) => el("select", { onchange: e => { selection[which] = e.target.value; storeSet(AN_SEL, selection); renderAnalysis(); } },
    ...(withNone ? [opt("", "- none -", !selection[which])] : []), ...all.map(s => opt(s.id, s.label, s.id === selection[which])));
  const paste = el("input", { type: "text", placeholder: "Paste a share link here", className: "paste" });
  return el("section", { className: "an-panel" },
    el("div", { className: "an-pick" },
      el("label", {}, "List A ", sel("a", false)),
      el("label", {}, "List B ", sel("b", true)),
      el("label", {}, "Attacks ", el("select", { onchange: e => { attackMode = e.target.value; renderAnalysis(); } },
        opt("full", "Full strength (all ranks)", attackMode === "full"), opt("avg", "Average over ranks", attackMode === "avg"))),
      el("label", {}, "Healing ", el("select", { onchange: e => { healRounds = +e.target.value; renderAnalysis(); } },
        opt("0", "Ignore", healRounds === 0), ...[2, 3, 4, 6].map(n => opt(String(n), `Count ${n} rounds`, healRounds === n)))),
      el("label", {}, "Compare to ", el("select", { onchange: e => { baseline = e.target.value; renderAnalysis(); } },
        opt("list", "Faction of list A", baseline === "list"), opt("all", "All units", baseline === "all"),
        ...data.factions.filter(f => f.id !== "neutral" || true).map(f => opt(f.id, f.name.replace(/^House /, ""), baseline === f.id))))),
    el("div", { className: "an-pick" }, paste,
      el("button", { className: "row-btn", textContent: "Add as List B", onclick: () => { addPasted(paste.value); storeSet(AN_SEL, selection); renderAnalysis(); } }),
      pasteMsg ? el("span", { className: "tool-msg", textContent: pasteMsg }) : ""),
    all.length ? "" : el("p", { className: "meta", textContent: "No lists yet. Build one on the Build page (it is saved automatically) and it appears here." }));
}

function deltaCell(a, b, m) {
  if (b == null) return el("td");
  const d = b - a;
  if (Math.abs(d) < 0.005) return el("td", { className: "delta", textContent: "=" });
  const good = m.more == null ? "" : (d > 0) === m.more ? " good" : " bad";
  return el("td", { className: `delta${good}`, textContent: `${d > 0 ? "+" : ""}${m.fmt === pct ? Math.round(d * 100) + " pts" : r2(d)}` });
}

function renderCompare(A, B, base) {
  const avg = averages(base.ps);
  const head = el("tr", {}, el("th", { textContent: "" }), el("th", { textContent: "List A" }),
    ...(B ? [el("th", { textContent: "List B" }), el("th", { textContent: "B - A" })] : []),
    el("th", { textContent: base.label, title: "Average combat unit (per-point numbers are per point of units)" }));
  const body = METRICS.map(m => {
    if (m.group) return el("tr", { className: "group" }, el("th", { colSpan: B ? 5 : 3, textContent: m.group }));
    const val = p => (m.raw ? m.raw(p) : p[m.key]);
    const a = val(A), b = B ? val(B) : null;
    const bv = m.base ? avg[m.base] : null;
    return el("tr", {}, el("td", { textContent: m.label }),
      el("td", { textContent: m.fmt(a, A) }),
      ...(B ? [el("td", { textContent: m.fmt(b, B) }), deltaCell(a, b, m)] : []),
      el("td", { className: "meta", textContent: bv == null ? "" : m.fmt(bv, null) }));
  });
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Comparison" }),
    el("div", { className: "table-wrap" }, el("table", { className: B ? "an-table cmp hasb" : "an-table cmp" }, el("thead", {}, head), el("tbody", {}, ...body))));
}

function renderRadar(A, B, base, a, b) {
  const avg = averages(base.ps);
  const rel = (v, ref) => (ref ? (v / ref) * 100 : 0);
  const axes = [{ label: "Damage" }, { label: "Durability" }, { label: "Mobility" }, { label: "Resolve" }, { label: "Control" }];
  const vals = P => [rel(P.damagePerPoint, avg.damagePerPoint), rel(P.woundsPerPoint, avg.woundsPerPoint), rel(P.speed, avg.speed),
    rel(P.resolve, avg.resolve), rel(P.tokensPerUnit, avg.tokens)];
  const series = [{ name: base.label, color: "#8c96a3", values: axes.map(() => 100), dashed: true },
    { name: `A: ${a.list.name}`, color: "#E6C34A", values: vals(A) }];
  if (B) series.push({ name: `B: ${b.list.name}`, color: "#6FB7C9", values: vals(B) });
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Shape of the list" }),
    el("p", { className: "meta", textContent: `Each axis shows the list as a percentage of the ${base.label.toLowerCase()} (100 = equal to it, outer ring = 200).` }),
    el("div", { className: "radar-wrap" }, radar(axes, series),
      el("ul", { className: "legend" }, ...series.map(s => el("li", {}, el("span", { className: "swatch", style: `background:${s.color}` }), s.name)))),
    el("p", { className: "meta", textContent: "Damage = hits per unit point. Durability = effective wounds per unit point. Mobility = average speed. Resolve = average morale pass chance. Control = condition applications per combat unit." }));
}

function renderUnits(P, label, l) {
  const head = ["Unit", "Pts", "Melee", "Ranged", "Eff. wounds", "Heal/rnd", "Spd", "Def", "Mor", "Control", "Attachments"];
  return el("section", { className: "an-panel" }, el("h2", { textContent: label }),
    el("div", { className: "table-wrap" }, el("table", { className: "an-table units" },
      el("thead", {}, el("tr", {}, ...head.map(h => el("th", { textContent: h })))),
      el("tbody", {}, ...P.rows.filter(r => r.p).map(r => el("tr", {},
        el("td", { textContent: r.p.name }), el("td", { textContent: r.points }), el("td", { textContent: r1(r.p.melee) }),
        el("td", { textContent: r1(r.p.ranged) || "-" }), el("td", { textContent: r1(r.p.effWounds + (r.extraHeal * healRounds) / (1 - r.p.save)) }),
        el("td", { textContent: r1(r.p.heal + r.extraHeal) || "-" }), el("td", { textContent: r.p.speed }),
        el("td", { textContent: `${r.p.defense}+` }), el("td", { textContent: `${r.p.morale}+` }),
        el("td", { textContent: r.p.tokens + (r.extraTokens ? ` (+${r.extraTokens})` : "") }),
        el("td", { className: "meta", textContent: [r.commander ? `${r.commander.name} (Commander)` : "", ...r.attachments].filter(Boolean).join(", ") })))))),
    l.ncus.length ? el("p", { className: "meta", textContent: "NCUs: " + l.ncus.map(modelName).join(", ") }) : "");
}


// ---- unit lab: filter every combat unit, sort, and compare chosen units side by side ----
const LAB_COLS = [
  ["Pts", "points", n => n], ["Melee", "melee", r2], ["Ranged", "ranged", r2], ["Hits", "damage", r2], ["Hits/pt", "damagePerPoint", r2],
  ["Eff. wounds", "effWounds", r1], ["Wnds/pt", "woundsPerPoint", r2], ["Heal/rnd", "heal", r2], ["Spd", "speed", n => n], ["Save", "save", pct], ["Morale", "resolve", pct], ["Control", "tokens", n => n],
];
const LAB_ROWS = [  // [label, key, format, higher is better (null = no judgement)]
  ["Points", "points", n => n, null], ["Speed", "speed", n => n, true], ["Defence", "defense", n => `${n}+`, false], ["Morale", "morale", n => n, false],
  ["Ranks", "ranks", n => n, null], ["Melee hits", "melee", r2, true], ["Ranged hits", "ranged", r2, true], ["Total hits", "damage", r2, true],
  ["Hits per point", "damagePerPoint", r2, true], ["Wound pool", "pool", n => n, true], ["Healing per round (own unit)", "heal", r2, true], ["Healing per round (to others)", "support", r2, true],
  ["Effective wounds", "effWounds", r1, true],
  ["Effective wounds per point", "woundsPerPoint", r2, true], ["Save chance", "save", pct, true], ["Morale pass chance", "resolve", pct, true],
  ["Condition applications", "tokens", n => n, true], ["Orders", "orders", n => n, true],
];
const LAB_COLORS = ["#E6C34A", "#6FB7C9", "#D98C7A", "#9CC98A", "#B79AD9", "#E0A35C"];

function labPool() {
  return allUnits().map(p => ({ ...p, damagePerPoint: p.points ? p.damage / p.points : 0, woundsPerPoint: p.points ? p.effWounds / p.points : 0 }));
}
function labFiltered(pool) {
  const t = lab.text.trim().toLowerCase(), lo = lab.minPts === "" ? -Infinity : +lab.minPts, hi = lab.maxPts === "" ? Infinity : +lab.maxPts;
  const rows = pool.filter(p => (lab.faction === "all" || p.faction === lab.faction) && (lab.type === "all" || p.type === lab.type)
    && p.points >= lo && p.points <= hi && (!t || `${p.name} ${p.nickname ?? ""}`.toLowerCase().includes(t)));
  return rows.sort((a, b) => (typeof a[lab.sort] === "string" ? a[lab.sort].localeCompare(b[lab.sort]) * -lab.dir : (a[lab.sort] - b[lab.sort]) * lab.dir) || a.name.localeCompare(b.name));
}
const facName = id => data.factionsById.get(id)?.name.replace(/^House /, "") ?? id;
function togglePick(id) {
  const i = lab.picks.indexOf(id);
  if (i >= 0) lab.picks.splice(i, 1); else lab.picks.push(id);
  renderAnalysis();
}

function renderLab(a) {
  const pool = labPool(), rows = labFiltered(pool), picked = lab.picks.map(id => pool.find(p => p.id === id)).filter(Boolean);
  const inp = (key, ph, w) => el("input", { type: "text", value: lab[key], placeholder: ph, className: "paste", style: `flex:0 1 ${w}px`,
    onchange: e => { lab[key] = e.target.value; renderAnalysis(); } });
  const opt = (v, t, sel) => el("option", { value: v, textContent: t, selected: sel });
  const filters = el("div", { className: "an-pick" },
    el("label", {}, "Faction ", el("select", { onchange: e => { lab.faction = e.target.value; renderAnalysis(); } },
      opt("all", "All", lab.faction === "all"), ...data.factions.map(f => opt(f.id, facName(f.id), lab.faction === f.id)))),
    el("label", {}, "Type ", el("select", { onchange: e => { lab.type = e.target.value; renderAnalysis(); } },
      opt("all", "All", lab.type === "all"), ...[...new Set(pool.map(p => p.type))].sort().map(t => opt(t, cap(t), lab.type === t)))),
    inp("text", "Search name", 150), inp("minPts", "Min pts", 70), inp("maxPts", "Max pts", 70),
    el("button", { className: "row-btn", textContent: "Reset filters", onclick: () => { Object.assign(lab, { faction: "all", type: "all", text: "", minPts: "", maxPts: "" }); renderAnalysis(); } }),
    a ? el("button", { className: "row-btn", textContent: "Pick the units of list A",
      onclick: () => { lab.picks = [...new Set(a.list.entries.map(e => e.unit).filter(Boolean))].slice(0, 6); renderAnalysis(); } }) : "",
    lab.picks.length ? el("button", { className: "row-btn", textContent: `Clear picks (${lab.picks.length})`, onclick: () => { lab.picks = []; renderAnalysis(); } }) : "");
  const sortHead = ([t, k]) => el("th", { className: "sortable" + (lab.sort === k ? " sorted" : ""), textContent: t + (lab.sort === k ? (lab.dir < 0 ? " ▼" : " ▲") : ""),
    onclick: () => { if (lab.sort === k) lab.dir *= -1; else { lab.sort = k; lab.dir = k === "name" ? 1 : -1; } renderAnalysis(); } });
  const board = el("div", { className: "table-wrap lab-scroll" }, el("table", { className: "an-table" },
    el("thead", {}, el("tr", {}, el("th", { textContent: "" }), sortHead(["Unit", "name"]), sortHead(["Faction", "faction"]), sortHead(["Type", "type"]), ...LAB_COLS.map(c => sortHead(c)))),
    el("tbody", {}, ...rows.map(p => el("tr", { className: lab.picks.includes(p.id) ? "hot" : "", onclick: () => togglePick(p.id) },
      el("td", {}, el("input", { type: "checkbox", checked: lab.picks.includes(p.id), onclick: e => e.stopPropagation(), onchange: () => togglePick(p.id) })),
      el("td", { textContent: p.name }), el("td", { textContent: facName(p.faction) }), el("td", { className: "cap", textContent: p.type }),
      ...LAB_COLS.map(c => el("td", { textContent: c[2](p[c[1]]) })))))));
  const parts = [el("h2", { textContent: "Unit lab" }),
    el("p", { className: "meta", textContent: `Filter the ${pool.length} combat units, click a column to sort, and tick up to six units to compare them side by side. ${rows.length} shown.` }),
    filters, board];
  if (picked.length) parts.push(renderLabCompare(picked, rows.length ? rows : pool));
  return el("section", { className: "an-panel" }, ...parts);
}

function renderLabCompare(picked, ref) {
  const head = el("tr", {}, el("th", { textContent: "" }), ...picked.map((p, i) => el("th", { style: `color:${LAB_COLORS[i]}`, textContent: p.name, title: facName(p.faction) })));
  const body = LAB_ROWS.map(([label, key, fmt, better]) => {
    const vals = picked.map(p => p[key]), best = better == null ? null : (better ? Math.max(...vals) : Math.min(...vals));
    return el("tr", {}, el("td", { textContent: label }),
      ...picked.map((p, i) => el("td", { className: picked.length > 1 && best != null && p[key] === best && vals.some(v => v !== best) ? "best" : "", textContent: fmt(p[key]) })));
  });
  const avg = averages(ref), rel = (v, r) => (r ? (v / r) * 100 : 0);
  const axes = [{ label: "Damage" }, { label: "Durability" }, { label: "Mobility" }, { label: "Resolve" }, { label: "Control" }];
  const vals = p => [rel(p.damagePerPoint, avg.damagePerPoint), rel(p.woundsPerPoint, avg.woundsPerPoint), rel(p.speed, avg.speed), rel(p.resolve, avg.resolve), rel(p.tokens, avg.tokens)];
  const series = [{ name: "Average of the units shown above", color: "#8c96a3", values: axes.map(() => 100), dashed: true },
    ...picked.map((p, i) => ({ name: p.name, color: LAB_COLORS[i], values: vals(p) }))];
  return el("div", {}, el("h3", { textContent: "Side by side" }),
    el("div", { className: "table-wrap" }, el("table", { className: "an-table" }, el("thead", {}, head), el("tbody", {}, ...body))),
    el("p", { className: "meta", textContent: "Green marks the best value in a row (lowest for Defence and Morale numbers). Per-point numbers are per point of the unit alone." }),
    el("div", { className: "radar-wrap" }, radar(axes, series),
      el("ul", { className: "legend" }, ...series.map(s => el("li", {}, el("span", { className: "swatch", style: `background:${s.color}` }), s.name)))));
}

const FACTION_METRICS = {
  damagePerPoint: ["Hits per point", r2], woundsPerPoint: ["Effective wounds per point", r2], damage: ["Hits per unit", r2],
  melee: ["Melee hits per unit", r2], ranged: ["Ranged hits per unit", r2], effWounds: ["Effective wounds per unit", r1], heal: ["Healing per unit per round", r2],
  speed: ["Average speed", r1], resolve: ["Morale pass chance", pct], tokens: ["Condition applications per unit", r2], points: ["Average unit cost", r1],
};

function renderFactions(highlight) {
  const all = allUnits();
  const facs = data.factions.map(f => ({ f, a: averages(all.filter(p => p.faction === f.id)) })).filter(x => x.a.n);
  const [mlabel, mfmt] = FACTION_METRICS[factionMetric];
  const items = facs.map(x => ({ id: x.f.id, label: x.f.name.replace(/^House /, ""), value: x.a[factionMetric] })).sort((p, q) => q.value - p.value);
  const metricSel = el("select", { onchange: e => { factionMetric = e.target.value; renderAnalysis(); } },
    ...Object.entries(FACTION_METRICS).map(([k, [l]]) => el("option", { value: k, textContent: l, selected: k === factionMetric })));
  const cols = [["Units", "n", n => n], ["Avg pts", "points", r1], ["Melee", "melee", r2], ["Ranged", "ranged", r2], ["Hits/pt", "damagePerPoint", r2],
    ["Eff. wounds/pt", "woundsPerPoint", r2], ["Heal/rnd", "heal", r2], ["Speed", "speed", r1], ["Morale", "resolve", pct], ["Control", "tokens", r2]];
  const typeFacs = typeFaction === "all" ? all : all.filter(p => p.faction === typeFaction);
  const types = [...new Set(typeFacs.map(p => p.type))].sort();
  const tcols = [["Units", "n", n => n], ["Avg pts", "points", r1], ["Melee", "melee", r2], ["Ranged", "ranged", r2], ["Hits/pt", "damagePerPoint", r2],
    ["Eff. wounds", "effWounds", r1], ["Heal/rnd", "heal", r2], ["Speed", "speed", r1], ["Def save", "save", pct], ["Morale", "resolve", pct], ["Control", "tokens", r2]];
  return el("section", { className: "an-panel" }, el("h2", { textContent: "Faction averages" }),
    el("p", { className: "meta", textContent: "Averages over every combat unit of the faction (neutral units count as the Neutral faction)." }),
    el("div", { className: "an-pick" }, el("label", {}, "Chart ", metricSel)),
    bars(items, mfmt, highlight),
    el("div", { className: "table-wrap" }, el("table", { className: "an-table avgs" },
      el("thead", {}, el("tr", {}, el("th", { textContent: "Faction" }), ...cols.map(c => el("th", { textContent: c[0] })))),
      el("tbody", {}, ...facs.map(x => el("tr", { className: x.f.id === highlight ? "hot" : "" }, el("td", { textContent: x.f.name.replace(/^House /, "") }),
        ...cols.map(c => el("td", { textContent: c[2](x.a[c[1]]) }))))))),
    el("h3", { textContent: "Average unit by type" }),
    el("div", { className: "an-pick" }, el("label", {}, "Faction ", el("select", { onchange: e => { typeFaction = e.target.value; renderAnalysis(); } },
      el("option", { value: "all", textContent: "All", selected: typeFaction === "all" }),
      ...facs.map(x => el("option", { value: x.f.id, textContent: x.f.name.replace(/^House /, ""), selected: typeFaction === x.f.id }))))),
    el("div", { className: "table-wrap" }, el("table", { className: "an-table avgs" },
      el("thead", {}, el("tr", {}, el("th", { textContent: "Type" }), ...tcols.map(c => el("th", { textContent: c[0] })))),
      el("tbody", {}, ...types.map(t => { const a = averages(typeFacs.filter(p => p.type === t));
        return el("tr", {}, el("td", { className: "cap", textContent: cap(t) }), ...tcols.map(c => el("td", { textContent: c[2](a[c[1]]) }))); })))));
}

function renderNotes() {
  return el("details", { className: "an-panel" }, el("summary", { textContent: "How the numbers work" }),
    el("ul", {},
      el("li", { textContent: "Hits per attack = attack dice (full strength = the first dice number on the unit card; average over ranks = the mean of all the dice numbers, for a unit that has lost ranks) x the chance of the attack roll (a 3+ hits on 4 of 6 faces). Melee and ranged are shown separately and added for the total." }),
      el("li", { textContent: "Save chance = the chance one die meets the Defence number (a 4+ is 3 of 6). Morale pass chance = the chance two dice total at least the Morale number (a 7 is 21 of 36). Effective wounds = the unit's wound pool divided by the chance a hit gets through. The pool is the wounds printed on the card, or ranks x wounds per model. It is a relative toughness number for comparing units, not an exact count." }),
      el("li", { textContent: "Healing: every card that restores Wounds (data/healing.json) is turned into an expected number of Wounds per round: the Wounds it restores, times how often its trigger happens in a round (always-on abilities count once, 'after an attack that dealt Wounds' 0.75, 'when a unit passes a Morale Test' or 'when an enemy fails a Panic Test' 0.5, once per game 1/6, and so on), plus half a Wound for '+1 per destroyed rank'. Bonuses that need you to Control a symbol are left out. Your 'Healing' choice says how many rounds of that healing count: it is added to the unit's wound pool before the Defence adjustment. Healing that a unit, commander or NCU gives to others is added to the list as a whole, so it also raises the list's effective wounds per point and its Durability on the radar. Faction and unit averages use the combat units' own healing only, so NCU healing never counts toward them. Choose Ignore to leave healing out. These frequencies are estimates, not measured."  }),
      el("li", { textContent: "Control counts how many times a card says a target 'becomes' Vulnerable, Weakened or Panicked. When a card gives a choice between conditions it counts once. Attachments, commanders and NCUs add to the list's total." }),
      el("li", { textContent: "Special rules, rerolls, Sundering, Precision, Orders and tactics cards are not in the damage or defence numbers. Attachments' own changes to the unit are not included either, only their healing, condition applications and the number of Orders." }),
      el("li", { textContent: "Per-point numbers use the points of the combat units only, so attachments and NCUs do not dilute them. The tool treats your 'Compare to' choice as 100%." })));
}

function renderPage() {
  const all = sources();
  if (!pick(all, selection.a) && all.length) selection.a = all[0].id;
  if (selection.b && !pick(all, selection.b)) selection.b = "";
  const a = pick(all, selection.a), b = selection.b ? pick(all, selection.b) : null;
  const parts = [...renderNav("analysis"), renderPicker(all)];
  if (!a || !a.list.faction) {
    parts.push(el("p", { className: "meta", textContent: "Choose a list with a faction to analyse." }), renderLab(null), renderFactions(null));
    return parts;
  }
  const A = listProfile(a.list), B = b && b.list.faction ? listProfile(b.list) : null;
  const base = baselineUnits(a);
  parts.push(
    el("div", { className: "an-summary" }, ...[[a, A, "A"], ...(B ? [[b, B, "B"]] : [])].map(([s, P, tag]) =>
      el("div", { className: "an-card" }, el("h3", { textContent: `${tag}: ${s.list.name}` }),
        el("p", { className: "meta", textContent: `${data.factionsById.get(s.list.faction).name.replace(/^House /, "")} - ${P.total}/${P.size} points - ${P.acts} activations` }),
        el("p", { textContent: `${Object.entries(P.types).map(([t, n]) => `${n} ${cap(t)}`).join(", ") || "No combat units yet"}` })))),
    renderRadar(A, B, base, a, b), renderCompare(A, B, base), renderUnits(A, `Units in list A`, a.list));
  if (B) parts.push(renderUnits(B, `Units in list B`, b.list));
  parts.push(renderLab(a), renderFactions(a.list.faction), renderNotes());
  return parts;
}

function renderAnalysis() {
  document.getElementById("app").replaceChildren(...renderPage());
}

async function startAnalysis() {
  try {
    data = await loadData();
    renderAnalysis();
  } catch (err) {
    console.error("Analysis failed to start:", err);
    document.getElementById("app").textContent = "Could not load the data.";
  }
}
startAnalysis();
