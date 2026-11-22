// Cloud storage for the tournament page, using Supabase (a hosted Postgres database). See schema.sql for the tables and the
// security rules, and cloud-core.js for how rows become the tournament object the page uses.
//
// Who writes what:
//  - Players: their own profile, a request to join, their own army list, and the result of their own games.
//  - Organisers: everything else about their tournament (settings, who is approved, rounds, tables, results).
//  - The organiser's edits to a tournament are sent by `schedule`/`flush` (only the records that changed since the last copy the
//    database is known to hold). A copy is kept in the browser with a "pending" marker until it has been sent, so a dropped
//    signal at a venue loses nothing.
//  - Everything else (joining, lists, approvals, reports) is a direct call.
// `watch` listens for live changes to one tournament so every screen stays up to date.

const PENDING_KEY = "song-tool-pending";   // an organiser's tournament edits not yet sent: { t }

// real names are not in the profiles table the API can read; profile_names returns them only where the database says this viewer may see them
const PROFILE_COLS = "id,nickname,club,country,avatar_updated_at,created_at";

const cloud = {
  enabled: !!window.SONG_CLOUD?.url,
  client: null, user: null, synced: new Map(),
  status: "idle",            // idle | saving | saved | offline
  onStatus: () => {},        // set by the page
  _timer: null, _retry: null, _busy: false, _again: false, _latest: null, _reports: new Map(),

  // ---- connection and sign-in ----
  async init(onAuth) {
    if (!window.supabase?.createClient) throw new Error("The database service could not be loaded. Check your connection and reload.");
    this.client = window.supabase.createClient(window.SONG_CLOUD.url, window.SONG_CLOUD.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    const { data } = await this.client.auth.getSession();
    this.user = data.session?.user ?? null;
    this.client.auth.onAuthStateChange((event, session) => {
      const next = session?.user ?? null;
      if (next?.id !== this.user?.id) { this.user = next; onAuth(event); }
    });
  },
  async signIn(email) {
    const { error } = await this.client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true } });
    if (error) throw error;
  },
  // sign out, unless there are changes that have not reached the database
  async signOut() {
    if (this.dirty()) { await this.flush(); if (this.dirty()) return false; }
    await this.client.auth.signOut();
    this.synced = new Map();
    storeSet(PENDING_KEY, null);
    return true;
  },
  dirty: () => !!storeGet(PENDING_KEY, null),
  _check({ data, error }) { if (error) throw error; return data; },

  // ---- reading ----
  async _all(make) {   // the API returns 1000 rows at most per request, so page through
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await make().range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) return out;
    }
  },
  async myProfile() {
    const rows = await this._withNames(await this._all(() => this.client.from("profiles").select(PROFILE_COLS).eq("id", this.user.id).order("id")));
    return rows[0] ? fromProfileRow(rows[0]) : null;
  },
  async _withNames(rows) {
    if (!rows.length) return rows;
    const names = await this._all(() => this.client.from("profile_names").select("id,first_name,last_name").in("id", rows.map(r => r.id)).order("id"));
    return rows.map(r => ({ ...r, ...(names.find(n => n.id === r.id) ?? {}) }));
  },
  // not an upsert: the database lets nobody read real names from the profiles table, and an upsert needs to read the columns it replaces
  async saveProfile(p) {
    const row = toProfileRow({ ...p, id: this.user.id });
    const exists = this._check(await this.client.from("profiles").select("id").eq("id", this.user.id)).length > 0;
    if (exists) { const { id, ...changes } = row; this._check(await this.client.from("profiles").update(changes).eq("id", this.user.id)); }
    else this._check(await this.client.from("profiles").insert(row));
  },
  // a profile picture is a 256-pixel JPEG kept at avatars/<account id>/avatar.jpg; avatarAt busts the browser's cache when it changes
  avatarUrl(p) { return p?.avatarAt ? `${window.SONG_CLOUD.url}/storage/v1/object/public/avatars/${p.id}/avatar.jpg?v=${Date.parse(p.avatarAt) || 0}` : ""; },
  async setAvatar(blob) {
    const path = `${this.user.id}/avatar.jpg`;
    this._check(await this.client.storage.from("avatars").upload(path, blob, { upsert: true, contentType: "image/jpeg", cacheControl: "3600" }));
    const at = new Date().toISOString();
    this._check(await this.client.from("profiles").update({ avatar_updated_at: at }).eq("id", this.user.id));
    return at;
  },
  async removeAvatar() {
    this._check(await this.client.storage.from("avatars").remove([`${this.user.id}/avatar.jpg`]));
    this._check(await this.client.from("profiles").update({ avatar_updated_at: null }).eq("id", this.user.id));
  },
  // a person's record: games, wins, tournaments entered and won... (the player_stats view in schema.sql)
  async stats(pid) {
    const rows = await this._all(() => this.client.from("player_stats").select("*").eq("profile_id", pid).order("profile_id"));
    return rows[0] ?? null;
  },
  // a person's rating (overall and per faction), leaderboard position and rating history after each rated tournament
  async ratings(pid) {
    const [rows, ranks, hist] = await Promise.all([
      this._all(() => this.client.from("player_ratings").select("*").eq("profile_id", pid).order("scope")),
      this._all(() => this.client.from("rating_ranks").select("*").eq("profile_id", pid).order("scope")),
      this._all(() => this.client.from("rating_history").select("*").eq("profile_id", pid).order("scope").order("tournament_id")),
    ]);
    // the history in date order, with the tournament's name and date (every scope: overall and each faction)
    const ids = [...new Set(hist.map(h => h.tournament_id))];
    const ts = ids.length ? await this._all(() => this.client.from("tournaments").select("id,name,date").in("id", ids).order("id")) : [];
    const info = new Map(ts.map(x => [x.id, x]));
    const history = hist.map(h => ({ ...h, name: info.get(h.tournament_id)?.name ?? "", date: info.get(h.tournament_id)?.date ?? "" }))
      .sort((x, y) => (x.date || "").localeCompare(y.date || "") || x.name.localeCompare(y.name));
    return { rows, ranks, history };
  },
  // players whose nickname contains the text (public details only)
  async searchPlayers(q) {
    const s = String(q ?? "").trim().replace(/[%_,()\\*]/g, " ").slice(0, 40);
    if (s.length < 2) return [];
    return (await this._all(() => this.client.from("profiles").select(PROFILE_COLS).ilike("nickname", `%${s}%`).order("nickname").order("id"))).slice(0, 20).map(fromProfileRow);
  },
  // everyone ranked in a scope ('overall' or a faction id), best first
  async rankings(scope) {
    return this._all(() => this.client.from("ranking_board").select("*").eq("scope", scope).order("rating", { ascending: false }).order("profile_id"));
  },
  // every game a person has played that the viewer may see (the player_games view); list codes are NOT included here
  async gamesOf(pid) { return this._all(() => this.client.from("player_games").select("*").eq("profile_id", pid).order("game_id")); },
  // the list a player entered in a tournament, if the viewer is allowed to see it (database rules decide, not the page)
  async entryList(tid, pid) {
    const rows = this._check(await this.client.from("entry_lists").select("list_code").eq("tournament_id", tid).eq("profile_id", pid));
    return rows?.[0]?.list_code ?? null;
  },

  // ---- private saved-list library (the Building page's "Saved lists") ----
  async savedLists() { return (await this._all(() => this.client.from("saved_lists").select("name,list_code,updated_at").order("name"))).map(fromSavedRow); },
  async putSavedList(e) { this._check(await this.client.from("saved_lists").upsert(toSavedRow(this.user.id, e), { onConflict: "owner,name" })); },
  async deleteSavedList(name) { this._check(await this.client.from("saved_lists").delete().eq("owner", this.user.id).eq("name", name)); },
  async profiles(ids) {
    if (!ids.length) return [];
    return (await this._withNames(await this._all(() => this.client.from("profiles").select(PROFILE_COLS).in("id", ids).order("id")))).map(fromProfileRow);
  },
  // the short form of a tournament row, plus how many approved players it has
  async _summaries(rows) {
    const ids = rows.map(r => r.id);
    const regs = ids.length ? await this._all(() => this.client.from("registrations").select("tournament_id,profile_id").eq("status", "approved").in("tournament_id", ids).order("tournament_id")) : [];
    return rows.map(r => ({
      id: r.id, owner: r.owner, name: r.name, date: r.date ?? "", location: r.location, points: r.points, status: r.status,
      registrationOpen: r.registration_open, maxPlayers: r.max_players, listsLocked: r.lists_locked, plannedRounds: r.planned_rounds, format: r.format, teamSize: r.team_size,
      players: regs.filter(g => g.tournament_id === r.id).length,
    }));
  },
  // listed tournaments, newest first. q searches name and place.
  async directory({ q = "", openOnly = false } = {}) {
    let query = this.client.from("tournaments").select("*").order("date", { ascending: false, nullsFirst: false }).limit(100);
    const s = q.replace(/[%,()*\\]/g, " ").trim();
    if (s) query = query.or(`name.ilike.%${s}%,location.ilike.%${s}%`);
    if (openOnly) query = query.eq("registration_open", true).eq("lists_locked", false);
    return this._summaries(this._check(await query));
  },
  // tournaments I organise, and ones I have asked to join or joined
  async mine() {
    const me = this.user.id;
    const owned = await this._all(() => this.client.from("tournaments").select("*").eq("owner", me).order("id"));
    const regs = await this._all(() => this.client.from("registrations").select("tournament_id,status").eq("profile_id", me).order("tournament_id"));
    const otherIds = regs.map(r => r.tournament_id).filter(id => !owned.some(t => t.id === id));
    const joinedRows = otherIds.length ? await this._all(() => this.client.from("tournaments").select("*").in("id", otherIds).order("id")) : [];
    const sort = a => a.sort((x, y) => (y.date || "").localeCompare(x.date || ""));
    return {
      owned: sort(await this._summaries(owned)),
      joined: sort((await this._summaries(joinedRows)).map(s => ({ ...s, myStatus: regs.find(r => r.tournament_id === s.id)?.status }))),
      registered: regs,
    };
  },
  // one tournament with everything this viewer may see, and the profiles of the people in it
  async load(id) {
    const trs = await this._all(() => this.client.from("tournaments").select("*").eq("id", id).order("id"));
    if (!trs.length) return null;
    const [regs, lists, rounds, games, teams, matches] = await Promise.all([
      this._all(() => this.client.from("registrations").select("*").eq("tournament_id", id).order("profile_id")),
      this._all(() => this.client.from("entry_lists").select("*").eq("tournament_id", id).order("profile_id")),
      this._all(() => this.client.from("rounds").select("*").eq("tournament_id", id).order("id")),
      this._all(() => this.client.from("games").select("*").eq("tournament_id", id).order("id")),
      this._all(() => this.client.from("teams").select("*").eq("tournament_id", id).order("id")),
      this._all(() => this.client.from("matches").select("*").eq("tournament_id", id).order("id")),
    ]);
    const t = fromRows(trs[0], regs, lists, rounds, games, teams, matches);
    const people = await this.profiles([...new Set([t.owner, ...regs.map(r => r.profile_id), ...teams.map(x => x.captain)])]);
    return { t, people };
  },
  // call `onChange` (after a short pause) whenever anything in this tournament changes; returns a function that stops listening
  watch(id, onChange) {
    let timer = null;
    const fire = () => { clearTimeout(timer); timer = setTimeout(onChange, 600); };
    const ch = this.client.channel(`tournament-${id}-${Math.random().toString(36).slice(2, 7)}`);
    for (const [table, filter] of [["games", `tournament_id=eq.${id}`], ["rounds", `tournament_id=eq.${id}`], ["registrations", `tournament_id=eq.${id}`],
      ["entry_lists", `tournament_id=eq.${id}`], ["teams", `tournament_id=eq.${id}`], ["matches", `tournament_id=eq.${id}`], ["tournaments", `id=eq.${id}`]])
      ch.on("postgres_changes", { event: "*", schema: "public", table, filter }, fire);
    ch.subscribe();
    return () => { clearTimeout(timer); this.client.removeChannel(ch); };
  },

  // ---- players: direct calls ----
  async requestJoin(tid) { this._check(await this.client.from("registrations").insert({ tournament_id: tid, profile_id: this.user.id })); },
  // team events: the captain creates the team and enters it; teammates ask to join it and the captain accepts them
  async createTeam(tid, name) {
    const id = newId();
    this._check(await this.client.from("teams").insert({ id, tournament_id: tid, name, captain: this.user.id }));
    this._check(await this.client.from("registrations").insert({ tournament_id: tid, profile_id: this.user.id, team_id: id }));
    return id;
  },
  async requestJoinTeam(tid, teamId) { this._check(await this.client.from("registrations").insert({ tournament_id: tid, profile_id: this.user.id, team_id: teamId })); },
  // organiser: find somebody to bring in, and put them in place of a player who dropped out
  async findProfiles(tid, q) { return (this._check(await this.client.rpc("find_profiles", { tid, q })) ?? []).map(fromProfileRow); },
  async substitute(tid, oldPid, newPid) { this._check(await this.client.rpc("substitute_player", { tid, old_pid: oldPid, new_pid: newPid })); },
  async acceptMember(tid, pid) { this._check(await this.client.from("registrations").update({ team_ok: true }).eq("tournament_id", tid).eq("profile_id", pid)); },
  async renameTeam(teamId, name) { this._check(await this.client.from("teams").update({ name }).eq("id", teamId)); },
  async disbandTeam(teamId) { this._check(await this.client.from("teams").delete().eq("id", teamId)); },
  async withdraw(tid) { this._check(await this.client.from("registrations").delete().eq("tournament_id", tid).eq("profile_id", this.user.id)); },
  // meta = { faction, commander, points } of the list, kept with the entry so faction records can be worked out
  async setList(tid, pid, code, meta = {}) { this._check(await this.client.from("entry_lists").upsert(toEntryRow(tid, pid, code, meta), { onConflict: "tournament_id,profile_id" })); },
  // the organiser re-checks each entry's faction/commander/points against its list code when locking, so they cannot disagree
  async syncEntryMeta(tid, entries) {
    for (const e of entries) this._check(await this.client.from("entry_lists").update({ faction: e.faction || null, commander: e.commander || null, points: Number.isFinite(e.points) ? e.points : null }).eq("tournament_id", tid).eq("profile_id", e.pid));
  },
  async clearList(tid, pid) { this._check(await this.client.from("entry_lists").delete().eq("tournament_id", tid).eq("profile_id", pid)); },
  // send a player's report of a game a moment after the last change
  reportGame(g) {
    if (!g.gid) return;
    this._reports.set(g.gid, toReportRow(g));
    this._setStatus("saving");
    clearTimeout(this._reportTimer);
    this._reportTimer = setTimeout(() => this._sendReports(), 700);
  },
  async _sendReports() {
    try {
      for (const [gid, row] of [...this._reports]) { this._check(await this.client.from("games").update(row).eq("id", gid)); this._reports.delete(gid); }
      this._setStatus("saved");
    } catch (err) {
      console.error("Report failed:", err);
      this._setStatus("offline");
      this._reportTimer = setTimeout(() => this._sendReports(), 15000);
    }
  },

  // ---- organiser: final results ----
  // saved when a tournament is finished (so wins and podiums can be counted), removed if it is reopened
  async saveResults(t, st) {
    const rows = toResultRows(t, st);
    if (rows.length) this._check(await this.client.from("tournament_results").upsert(rows, { onConflict: "tournament_id,profile_id" }));
  },
  // ratings are rebuilt on the server from every rated tournament, so this is safe to call at any time
  async recomputeRatings() { this._check(await this.client.rpc("recompute_ratings")); },
  async clearResults(tid) { this._check(await this.client.from("tournament_results").delete().eq("tournament_id", tid)); },

  // ---- organiser: direct calls ----
  async createTournament(t) { this._check(await this.client.from("tournaments").insert(toTournamentRow(t))); this.synced = snapshotOf(t); },
  async deleteTournament(id) { this._check(await this.client.from("tournaments").delete().eq("id", id)); },
  async setRegistration(tid, pid, patch) { this._check(await this.client.from("registrations").update(patch).eq("tournament_id", tid).eq("profile_id", pid)); },
  async removeRegistration(tid, pid) { this._check(await this.client.from("registrations").delete().eq("tournament_id", tid).eq("profile_id", pid)); },

  // ---- organiser: edits to the open tournament ----
  // `loaded` marks the copy just read from the database as the baseline for what has changed
  baseline(t) { this.synced = snapshotOf(t); },
  schedule(t) {
    this._latest = t;
    storeSet(PENDING_KEY, { t });
    this._setStatus("saving");
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 700);
  },
  async flush() {
    clearTimeout(this._timer); clearTimeout(this._retry);
    if (this._busy) { this._again = true; return; }
    this._busy = true;
    try {
      const t = this._latest;
      if (t) await this._push(t);
      if (this._again) { this._again = false; this._busy = false; return this.flush(); }
      storeSet(PENDING_KEY, null);
      this._setStatus("saved");
    } catch (err) {
      console.error("Upload failed:", err);
      this._setStatus("offline");
      this._retry = setTimeout(() => this.flush(), 15000);
    } finally { this._busy = false; }
  },
  _setStatus(s) { this.status = s; this.onStatus(); },

  // send what changed since `synced`. Every call is an upsert or a delete, so repeating after a failure is safe.
  async _push(t) {
    const c = this.client, cur = snapshotOf(t), old = this.synced;
    const changed = k => cur.get(k) !== old.get(k);
    const check = ({ error }) => { if (error) throw error; };
    if (changed(`t:${t.id}`)) check(await c.from("tournaments").upsert(toTournamentRow(t), { onConflict: "id" }));
    for (const r of t.rounds) {
      const matchesChanged = changed(`m:${t.id}:${r.n}`);
      const gamesChanged = r.tables.some(g => changed(`g:${t.id}:${r.n}:${g.id}`));
      const goneGames = [...old.keys()].some(k => k.startsWith(`g:${t.id}:${r.n}:`) && !cur.has(k));
      if (!changed(`r:${t.id}:${r.n}`) && !gamesChanged && !goneGames && !matchesChanged && r.rid) continue;
      const { data, error } = await c.from("rounds").upsert(toRoundRow(t, r), { onConflict: "tournament_id,n" }).select("id").single();
      if (error) throw error;
      r.rid = data.id;
      if (r.matches?.length) check(await c.from("matches").upsert(r.matches.map(m => toMatchRow(t, r, m)), { onConflict: "id" }));   // before the games that point at them
      const rows = r.tables.filter(g => changed(`g:${t.id}:${r.n}:${g.id}`)).map(g => toGameRow(t, r, g, r.rid));
      if (rows.length) check(await c.from("games").upsert(rows, { onConflict: "round_id,table_no" }));
      if (goneGames || rows.length) {   // drop games that are no longer in the round (a redraw can have fewer tables)
        const del = c.from("games").delete().eq("round_id", r.rid);
        check(await (r.tables.length ? del.not("table_no", "in", `(${r.tables.map(g => g.id).join(",")})`) : del));
      }
      if (matchesChanged) {   // matches of an earlier draw of this round
        const keepIds = (r.matches ?? []).map(m => m.mid), before = old.get(`m:${t.id}:${r.n}`);
        if (keepIds.length || (before && before !== "[]")) {
          const dm = c.from("matches").delete().eq("round_id", r.rid);
          check(await (keepIds.length ? dm.not("id", "in", `(${keepIds.join(",")})`) : dm));
        }
      }
    }
    const keep = new Set(t.rounds.map(r => r.n));
    const goneR = [...old.keys()].filter(k => k.startsWith(`r:${t.id}:`)).map(k => +k.split(":")[2]).filter(n => !keep.has(n));
    if (goneR.length) check(await c.from("rounds").delete().eq("tournament_id", t.id).in("n", goneR));
    this.synced = cur;
    // new games have ids now; learn them so players' reports can be matched, without replacing what is on screen
    if (t.rounds.some(r => r.tables.some(g => !g.gid))) {
      const fresh = await this.load(t.id);
      for (const r of t.rounds) { const fr = fresh?.t.rounds.find(x => x.n === r.n); if (fr) { r.rid = fr.rid; for (const g of r.tables) g.gid = fr.tables.find(x => x.id === g.id)?.gid ?? g.gid; } }
    }
  },
};

if (typeof module !== "undefined") module.exports = { cloud };
