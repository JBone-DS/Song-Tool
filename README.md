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
| `tournament.html`, `tournament.js` | The Tournament page: directory, profiles, joining, lists, rules, rounds, standings. Also loads `app.js` (for list checking) in the same way. |
| `rankings.html`, `rankings.js` | The Rankings page: best players by rating, filtered by faction, continent and country (continents only appear once they have 10 ranked players). Reads the `ranking_board` view. |
| `countries.js` | The country list (with continents) used by the profile's Country dropdown and the Rankings filters. The profile's Country field is a dropdown of this list. |
| `tournament-core.js` | The tournament maths with no page code: scoring, standings, pairings. `test-tournament.js` tests it in Node. |
| `cloud.js`, `cloud-core.js`, `cloud-config.js` | The Supabase side: sign-in, reading and saving tournaments, joining, live updates. `cloud-core.js` (pure mapping, tested by `test-cloud.js`) turns database rows into the tournament object and back; `cloud-config.js` holds the project URL and public key. |
| `schema.sql`, `migration-v1-to-v2.sql`, `migration-profile-names-results.sql` | The database tables and security rules (paste into Supabase's SQL Editor; safe to re-run), and the one-off step for anyone who ran the first version. |
| `profile-gate.js` | Loaded by `analysis.html`: sends anyone signed in without a profile to create one first (the Building page does the same inside `saved-sync.js`; the Tournament page shows only the create-profile form until it exists). |
| `saved-sync.js` | Loaded by `index.html` only: keeps the Building page's Saved lists on the signed-in account (private library), merging by name, newest save wins. |
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

`tournament.html` (with `tournament.js`) is a directory of tournaments plus everything to run one. It works on one tournament at a
time, held in `ui.t`, in the shape described at the top of `cloud-core.js`:

```
t = { id, owner, name, date, location, description, points, plannedRounds, status, rules,
      registrationOpen, maxPlayers, listsLocked, hideListsUntilRound1,
      players:  [ { pid, dropped, listCode } ],          // approved players; listCode is null if you may not see it yet
      requests: [ { pid, status, listCode } ],           // asked to join and waiting, or declined
      rounds:   [ { n, rid, done, tables: [ { id, gid, a, b, result, manual, vpA, vpB, bonusA, bonusB, killedByA, killedByB } ] } ] }   // b = null is a bye
rules: { pairing: "swiss" | "random", avoidClub, win, draw, loss, tiebreakers: ["sos", "vpDiff", "destroyed"],
         margins: { enabled, band, marginalWin, majorWin } }
```

**People and flows**
- **Everyone** can browse the directory and open any tournament without an account.
- **Players** sign in with an email link and have one profile: first name, last name, an optional nickname (shown as Sam "The Kraken" Reid), club, country and an optional picture. They ask to join a
  tournament, choose their army list (a saved list from the Building page, or a pasted share link) and, once in a game, enter
  its victory points and tick off destroyed units.
- **Organisers** are whoever created the tournament. They approve or decline requests, lock lists, set the rules, draw rounds,
  seat players and can change any result. Tabs: Players, Details, Rules, Rounds, Standings.
- **List privacy:** a list is private to its player and the organiser until the organiser **locks lists**; then it is public to
  anyone who can view the tournament, or (if "hide locked lists until round 1 is drawn" is set) once round 1 exists. Players
  cannot change a list after locking. The database enforces this, not just the page.
- **Visibility:** every tournament is public. An optional player limit blocks approving more.

- **Pairing:** round one is random. Later Swiss rounds pair players by standings. No-one meets the same opponent twice and
  clubmates are avoided when the rules say so, as long as that is possible; if not, the rule is relaxed one step at a time
  and the page warns. An odd player gets a bye (a win with no victory points) and nobody gets a second one while others
  have had none. Seats can be swapped by hand before any result is entered.
- **Results:** enter victory points (the winner is worked out) or pick the result directly (organiser). Bonus points are added to
  tournament points. Ties on every measure share a rank.
- **How a game is decided:** by default the result follows the game record, and the organiser can override it per table
  ("Automatic" in the result menu). Order: (1) an army with every unit destroyed loses automatically (a major win when
  margins are on, whatever the VP); (2) more victory points wins; (3) if VP are level, more **points left on the
  table** wins (army points, less NCU costs, less the points the enemy destroyed); (4) still level is a draw.
  `decideResult` in `tournament-core.js` does this. Tournament points are set on their own line of the Rules tab:
  "Pts per Win" (or "Pts per Marginal Win" and "Pts per Major Win" when margins are on), "Pts per Draw", "Pts per Loss".
  Changing a table's seat clears its kills and result.
- **Marginal and major victories (on by default, can be turned off on the Rules tab):** a win by `band` victory points or fewer (default 2) is
  marginal, a bigger win (or a wipe-out) is major, and each is worth its own tournament points (defaults 2 and 3; the
  plain win score is not used). Both players' victory points must be entered so the margin is known, unless an army was wiped out. A bye counts as a major
  win. Standings show each player's major wins.
- **Units destroyed:** every game has a checklist, one tile for each unit in the opposing locked list (its picture from
  `images/units/<id>.jpg`, or its name if there is none). Click a tile to cross the unit off: it fades with a red
  cross. `killedByA` holds the positions in B's list that A destroyed (and the reverse), so they stay correct as lists
  are known. The points of destroyed units become the tie-breakers "Enemy points destroyed" and "Points destroyed minus
  points lost". A destroyed unit always counts with its attachments. Up to four tie-breakers (default: strength of schedule, victory point difference, victory points scored, then points destroyed minus points lost; team events use the same default, and "individual games won" can be chosen as a tie-breaker)
  can be chosen, in order.
- **Team events:** the organiser picks "Teams" and a team size (2, 3 or 4) when creating the tournament (`format`,
  `teamSize`). There are no solo sign-ups: a captain enters a named team, teammates ask to join it, the captain accepts
  them, and the organiser approves the squad (Players tab, "Approve team"). Every team event shows the banner "This is a team
  event... Players are to assign a team captain, and that player applies for entry for the squad as a whole."
  Each round pairs team against team (Swiss or random, no rematches, an odd team gets a bye) and then pairs the players of
  the two teams one-to-one (Swiss by individual standing, or random: the "Player pairing in a match-up" rule). The organiser can
  swap seats between teammates, sub in a teammate, or leave a seat empty. An empty seat is a forfeit win for the player
  present and is not recorded against anyone's profile (it works like a bye, and is ignored by ratings). A team wins a match
  by winning more individual games than it loses; level is a draw, and a drawn game is never a win. Team points use the
  normal win/draw/loss points (a major win is a clean sweep). Team standings and the individual standings are both shown;
  tie-breakers include "individual games won". Individual games still count for each player's record and Glicko-2 rating;
  there are no team ratings. The engine is in the team section of `tournament-core.js` (`drawTeamRound`, `matchOutcome`,
  `teamStandings`); the tables are `teams` and `matches` in `schema.sql`, with the rules enforced by triggers.
- **All tournaments are public:** there is no visibility setting; every tournament is listed in the directory and readable by anyone (`schema.sql` drops the old `visibility` column and its rules).
- **Swapping team members and substitutes:** until the organiser locks the lists, a captain can swap a player by
  removing them ("Remove to replace") and letting the replacement join the team and be accepted. Once lists are locked
  (and at any time during the event) only the organiser can substitute: on the Players tab, "Replace" on any player
  (team or individual events) searches nicknames for anybody with a profile (they need not be on the team or in the
  tournament), optionally takes their share link, drops the old player and enters the new one in the same team. A game still open
  is handed over to the substitute (its record is cleared). This uses two organiser-only database functions,
  `find_profiles` and `substitute_player` in `schema.sql`. The tournament directory has a Format column (Individual /
  Team (Ns)).
- **Rankings and the rating graph:** the Rankings page (nav: Rankings) lists ranked players (5 rated games overall, 3 with a
  faction) by Glicko-2 rating. Filters: faction (overall or any faction), region (continent; only regions with 10+ ranked players
  are offered) and country (always shown), plus a "Find a player" search that opens a player's page (`tournament.html?player=<id>`: record, rating graph, faction ratings and game history), so you can see "Best Greyjoy player in Europe" or "Best overall player in the United Kingdom".
  Players pick their country from a list on their profile. My profile shows a line chart of the rating after each rated
  tournament (in date order, from the 1500 start, hover a point for the tournament), with buttons to switch between overall and each faction.
- **Not built yet:** public profile pages, the achievement and trophy rules themselves (the records they need are tracked),
  per-round points limits (escalation), and organisers adding co-organisers.

## The database (Supabase)

The page stores everything in a Supabase project (hosted Postgres, with sign-in and live updates).

- **Tables** (`schema.sql`): `profiles` (one per account), `tournaments`, `registrations` (a player's request and the
  organiser's decision), `entry_lists` (army lists, kept apart so they can be hidden), `tournament_results` (final standings,
  saved when a tournament is finished), `rounds` and `games`. Security is
  row level security written in the same file: see its header for who can do what. Games can be updated by the organiser or
  by the two players in them while the round is open, and a trigger stops players moving seats or changing bonus points.
- **Records, achievements and trophies:** the `player_stats` view (end of `schema.sql`) gives one row per profile: games played,
  won, drawn and lost, byes, tournaments played, tournament wins, podium finishes, major wins and enemy points destroyed. It is
  worked out from finished rounds (`games`) and `tournament_results`, and respects what the viewer may see (a profile's
  public record counts only public tournaments). To grant an achievement, test those columns (for example `games_played >= 10`
  or `tournament_wins >= 1`); add columns to the view for new kinds. The profile page shows the signed-in player's record.
  Finishing a tournament writes its `tournament_results` (reopening removes them); a tournament only counts toward wins once finished.
- **Ratings (Glicko-2):** everyone starts at 1500 with a rating deviation (RD) of 350. One finished tournament is one rating
  period; a draw scores 0.5; byes are ignored. Only **rated tournaments** count: finished, and with **16 or more
  players** (`MIN_RATED_PLAYERS` in `tournament.js` is only the wording; the real rule is `is_rated()` in `schema.sql`). The site
  administrator can force a tournament in or out with `tournaments.rating_override` (set it in the Supabase dashboard; a trigger
  stops organisers changing it), which is also the place to remove padded events. `recompute_ratings()` rebuilds every rating
  from the games, oldest tournament first, so reopening or deleting a tournament never leaves stale numbers; the page calls it
  after finishing or reopening. Tables `player_ratings` (one row per player and scope) and `rating_history`; view `rating_ranks`
  (leaderboard positions: 5 rated games overall, 3 for a faction). The **overall rating is the headline**; a **faction rating**
  is kept separately per faction (that faction's games against opponents' overall ratings) and is shown by the "Faction rating"
  button on the profile. Ratings that have fewer games than the threshold are marked provisional. Players who do not play in a
  tournament keep their RD unchanged (no inactivity growth). `glicko2_update` reproduces Glickman's worked
  example (1464.05, RD 151.52, volatility 0.06000; the paper's 1464.06 is hand-rounded).
- **Entry faction records:** `entry_lists` stores each entry's faction, commander and points next to the list code (set when the
  player chooses the list, and re-synced by the organiser when lists are locked). The `player_games` view gives one row per game
  played (game history, per-faction record, record against each faction); it respects list visibility, so faction columns are
  filled only where the viewer may see the lists.
- **Private saved-list library:** `saved_lists` holds each person's Saved lists from the Building page. Row level security lets
  only the owner read or change them; nobody else, including organisers, can see them. A list becomes visible to others only
  when entered in a tournament, under that tournament's list rules. The profile's game history opens a list only through that
  route. A deletion made on a device that was offline can be undone by another device that still has the list (known limit).
- **Signed out vs signed in:** anyone can browse tournaments and use the Building and Analysis pages. In the Building page's List tools, **Save, Load and Share link** need a signed-in account with a profile; Print / PDF, Export and New list are open to everyone (shared links still open for everyone). A new account must create its profile before using any page's tools.
- **Names and privacy:** the **nickname is required** and is the public name (rankings, rosters, standings, ratings). Real names
  are shown only in tournament match-ups, in game history, to organisers managing their players, and on the person's own profile.
  This is enforced in the database, not just the page: `first_name`/`last_name` cannot be read from `profiles` through the API;
  the view `profile_names` returns a real name only to the person, anyone who can view a tournament in which they have a game,
  and organisers of tournaments they registered for (`can_see_real_name` in `schema.sql`). Profiles made before the nickname was
  required get their first name as nickname when `schema.sql` is run. "My profile" is in the top button bar (`?profile=me`);
  "Edit profile" opens `?profile=edit`.
- **Profile pictures:** stored in a public Supabase Storage bucket `avatars` (created by `schema.sql`) at
  `avatars/<account id>/avatar.jpg`. The page crops to a square and shrinks to 256 pixels before upload; the bucket refuses
  files over 512 KB or that are not images, and people can only change files in their own folder. `profiles.avatar_updated_at`
  marks when the picture changed (it is also the cache-buster in the picture's address). Without a picture the player's initials show.
- **Setting up from scratch:** run `schema.sql` in Supabase's SQL Editor. It is safe to run again. If you ran the first
  (organiser-only) version, run `migration-v1-to-v2.sql` once first; it deletes the old test data. If you ran version 2 before
  profiles had first/last names, run `migration-profile-names-results.sql` once first; it keeps your profiles.
- **Sign-in:** Supabase Authentication with email links. "Allow new users to sign up" must be ON for players to create
  accounts. The Site URL and Redirect URLs (Authentication, URL Configuration) must include the site's address.
- **Keys:** `cloud-config.js` holds the project URL and the *publishable* key. Both are meant to be public; the security
  rules protect the data. Never put the service-role or secret key in the site.
- **How saving works** (`cloud.js`): an organiser's edits to the open tournament are compared with the last copy the database
  is known to hold, and only the changed settings, rounds and games are sent a moment later. A copy waits in the browser
  (`song-tool-pending`) until it has been sent, so a dropped signal loses nothing. Joining, lists, approvals and players'
  reports are direct calls. Live changes (Supabase Realtime) refresh whoever has the tournament open; the page waits until a
  text box is no longer being typed in before redrawing.
- **Mapping:** `cloud-core.js` turns database rows into the tournament object and back. `node test-cloud.js` checks it and the
  upload logic against a fake database. The security rules were tested separately against a local Postgres (not included).
- **Changing the tables:** edit `schema.sql` (and write a small migration for existing data), update `cloud-core.js` and its test.
- **Limits:** if the organiser edits from two devices at once the last save wins. The free plan pauses a project after a week
  without use. A deleted account's games block deleting its profile (a future clean-up job).

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
