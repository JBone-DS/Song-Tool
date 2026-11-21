# Song Tool

A browser army-list builder for the miniatures game **A Song of Ice and Fire** (data for Season 7.2).
It is a static site: plain HTML, CSS and vanilla JavaScript, plus JSON data. There is no build step and no
dependencies, so it runs on GitHub Pages as it is.

- **Building** (`index.html`): pick a faction, commander, units, attachments and NCUs. Points, limits and rules are
  checked as you go. Lists can be saved, shared by link, exported as text, and printed as a card sheet.
- **Analysis** (`analysis.html`): compares saved lists, units and factions using a simple dice-probability model.

## Running it locally

The pages load their data with `fetch`, so opening the file directly will not work. Serve the folder instead:

```
python -m http.server 8000
```

then open `http://localhost:8000/`. Before committing data changes, run:

```
node check-data.js
```

It prints `Data OK`, or a list of problems (unknown ids, cards pointing outside their sheet, combat units with no
combat numbers, decks of the wrong size). Run it from the repository root.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `app.js` | The Building page. `app.js` holds the state, the rules and the screen drawing. |
| `analysis.html`, `analysis.js` | The Analysis page. It loads `app.js` with `window.SONG_NO_UI = true` (so the Building screen does not start) and reuses its rules and helpers. |
| `style.css` | Styles for both pages. |
| `data/` | All game data (see below). |
| `images/cards/` | Card sheets (many cards per picture). `images/tactics/` holds the tactics-card sheets. Other folders hold faction logos and unit art. |
| `sourcedata/` | The original card PDFs the card sheets were cut from. Not used by the site. |
| `check-data.js` | Data checker (Node). |
| `backup/` | Old copies of `app.js` and `style.css` from before an earlier change. Not used; safe to delete. |

## How `app.js` works

There is one global `list` and every change edits it, then calls `render()`, which rebuilds the page from scratch.
(Rebuilding takes about 6 ms, so there is no need for anything cleverer.)

```
list = {
  name, season, gameSize, faction,
  commander,            // commander id, or null
  commanderUnit,        // index of the row the commander is attached to
  entries: [ { unit, attachments: [ids] } ],   // one row per unit; `unit` may be null
  enemyAttachments: [ids],                     // attachments that go on an enemy unit
  ncus: [ids],
}
```

The file reads top to bottom: state and data loading, list editing, a **Rules** section (costs, limits, loyalty,
army requirements and the `validate...` functions, none of which touch the page), then an **Interface** section
(tiles, pick menus, saving and sharing, and the `render...` functions).

Conventions worth knowing:

- Rule functions take the list as a parameter (`l` or `list`) rather than reading the global, which is what lets
  `analysis.js` run them on any saved list.
- `validate...` functions return an array of problem messages; `validateList` gathers them all.
- Points: `modelPoints` (printed cost after an in-army discount) → `attachmentCosts` (adds the free and
  first-attachment discounts for one row) → `rowCost` / `attachmentTotals` / `totalPoints`.
- Army-wide lookups use `armyIds(list)` (every model in the list, commander included) and `armyHasAny(list, ids)`.
- Commanders come in three kinds: an attached commander (most), a **unit commander** (`unit` field: Mag the
  Mighty, Varamyr Sixskins), and a **field commander** (`field` and `ncu` fields: Doran Martell, who is fielded as his
  NCU while Areo Hotah goes on the unit).

## Data files

**`units.json`** is a flat list. Every unit, attachment and NCU is one object.

Always present: `id`, `name`, `class` (`combat_unit`, `attachment` or `ncu`), `faction`, `points`, `excludedFactions`.
Common: `nickname`, `traits`, `maxPerList`. Combat units also have `type` (infantry, cavalry...), `stats`
(`speed`, `defense`, `morale`).

Optional fields that drive rules:

| Field | Meaning | Example |
| --- | --- | --- |
| `attachesTo` | Which units an attachment may join: `type: [...]`, optionally narrowed by `units: [ids]` and `factions: [ids]`, plus `requiresAttachment: [ids]` if it needs a partner on the same unit | Theon needs Ramsay |
| `attachesToEnemy` | The attachment goes on an enemy unit and gets its own row | Mance Rayder |
| `ignoresLimits` | Limits the attachment ignores, e.g. `["attachment-limits"]` | |
| `ignoresLimitsWith` | Ignores a limit only while one of `models` is on the unit | Qarl with an Asha |
| `soloUnit` / trait `solo-rider` | A single-model unit; it cannot take attachments. Set `soloUnit: true` (or give it the `solo-rider` trait) | Jorah Mormont |
| `maxPerList` | A number: at most this many in a list (an empty value means no limit) | |
| `limits`, `tags` | Per-unit limits by tag (e.g. one `bastards-boy` per unit) | Ben Bones |
| `requiresInArmy` | May only be fielded if one of these models is in the army | Arya needs Sandor |
| `forbiddenWith` | May not be fielded with any of these models (checked from either side) | Rainbow Guard, Hangwoman |
| `mustHost` | If one of these characters is in the army he must be attached to this unit | Rainbow Guard and Renly |
| `loyalty` | An army may not mix different loyalties | `stannis-baratheon` |
| `excludedFactions` | Factions that may not use this model | neutral Bolton copies |
| `discountIfInArmy` | `{ ids, amount }`: this model costs `amount` less while one of `ids` is in the army | Cortnay Penrose |
| `firstAttachmentDiscount` | Reduces the cost of the first attachment in the army by this much. Several stack, floored at 0 | Gendry, Hot Pie |
| `freeFirstIfInArmy` | The first copy of this attachment is free while one of the listed models is in the army | Crannogman Survivalist |
| `freeAttachments` | Ids of attachments this unit takes for nothing | Stone Crows with Tyrion |
| `adaptive` | `{ attachmentsAffected, attachmentCostReduction }`: cheaper attachments on this unit | Stormcrow Mercenaries |
| `discountsUnits` | NCU that cheapens units: `{ units, amount, count }` | Daenerys, The Unburnt |
| `extraCards` | `[{ id, name }]`: more cards shown under "View cards" (the id must exist in `cards.json`) | Poison, Banners, Skinchanger beasts |
| `grantsKeyword` | Text shown for a keyword the model grants | |

**`commanders.json`** is a list of groups of commanders (grouped by faction). A commander has `id`, `name`,
`nickname`, `faction`, `traits`, `removedFactionCards` (faction tactics cards he takes out of the deck),
and optionally `loyalty`, `grantsKeyword`, `requiresInArmy`, `extraCards`, `allowedUnitTypes` and
`attachesToUnits` (limits on which units he may join), plus the commander kinds above: `unit`, `ncu`, `field`
and `points`.

**`factions.json`**: `id`, `name`, `canUseNeutrals`, and `borrowing` (`[{ from: [faction ids], max }]` for factions that
may take units from another, like the Brotherhood).

**`season.json`**: season name, allowed `gameSize`s, `defaultGameSize`, `attachmentsPerUnit`, and
`freeAttachmentPoints` per game size (the points of own-faction attachments that cost nothing).

**`tactics.json`**: the tactics cards (`owner` is `faction` or `commander`, with `ownerId`, and where the card sits
in its sheet under `images/tactics/`).

**`cards.json`**: the unit, attachment, commander and NCU cards.
`sheets` maps a sheet name to its file, grid (`cols`, `rows`) and the size of one card (`w`, `h`); `cards` maps a model id
(or an extra-card id) to `[sheet, col, row]`.
Portrait sheets are 450×630 cards, landscape (combat unit) sheets are 640×373.

**`healing.json`**: every model whose card restores Wounds (units, attachments, commanders and NCUs), used only by the
Analysis page. `sources` maps a model id to its abilities: `who` (`self` heals the unit the model is, or is attached to;
`other` heals other friendly units), `amount` (Wounds per use), optional `rank: true` (the card adds "+1 Wound for each
destroyed rank") and `when` (how often it happens, a key of the `when` table). `when` gives each trigger an expected number of
uses per round (`perRound`), and `rankBonus` is the average extra Wounds for a rank bonus. These frequencies are estimates:
change them there and the page follows. Bonuses that depend on Controlling a symbol are not counted.

**`combat.json`**: numbers read off the combat unit cards, used only by the Analysis page: per unit
the attack `plates` (type, to-hit, dice), `ranks` and wounds, and `tokens` for how often its cards cause
Vulnerable, Weakened or Panicked.

## Common jobs

- **Add a rule to a unit**: add one of the fields above to its object in `units.json`, then run `node check-data.js`.
  Most rules need no code. If a rule is genuinely new, add the field here in the README and handle it in `app.js`
  (look at `unitAllowed`, `armyConflict` or `modelPoints` for how existing ones work).
- **Add a card or an extra card**: add the picture to a sheet in `images/cards/`, add `id: [sheet, col, row]` to
  `cards.json` (adding a row to the sheet means raising `rows` too), and for an extra card list it in the model's
  `extraCards`.
- **Show a card for a model**: it appears under "View cards" when its id is in `cards.json`.

## Analysis page model

Hit chance is `(7 − X) / 6` for an X+ roll; hits are dice × hit chance (dice at full strength, or averaged over ranks
if chosen); save chance is `(7 − Defense) / 6`; effective wounds are the wound pool divided by `(1 − save)`;
morale passes when two dice total at least the Morale number; "control" counts how often a card says a target
becomes Vulnerable, Weakened or Panicked. Healing (see `healing.json`) is converted to Wounds restored per round and the "Healing"
setting says how many rounds of it count toward resilience: it is added to the wound pool before dividing by `(1 − save)`, and healing
given to other units is added at the list level. These are relative measures for comparing lists, not exact predictions.
The page explains its assumptions in the "How the numbers work" box.
