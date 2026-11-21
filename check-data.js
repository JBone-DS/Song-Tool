const fs = require("fs");
const load = name => JSON.parse(fs.readFileSync(`data/${name}.json`, "utf8"));

const season = load("season");
const factions = load("factions");
const units = load("units");
const tactics = load("tactics");
const commanders = load("commanders").flatMap(group => Object.values(group).flat());
const cards = load("cards");
const combat = load("combat");
const healing = load("healing");

const FACTION_CARDS = 7;     // standard faction deck size
const COMMANDER_CARDS = 3;   // standard minimum of commander cards

const factionIds = new Set(factions.map(f => f.id));
const models = [...units, ...commanders];
const modelIds = new Set(models.map(m => m.id));
const seen = new Set();
const problems = [];

// Season rules
if (typeof season.attachmentsPerUnit !== "number")
  problems.push("season: attachmentsPerUnit must be a number");
if (typeof season.defaultGameSize !== "number")
  problems.push("season: defaultGameSize must be a number");
for (const size of season.gameSize ?? [])
  if (typeof season.freeAttachmentPoints?.[size] !== "number")
    problems.push(`season: no freeAttachmentPoints for game size ${size}`);

// Every unit and commander
for (const m of models) {
  if (seen.has(m.id)) problems.push(`Duplicate id: ${m.id}`);
  seen.add(m.id);
  if (!factionIds.has(m.faction)) problems.push(`${m.id}: unknown faction "${m.faction}"`);
  for (const f of m.excludedFactions ?? [])
    if (!factionIds.has(f)) problems.push(`${m.id}: unknown excluded faction "${f}"`);
  for (const r of m.attachesTo?.requiresAttachment ?? [])
    if (!modelIds.has(r)) problems.push(`${m.id}: unknown required attachment "${r}"`);
}

// Fields that point at other models (see README.md): every id must exist
const ID_LISTS = ["requiresInArmy", "forbiddenWith", "mustHost", "freeAttachments"];
for (const m of models) {
  for (const field of ID_LISTS)
    for (const id of m[field] ?? [])
      if (!modelIds.has(id)) problems.push(`${m.id}: ${field} names unknown model "${id}"`);
  for (const id of m.discountIfInArmy?.ids ?? [])
    if (!modelIds.has(id)) problems.push(`${m.id}: discountIfInArmy names unknown model "${id}"`);
  for (const id of m.freeFirstIfInArmy ?? [])
    if (!modelIds.has(id)) problems.push(`${m.id}: freeFirstIfInArmy names unknown model "${id}"`);
  for (const id of m.discountsUnits?.units ?? [])
    if (!modelIds.has(id)) problems.push(`${m.id}: discountsUnits names unknown unit "${id}"`);
  for (const id of m.ignoresLimitsWith?.models ?? [])
    if (!modelIds.has(id)) problems.push(`${m.id}: ignoresLimitsWith names unknown model "${id}"`);
  for (const key of ["ncu", "field", "unit"])
    if (m[key] && !modelIds.has(m[key])) problems.push(`${m.id}: ${key} "${m[key]}" is not a known model`);
  for (const x of m.extraCards ?? [])
    if (!cards.cards[x.id]) problems.push(`${m.id}: extra card "${x.id}" has no picture in cards.json`);
}

// Healing: every model named must exist, and every ability needs a known trigger and a sensible amount
for (const [id, abilities] of Object.entries(healing.sources)) {
  if (!modelIds.has(id)) problems.push(`healing: unknown model "${id}"`);
  for (const a of abilities) {
    if (!healing.when[a.when]) problems.push(`healing: ${id} uses unknown trigger "${a.when}"`);
    if (!["self", "other"].includes(a.who)) problems.push(`healing: ${id} has who "${a.who}" (use "self" or "other")`);
    if (!(a.amount > 0)) problems.push(`healing: ${id} has no amount`);
  }
}

// Card pictures: every card must point at a real sheet and a cell inside it; every combat unit needs combat numbers
for (const [id, [sheet, col, row]] of Object.entries(cards.cards)) {
  const s = cards.sheets[sheet];
  if (!s) problems.push(`cards: "${id}" uses unknown sheet "${sheet}"`);
  else if (col >= s.cols || row >= s.rows) problems.push(`cards: "${id}" is outside sheet "${sheet}" (col ${col}, row ${row})`);
}
for (const u of units.filter(u => u.class === "combat_unit"))
  if (!combat.units[u.id]) problems.push(`${u.id}: no entry in combat.json (the Analysis page skips it)`);

for (const u of units) {
  if (!["combat_unit", "attachment", "ncu"].includes(u.class)) problems.push(`${u.id}: bad class "${u.class}"`);
  if (typeof u.points !== "number") problems.push(`${u.id}: points is not a number`);
  if (u.class === "attachment" && !u.attachesTo?.type) problems.push(`${u.id}: attachment has no attachesTo.type`);
}

// Deck checks. Until tactics.json is filled in, expect "Deck:" lines: they are your to-do list.
for (const f of factions) {
  const count = tactics.filter(c => c.owner === "faction" && c.ownerId === f.id).length;
  if (count > 0 && count !== FACTION_CARDS) problems.push(`Deck: ${f.id} has ${count} faction cards, expected ${FACTION_CARDS}`);
}
const fieldCommanders = new Set(commanders.map(c => c.field).filter(Boolean));   // e.g. Areo Hotah, fielded for Doran
for (const c of commanders) {
  if (fieldCommanders.has(c.id)) continue;
  const own = tactics.filter(t => t.owner === "commander" && t.ownerId === c.id).length;
  if (own < COMMANDER_CARDS) problems.push(`Deck: ${c.id} has ${own} commander cards, expected at least ${COMMANDER_CARDS}`);
  for (const name of c.removedFactionCards ?? []) {
    const exists = tactics.some(t => t.owner === "faction" && t.ownerId === c.faction && t.name === name);
    if (!exists) problems.push(`Deck: ${c.id} removes "${name}", which is not a ${c.faction} faction card`);
  }
}

console.log(problems.length ? problems.join("\n") : "Data OK");