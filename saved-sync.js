// Keeps the Building page's "Saved lists" on the person's account (a private library only they can read), so the lists follow them
// between devices. Nothing changes for someone who is not signed in: saved lists stay in this browser as before.
// Sign in on the Tournament page; this page then picks the session up. Conflicts are settled by name, newest save wins.
// Deleting a list here also deletes it from the account; a deletion that could not be sent is remembered and sent next time.

const DELETED_KEY = "song-tool-saved-deleted";

const savedSync = {
  note: "",
  active: false,
  signedIn: false,   // signed in AND has a profile: the Save, Load and Share link tools are available
  _say(text) { this.note = text; if (typeof render === "function" && list) render(); },
  async start() {
    if (!window.SONG_CLOUD?.url || !window.supabase?.createClient || typeof cloud === "undefined") return;
    try { await cloud.init(() => this.sync()); } catch { return; }
    this.active = true;
    if (cloud.user) {
      // everyone signed in must have a profile before using the tools
      let profile = null;
      try { profile = await cloud.myProfile(); } catch { /* treat as unknown below */ }
      if (!profile) { location.replace("tournament.html?profile=me"); return; }
      this.signedIn = true;
      await this.sync();
    }
    else this._say("Signed out: saved lists stay in this browser. Sign in on the Tournament page to keep them on your account.");
  },
  async sync() {
    if (!cloud.user) { this._say("Signed out: saved lists stay in this browser. Sign in on the Tournament page to keep them on your account."); return; }
    try {
      // deletions made earlier that never reached the account
      const gone = new Set(storeGet(DELETED_KEY, []));
      for (const name of [...gone]) { await cloud.deleteSavedList(name); gone.delete(name); storeSet(DELETED_KEY, [...gone]); }
      const remote = await cloud.savedLists(), local = storeGet(STORE_SAVED, []);
      const byName = new Map(local.map(e => [e.name, e]));
      let pulled = 0, pushed = 0;
      for (const r of remote) {
        const mine = byName.get(r.name);
        if (!mine || Date.parse(r.saved) > Date.parse(mine.saved || 0)) {
          const l = decodeList(r.code);
          if (l) { byName.set(r.name, { name: r.name, saved: r.saved, list: l }); pulled++; }
        }
      }
      const remoteByName = new Map(remote.map(r => [r.name, r]));
      for (const e of byName.values()) {
        const r = remoteByName.get(e.name);
        if (!r || Date.parse(e.saved) > Date.parse(r.saved)) { await this._put(e); pushed++; }
      }
      const merged = [...byName.values()].sort((a, b) => Date.parse(b.saved) - Date.parse(a.saved));
      storeSet(STORE_SAVED, merged);
      this._say(`Saved lists are kept on your account (${merged.length}).${pulled ? ` ${pulled} brought in from your account.` : ""}${pushed ? ` ${pushed} sent to it.` : ""}`);
    } catch (err) { this._say(`Could not sync saved lists with your account (${err?.message ?? err}). They are still saved in this browser.`); }
  },
  _put(e) {
    const l = e.list;
    return cloud.putSavedList({ name: e.name, code: encodeList(l), faction: l.faction, points: totalPoints(l), saved: e.saved });
  },
  async push(entry) {
    if (!this.active || !cloud.user) return;
    storeSet(DELETED_KEY, storeGet(DELETED_KEY, []).filter(n => n !== entry.name));
    try { await this._put(entry); this._say("Saved to your account."); }
    catch (err) { this._say(`Saved in this browser, but not yet on your account (${err?.message ?? err}). It will be sent next time.`); }
  },
  async remove(name) {
    if (!this.active || !cloud.user) return;
    storeSet(DELETED_KEY, [...new Set([...storeGet(DELETED_KEY, []), name])]);
    try { await cloud.deleteSavedList(name); storeSet(DELETED_KEY, storeGet(DELETED_KEY, []).filter(n => n !== name)); this._say("Deleted from your account too."); }
    catch (err) { this._say(`Deleted here, but not yet from your account (${err?.message ?? err}). It will be retried next time.`); }
  },
};
window.savedSync = savedSync;   // started by app.js once the builder has loaded
