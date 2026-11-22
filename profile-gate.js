// Loaded by pages that have no cloud features of their own (the Analysis page): anyone signed in without a profile is sent to create
// one first, because the profile must be set up before using any of the tools. Signed-out visitors are not affected.
(async () => {
  if (!window.SONG_CLOUD?.url || !window.supabase?.createClient || typeof cloud === "undefined") return;
  try {
    await cloud.init(() => {});
    if (cloud.user && !(await cloud.myProfile())) location.replace("tournament.html?profile=me");
  } catch { /* offline or not configured: leave the page usable */ }
})();
