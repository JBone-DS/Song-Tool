let data;
let list;

async function loadData() {
  const names = ["season", "factions", "commanders", "units", "tactics"];
  const [season, factions, commandersRaw, units, tactics] = await Promise.all(
    names.map(n => fetch(`data/${n}.json`).then(r => r.json()))
  );
  const commanders = commandersRaw.flatMap(group => Object.values(group).flat());
  return {
    season, factions, commanders, units, tactics,
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
    ncus: []
  };
}

function addUnit(unitId) {
  list.entries.push({ unit: unitId, attachments: [] });
  render();
}

function removeUnit(index) {
  list.entries.splice(index, 1);
  if (list.commanderUnit === index) list.commanderUnit = null;
  else if (list.commanderUnit !== null && list.commanderUnit > index) list.commanderUnit -= 1;
  render();
}

function addAttachment(index, attachmentId) {
  list.entries[index].attachments.push(attachmentId);
  render();
}

function removeAttachment(i, j) { list.entries[i].attachments.splice(j, 1); render(); }
function addNcu(id) { list.ncus.push(id); render(); }
function removeNcu(i) { list.ncus.splice(i, 1); render(); }
function setCommanderUnit(i) { list.commanderUnit = i; render(); }

function render() {
  // replaced in Step 7
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
    rule.from.includes(data.unitsById.get(entry.unit).faction)
  ).length;
}

//tactics deck rules

function buildDeck(list) {
  if (!list.commander) return [];
  const commander = data.commandersById.get(list.commander);
  const removed = commander.removedFactionCards ?? [];
  return data.tactics.filter(card =>
    (card.owner === "faction" && card.ownerId === list.faction && !removed.includes(card.name)) ||
    (card.owner === "commander" && card.ownerId === list.commander)
  );
}

// attachment slots used on a unit: ordinary attachments, plus the commander if attached here
function slotsUsed(list, index) {
  const here = modelsOnUnit(list, index);
  const used = list.entries[index].attachments
    .map(id => data.unitsById.get(id))
    .filter(a => countsTowardCap(a, here)).length;
  return used + (list.commanderUnit === index ? 1 : 0);
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
function attachmentCosts(entry) {
  const unit = data.unitsById.get(entry.unit);
  const costs = entry.attachments.map(id => {
    const attachment = data.unitsById.get(id);
    return { attachment, cost: attachment.points };
  });
  if (unit.adaptive) {   // Stormcrow Mercenaries: cheaper attachments
    const { attachmentsAffected: n, attachmentCostReduction: r } = unit.adaptive;
    costs.slice(0, n).forEach(c => { c.cost -= Math.min(r, c.cost); });
  }
  return costs;
}

function attachmentTotals(list) {
  const all = list.entries.flatMap(entry => attachmentCosts(entry));
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

function totalPoints(list) {
  const units = list.entries.reduce((sum, e) => sum + data.unitsById.get(e.unit).points, 0);
  const ncus = list.ncus.reduce((sum, id) => sum + data.unitsById.get(id).points, 0);
  return units + ncus + attachmentTotals(list).charged;   // commanders cost nothing
}

//rules validation

function modelsOnUnit(list, index) {
  const ids = [...list.entries[index].attachments];
  if (list.commanderUnit === index) ids.push(list.commander);
  return ids;
}

function allModelIds(list) {
  return [...list.entries.flatMap(e => [e.unit, ...e.attachments]), ...list.ncus];
}

function validateCommander(list) {
  if (!list.commander) return ["Choose a commander"];
  const c = data.commandersById.get(list.commander);
  return c.faction === list.faction ? [] : [`${c.name} does not belong to this faction`];
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
    .map(rule => `${faction.name} may take at most ${rule.max} unit(s) from ${rule.from.join(" or ")}`);
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
    const unit = data.unitsById.get(entry.unit);
    entry.attachments.forEach(id => {
  const att = data.unitsById.get(id);
  if (!att.attachesTo) {                                   // add
    problems.push(`${att.name} is not set up as an attachment`);   // add
    return;                                                // add
  }
  if (!att.attachesTo.type.includes(unit.type))
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
      problems.push(`${data.unitsById.get(entry.unit).name} has ${used} attachments including the commander (maximum ${max})`);
  });
  return problems;
}

function validateList(list) {
  if (!list.faction) return ["Choose a faction"];
  return [
    ...validateCommander(list),
    ...validatePoints(list),
    ...validateEligibility(list),
    ...validateBorrowing(list),
    ...validatemaxPerList(list),
    ...validateAttachments(list),
    ...validateAttachmentCap(list),
    ...validatePerUnitLimits(list),
    ...validatePerUnitLimits(list),
    ...validateDuplicateAttachments(list),
    ...validateUniqueCharacters(list),
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

function validatePerUnitLimits(list) {
  const problems = [];
  list.entries.forEach(entry => {
    const unit = data.unitsById.get(entry.unit);
    const attached = entry.attachments.map(id => data.unitsById.get(id));
    const checked = new Set();
    attached.forEach(a => (a.limits ?? []).forEach(rule => {
      if (!rule.perUnit || checked.has(rule.tag)) return;
      checked.add(rule.tag);
      const count = attached.filter(x => (x.tags ?? []).includes(rule.tag)).length;
      if (count > rule.max)
        problems.push(`${unit.name} has ${count} "${rule.tag}" attachments (maximum ${rule.max})`);
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
  list.entries.forEach(entry => {
    const seen = new Set();
    entry.attachments.forEach(id => {
      if (seen.has(id))
        problems.push(`${data.unitsById.get(entry.unit).name} has more than one ${data.unitsById.get(id).name}`);
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
  if (commander) names.push(commander.name);
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

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function render() {
  document.getElementById("app").replaceChildren(renderSetup());
}

function changeFaction(id) {
  // switching faction clears the list, keeping only the chosen game size
  list = { ...newList(), faction: id || null, gameSize: list.gameSize };
  render();
}

// Pictures are found by id: images/<folder>/<id>.<ext>. A missing picture just leaves the name showing.
function artTile(folder, model, onclick, ext = "jpg") {
  const tile = el("button", { className: "tile", onclick });
  if (model) {
    const img = el("img", { src: `images/${folder}/${model.id}.${ext}`, alt: "" });
    img.onerror = () => img.remove();
    const label = model.nickname ? `${model.name} - ${model.nickname}` : model.name;
    tile.append(img, el("span", { className: "tile-name", textContent: label }));
  }
  return tile;
}

function renderSetup() {
  const box = el("section", { className: "setup" });

  // one tile per playable faction (the neutral pool isn't a faction you can lead)
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
    el("select", { onchange: e => { list.commander = e.target.value; render(); } },
      el("option", { value: "", textContent: list.faction ? "Choose a commander..." : "Choose a faction first" }),
      ...commanders.map(c => el("option", {
        value: c.id,
        textContent: `${c.name} - ${c.nickname}`,
        selected: c.id === list.commander
      }))));

  box.append(factionRow, sizes, commanderLine);
  return box;
}

function renderUnitPicker() {
  const box = el("section", {}, el("h2", { textContent: "Units" }));
  const faction = data.factionsById.get(list.faction);
  if (!faction) return box;

  const eligible = data.units.filter(u => isEligible(u, faction));
  for (const cls of ["combat_unit", "ncu"]) {
    box.append(el("h3", { textContent: cls === "ncu" ? "Non-combatant units" : "Combat units" }));
    eligible.filter(u => u.class === cls).forEach(u => {
      box.append(el("div", {},
        `${u.name}${u.nickname ? " - " + u.nickname : ""} (${u.points}) `,
        el("button", { textContent: "Add", onclick: () => (cls === "ncu" ? addNcu(u.id) : addUnit(u.id)) })));
    });
  }
  return box;
}

function renderUnitPicker() {
  const box = el("section", {}, el("h2", { textContent: "Units" }));
  const faction = data.factionsById.get(list.faction);
  if (!faction) return box;

  const eligible = data.units.filter(u => isEligible(u, faction));
  for (const cls of ["combat_unit", "ncu"]) {
    box.append(el("h3", { textContent: cls === "ncu" ? "Non-combatant units" : "Combat units" }));
    eligible.filter(u => u.class === cls).forEach(u => {
      box.append(el("div", {},
        `${u.name}${u.nickname ? " - " + u.nickname : ""} (${u.points}) `,
        el("button", { textContent: "Add", onclick: () => (cls === "ncu" ? addNcu(u.id) : addUnit(u.id)) })));
    });
  }
  return box;
}

function render() {
  document.getElementById("app").replaceChildren(renderSetup(), renderUnitPicker());
}

function renderList() {
  const box = el("section", {}, el("h2", { textContent: "Your list" }));
  const faction = data.factionsById.get(list.faction);
  if (!faction) return box;
  const name = id => data.unitsById.get(id).name;
  const cap = data.season.attachmentsPerUnit;

  list.entries.forEach((entry, i) => {
    const unit = data.unitsById.get(entry.unit);
    const row = el("div", {},
      el("strong", { textContent: `${unit.name} (${unit.points})` }),
      el("button", { textContent: "Remove", onclick: () => removeUnit(i) }),
      el("button", {
        textContent: list.commanderUnit === i ? "Commander is here" : "Attach commander",
        onclick: () => setCommanderUnit(i)
      }));

    entry.attachments.forEach((id, j) =>
      row.append(el("div", {}, `+ ${name(id)} (${data.unitsById.get(id).points}) `,
        el("button", { textContent: "x", onclick: () => removeAttachment(i, j) }))));

    // once a unit is at its cap, offer only attachments that don't count toward it
       const atCap = slotsUsed(list, i) >= cap;
        const commander = data.commandersById.get(list.commander);
    const here = modelsOnUnit(list, i);
    const options = data.units.filter(u =>
      u.class === "attachment" && isEligible(u, faction) &&
      u.attachesTo.type.includes(unit.type) &&
      (!atCap || !countsTowardCap(u, here)) &&
      !(commander && u.name === commander.name && u.nickname === commander.nickname) &&
            (!u.attachesTo.requiresAttachment || u.attachesTo.requiresAttachment.some(r => here.includes(r))) &&
            !perUnitLimitHit(list, i, u) &&
            !alreadyOnUnit(list, i, u) &&
             !characterTaken(list, u) &&
      !atMaxPerList(list, u));
    row.append(el("select", { onchange: e => { if (e.target.value) addAttachment(i, e.target.value); } },
      el("option", { value: "", textContent: "Add attachment..." }),
      ...options.map(u => el("option", {
        value: u.id,
        // neutral attachments are marked because they can't use the free points
        textContent: `${u.name}${u.nickname ? " - " + u.nickname : ""} (${u.points})${usesFreePoints(u, list) ? "" : " [no free points]"}`
      }))));
    box.append(row);
  });

  list.ncus.forEach((id, i) =>
    box.append(el("div", {}, `${name(id)} (NCU) `,
      el("button", { textContent: "Remove", onclick: () => removeNcu(i) }))));

  const att = attachmentTotals(list);
  box.append(el("p", { textContent: `Points: ${totalPoints(list)} / ${list.gameSize}` }));
  box.append(el("p", {
    textContent: `Attachments: ${att.total} points (${att.inFaction} in-faction, ${att.other} neutral or other). ` +
      `Free points used: ${att.freeUsed} of ${att.free}. Charged: ${att.charged}.`
  }));
  box.append(el("h3", { textContent: "Problems" }),
    el("ul", {}, ...validateList(list).map(p => el("li", { textContent: p }))));
  box.append(el("h3", { textContent: "Tactics deck" }),
    el("ul", {}, ...buildDeck(list).map(c => el("li", { textContent: c.name }))));
  return box;
}

function render() {
  document.getElementById("app").replaceChildren(renderSetup(), renderUnitPicker(), renderList());
}

async function start() {
  try {
    console.log("1. loading data...");
    data = await loadData();
    console.log("2. data loaded", data);
    list = newList();
    console.log("3. list created", list);
    render();
    console.log("4. rendered");
  } catch (err) {
    console.error("Startup failed at the last step above:", err);
  }
}

start();