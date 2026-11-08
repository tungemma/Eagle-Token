/* ================================================================
   Eagle Token — config.js
   Loaded before shared.js. Fetches /config.json and exposes it as
   window.__EAGLE_CONFIG__. Also exposes window.__EAGLE_CONFIG_READY__,
   a promise that resolves once the config is loaded (or rejects on
   failure). shared.js awaits it before constructing PocketBase.

   The old sync-XHR approach blocked the main thread and is deprecated
   in every modern browser. The async version costs nothing extra
   because shared.js already needed to run before app.js.
   ================================================================ */

window.__EAGLE_CONFIG__ = null;

window.__EAGLE_CONFIG_READY__ = (async function loadConfig() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch("/config.json", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error("config.json returned HTTP " + res.status);
    }
    const parsed = await res.json();
    if (!parsed || typeof parsed.pb_url !== "string" || !parsed.pb_url.trim()) {
      throw new Error("config.json is missing a valid 'pb_url' field");
    }
    window.__EAGLE_CONFIG__ = { pb_url: parsed.pb_url.trim() };
    return window.__EAGLE_CONFIG__;
  } catch (err) {
    console.error("[eagle] FATAL: config.json could not be loaded:", err && err.message);
    console.error("[eagle] The app will not start. Fix /config.json and reload.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
})();