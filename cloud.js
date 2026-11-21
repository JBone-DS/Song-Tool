// Cloud storage for the tournament page, using Supabase (a hosted Postgres database). See schema.sql for the tables.
//
// How it works:
//  - Organisers sign in with an email link. They read and write their own profiles and tournaments.
//  - The page keeps working on one in-memory `db` object (see tournament.js). After every change, `cloud.schedule` sends
//    only the records that changed (compared with `synced`, the last copy the database is known to have) a moment later.
//  - A copy is also kept in this browser (localStorage), and a "dirty" flag marks changes not yet uploaded, so a dropped
//    signal at a venue loses nothing: the changes upload when the connection returns.
//  - Anyone can open a tournament read-only with ?view=<tournament id> (no account) and it updates live.
// The mapping between `db` and database rows is in cloud-core.js.

const DIRTY_KEY = "song-tool-tournaments-dirty";
const LEGACY_KEY = "song-tool-tournaments-legacy";   // the browser-only data from before the database, kept until it is uploaded

const cloud = {
  enabled: !!window.SONG_CLOUD?.url,
  client: null, user: null, synced: new Map(),
  status: "idle",            // idle | saving | saved | offline
  onStatus: () => {},        // set by the page
  _timer: null, _retry: null, _busy: false, _again: false, _latest: null,

  // ---- connection and sign-in ----
  async init(onAuth) {
    if (!window.supabase?.createClient) throw new Error("The sign-in service could not be loaded. Check your connection and reload.");
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
    storeSet(STORE_TOURNEY, null); storeSet(DIRTY_KEY, null);
    return true;
  },
  dirty: () => !!storeGet(DIRTY_KEY, null),

  // ---- reading ----
  async _all(make) {   // the API returns 1000 rows at most per request, so page through
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await make().order("id").range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) return out;
    }
  },
  async _tournamentsFrom(trs, profileRows) {
    const ids = trs.map(t => t.id);
    const [players, rounds, games] = ids.length ? await Promise.all([
      this._all(() => this.client.from("tournament_players").select("*").in("tournament_id", ids)),
      this._all(() => this.client.from("rounds").select("*").in("tournament_id", ids)),
      this._all(() => this.client.from("games").select("*").in("tournament_id", ids)),
    ]) : [[], [], []];
    return { profiles: profileRows.map(fromProfileRow), tournaments: trs.map(t => fromRows(t, players, rounds, games)) };
  },
  // everything this signed-in organiser owns
  async pull() {
    const owner = this.user.id;
    const [profiles, trs] = await Promise.all([
      this._all(() => this.client.from("profiles").select("*").eq("owner", owner)),
      this._all(() => this.client.from("tournaments").select("*").eq("owner", owner)),
    ]);
    const db = { version: 1, ...(await this._tournamentsFrom(trs, profiles)) };
    this.synced = snapshotOf(db);
    return db;
  },
  // one public tournament and the profiles in it, for the read-only page
  async pullPublic(id) {
    const trs = await this._all(() => this.client.from("tournaments").select("*").eq("id", id));
    if (!trs.length) return null;
    const players = await this._all(() => this.client.from("tournament_players").select("profile_id").eq("tournament_id", id));
    const profiles = players.length ? await this._all(() => this.client.from("profiles").select("*").in("id", players.map(p => p.profile_id))) : [];
    return this._tournamentsFrom(trs, profiles);
  },
  // call `onChange` (after a short pause) whenever anything in this tournament changes
  watch(id, onChange) {
    let t = null;
    const fire = () => { clearTimeout(t); t = setTimeout(onChange, 600); };
    const ch = this.client.channel(`tournament-${id}`);
    for (const [table, filter] of [["games", `tournament_id=eq.${id}`], ["rounds", `tournament_id=eq.${id}`], ["tournament_players", `tournament_id=eq.${id}`], ["tournaments", `id=eq.${id}`]])
      ch.on("postgres_changes", { event: "*", schema: "public", table, filter }, fire);
    ch.subscribe();
  },

  // ---- writing ----
  schedule(db) {
    this._latest = db;
    storeSet(DIRTY_KEY, 1);
    this._setStatus("saving");
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 700);
  },
  async flush() {
    clearTimeout(this._timer); clearTimeout(this._retry);
    if (this._busy) { this._again = true; return; }
    this._busy = true;
    try {
      const db = this._latest;
      if (db) await this._push(db);
      if (this._again) { this._again = false; this._busy = false; return this.flush(); }
      storeSet(DIRTY_KEY, null);
      this._setStatus("saved");
    } catch (err) {
      console.error("Upload failed:", err);
      this._setStatus("offline");
      this._retry = setTimeout(() => this.flush(), 15000);
    } finally { this._busy = false; }
  },
  _setStatus(s) { this.status = s; this.onStatus(); },

  // send what changed since `synced`. Every call is an upsert or a delete, so repeating after a failure is safe.
  async _push(db) {
    const c = this.client, cur = snapshotOf(db), old = this.synced;
    const changed = k => cur.get(k) !== old.get(k);
    const check = ({ error }) => { if (error) throw error; };
    const ids = (prefix, snap) => [...snap.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));

    // removed tournaments first (their players, rounds and games go with them), then removed profiles
    const goneT = ids("t:", old).filter(id => !cur.has(`t:${id}`));
    if (goneT.length) check(await c.from("tournaments").delete().in("id", goneT));
    const goneP = ids("p:", old).filter(id => !cur.has(`p:${id}`));
    if (goneP.length) check(await c.from("profiles").delete().in("id", goneP));

    const profiles = db.profiles.filter(p => changed(`p:${p.id}`));
    if (profiles.length) check(await c.from("profiles").upsert(profiles.map(toProfileRow), { onConflict: "id" }));

    for (const t of db.tournaments) {
      if (changed(`t:${t.id}`)) check(await c.from("tournaments").upsert(toTournamentRow(t), { onConflict: "id" }));
      if (changed(`tp:${t.id}`)) {
        const rows = toPlayerRows(t);
        if (rows.length) check(await c.from("tournament_players").upsert(rows, { onConflict: "tournament_id,profile_id" }));
        const del = c.from("tournament_players").delete().eq("tournament_id", t.id);
        check(await (rows.length ? del.not("profile_id", "in", `(${rows.map(r => r.profile_id).join(",")})`) : del));
      }
      for (const r of t.rounds) {
        if (!changed(`r:${t.id}:${r.n}`)) continue;
        const { data, error } = await c.from("rounds").upsert(toRoundRow(t, r), { onConflict: "tournament_id,n" }).select("id").single();
        if (error) throw error;
        const rows = toGameRows(t, r, data.id);
        if (rows.length) check(await c.from("games").upsert(rows, { onConflict: "round_id,table_no" }));
        const del = c.from("games").delete().eq("round_id", data.id);
        check(await (rows.length ? del.not("table_no", "in", `(${rows.map(g => g.table_no).join(",")})`) : del));
      }
      const keep = new Set(t.rounds.map(r => r.n));
      const goneR = ids(`r:${t.id}:`, old).map(Number).filter(n => !keep.has(n));
      if (goneR.length) check(await c.from("rounds").delete().eq("tournament_id", t.id).in("n", goneR));
    }
    this.synced = cur;
  },
};

if (typeof module !== "undefined") module.exports = { cloud };
