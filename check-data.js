const fs = require("fs");
const load = name => JSON.parse(fs.readFileSync(`data/${name}.json`, "utf8"));

const season = load("season");
const factions = load("factions");
const units = load("units");
const tactics = load("tactics");
const commanders = load("commanders").flatMap(group => Object.values(group).flat());

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
for (const c of commanders) {
  const own = tactics.filter(t => t.owner === "commander" && t.ownerId === c.id).length;
  if (own < COMMANDER_CARDS) problems.push(`Deck: ${c.id} has ${own} commander cards, expected at least ${COMMANDER_CARDS}`);
  for (const name of c.removedFactionCards ?? []) {
    const exists = tactics.some(t => t.owner === "faction" && t.ownerId === c.faction && t.name === name);
    if (!exists) problems.push(`Deck: ${c.id} removes "${name}", which is not a ${c.faction} faction card`);
  }
}

console.log(problems.length ? problems.join("\n") : "Data OK");