let data;
let list;
let notice = null;   // a one-off message shown after an action (e.g. which attachments were removed with another)
let toolMsg = null;   // a short message shown beside the save / share buttons, cleared on the next redraw
let dialog = null;    // the load or export pop-up: { kind: "load" } | { kind: "export", text }
let confirmNew = false;
let toolsOpen = storeGet("song-tool-tools-open", false);   // the save / load / share / export panel under the title
let dragRow = null;    // index of the row being dragged, if any
let gallery = null;   // the tactics card viewer: { cards, index } when open
let menu = null;   // which pick-menu is open: { kind: "unit" } | { kind: "ncu" } | { kind: "attachment", index }

async function loadData() {
  const names = ["season", "factions", "commanders", "units", "tactics", "cards", "combat"];
  const [season, factions, commandersRaw, units, tactics, cards, combat] = await Promise.all(
    names.map(n => fetch(`data/${n}.json`).then(r => r.json()))
  );
  const commanders = commandersRaw.flatMap(group => Object.values(group).flat());
  return {
    season, factions, commanders, units, tactics, cards, combat,
    unitsById: new Map(units.map(u => [u.id, u])),
    commandersById: new Map(commanders.map(c => [c.id, c])),
    factionsById: new Map(factions.map(f => [f.id, f])),
  };
}

function newList() {
  return {
    name: "My List",
    season: data.season.season,
    gameSize: data.season.defaultGameSize,
    faction: null,
    commander: null,
    commanderUnit: null,
    entries: [],
    enemyAttachments: [],   // attachments that go on an enemy unit (Turncoat, Jaime Lannister...): not tied to a row
    ncus: []
  };
}

// A row ("slot") is { unit, attachments }. The unit can be empty (null): attachments and the
// commander stay with the row, so units can be swapped in and out without losing them.

// put a unit into row `index`; a row number past the end starts a new row
function setUnit(index, unitId) {
  if (index >= list.entries.length) list.entries.push({ unit: unitId, attachments: [] });
  else list.entries[index].unit = unitId;
  render();
}

// take the unit out of a row but keep its attachments (and the commander)
function removeUnit(index) {
  list.entries[index].unit = null;
  tidy();
  render();
}

// rows at the bottom with no unit, no attachments and no commander are just clutter
function tidy() {
  while (list.entries.length) {
    const last = list.entries.length - 1;
    const e = list.entries[last];
    if (e.unit || e.attachments.length || list.commanderUnit === last) break;
    list.entries.pop();
  }
}

// Models that need something else in the list go when it goes: an attachment needing a partner on the same row
// (Theon needs Ramsay, Biter needs Rorge) or a model somewhere in the army (Arya needs Sandor). The partner can be
// another attachment, an NCU or the commander. Repeats in case one removal leads to another.
function dropOrphans() {
  const dropped = [];
  const keep = (id, here) => {
    const model = data.unitsById.get(id);
    const sameUnit = model.attachesTo?.requiresAttachment;
    const ok = (!sameUnit || sameUnit.some(r => here.includes(r))) && armyRequirementMet(model, list);
    if (!ok) dropped.push(model.name);
    return ok;
  };
  let changed = true;
  while (changed) {
    const before = dropped.length;
    list.entries.forEach((entry, i) => { entry.attachments = entry.attachments.filter(id => keep(id, modelsOnUnit(list, i))); });
    // units that need a particular character (Rainbow Guard needs Renly, King in the South) leave when he does
    list.entries.forEach((entry, i) => {
      const unit = entry.unit && data.unitsById.get(entry.unit);
      if (!unit || unitAllowed(unit, list, i)) return;
      dropped.push(unit.name);
      entry.unit = null;
    });
    list.enemyAttachments = list.enemyAttachments.filter(id => keep(id, []));
    list.ncus = list.ncus.filter(id => keep(id, []));
    changed = dropped.length > before;
  }
  notice = dropped.length ? `Also removed ${dropped.join(", ")}, which needed something that was removed.` : null;
}

function addAttachment(index, attachmentId) {
  if (data.unitsById.get(attachmentId).attachesToEnemy) {
    // goes on an enemy unit, so it gets its own row instead of joining this unit
    list.enemyAttachments.push(attachmentId);
    tidy();   // the row the menu was opened from may be an empty new one
  } else list.entries[index].attachments.push(attachmentId);
  render();
}

function removeEnemyAttachment(i) { list.enemyAttachments.splice(i, 1); dropOrphans(); tidy(); render(); }

function removeAttachment(i, j) { list.entries[i].attachments.splice(j, 1); dropOrphans(); tidy(); render(); }
function addNcu(id) { list.ncus.push(id); render(); }
function removeNcu(i) {
  const c = list.commander ? data.commandersById.get(list.commander) : null;
  const goes = c && c.ncu && list.ncus[i] === c.ncu;   // Doran's NCU cannot stay without Doran as commander
  list.ncus.splice(i, 1);
  if (goes) { releaseUnitCommander(); list.commander = null; list.commanderUnit = null; }
  dropOrphans();
  if (goes) notice = `${notice ? notice + " " : ""}${c.name} is no longer the commander.`;
  tidy(); render();
}
// a few commanders (Mag the Mighty, Varamyr Sixskins) are units in themselves: they fill the big box of the
// top row at their commander cost, and are not attached to anything
function unitCommander(l = list) {
  const c = l.commander ? data.commandersById.get(l.commander) : null;
  return c && c.unit ? c : null;
}
// Doran Martell is a commander who stays off the table: he is fielded as his NCU, and Areo Hotah goes on
// the unit as the commander attachment. `ncu` is the NCU he adds, `field` the commander model on the unit.
function fieldCommander(l = list) {
  const c = l.commander ? data.commandersById.get(l.commander) : null;
  return c && c.field ? data.commandersById.get(c.field) : null;
}
// takes away what the current commander brought with him (his NCU); returns a note for the person, or null
function releaseCommanderExtras() {
  const c = list.commander ? data.commandersById.get(list.commander) : null;
  if (!c || !c.ncu || !list.ncus.includes(c.ncu)) return null;
  list.ncus.splice(list.ncus.indexOf(c.ncu), 1);
  return `${data.unitsById.get(c.ncu).name} left the list with his commander.`;
}
// the commander counts as an attachment on row i (taking a slot) only when he is not a unit himself
function attachedCommander(l, i) {
  return l.commanderUnit === i && l.commander && !unitCommander(l);
}
// drop the row a unit commander occupies (the top row) before the commander changes or goes
function releaseUnitCommander() {
  if (unitCommander() && list.commanderUnit === 0) list.entries.shift();
}

// the commander takes the row's attachment slot, so any attachment on that row that counts toward the
// attachment limit moves to a new row at the bottom (attachments that ignore the limit can stay)
function makeRoomForCommander(i) {
  const entry = list.entries[i];
  const present = [...entry.attachments, list.commander];
  const moved = entry.attachments.filter(id => countsTowardCap(data.unitsById.get(id), present));
  if (!moved.length) return;
  entry.attachments = entry.attachments.filter(id => !moved.includes(id));
  list.entries.push({ unit: null, attachments: moved });
}

// clicking the cross on the commander clears the choice altogether
function clearCommander() {
  releaseUnitCommander();
  const gone = releaseCommanderExtras();
  list.commander = null;
  list.commanderUnit = null;
  dropOrphans();
  if (gone) notice = `${notice ? notice + " " : ""}${gone}`;
  tidy();
  render();
}

// rule functions

//faction rules

function isEligible(unit, faction) {
  if (unit.excludedFactions?.includes(faction.id)) return false;   // e.g. neutral Bolton copies
  if (unit.faction === faction.id) return true;
  if (unit.faction === "neutral") return faction.canUseNeutrals;  // false for Freefolk
  return faction.borrowing.some(rule => rule.from.includes(unit.faction));  // e.g. Brotherhood
}

function borrowedCount(rule, list) {
  return list.entries.filter(entry =>
    entry.unit && rule.from.includes(data.unitsById.get(entry.unit).faction)
  ).length;
}

//tactics deck rules

function buildDeck(list) {
  // commander cards come first, then the faction cards; before a commander is chosen it is just the faction cards
  const commander = list.commander ? data.commandersById.get(list.commander) : null;
  const removed = commander?.removedFactionCards ?? [];
  const own = commander ? data.tactics.filter(c => c.owner === "commander" && c.ownerId === list.commander) : [];
  const faction = data.tactics.filter(c =>
    c.owner === "faction" && c.ownerId === list.faction && !removed.includes(c.name));
  return [...own, ...faction];
}

// attachment slots used on a unit: ordinary attachments, plus the commander if attached here
function slotsUsed(list, index) {
  const here = modelsOnUnit(list, index);
  const used = list.entries[index].attachments
    .map(id => data.unitsById.get(id))
    .filter(a => countsTowardCap(a, here)).length;
  return used + (attachedCommander(list, index) ? 1 : 0);
}

//free attachments rules

function freeAttachmentPoints(list) {
  return data.season.freeAttachmentPoints[list.gameSize] ?? 0;
}

// attachment cap rules

function countsTowardCap(attachment, presentIds = []) {
  if ((attachment.ignoresLimits ?? []).includes("attachment-limits")) return false;
  const rule = attachment.ignoresLimitsWith;
  if (rule && rule.limit === "attachment-limits" && rule.models.some(id => presentIds.includes(id)))
    return false;
  return true;
}

// only attachments from the list's own faction can use the free points
function usesFreePoints(attachment, list) {
  return attachment.faction === list.faction;
}

// the cost of each attachment on one unit, after any discount the unit gives
// printed points less any discount that applies in this list
// (Cortnay Penrose, Loyal Tactician: 1 less while a form of Renly Baratheon is in the army)
function modelPoints(model, l = list) {
  const d = model.discountIfInArmy;
  return d && l && d.ids.some(id => armyIds(l).includes(id)) ? Math.max(0, model.points - d.amount) : model.points;
}

// Brotherhood attachments (Gendry, Hot Pie...) that say "Reduce the cost of the first attachment included in your army by 1":
// each one in the army takes that much off the first attachment, counting rows in order, then attachments on enemy units
function firstAttachmentDiscount(l = list) {
  const all = [...l.entries.flatMap(e => e.attachments), ...l.enemyAttachments];
  const amount = all.reduce((s, id) => s + (data.unitsById.get(id)?.firstAttachmentDiscount ?? 0), 0);
  const row = l.entries.findIndex(e => e.attachments.length);
  return { amount, row, enemy: row < 0 && l.enemyAttachments.length > 0 };
}

function attachmentCosts(entry, l = list) {
  const unit = entry.unit ? data.unitsById.get(entry.unit) : null;
  const costs = entry.attachments.map(id => {
    const attachment = data.unitsById.get(id);
    // some units take a particular attachment for nothing (Tyrion on the Stone Crows)
    return { attachment, cost: unit?.freeAttachments?.includes(id) ? 0 : modelPoints(attachment, l) };
  });
  // "the first X in your army is free while Y is in the army" (Crannogman Survivalist with Howland Reed)
  costs.forEach((c, j) => {
    const need = c.attachment.freeFirstIfInArmy;
    if (need && need.some(id => armyIds(l).includes(id)) &&
        l.entries.findIndex(e => e.attachments.includes(c.attachment.id)) === l.entries.indexOf(entry) &&
        entry.attachments.indexOf(c.attachment.id) === j) c.cost = 0;
  });
  const first = firstAttachmentDiscount(l);
  if (first.amount && first.row >= 0 && l.entries[first.row] === entry)
    costs[0].cost = Math.max(0, costs[0].cost - first.amount);
  if (unit?.adaptive) {   // Stormcrow Mercenaries: cheaper attachments
    const { attachmentsAffected: n, attachmentCostReduction: r } = unit.adaptive;
    costs.slice(0, n).forEach(c => { c.cost -= Math.min(r, c.cost); });
  }
  return costs;
}

// attachments placed on enemy units: no unit of ours to discount them, so they cost their printed points
function enemyAttachmentCosts(list) {
  const first = firstAttachmentDiscount(list);
  return list.enemyAttachments.map((id, k) => {
    const attachment = data.unitsById.get(id);
    const cost = modelPoints(attachment, list);
    return { attachment, cost: first.enemy && k === 0 ? Math.max(0, cost - first.amount) : cost };
  });
}

function attachmentTotals(list) {
  const all = [...list.entries.flatMap(entry => attachmentCosts(entry, list)), ...enemyAttachmentCosts(list)];
  const sum = items => items.reduce((s, c) => s + c.cost, 0);
  const inFaction = sum(all.filter(c => usesFreePoints(c.attachment, list)));
  const other = sum(all.filter(c => !usesFreePoints(c.attachment, list)));
  const free = freeAttachmentPoints(list);
  const freeUsed = Math.min(inFaction, free);
  return {
    inFaction, other, total: inFaction + other,
    free, freeUsed,
    charged: inFaction - freeUsed + other
  };
}

// what an NCU costs in this list: Doran's NCU costs what his commander card says (4) while he leads
function ncuCost(l, id) {
  const c = l.commander ? data.commandersById.get(l.commander) : null;
  return c && c.ncu === id && c.points != null ? c.points : data.unitsById.get(id).points;
}

// NCUs that cheapen certain units (Daenerys, The Unburnt: one dragon costs 1 less):
// returns the discount for each row, given to the first rows holding a listed unit
function unitDiscounts(l = list) {
  const out = new Map();
  l.ncus.map(id => data.unitsById.get(id)?.discountsUnits).filter(Boolean).forEach(rule => {
    let left = rule.count ?? 1;
    l.entries.forEach((e, i) => {
      if (left > 0 && e.unit && rule.units.includes(e.unit) && !out.has(i)) { out.set(i, rule.amount); left -= 1; }
    });
  });
  return out;
}
// whether a unit about to be picked would get such a discount
function pickDiscount(model, l = list) {
  if (model.class !== "combat_unit") return 0;
  const taken = unitDiscounts(l);
  for (const rule of l.ncus.map(id => data.unitsById.get(id)?.discountsUnits).filter(Boolean))
    if (rule.units.includes(model.id) && taken.size < (rule.count ?? 1)) return rule.amount;
  return 0;
}
// what row i costs: the unit (or its commander price) less any NCU discount
function rowCost(l, i) {
  const e = l.entries[i];
  if (!e?.unit) return 0;
  const uc = unitCommander(l);
  const base = uc && l.commanderUnit === i ? uc.points : data.unitsById.get(e.unit).points;
  return Math.max(0, base - (unitDiscounts(l).get(i) ?? 0));
}

function totalPoints(list) {
  const units = list.entries.reduce((sum, e, i) => sum + rowCost(list, i), 0);
  const ncus = list.ncus.reduce((sum, id) => sum + ncuCost(list, id), 0);
  return units + ncus + attachmentTotals(list).charged;   // commanders cost nothing
}

// neutral limit: neutral models may use only a percentage of the game size
function neutralLimit(list) {
  return list.gameSize * (data.season.neutralLimitPercent ?? 30) / 100;
}

// points spent on neutral units, neutral attachments (at their full cost) and neutral NCUs
function neutralPoints(list) {
  const units = list.entries.reduce((sum, e) => {
    const u = e.unit ? data.unitsById.get(e.unit) : null;
    return sum + (u && u.faction === "neutral" ? u.points : 0);
  }, 0);
  const attachments = [...list.entries.flatMap(e => attachmentCosts(e, list)), ...enemyAttachmentCosts(list)]
    .filter(c => c.attachment.faction === "neutral")
    .reduce((sum, c) => sum + c.cost, 0);
  const ncus = list.ncus.map(id => data.unitsById.get(id))
    .filter(u => u.faction === "neutral")
    .reduce((sum, u) => sum + u.points, 0);
  return units + attachments + ncus;
}

// a Neutral list is all neutral, and Freefolk cannot take neutrals, so neither has this limit
function hasNeutralLimit(list) {
  const faction = data.factionsById.get(list.faction);
  return !!faction && faction.id !== "neutral" && !!faction.canUseNeutrals;
}

function validateNeutralLimit(list) {
  if (!hasNeutralLimit(list)) return [];
  const used = neutralPoints(list);
  const limit = neutralLimit(list);
  return used > limit ? [`Too many neutral points: ${used} of ${limit}`] : [];
}

//rules validation

// how a row is named in messages: its unit, or "Row 3" while it has no unit yet
function rowName(list, index) {
  const e = list.entries[index];
  return e.unit ? data.unitsById.get(e.unit).name : `Row ${index + 1} (no unit)`;
}

function modelsOnUnit(list, index) {
  const ids = [...list.entries[index].attachments];
  if (attachedCommander(list, index)) ids.push(list.commander, ...(fieldCommander() ? [fieldCommander().id] : []));
  return ids;
}

function allModelIds(list) {
  return [...list.entries.flatMap(e => (e.unit ? [e.unit] : []).concat(e.attachments)), ...list.enemyAttachments, ...list.ncus];
}

// ---- Loyalty ------------------------------------------------------------
// "Your army may never contain units or attachments with different Loyalties": every model in the list
// (commander included) that has a Loyalty must have the same one.
const loyaltyName = id => id.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
function listLoyalties(l, withoutCommander = false) {
  const models = allModelIds(l).map(id => data.unitsById.get(id));
  if (!withoutCommander && l.commander) models.push(data.commandersById.get(l.commander), fieldCommander(l));
  return new Set(models.map(m => m?.loyalty).filter(Boolean));
}
// would this model bring in a Loyalty different from one already in the list?
function loyaltyClash(model, l, withoutCommander = false) {
  return !!model.loyalty && [...listLoyalties(l, withoutCommander)].some(x => x !== model.loyalty);
}
function validateHosts(l) {
  const ids = armyIds(l);
  return l.entries.flatMap((e, i) => {
    const unit = e.unit && data.unitsById.get(e.unit);
    if (!unit?.mustHost) return [];
    const away = unit.mustHost.filter(id => ids.includes(id) && !modelsOnUnit(l, i).includes(id));
    return away.length ? [`${unit.name}: ${namesOf(away)} must be attached to this unit`] : [];
  });
}
function validateLoyalty(l) {
  const found = [...listLoyalties(l)];
  return found.length > 1 ? [`Different Loyalties in one army: ${found.map(loyaltyName).join(" and ")}`] : [];
}

// ---- army-wide rules ----------------------------------------------------
// every model id in the list, commander included
function armyIds(list) {
  return [...allModelIds(list), ...(list.commander ? [list.commander] : []), ...(fieldCommander(list) ? [fieldCommander(list).id] : [])];
}

// a unit can stay in row i only while its character requirements hold: a required character is in the army,
// a forbidden one is not, and the characters it says "must be attached to this unit" are on this row
function unitAllowed(unit, l, i) {
  if (!armyRequirementMet(unit, l)) return false;
  const ids = armyIds(l);
  if ((unit.forbiddenWith ?? []).some(id => ids.includes(id))) return false;
  const here = modelsOnUnit(l, i);
  return (unit.mustHost ?? []).every(id => !ids.includes(id) || here.includes(id));
}
// rows where a unit that must carry a particular character may go: the rows he is attached to
function hostRows(unit, l) {
  return l.entries.map((e, j) => j).filter(j => modelsOnUnit(l, j).some(id => (unit.mustHost ?? []).includes(id)));
}

function modelById(id) { return data.unitsById.get(id) ?? data.commandersById.get(id); }
// units that can activate in a round: combat units plus non-combatant units
function activations(l) {
  return l.entries.filter(e => e.unit).length + l.ncus.length;
}

function modelLabel(m) { return m.nickname ? `${m.name} - ${m.nickname}` : m.name; }

// "May only be fielded in an army containing X": at least one of the listed models must be somewhere in the list
function armyRequirementMet(model, list) {
  return !model.requiresInArmy || model.requiresInArmy.some(id => armyIds(list).includes(id));
}

// "May not be fielded in an army containing X": either side can forbid the other
function armyConflict(model, list) {
  const ids = armyIds(list);
  if ((model.forbiddenWith ?? []).some(id => ids.includes(id))) return true;
  return ids.some(id => (modelById(id)?.forbiddenWith ?? []).includes(model.id));
}

// a list of models as a short phrase: one entry per character, with the nickname only when a single form is meant
function namesOf(ids, plain = false) {
  const byName = new Map();
  ids.map(modelById).filter(Boolean).forEach(m => byName.set(m.name, [...(byName.get(m.name) ?? []), m]));
  return [...byName.values()].map(forms => forms.length === 1 && !plain ? modelLabel(forms[0]) : forms[0].name).join(" or ");
}

function validateRequirements(list) {
  const problems = [];
  [...new Set(armyIds(list))].map(modelById).filter(Boolean).forEach(m => {
    if (!armyRequirementMet(m, list)) problems.push(`${modelLabel(m)} needs ${namesOf(m.requiresInArmy)} in the army`);
    const clash = (m.forbiddenWith ?? []).filter(id => armyIds(list).includes(id));
    if (clash.length) problems.push(`${modelLabel(m)} cannot be fielded with ${namesOf(clash, true)}`);
  });
  return problems;
}

// ---- which units can take attachments ----
// solo units (Gregor Clegane, solo riders) take nothing
function isSolo(unit) { return unit.soloUnit === true || (unit.traits ?? []).includes("solo-rider"); }

// does this attachment fit this unit by type, by named unit and by faction? (the unit-specific part of the rule)
function attachmentFitsUnit(att, unit) {
  const a = att.attachesTo;
  return !!a && a.type.includes(unit.type) &&
    (!a.units || a.units.includes(unit.id)) &&
    (!a.factions || a.factions.includes(unit.faction));
}

// can anything ever be attached to this unit? Monsters and most war machines have no attachments at all
const takesAttachmentsCache = new Map();
function canTakeAttachments(unit) {
  if (isSolo(unit)) return false;
  if (!takesAttachmentsCache.has(unit.id))
    takesAttachmentsCache.set(unit.id, data.units.some(a => a.class === "attachment" && !a.attachesToEnemy && attachmentFitsUnit(a, unit)));
  return takesAttachmentsCache.get(unit.id);
}

// commanders join units like attachments do; a few cannot join certain unit types (Benjen First Ranger: infantry only)
function commanderFitsUnit(commander, unit) {
  return canTakeAttachments(unit) && (!commander.allowedUnitTypes || commander.allowedUnitTypes.includes(unit.type)) &&
    (!commander.attachesToUnits || commander.attachesToUnits.includes(unit.id));
}

// limits written as { max, per: { tag, type } }: at most `max` of this unit for each unit in the list with that tag and type
function perLimitAllowed(list, rule) {
  const hosts = list.entries.filter(e => {
    const m = e.unit && data.unitsById.get(e.unit);
    return m && (m.tags ?? []).includes(rule.per.tag) && m.type === rule.per.type;
  }).length;
  return rule.max * hosts;
}

function perLimitReached(list, unit) {
  return (unit.limits ?? []).some(rule =>
    rule.per && list.entries.filter(e => e.unit === unit.id).length >= perLimitAllowed(list, rule));
}

function validatePerLimits(list) {
  const problems = [];
  const seen = new Set();
  list.entries.forEach(e => {
    const unit = e.unit && data.unitsById.get(e.unit);
    if (!unit || seen.has(unit.id)) return;
    seen.add(unit.id);
    (unit.limits ?? []).filter(rule => rule.per).forEach(rule => {
      const have = list.entries.filter(x => x.unit === unit.id).length;
      const allowed = perLimitAllowed(list, rule);
      if (have > allowed) {
        const host = `${rule.per.tag.replace(/-/g, " ")} ${rule.per.type}`.replace(/\b\w/g, c => c.toUpperCase());
        problems.push(`${unit.name}: ${have} taken but only ${allowed} allowed (${rule.max} per ${host} unit in the list)`);
      }
    });
  });
  return problems;
}

function validateCommander(list) {
  if (!list.commander) return ["Choose a commander"];
  const c = data.commandersById.get(list.commander);
  if (c.faction !== list.faction) return [`${c.name} does not belong to this faction`];
  if (c.unit) return list.entries[list.commanderUnit]?.unit === c.unit ? [] : [`${c.name} must lead the top row`];
  if (list.commanderUnit !== null && !list.entries[list.commanderUnit]?.unit) return [`Choose a unit for ${c.name} to join`];
  const joined = list.commanderUnit !== null ? data.unitsById.get(list.entries[list.commanderUnit].unit) : null;
  if (joined && !commanderFitsUnit(fieldCommander(list) ?? c, joined)) return [`${c.name} cannot join ${joined.name}`];
  return [];
}

function validatePoints(list) {
  const total = totalPoints(list);
  return total > list.gameSize ? [`Over the limit: ${total} of ${list.gameSize} points`] : [];
}

function validateEligibility(list) {
  const faction = data.factionsById.get(list.faction);
  return allModelIds(list)
    .map(id => data.unitsById.get(id))
    .filter(u => !isEligible(u, faction))
    .map(u => `${u.name} cannot be used by ${faction.name}`);
}

function validateBorrowing(list) {
  const faction = data.factionsById.get(list.faction);
  return faction.borrowing
    .filter(rule => rule.from.length > 0 && borrowedCount(rule, list) > rule.max)
    .map(rule => `${faction.name} may take at most ${rule.max} ${rule.max === 1 ? "unit" : "units"} from ${rule.from.map(id => data.factionsById.get(id)?.name ?? id).join(" or ")}`);
}

function validatemaxPerList(list) {
  const counts = {};
  allModelIds(list).forEach(id => { counts[id] = (counts[id] ?? 0) + 1; });
  return Object.entries(counts)
    .filter(([id, n]) => typeof data.unitsById.get(id).maxPerList === "number" && n > data.unitsById.get(id).maxPerList)
    .map(([id]) => `Too many copies of ${data.unitsById.get(id).name}`);
}

// has this model already used up its per-list allowance?
function atMaxPerList(list, unit) {
  return typeof unit.maxPerList === "number" &&
    allModelIds(list).filter(id => id === unit.id).length >= unit.maxPerList;
}

function validateAttachments(list) {
  const problems = [];
  list.entries.forEach((entry, i) => {
    if (!entry.unit) {   // attachments waiting for a unit
      if (entry.attachments.length)
        problems.push(`Choose a unit for ${rowName(list, i)}: it holds ${entry.attachments.map(id => data.unitsById.get(id).name).join(", ")}`);
      return;
    }
    const unit = data.unitsById.get(entry.unit);
    if (entry.attachments.length && isSolo(unit)) problems.push(`${unit.name} cannot have attachments`);
    entry.attachments.forEach(id => {
      const att = data.unitsById.get(id);
      if (!att.attachesTo) {
        problems.push(`${att.name} is not set up as an attachment`);
        return;
      }
      if (!attachmentFitsUnit(att, unit))
        problems.push(`${att.name} cannot attach to ${unit.name} (${unit.type})`);
      const needs = att.attachesTo.requiresAttachment;
      if (needs && !needs.some(r => modelsOnUnit(list, i).includes(r)))
        problems.push(`${att.name} needs one of [${needs.join(", ")}] on the same unit`);
    });
  });
  return problems;
}

function validateAttachmentCap(list) {
  const max = data.season.attachmentsPerUnit;
  const problems = [];
  list.entries.forEach((entry, i) => {
    const used = slotsUsed(list, i);
    if (used > max)
      problems.push(`${rowName(list, i)} has ${used} attachments including the commander (maximum ${max})`);
  });
  return problems;
}

function validateList(list) {
  if (!list.faction) return ["Choose a faction"];
  return [
    ...validateCommander(list),
    ...validatePoints(list),
    ...validateNeutralLimit(list),
    ...validateEligibility(list),
    ...validateBorrowing(list),
    ...validatemaxPerList(list),
    ...validateAttachments(list),
    ...validateAttachmentCap(list),
    ...validateRequirements(list),
    ...validatePerLimits(list),
    ...validatePerUnitLimits(list),
    ...validateDuplicateAttachments(list),
    ...validateUniqueCharacters(list),
    ...validateLoyalty(list),
    ...validateHosts(list),
  ];
}

// would adding this attachment to unit `index` break one of its own per-unit limits?
function perUnitLimitHit(list, index, attachment) {
  return (attachment.limits ?? []).some(rule => {
    if (!rule.perUnit) return false;
    const already = list.entries[index].attachments
      .map(id => data.unitsById.get(id))
      .filter(a => (a.tags ?? []).includes(rule.tag)).length;
    return already >= rule.max;
  });
}

// readable names for the tags used in per-unit limits
const TAG_NAMES = { "bastards-boy": "Bastard's Boy", "golden-company": "Golden Company" };
function tagName(tag) {
  return TAG_NAMES[tag] ?? tag.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function validatePerUnitLimits(list) {
  const problems = [];
  list.entries.forEach((entry, i) => {
    const attached = entry.attachments.map(id => data.unitsById.get(id));
    const checked = new Set();
    attached.forEach(a => (a.limits ?? []).forEach(rule => {
      if (!rule.perUnit || checked.has(rule.tag)) return;
      checked.add(rule.tag);
      const count = attached.filter(x => (x.tags ?? []).includes(rule.tag)).length;
      if (count > rule.max)
        problems.push(`${rowName(list, i)} has ${count} ${tagName(rule.tag)} attachments (maximum ${rule.max})`);
    }));
  });
  return problems;
}

// is this exact attachment already on this unit?
function alreadyOnUnit(list, index, attachment) {
  return list.entries[index].attachments.includes(attachment.id);
}

function validateDuplicateAttachments(list) {
  const problems = [];
  list.entries.forEach((entry, i) => {
    const seen = new Set();
    entry.attachments.forEach(id => {
      if (seen.has(id))
        problems.push(`${rowName(list, i)} has more than one ${data.unitsById.get(id).name}`);
      seen.add(id);
    });
  });
  return problems;
}

// a named character is any model with a nickname; the commander counts as one too
function characterNamesInList(list) {
  const names = allModelIds(list)
    .map(id => data.unitsById.get(id))
    .filter(m => m.nickname)
    .map(m => m.name);
  const commander = data.commandersById.get(list.commander);
  // Doran stands in the list as his NCU, so the commander does not count a second time; Areo does take his place
  if (commander && !commander.ncu) names.push(commander.name);
  if (fieldCommander(list)) names.push(fieldCommander(list).name);
  return names;
}

// is this model another form of a character who is already in the list?
function characterTaken(list, model) {
  return !!model.nickname && characterNamesInList(list).includes(model.name);
}

function validateUniqueCharacters(list) {
  const counts = {};
  characterNamesInList(list).forEach(n => { counts[n] = (counts[n] ?? 0) + 1; });
  return Object.entries(counts)
    .filter(([, n]) => n > 1)
    .map(([name]) => `${name} appears more than once in the list`);
}

// ====================================================================
// Interface
// ====================================================================

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function changeFaction(id) {
  // switching faction clears the list, keeping only the chosen game size
  list = { ...newList(), faction: id || null, gameSize: list.gameSize, name: list.name };
  menu = null;
  render();
}

function openMenu(m) { menu = m; render(); }
function closeMenu() { menu = null; tidy(); render(); }

// ---- pictures ---------------------------------------------------------
// Pictures are found by id: images/<folder>/<id>.<ext>. A missing picture just leaves the name showing.
function artTile(folder, model, onclick, ext = "jpg") {
  const tile = el("button", { className: "tile", onclick });
  if (model?.faction) tile.classList.add(`faction-${model.faction}`);   // lets the stylesheet colour each faction's boxes
  if (model) {
    // folder may be a list: each is tried in turn until a picture is found
    const folders = [].concat(folder);
    let tried = 0;
    const img = el("img", { src: `images/${folders[0]}/${model.id}.${ext}`, alt: "" });
    img.onload = () => tile.classList.add("hasart");
    img.onerror = () => {
      tried++;
      if (tried < folders.length) img.src = `images/${folders[tried]}/${model.id}.${ext}`;
      else { img.remove(); tile.classList.add("noart"); }
    };
    const label = model.nickname ? `${model.name} - ${model.nickname}` : model.name;
    tile.append(img, el("span", { className: "tile-name", textContent: label }));
  }
  return tile;
}

// a tile for a model that has been picked: shows its art and points, and does nothing when clicked
function filledTile(model, size) {
  // attachments use images/attachments/<id>.jpg (face icons) first, then images/units/<id>.jpg
  const tile = artTile(size === "small" ? ["attachments", "units"] : "units", model);
  tile.classList.add("filled", size);
  tile.title = model.nickname ? `${model.name} - ${model.nickname}` : model.name;
  tile.append(el("span", { className: "tile-points", textContent: modelPoints(model) }));
  return tile;
}

// the commander, shown as the first small box on the unit he is attached to
function commanderTile(commander) {
  const tile = artTile("attachments", commander);
  tile.classList.add("filled", "small", "commander");
  tile.title = `${commander.name} - ${commander.nickname} (commander)`;
  tile.append(el("span", { className: "tile-points", textContent: "C" }));
  return tile;
}

// the "+" box; with no click handler it is shown greyed out
function addTile(onclick, size = "small") {
  const tile = el("button", { className: `tile empty ${size}`, textContent: "+" });
  if (onclick) tile.onclick = onclick;
  else { tile.classList.add("disabled"); tile.disabled = true; }
  return tile;
}

// wraps a tile and (optionally) gives it a remove button
function slotBox(size, tile, onRemove, removeTitle = "Remove") {
  const box = el("div", { className: `slot ${size}` }, tile);
  if (onRemove) box.append(el("button", { className: "remove", textContent: "×", title: removeTitle, onclick: onRemove }));
  return box;
}

// ability ids are plain lowercase words; these few need punctuation in the name shown on the page
const TRAIT_NAMES = {
  "berics-vassal": "Beric's Vassal", "commanders-vassal": "Commander's Vassal", "davos-vassal": "Davos' Vassal",
  "harmas-vassal": "Harma's Vassal", "jaimes-vassal": "Jaime's Vassal", "jokins-vassal": "Jokin's Vassal",
  "victarions-vassal": "Victarion's Vassal", "jokins-protector": "Jokin's Protector", "renlys-protector": "Renly's Protector",
  "jojens-greensight": "Jojen's Greensight", "maegis-healing": "Maegi's Healing", "mad-dogs-ferocity": "Mad Dog's Ferocity",
  "the-krakens-dues": "The Kraken's Dues", "the-mountains-strength": "The Mountain's Strength", "vipers-fangs": "Viper's Fangs",
  "winterfells-wrath": "Winterfell's Wrath", "first-of-the-kings-men": "First of the King's Men", "sic-em": "Sic 'Em",
  "prayers-to-rhllor": "Prayers to R'hllor", "my-name-is-reek": "My Name Is Reek!", "hot-pies": "Hot Pies!",
  "to-the-last": "To the Last!", "hodor": "Hodor!", "hodor-hodor-hodor": "Hodor!!!", "stand-your-ground": "Stand Your Ground!",
  "a-man-freed-a-name-owed": "A Man Freed, a Name Owed",
  "hold-the-line": "Hold the Line!", "stay-at-your-posts": "Stay at Your Posts!", "dance": "Dance!!!"
};
const SMALL_WORDS = new Set(["a", "an", "and", "at", "by", "in", "of", "the", "to"]);
function prettyTrait(id) {
  const bare = id.replace(/^order-/, "");
  const name = TRAIT_NAMES[bare] ?? bare.replace(/-/g, " ")
    .replace(/\b\w+/g, (w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
  return id.startsWith("order-") ? `${name} (Order)` : name;
}

// ---- what can be picked -----------------------------------------------
function borrowingFull(unit, faction, forList) {
  if (unit.faction === faction.id || unit.faction === "neutral") return false;
  return faction.borrowing.some(rule => rule.from.includes(unit.faction) && borrowedCount(rule, forList) >= rule.max);
}

// units that can go into row `index` (a row number past the end means a new row)
function unitOptions(index) {
  const faction = data.factionsById.get(list.faction);
  const commander = data.commandersById.get(list.commander);
  // when swapping, count the list as if the unit being replaced were already gone
  const without = {
    ...list,
    entries: list.entries.map((e, k) => (k === index ? { ...e, unit: null } : e))
  };
  return data.units.filter(u =>
    u.class === "combat_unit" && isEligible(u, faction) && u.id !== unitCommander()?.unit &&
    !borrowingFull(u, faction, without) && !atMaxPerList(without, u) &&
    !perLimitReached(without, u) && (!u.mustHost || hostRows(u, list).includes(index)) && armyRequirementMet(u, list) && !armyConflict(u, list) && !loyaltyClash(u, without) &&
    // the commander always sits in the top row, so that row only offers units he can join
    !(index === 0 && commander && !commanderFitsUnit(fieldCommander() ?? commander, u)));
}

function ncuOptions() {
  const faction = data.factionsById.get(list.faction);
  return data.units.filter(u =>
    u.class === "ncu" && isEligible(u, faction) &&
    !characterTaken(list, u) && !atMaxPerList(list, u) &&
    armyRequirementMet(u, list) && !armyConflict(u, list) && !loyaltyClash(u, list));
}

function attachmentOptions(i) {
  const faction = data.factionsById.get(list.faction);
  const unit = list.entries[i].unit ? data.unitsById.get(list.entries[i].unit) : null;
  const atCap = slotsUsed(list, i) >= data.season.attachmentsPerUnit;   // at the cap: only cap-ignoring attachments
  const here = modelsOnUnit(list, i);
  return data.units.filter(u => {
    if (u.class !== "attachment" || !isEligible(u, faction) || !u.attachesTo) return false;
    if (characterTaken(list, u) || atMaxPerList(list, u)) return false;
    if (!armyRequirementMet(u, list) || armyConflict(u, list) || loyaltyClash(u, list)) return false;
    // goes on an enemy unit: this row's unit and attachment limits don't matter, just one copy
    if (u.attachesToEnemy) return !list.enemyAttachments.includes(u.id);
    return (!unit || (!isSolo(unit) && attachmentFitsUnit(u, unit))) &&
      (!atCap || !countsTowardCap(u, here)) &&
      (!u.attachesTo.requiresAttachment || u.attachesTo.requiresAttachment.some(r => here.includes(r))) &&
      !perUnitLimitHit(list, i, u) &&
      !alreadyOnUnit(list, i, u);
  });
}

// ---- setup: factions, game size, commander ----------------------------
// ---- saving, sharing and exporting ---------------------------------------
const STORE_CURRENT = "song-tool-current";   // the list being edited, restored when the page is reopened
const STORE_SAVED = "song-tool-saved";       // lists saved by name: [{ name, saved, list }]

function storeGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function storeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function saveCurrent() { storeSet(STORE_CURRENT, list); }

// turn something read from storage or a link back into a safe list; unknown ids are dropped
function sanitizeList(raw) {
  if (!raw || typeof raw !== "object" || !data.factionsById.has(raw.faction)) return null;
  const l = newList();
  l.name = String(raw.name ?? "").slice(0, 60) || "My List";
  l.faction = raw.faction;
  if (data.season.gameSize.includes(raw.gameSize)) l.gameSize = raw.gameSize;
  const known = id => typeof id === "string" && data.unitsById.has(id);
  const commander = data.commandersById.get(raw.commander);
  if (commander && commander.faction === l.faction) l.commander = commander.id;
  l.entries = (Array.isArray(raw.entries) ? raw.entries : []).map(e => ({
    unit: known(e?.unit) ? e.unit : null,
    attachments: (Array.isArray(e?.attachments) ? e.attachments : []).filter(known),
  }));
  if (l.commander) {
    if (!l.entries.length) l.entries.push({ unit: null, attachments: [] });
    l.commanderUnit = 0;
    if (commander.unit) l.entries[0] = { unit: commander.unit, attachments: [] };
  }
  l.enemyAttachments = (Array.isArray(raw.enemyAttachments) ? raw.enemyAttachments : []).filter(known);
  l.ncus = (Array.isArray(raw.ncus) ? raw.ncus : []).filter(known);
  return l;
}

function encodeList(l) {
  const bytes = new TextEncoder().encode(JSON.stringify(l));
  let bin = "";
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeList(text) {
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return sanitizeList(JSON.parse(new TextDecoder().decode(bytes)));
  } catch { return null; }
}
function shareUrl() {
  return `${location.origin}${location.pathname}#list=${encodeList(list)}`;
}

function modelLabel(m) { return m.nickname ? `${m.name} - ${m.nickname}` : m.name; }

// the list as plain text, for pasting into a chat or printing
function exportText() {
  const faction = data.factionsById.get(list.faction);
  if (!faction) return "";
  const commander = list.commander ? data.commandersById.get(list.commander) : null;
  const lines = [`${list.name} - ${faction.name.replace(/^House /, "")} - ${totalPoints(list)}/${list.gameSize} points`];
  if (commander) lines.push(`Commander: ${modelLabel(commander)}`);
  lines.push("");
  list.entries.forEach((e, i) => {
    const unit = e.unit ? data.unitsById.get(e.unit) : null;
    const extras = e.attachments.map(id => data.unitsById.get(id)).map(a => `${modelLabel(a)} (${modelPoints(a)})`);
    const asUnit = unitCommander() && list.commanderUnit === i;
    if (commander && list.commanderUnit === i && !asUnit) extras.unshift(`${modelLabel(fieldCommander() ?? commander)} (Commander)`);
    lines.push(`${i + 1}. ${unit ? `${unit.name} (${asUnit ? `${commander.points}, Commander` : rowCost(list, i)})` : "(no unit)"}${extras.length ? ` + ${extras.join(", ")}` : ""}`);
  });
  if (list.enemyAttachments.length)
    lines.push(`Attached to enemy units: ${list.enemyAttachments.map(id => modelLabel(data.unitsById.get(id))).join(", ")}`);
  if (list.ncus.length)
    lines.push(`Non-combatant units: ${list.ncus.map(id => { const u = data.unitsById.get(id); return `${u.name} (${ncuCost(list, id)})`; }).join(", ")}`);
  const att = attachmentTotals(list);
  lines.push("", `Points: ${totalPoints(list)}/${list.gameSize}`);
  if (hasNeutralLimit(list)) lines.push(`Neutral points: ${neutralPoints(list)}/${neutralLimit(list)}`);
  lines.push(`Free attachment points: ${att.freeUsed}/${att.free}`);
  const problems = validateList(list);
  if (problems.length) lines.push("", "Problems:", ...problems.map(p => `- ${p}`));
  const deck = buildDeck(list);
  if (deck.length) lines.push("", `Tactics deck: ${deck.map(c => c.name).join(", ")}`);
  lines.push("", `Open this list: ${shareUrl()}`);
  return lines.join("\n");
}

async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toolMsg = done; }
  catch { toolMsg = "Could not copy automatically - use Export and copy the text instead."; }
  render();
}

function saveList() {
  if (!list.faction) { toolMsg = "Choose a faction before saving."; render(); return; }
  const saved = storeGet(STORE_SAVED, []).filter(s => s.name !== list.name);
  saved.unshift({ name: list.name, saved: new Date().toISOString(), list });
  toolMsg = storeSet(STORE_SAVED, saved) ? `Saved "${list.name}".` : "Could not save - browser storage is unavailable.";
  render();
}

function loadSaved(entry) {
  const l = sanitizeList(entry.list);
  if (!l) { toolMsg = "That saved list could not be read."; dialog = null; render(); return; }
  list = l;
  dialog = null;
  menu = null;
  toolMsg = `Loaded "${l.name}".`;
  render();
}

function deleteSaved(name) {
  storeSet(STORE_SAVED, storeGet(STORE_SAVED, []).filter(s => s.name !== name));
  render();
}

function downloadText(text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = el("a", { href: url, download: `${list.name.replace(/[^\w\- ]+/g, "").trim() || "list"}.txt` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderListBar() {
  const bar = el("div", { className: "list-bar" });
  const name = el("input", { type: "text", className: "list-name", value: list.name, maxLength: 60, placeholder: "List name", title: "List name" });
  name.oninput = () => { list.name = name.value; saveCurrent(); };
  name.onchange = () => { list.name = name.value.trim() || "My List"; saveCurrent(); };   // no redraw here: it would swallow the click on Save
  bar.append(name,
    el("button", { textContent: "Save", onclick: saveList }),
    el("button", { textContent: "Load", onclick: () => { dialog = { kind: "load" }; render(); } }),
    el("button", { textContent: "Share link", disabled: !list.faction, onclick: () => copyText(shareUrl(), "Share link copied.") }),
    el("button", { textContent: "Print / PDF", disabled: !list.faction, title: "Opens the print dialog - choose Save as PDF to make a PDF", onclick: () => window.print() }),
    el("button", { textContent: "Export", disabled: !list.faction, onclick: () => { dialog = { kind: "export", text: exportText() }; render(); } }),
    el("button", {
      textContent: confirmNew ? "Click again to clear" : "New list",
      onclick: () => {
        if (!confirmNew) { confirmNew = true; render(); setTimeout(() => { if (confirmNew) { confirmNew = false; render(); } }, 4000); return; }
        confirmNew = false;
        list = newList();
        menu = null;
        toolMsg = "Started a new list. Saved lists are kept.";
        render();
      } }));
  return bar;
}

// the title with a button that opens or closes the panel of list tools
// Build / Analysis links shown at the top of both pages
function renderNav(current) {
  const link = (id, href, text) => el("a", { href, textContent: text, className: id === current ? "nav-link current" : "nav-link" });
  return [el("nav", { className: "site-nav" }, link("build", "index.html", "Building"), link("analysis", "analysis.html", "Analysis"))];
}

function renderHeader() {
  const toggle = el("button", {
    className: toolsOpen ? "tools-toggle open" : "tools-toggle",
    title: "Save, load, share, print and export lists",
    onclick: () => { toolsOpen = !toolsOpen; storeSet("song-tool-tools-open", toolsOpen); render(); },
  }, "List tools ", el("span", { className: "chevron", textContent: "▸" }));
  toggle.setAttribute("aria-expanded", String(toolsOpen));
  const head = el("div", { className: "page-head" }, el("h1", { textContent: "ASOIAF List Builder" }), toggle);
  if (toolsOpen) head.append(renderListBar());   // opens to the right of the button
  if (toolMsg) head.append(el("span", { className: "tool-msg", textContent: toolMsg }));
  return [head];
}

function renderDialog() {
  if (!dialog) return null;
  const close = () => { dialog = null; render(); };
  const overlay = el("div", { className: "overlay" });
  overlay.onclick = e => { if (e.target === overlay) close(); };
  const panel = el("div", { className: "menu dialog" });
  if (dialog.kind === "export") {
    const box = el("textarea", { className: "export-text", readOnly: true, value: dialog.text, rows: 18 });
    panel.append(
      el("div", { className: "menu-head" }, el("h2", { textContent: "Export list" }), el("button", { textContent: "Close", onclick: close })),
      box,
      el("div", { className: "dialog-buttons" },
        el("button", { textContent: "Copy text", onclick: async () => {
          try { await navigator.clipboard.writeText(dialog.text); toolMsg = "List text copied."; }
          catch { box.select(); toolMsg = "Press Ctrl+C to copy the selected text."; }
          dialog = null; render(); } }),
        el("button", { textContent: "Download .txt", onclick: () => downloadText(dialog.text) })));
  } else {
    const saved = storeGet(STORE_SAVED, []);
    panel.append(el("div", { className: "menu-head" }, el("h2", { textContent: "Saved lists" }), el("button", { textContent: "Close", onclick: close })));
    if (!saved.length) panel.append(el("p", { textContent: "No saved lists yet. Use Save to keep the current list under its name." }));
    saved.forEach(entry => {
      const l = sanitizeList(entry.list);
      const faction = l ? data.factionsById.get(l.faction).name.replace(/^House /, "") : "unreadable";
      const pts = l ? `${totalPoints(l)}/${l.gameSize}` : "";
      const acts = l ? activations(l) : null;
      const when = acts === null ? "" : `${acts} ${acts === 1 ? "activation" : "activations"}`;
      panel.append(el("div", { className: "saved-row" },
        el("span", { className: "saved-name", textContent: entry.name }),
        el("span", { className: "saved-info", textContent: [faction, pts && `${pts} pts`, when].filter(Boolean).join(" - ") }),
        el("button", { textContent: "Load", disabled: !l, onclick: () => loadSaved(entry) }),
        el("button", { textContent: "Delete", onclick: () => deleteSaved(entry.name) })));
    });
  }
  overlay.append(panel);
  return overlay;
}

// ---- printable card sheet --------------------------------------------------
// A hidden sheet holding every card on the list. The browser's print dialog shows it ("Save as PDF" makes the PDF).
// Cards are cut from the faction sheets in images/cards, using the positions listed in data/cards.json.
function printCard(id) {
  const model = modelById(id);
  const pos = data.cards.cards[id];
  const sheet = pos && data.cards.sheets[pos[0]];
  if (!sheet) return el("div", { className: "pcard missing", textContent: model ? model.name : id });
  const box = el("div", { className: `pcard ${sheet.w > sheet.h ? "land" : "port"}`, title: model?.name ?? id });
  box.style.aspectRatio = `${sheet.w} / ${sheet.h}`;
  const img = el("img", { src: sheet.file, alt: model?.name ?? id });
  img.style.width = `${sheet.cols * 100}%`;
  img.style.left = `${-pos[1] * 100}%`;
  img.style.top = `${-pos[2] * 100}%`;
  box.append(img);
  return box;
}

function renderPrintSheet() {
  const box = el("section", { className: "print-sheet" });
  if (!list.faction) return box;
  const faction = data.factionsById.get(list.faction).name.replace(/^House /, "");
  const commander = list.commander ? data.commandersById.get(list.commander) : null;
  box.append(el("h1", { textContent: list.name }),
    el("p", { className: "print-sub", textContent:
      `${faction} - ${totalPoints(list)}/${list.gameSize} points` + (commander ? ` - Commander: ${modelLabel(commander)}` : "") }));
  list.entries.forEach((e, i) => {
    const ids = [...(e.unit ? [e.unit] : []), ...e.attachments, ...(attachedCommander(list, i) ? [commander.id, ...(fieldCommander() ? [fieldCommander().id] : [])].filter(id => data.cards.cards[id]) : [])];
    if (!ids.length) return;
    const unit = e.unit ? data.unitsById.get(e.unit) : null;
    box.append(el("div", { className: "print-row" },
      el("h3", { textContent: `${i + 1}. ${unit ? unit.name : "(no unit)"}` }),
      el("div", { className: "print-cards" }, ...ids.map(printCard))));
  });
  if (list.enemyAttachments.length)
    box.append(el("div", { className: "print-row" }, el("h3", { textContent: "Attached to enemy units" }),
      el("div", { className: "print-cards" }, ...list.enemyAttachments.map(printCard))));
  if (list.ncus.length)
    box.append(el("div", { className: "print-row" }, el("h3", { textContent: "Non-combatant units" }),
      el("div", { className: "print-cards" }, ...list.ncus.map(printCard))));
  return box;
}

function renderSetup() {
  const box = el("section", { className: "setup" });

  const factionRow = el("div", { className: "faction-row" });
  [...data.factionsById.values()].forEach(f => {
    const tile = artTile("factions", f, () => changeFaction(f.id), "png");
    if (list.faction === f.id) tile.classList.add("selected");
    factionRow.append(tile);
  });

  const sizes = el("div", { className: "sizes" }, "Game size: ");
  data.season.gameSize.forEach(n =>
    sizes.append(el("button", {
      className: n === list.gameSize ? "size selected" : "size",
      textContent: n,
      onclick: () => { list.gameSize = n; render(); }
    })));

  const commanders = [...data.commandersById.values()].filter(c => c.faction === list.faction);
  const commanderLine = el("div", { className: "commander-line" }, "Commander: ",
    el("select", { onchange: e => {
      releaseUnitCommander();
      const gone = releaseCommanderExtras();
      list.commander = e.target.value || null;
      const uc = unitCommander();
      if (uc) {
        // a unit commander leads a new top row of his own; any other copy of his unit leaves the list
        list.entries.forEach(en => { if (en.unit === uc.unit) en.unit = null; });
        list.entries = list.entries.filter(en => en.unit || en.attachments.length);
        list.entries.unshift({ unit: uc.unit, attachments: [] });
        list.commanderUnit = 0;
      } else if (list.commander) {
        // the commander always joins the first row (it is created empty if there are no rows yet)
        if (!list.entries.length) list.entries.push({ unit: null, attachments: [] });
        list.commanderUnit = 0;
        makeRoomForCommander(0);
      } else list.commanderUnit = null;
      const picked = data.commandersById.get(list.commander);
      if (picked?.ncu && !list.ncus.includes(picked.ncu)) list.ncus.push(picked.ncu);   // Doran joins as his NCU
      dropOrphans();
      if (gone) notice = `${notice ? notice + " " : ""}${gone}`;
      tidy();
      render();
    } },
      el("option", { value: "", textContent: list.faction ? "Choose a commander" : "Choose a faction" }),
      ...commanders.map(c => el("option", {
        value: c.id,
        textContent: `${c.name} - ${c.nickname}`,
        disabled: c.id !== list.commander && (loyaltyClash(c, list, true) || armyConflict(c, list)),   // his Loyalty clashes with a model already in the list
        selected: c.id === list.commander
      }))));

  box.append(factionRow, sizes, commanderLine);
  return box;
}

// ---- the list: one row per unit ---------------------------------------
// row = [ big unit box ] [ small attachment boxes ] [ unit info ]
// A row can have attachments (and the commander) before it has a unit, and keeps them if the unit is removed.
// ---- re-ordering rows by dragging ----------------------------------------
function clearDropMarks() {
  document.querySelectorAll(".drop-before, .drop-after").forEach(n => n.classList.remove("drop-before", "drop-after"));
}
// true when the pointer is over the upper half of the row (the dragged row goes above it)
function dropBefore(row, e) {
  const r = row.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2;
}
// move row `from` so that it sits before the row currently at position `at` (at = rows.length means the end)
function moveRow(from, at) {
  if (list.commanderUnit === from) return;   // the commander's row stays at the top
  if (list.commanderUnit === 0) at = Math.max(at, 1);   // and nothing goes above it
  if (at > from) at -= 1;                    // account for the row being taken out first
  if (at === from) return;
  const cu = list.commanderUnit;
  const [row] = list.entries.splice(from, 1);
  list.entries.splice(at, 0, row);
  if (cu !== null) {
    let c = cu;
    if (c > from) c -= 1;
    if (c >= at) c += 1;
    list.commanderUnit = c;
  }
  render();
}

function renderUnitInfo(entry, i) {
  const u = entry.unit ? data.unitsById.get(entry.unit) : null;
  const box = el("div", { className: "unit-info" });
  if (u) {
    box.append(
      el("h3", { textContent: u.name }),
      el("p", { className: "meta" }, el("span", { className: "cap", textContent: u.type }), ` · ${unitCommander() && list.commanderUnit === i ? `${unitCommander().points} pts as commander` : `${rowCost(list, i)} pts`}`));
    if (u.stats)
      box.append(el("p", { textContent: `Speed ${u.stats.speed} · Defense ${u.stats.defense} · Morale ${u.stats.morale}` }));
  } else {
    box.append(el("h3", { textContent: "No unit chosen" }));
  }
  // abilities: the unit's own first, then those of the attachments and commander on this row
  const abilities = [...new Set([...(u?.traits ?? []), ...modelsOnUnit(list, i).flatMap(id => modelById(id)?.traits ?? [])])].map(prettyTrait);
  // Loyalty (Baratheon units and attachments): "Loyalty: Stannis Baratheon", shown after the other abilities
  const loyalties = [...new Set([u, ...modelsOnUnit(list, i).map(modelById)].map(m => m?.loyalty).filter(Boolean))];
  loyalties.forEach(l => abilities.push(`Loyalty: ${l.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}`));
  if (abilities.length)
    box.append(el("p", { className: "traits", textContent: abilities.join(", ") }));
  // keywords added by the commander or attachments on this row (e.g. "Affiliation: Rangers")
  const keywords = [...new Set(modelsOnUnit(list, i).map(modelById).map(m => m?.grantsKeyword).filter(Boolean))];
  if (u && keywords.length)
    box.append(el("p", { className: "traits", textContent: keywords.join(", ") }));
  const costs = attachmentCosts(entry);
  if (costs.length)
    box.append(el("p", { textContent: "Attachments: " + costs.map(c => `${c.attachment.name} (${c.cost})`).join(", ") }));
  if (rowCards(i).length)
    box.append(el("button", { className: "row-btn", textContent: "View cards", onclick: () => openCards(rowCards(i)) }));
  return box;
}

function renderSlots() {
  const box = el("section", { className: "slots" }, el("div", { className: "slots-head" },
    el("h2", { textContent: "Your list" }),
    el("button", { textContent: "View cards", disabled: !list.faction || !allCards().length, title: "Look through every card in the list", onclick: () => openCards(allCards()) })));
  if (notice) box.append(el("p", { className: "notice", textContent: notice }));
  if (!list.faction) {
    box.append(el("p", { textContent: "Choose a faction to start building." }));
    return box;
  }

  list.entries.forEach((entry, i) => {
    // big box: the unit (click to swap it) or a "+" while the row has no unit
    let big;
    if (entry.unit) {
      const tile = filledTile(data.unitsById.get(entry.unit), "big");
      tile.querySelector(".tile-points").textContent = rowCost(list, i);
      if (unitCommander() && list.commanderUnit === i) {
        // a unit commander: shown as the unit, at his commander cost; the cross removes the commander
        tile.classList.add("commander");
        tile.querySelector(".tile-points").textContent = unitCommander().points;
        tile.title = `${modelLabel(unitCommander())} (commander)`;
        big = slotBox("big", tile, clearCommander, "Remove the commander");
      } else {
        tile.classList.add("swap");
        tile.title += " - click to swap";
        tile.onclick = () => openMenu({ kind: "unit", index: i });
        big = slotBox("big", tile, () => removeUnit(i), "Remove the unit (keeps its attachments)");
      }
    } else {
      big = slotBox("big", addTile(() => openMenu({ kind: "unit", index: i }), "big"));
    }

    const attachCol = el("div", { className: "attach-col" });
    const commander = data.commandersById.get(list.commander);
    if (commander && attachedCommander(list, i))
      attachCol.append(slotBox("small", commanderTile(fieldCommander() ?? commander), clearCommander, "Remove the commander"));
    const rowCosts = attachmentCosts(entry);
    entry.attachments.forEach((id, j) => {
      const t = filledTile(data.unitsById.get(id), "small");
      if (rowCosts[j]) t.querySelector(".tile-points").textContent = rowCosts[j].cost;   // after any discount
      attachCol.append(slotBox("small", t, () => removeAttachment(i, j)));
    });
    // nothing can ever be attached to solo units, monsters and the like: no + box at all
    const rowUnit = entry.unit ? data.unitsById.get(entry.unit) : null;
    if (!rowUnit || canTakeAttachments(rowUnit)) {
      const canAdd = attachmentOptions(i).length > 0;
      attachCol.append(slotBox("small", addTile(canAdd ? () => openMenu({ kind: "attachment", index: i }) : null)));
    }

    const row = el("div", { className: "slot-row" });
    // every row except the commander's can be dragged by its handle to a new place in the list
    if (list.commanderUnit !== i) {
      const handle = el("div", { className: "drag-handle", draggable: true, title: "Drag to change the order", textContent: "⋮⋮" });
      handle.ondragstart = e => {
        dragRow = i;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
        e.dataTransfer.setDragImage(row, 20, 20);
        setTimeout(() => row.classList.add("dragging"), 0);
      };
      handle.ondragend = () => { dragRow = null; clearDropMarks(); row.classList.remove("dragging"); };
      row.append(handle);
    } else row.append(el("div", { className: "drag-handle locked", title: "The commander's unit stays at the top", textContent: "" }));
    row.ondragover = e => {
      if (dragRow === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDropMarks();
      row.classList.add(dropBefore(row, e) ? "drop-before" : "drop-after");
    };
    row.ondrop = e => {
      if (dragRow === null) return;
      e.preventDefault();
      const from = dragRow;
      dragRow = null;
      clearDropMarks();
      moveRow(from, dropBefore(row, e) ? i : i + 1);
    };
    row.append(big, attachCol, renderUnitInfo(entry, i));
    box.append(row);
  });

  // one empty row at the bottom: pick a unit for it, or start it with an attachment
  const next = list.entries.length;
  box.append(el("div", { className: "slot-row" },
    el("div", { className: "drag-handle locked" }),   // keeps the empty row lined up with the rows above
    slotBox("big", addTile(() => openMenu({ kind: "unit", index: next }), "big")),
    el("div", { className: "attach-col" },
      slotBox("small", addTile(() => {
        list.entries.push({ unit: null, attachments: [] });
        openMenu({ kind: "attachment", index: next });
      })))));

  // attachments that go on enemy units: this row only exists while there is one
  if (list.enemyAttachments.length) {
    const enemyRow = el("div", { className: "tile-row" });
    list.enemyAttachments.forEach((id, i) =>
      enemyRow.append(slotBox("small", filledTile(data.unitsById.get(id), "small"), () => removeEnemyAttachment(i))));
    box.append(el("h3", { textContent: "Attachments for Enemy Units" }), enemyRow);
  }

  // non-combatant units
  const ncuRow = el("div", { className: "tile-row" });
  list.ncus.forEach((id, i) =>
    ncuRow.append(slotBox("small", (() => {
    const t = filledTile(data.unitsById.get(id), "small");
    t.querySelector(".tile-points").textContent = ncuCost(list, id);
    return t;
  })(), () => removeNcu(i))));
  ncuRow.append(slotBox("small", addTile(() => openMenu({ kind: "ncu" }))));
  box.append(el("h3", { textContent: "Non-combatant units" }), ncuRow);
  return box;
}

// ---- points, problems, tactics deck -----------------------------------
// one line of the points table: label, used / limit, and a small note
function pointsRow(label, used, limit, note) {
  return el("div", { className: used > limit ? "points-row over" : "points-row" },
    el("span", { className: "points-label", textContent: label }),
    el("span", { className: "points-value", textContent: `${used} / ${limit}` }),
    el("span", { className: "points-note", textContent: note ?? "" }));
}

function renderSummary() {
  if (!list.faction) return null;
  const box = el("section", { className: "summary" });
  const att = attachmentTotals(list);
  const table = el("div", { className: "points-table" });
  table.append(pointsRow("Points", totalPoints(list), list.gameSize));
  if (hasNeutralLimit(list))
    table.append(pointsRow("Neutral points", neutralPoints(list), neutralLimit(list)));
  table.append(pointsRow("Free attachment points", att.freeUsed, att.free));
  box.append(table);
  const problems = validateList(list);
  if (problems.length)
    box.append(el("h3", { textContent: "Problems" }),
      el("ul", {}, ...problems.map(p => el("li", { textContent: p }))));
  const deck = buildDeck(list);
  box.append(el("div", { className: "deck-head" },
    el("h3", { textContent: "Tactics deck" }),
    el("button", { textContent: "View Cards", disabled: !deck.length, onclick: () => openTactics(deck, 0) })),
    el("ul", {}, ...deck.map((c, i) => el("li", {},
      el("button", { className: "link", textContent: c.name, onclick: () => openTactics(deck, i) })))));
  return box;
}

// ---- the pick menu ------------------------------------------------------
function menuTile(model, onclick) {
  // attachment / non-combatant pickers use the face icons (images/attachments) first, then images/units
  const tile = artTile(menu.kind === "unit" ? "units" : ["attachments", "units"], model, onclick);
  // * = cannot use the free attachment points
  const star = menu.kind === "attachment" && !usesFreePoints(model, list) ? "*" : "";
  tile.append(el("span", { className: "tile-points", textContent: `${Math.max(0, modelPoints(model) - pickDiscount(model))}${star}` }));
  tile.title = model.nickname ? `${model.name} - ${model.nickname}` : model.name;
  return tile;
}

function renderMenu() {
  if (!menu) return null;
  const kind = menu.kind;
  const index = menu.index;
  let title, groups, pick;

  if (kind === "unit") {
    title = list.entries[index]?.unit ? "Swap unit" : "Choose a unit";
    pick = id => setUnit(index, id);
    const opts = unitOptions(index);
    const labels = { infantry: "Infantry", cavalry: "Cavalry", monster: "Monsters", "war-machine": "War machines" };
    groups = Object.entries(labels).map(([t, label]) => [label, opts.filter(u => u.type === t)]);
    const other = opts.filter(u => !(u.type in labels));
    if (other.length) groups.push(["Other", other]);
  } else if (kind === "ncu") {
    title = "Choose a non-combatant unit";
    pick = id => addNcu(id);
    groups = [["", ncuOptions()]];
  } else {
    title = `Attach to ${rowName(list, index)}`;
    pick = id => addAttachment(index, id);
    groups = [["", attachmentOptions(index)]];
  }
  // the faction's own models first, then borrowed ones, then neutral; the data order is kept within each
  const rank = u => (u.faction === list.faction ? 0 : u.faction === "neutral" ? 2 : 1);
  groups = groups.map(([label, us]) => [label, [...us].sort((a, b) => rank(a) - rank(b))]);
  groups = groups.filter(([, us]) => us.length);

  const overlay = el("div", { className: "overlay" });
  overlay.onclick = e => { if (e.target === overlay) closeMenu(); };
  const panel = el("div", { className: "menu" },
    el("div", { className: "menu-head" },
      el("h2", { textContent: title }),
      el("button", { textContent: "Close", onclick: closeMenu })));
  groups.forEach(([label, us]) => {
    if (label) panel.append(el("h3", { textContent: label }));
    panel.append(el("div", { className: kind === "unit" ? "menu-grid wide" : "menu-grid" },
      ...us.map(u => menuTile(u, () => { menu = null; pick(u.id); }))));
  });
  if (!groups.length) panel.append(el("p", { textContent: "Nothing available." }));
  if (kind === "attachment")
    panel.append(el("p", { className: "legend", textContent: "* = Neutral attachments cannot be purchased using free attachment points" }));
  overlay.append(panel);
  return overlay;
}

// ---- card viewer (tactics deck, and the cards of units, attachments and commanders) ------------
// A card is { name, label, image: { file, cols, rows, col, row, w, h } }; the picture is cut from a sheet of cards.
function galleryStep(n) {
  if (!gallery) return;
  gallery.index = (gallery.index + n + gallery.cards.length) % gallery.cards.length;
  render();
}
function closeGallery() { gallery = null; render(); }

function tacticsCards(deck) {
  return deck.map(c => ({
    name: c.name,
    label: c.owner === "commander" ? data.commandersById.get(c.ownerId).name : "Faction card",
    image: { file: c.atlas, cols: c.cols, rows: c.rows, col: c.col, row: c.row, w: 500, h: 700 },
  }));
}
function openTactics(deck, index) { gallery = { cards: tacticsCards(deck), index }; render(); }

// the card of a unit, attachment, commander or non-combatant unit (null if there is no picture of it)
function modelCard(id, label) {
  const model = modelById(id);
  const pos = data.cards.cards[id];
  const sheet = pos && data.cards.sheets[pos[0]];
  if (!model) return null;
  return { name: modelLabel(model), label, image: sheet ? { file: sheet.file, cols: sheet.cols, rows: sheet.rows, col: pos[1], row: pos[2], w: sheet.w, h: sheet.h } : null };
}

function extraCard(x, label) {
  const pos = data.cards.cards[x.id];
  const sheet = pos && data.cards.sheets[pos[0]];
  return { name: x.name, label, extra: true, image: sheet ? { file: sheet.file, cols: sheet.cols, rows: sheet.rows, col: pos[1], row: pos[2], w: sheet.w, h: sheet.h } : null };
}

// the cards on one row of the list: the unit, then its attachments, then the commander if he is there
function rowCards(i) {
  const e = list.entries[i];
  return [
    ...(e.unit ? [modelCard(e.unit, `Row ${i + 1} - Unit`)] : []),
    // cards that come with a unit without being a model of their own (Varamyr's Eagle)
    ...(e.unit ? (data.unitsById.get(e.unit).extraCards ?? []) : []).map(x => extraCard(x, `Row ${i + 1} - Unit`)),
    ...e.attachments.flatMap(id => [modelCard(id, `Row ${i + 1} - Attachment`), ...(data.unitsById.get(id)?.extraCards ?? []).map(x => extraCard(x, `Row ${i + 1} - Attachment`))]),
    ...(attachedCommander(list, i) ? [list.commander, ...(fieldCommander() ? [fieldCommander().id] : [])].filter(id => data.cards.cards[id]).flatMap(id => [modelCard(id, `Row ${i + 1} - Commander`), ...(modelById(id)?.extraCards ?? []).map(x => extraCard(x, `Row ${i + 1} - Commander`))]) : []),   // a commander who is his own unit (Mag, Varamyr) has no card of his own
  ].filter(Boolean);
}
function allCards() {
  return [
    ...list.entries.flatMap((e, i) => rowCards(i)),
    ...list.enemyAttachments.map(id => modelCard(id, "Attachment for an enemy unit")),
    ...list.ncus.flatMap(id => [modelCard(id, "Non-combatant unit"), ...(modelById(id)?.extraCards ?? []).map(x => extraCard(x, "Non-combatant unit"))]),
  ].filter(Boolean)
    // a poison card or the like shared by several models is shown once
    .filter((card, i, all) => !card.extra || all.findIndex(c => c.extra && c.name === card.name) === i);
}
function openCards(cards) { if (cards.length) { gallery = { cards, index: 0 }; render(); } }

function renderGallery() {
  if (!gallery) return null;
  const card = gallery.cards[gallery.index];
  const overlay = el("div", { className: "overlay" });
  overlay.onclick = e => { if (e.target === overlay) closeGallery(); };
  let picture;
  const im = card.image;
  if (im) {
    picture = el("div", { className: "card-img", role: "img", title: card.name });
    picture.style.aspectRatio = `${im.w} / ${im.h}`;
    picture.style.maxWidth = `min(100%, ${(68 * im.w / im.h).toFixed(1)}vh)`;
    picture.style.backgroundImage = `url(${im.file})`;
    picture.style.backgroundSize = `${im.cols * 100}% ${im.rows * 100}%`;
    picture.style.backgroundPosition = `${im.cols > 1 ? im.col * 100 / (im.cols - 1) : 0}% ${im.rows > 1 ? im.row * 100 / (im.rows - 1) : 0}%`;
  } else picture = el("div", { className: "card-missing", textContent: "No picture of this card yet." });
  overlay.append(el("div", { className: "gallery" },
    el("div", { className: "menu-head" },
      el("h2", { textContent: card.name }),
      el("button", { textContent: "Close", onclick: closeGallery })),
    el("div", { className: "gallery-body" },
      el("button", { className: "nav", textContent: "‹", title: "Previous", onclick: () => galleryStep(-1) }),
      picture,
      el("button", { className: "nav", textContent: "›", title: "Next", onclick: () => galleryStep(1) })),
    el("p", { className: "gallery-count", textContent: `${gallery.index + 1} / ${gallery.cards.length} - ${card.label}` })));
  return overlay;
}

function render() {
  const parts = [...renderNav("build"), ...renderHeader(), renderSetup(), renderSlots(), renderSummary(), renderMenu(), renderGallery(), renderDialog(), renderPrintSheet()].filter(Boolean);
  notice = null;   // a notice is shown once, then cleared
  toolMsg = null;
  saveCurrent();
  document.getElementById("app").replaceChildren(...parts);
}

async function start() {
  try {
    data = await loadData();
    // open a shared link if there is one, otherwise the list from last time
    const shared = location.hash.startsWith("#list=") ? decodeList(location.hash.slice(6)) : null;
    if (location.hash.startsWith("#list=")) history.replaceState(null, "", location.pathname + location.search);
    list = shared ?? sanitizeList(storeGet(STORE_CURRENT, null)) ?? newList();
    if (shared) toolMsg = "Opened the shared list.";
    document.addEventListener("keydown", e => {
      if (dialog) {
        if (e.key === "Escape") { dialog = null; render(); }
      } else if (gallery) {
        if (e.key === "Escape") closeGallery();
        else if (e.key === "ArrowRight") galleryStep(1);
        else if (e.key === "ArrowLeft") galleryStep(-1);
      } else if (e.key === "Escape" && menu) closeMenu();
    });
    render();
  } catch (err) {
    console.error("Startup failed:", err);
  }
}

if (!window.SONG_NO_UI) start();
