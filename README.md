# Song Tool

A browser army-list builder for the miniatures game **A Song of Ice and Fire** (data for Season 7.2).
It is a static site: plain HTML, CSS and vanilla JavaScript, plus JSON data. There is no build step and no
dependencies, so it runs on GitHub Pages as it is.

- **Building** (`index.html`): pick a faction, commander, units, attachments and NCUs. Points, limits and rules are
  checked as you go. Lists can be saved, shared by link, exported as text, and printed as a card sheet.
- **Analysis** (`analysis.html`): compares saved lists, units and factions using a simple dice-probability model.
- **Tournament** (`tournament.html`): player profiles and a tournament manager. Register players with locked lists, draw
  rounds (Swiss or random), enter results and see live standings. Data is stored in the browser for now (see below).

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
| `tournament.html`, `tournament.js` | The Tournament page: profiles, players, rules, rounds, standings, backup. Also loads `app.js` (for list checking) in the same way. |
| `tournament-core.js` | The tournament maths with no page code: scoring, standings, pairings. `test-tournament.js` tests it in Node. |
| `cloud.js`, `cloud-core.js`, `cloud-config.js` | Saving tournaments to the Supabase database: sign-in, uploading changes, the read-only public view. `cloud-core.js` (pure mapping, tested by `test-cloud.js`) turns the page's data into database rows; `cloud-config.js` holds the project URL and public key. |
| `schema.sql` | The database tables and security rules. Paste into Supabase's SQL Editor to set up (or rebuild) the database. |
| `style.css` | Styles for all pages. |
| `data/` | All game data (see below). |
| `images/cards/` | Card sheets (many cards per picture). `images/tactics/` holds the tactics-card sheets. Other folders hold faction logos and unit art. |
| `sourcedata/` | The original card PDFs the card sheets were cut from. Not used by the site. |
| `check-data.js` | Data checker (Node). |
| `test-cloud.js` | Tests for the database mapping and upload logic against a fake database (Node). |
| `test-tournament.js` | Tests for `tournament-core.js` (Node): runs 120 simulated events and checks there are no rematches or repeat byes. |
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

## The Tournament page

Everything is held in one object, `db`, saved in this browser's localStorage under `song-tool-tournaments`:

```
db = { version: 1,
       profiles:    [ { id, name, club, country, faction } ],
       tournaments: [ { id, name, date, location, points, plannedRounds, status, rules, players, rounds } ] }
players: [ { pid (a profile id), listCode (a share-link code), locked, dropped } ]
rounds:  [ { n, done, tables: [ { id, a, b, result, vpA, vpB, bonusA, bonusB, killedByA, killedByB } ] } ]   // b = null is a bye
rules:   { pairing: "swiss" | "random", avoidClub, win, draw, loss, tiebreakers: ["sos", "vpDiff", "destroyed"],
           margins: { enabled, band, marginalWin, majorWin } }
```

- **Reading and writing goes through `tstore`** at the top of `tournament.js`. Moving to a shared database later means
  replacing `tstore.load` and `tstore.save` (and making them asynchronous); nothing else reads storage.
- **Backup:** the Backup tab exports and imports the whole of `db` as a JSON file. Because data lives only in one browser,
  export after each round.
- **List locking:** a player's list is a share-link code. Locking checks it with the same `validateList` the Building page
  uses, and that it was built for the tournament's points. After round one starts lists cannot be unlocked.
- **Pairing:** round one is random. Later Swiss rounds pair players by standings. No-one meets the same opponent twice and
  clubmates are avoided when the rules say so, as long as that is possible; if not, the rule is relaxed one step at a time
  and the page warns. An odd player gets a bye (a win with no victory points) and nobody gets a second one while others
  have had none. Seats can be swapped by hand before any result is entered.
- **Results:** enter victory points (the winner is worked out) or pick the result directly. Bonus points are added to
  tournament points. Ties on every measure share a rank.
- **How a game is decided:** by default the result follows the game record, and the organiser can override it per table
  ("Automatic" in the result menu). Order: (1) an army with every unit destroyed loses automatically (a major win when
  margins are on, whatever the VP); (2) more victory points wins; (3) if VP are level, more **points left on the
  table** wins (army points, less NCU costs, less the points the enemy destroyed); (4) still level is a draw.
  `decideResult` in `tournament-core.js` does this. Tournament points are set on their own line of the Rules tab:
  "Pts per Win" (or "Pts per Marginal Win" and "Pts per Major Win" when margins are on), "Pts per Draw", "Pts per Loss".
  Changing a table's seat clears its kills and result.
- **Marginal and major victories (optional, Rules tab):** a win by `band` victory points or fewer (default 2) is
  marginal, a bigger win (or a wipe-out) is major, and each is worth its own tournament points (defaults 2 and 3; the
  plain win score is not used). Both players' victory points must be entered so the margin is known, unless an army was wiped out. A bye counts as a major
  win. Standings show each player's major wins.
- **Units destroyed:** every game has a checklist, one tile for each unit in the opposing locked list (its picture from
  `images/units/<id>.jpg`, or its name if there is none). Click a tile to cross the unit off: it fades with a red
  cross. `killedByA` holds the positions in B's list that A destroyed (and the reverse), so they stay correct as lists
  are locked. The points of destroyed units become the tie-breakers "Enemy points destroyed" and "Points destroyed minus
  points lost". A destroyed unit always counts with its attachments. Up to four tie-breakers
  can be chosen, in order.
- **Not built yet:** accounts and sign-in, shared live leaderboards for players on their own devices, per-round points
  limits (escalation), team events, and rankings across events. These need a hosted database.

## The database (Supabase)

The Tournament page saves to a Supabase project (hosted Postgres). `schema.sql` creates five tables: `profiles`, `tournaments`,
`tournament_players`, `rounds` and `games`, with row level security so an organiser can change only their own data and anyone
can read a tournament marked public. The page still works on one in-memory `db` object; `cloud.js` compares it with the last
copy the database is known to hold and sends only what changed, a moment after each edit. A copy is kept in the browser too,
with a "dirty" flag, so changes made offline upload when the connection returns.

- **Organisers** sign in with an email link (Supabase Authentication). Turn off "Allow new users to sign up" in the Supabase
  dashboard once the organiser accounts exist.
- **Players** need no account. A tournament's public link is `tournament.html?view=<tournament id>`: read-only standings and
  rounds, updating live (Supabase Realtime). A tournament can be made private from its page.
- **Keys:** `cloud-config.js` holds the project URL and the *publishable* key. Both are meant to be public; the security rules
  protect the data. Never put the service-role or secret key in the site. Removing `cloud-config.js`'s values (`window.SONG_CLOUD = null`)
  returns the page to browser-only storage.
- **Old browser data:** the first sign-in on a browser holding earlier tournaments offers to upload it (short ids are converted to uuids).
- **Changing the tables:** edit `schema.sql`, update the mapping in `cloud-core.js` and `node test-cloud.js`, then run the new SQL in Supabase.
- **Limits:** if two devices edit the same tournament at once the last save wins. The free plan pauses a project after a week of no use.

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
