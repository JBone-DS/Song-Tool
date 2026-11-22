// Rankings page: the best players by Glicko-2 rating, filtered by faction, region (continent) and country, plus a player search
// that opens a player's page (rating graph, faction ratings and game history: tournament.html?player=<id>).
// Anyone can view it. Players appear once they have enough rated games (5 overall, 3 for a faction; see rating_ranks in schema.sql).
// Players choose their country on their profile; countries.js maps it to a continent. A continent is offered as a filter only once
// it has MIN_CONTINENT_PLAYERS ranked players overall, so the list is not full of near-empty choices.

const MIN_CONTINENT_PLAYERS = 10;
const PAGE = 50;
const rk = { q: "", found: null, searching: false, scope: "overall", continent: "", country: "", rows: null, overall: null, loading: false, shown: PAGE, error: "" };
const THE = new Set(["United Kingdom", "United States", "Netherlands", "Philippines", "Czechia", "United Arab Emirates", "Bahamas", "Gambia"]);
const scopeName = id => (id === "overall" ? "overall" : data.factionsById.get(id)?.name.replace(/^House /, "") ?? id);
const withPlace = r => ({ ...r, info: countryInfo(r.country) });

async function loadScope(scope) {
  rk.loading = true; rk.error = ""; render();
  try {
    const rows = (await cloud.rankings(scope)).map(withPlace).sort((x, y) => y.rating - x.rating);
    rk.rows = rows;
    if (scope === "overall") rk.overall = rows;
    else if (!rk.overall) rk.overall = (await cloud.rankings("overall")).map(withPlace);
  } catch (err) { rk.rows = []; rk.error = `Could not load the rankings: ${err?.message ?? err}`; }
  rk.loading = false; render();
}
async function findPlayers() {
  try { rk.found = await cloud.searchPlayers(rk.q); } catch (err) { rk.found = []; rk.error = `Could not search: ${err?.message ?? err}`; }
  render();
}
const countBy = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); if (k) m.set(k, (m.get(k) ?? 0) + 1); } return m; };

function renderRankings() {
  const overall = rk.overall ?? [], rows = rk.rows ?? [];
  // continents with enough ranked players; always keep the chosen one so the choice never vanishes
  const popContinents = CONTINENTS.filter(c => (countBy(overall, r => r.info?.continent).get(c) ?? 0) >= MIN_CONTINENT_PLAYERS);
  if (rk.continent && !popContinents.includes(rk.continent)) rk.continent = "";
  const inContinent = rows.filter(r => !rk.continent || r.info?.continent === rk.continent);
  const countries = [...countBy(inContinent, r => r.info?.name)].sort((a, b) => a[0].localeCompare(b[0]));
  if (rk.country && !countries.some(([n]) => n === rk.country)) rk.country = "";
  const list = inContinent.filter(r => !rk.country || r.info?.name === rk.country);
  const factions = [...data.factionsById.values()].filter(f => f.id && f.id !== "neutral").sort((a, b) => a.name.localeCompare(b.name));
  const place = rk.country ? (THE.has(rk.country) ? "the " : "") + rk.country : rk.continent;
  const title = `Best ${rk.scope === "overall" ? "overall " : scopeName(rk.scope) + " "}player${place ? ` in ${place}` : ""}`;
  const me = cloud.user?.id;
  const sel = (label, value, options, onchange) => el("label", {}, label + " ", el("select", { onchange: e => onchange(e.target.value) }, ...options.map(([v, t]) => el("option", { value: v, textContent: t, selected: v === value }))));
  const picks = el("div", { className: "an-pick" },
    sel("Faction", rk.scope, [["overall", "Overall"], ...factions.map(f => [f.id, f.name.replace(/^House /, "")])], v => { rk.scope = v; rk.shown = PAGE; loadScope(v); }),
    sel("Region", rk.continent, [["", "Worldwide"], ...popContinents.map(c => [c, c])], v => { rk.continent = v; rk.country = ""; rk.shown = PAGE; render(); }),
    sel("Country", rk.country, [["", rk.continent ? `All of ${rk.continent}` : "All countries"], ...countries.map(([n, k]) => [n, `${n} (${k})`])], v => { rk.country = v; rk.shown = PAGE; render(); }));
  const link = (id, text) => el("a", { href: `tournament.html?player=${id}`, textContent: text });
  const overallOf = new Map((rk.overall ?? []).map(r => [r.profile_id, r]));
  const finder = el("div", {}, el("h3", { textContent: "Find a player" }),
    el("div", { className: "an-pick" },
      el("input", { type: "search", id: "rk-q", className: "paste", placeholder: "Search by nickname", value: rk.q, style: "flex:0 1 260px", onchange: e => { rk.q = e.target.value; findPlayers(); } }),
      el("button", { className: "row-btn", textContent: "Search", onclick: () => { rk.q = document.getElementById("rk-q").value; findPlayers(); } })),
    rk.found ? (rk.found.length ? el("div", { className: "table-wrap" }, el("table", { className: "an-table tn" },
      el("thead", {}, el("tr", {}, ...["Player", "Club", "Country", "Rating", ""].map(h => el("th", { textContent: h })))),
      el("tbody", {}, ...rk.found.map(p => el("tr", {}, el("td", {}, link(p.id, p.nickname)), el("td", { textContent: p.club || "-" }), el("td", { textContent: p.country || "-" }),
        el("td", { textContent: overallOf.has(p.id) ? Math.round(overallOf.get(p.id).rating) : "unranked" }), el("td", {}, link(p.id, "Rating and games"))))))) : el("p", { className: "meta", textContent: "No players found. Only players who have joined a tournament can be found." })) : "");
  const body = rk.loading && !rk.rows ? el("p", { className: "meta", textContent: "Loading..." })
    : rk.error ? el("p", { className: "warn", textContent: rk.error })
    : list.length ? el("div", { className: "table-wrap" }, el("table", { className: "an-table tn" },
        el("thead", {}, el("tr", {}, ...["#", "Player", "Club", "Country", "Rating", "±", "Games"].map(h => el("th", { textContent: h })))),
        el("tbody", {}, ...list.slice(0, rk.shown).map((r, i) => el("tr", { className: r.profile_id === me ? "hot" : "" },
          el("td", { textContent: i + 1 }), el("td", {}, link(r.profile_id, r.nickname || "(player)")), el("td", { textContent: r.club || "-" }),
          el("td", { textContent: r.info?.name ?? (r.country || "-") }), el("td", { textContent: Math.round(r.rating) }), el("td", { className: "meta", textContent: Math.round(r.rd) }), el("td", { textContent: r.games }))))))
    : el("p", { className: "meta", textContent: "Nobody is ranked here yet." });
  const note = `Ratings are Glicko-2 (start 1500; the ± figure is how uncertain a rating is). A player is ranked after ${5} rated games overall, or ${3} with a faction. Only finished tournaments with 16 or more players count. Continents appear once they have ${MIN_CONTINENT_PLAYERS} ranked players. Players choose their country on their profile.`;
  return [...renderNav("rankings"), el("section", { className: "an-panel" }, el("h2", { textContent: "Rankings" }), finder, picks,
    el("h3", { textContent: title }), body,
    list.length > rk.shown ? el("button", { className: "row-btn", textContent: `Show more (${list.length - rk.shown} left)`, onclick: () => { rk.shown += PAGE; render(); } }) : "",
    el("p", { className: "meta", textContent: note }))];
}
function render() { document.getElementById("app").replaceChildren(...renderRankings()); }

async function startRankings() {
  try {
    data = await loadData();
    if (!window.SONG_CLOUD?.url || typeof cloud === "undefined" || !cloud.enabled) { document.getElementById("app").textContent = "The rankings service is not set up (cloud-config.js is missing)."; return; }
    await cloud.init(() => {});
    await loadScope("overall");
  } catch (err) {
    console.error("Rankings failed to start:", err);
    document.getElementById("app").textContent = "Could not load the rankings.";
  }
}
startRankings();
