/* ================================================================
   Eagle Token — shared.js
   Loaded after /config.js and the PocketBase SDK.

   Because config.js is now async, shared.js exposes its own ready
   promise (window.EagleReady) that app.js / admin.js / verify.html
   must await before touching window.Eagle.
   ================================================================ */

(function () {
  "use strict";

  window.EagleReady = (async function init() {
    const cfgPromise = window.__EAGLE_CONFIG_READY__;
    if (!cfgPromise) {
      throw new Error(
        "[eagle] shared.js: config.js did not run or did not expose __EAGLE_CONFIG_READY__."
      );
    }

    let cfg;
    try {
      cfg = await cfgPromise;
    } catch (_) {
      throw new Error(
        "[eagle] shared.js: config.json failed to load. See earlier console errors."
      );
    }

    if (!cfg || !cfg.pb_url) {
      throw new Error(
        "[eagle] shared.js: __EAGLE_CONFIG__.pb_url is missing."
      );
    }

     const PB_URL = cfg.pb_url||"http://127.0.0.1:3000";

    // Single PocketBase instance for the whole page.
    const pb = new PocketBase(PB_URL);
    pb.autoCancellation(true);

    // ── API helper ─────────────────────────────────────────────
    // Throws on non-2xx with { status, data } attached.
    // opts.signal: optional AbortSignal for cancellation.
    async function api(method, path, body, opts) {
      const options = opts || {};
      const fetchOpts = { method, headers: {}, signal: options.signal };

      if (pb.authStore.isValid && pb.authStore.token) {
        fetchOpts.headers["Authorization"] = pb.authStore.token;
      }
      if (body) {
        fetchOpts.headers["Content-Type"] = "application/json";
        fetchOpts.body = JSON.stringify(body);
      }

      const res = await fetch(`${PB_URL}${path}`, fetchOpts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw Object.assign(
          new Error(data.error || `HTTP ${res.status}`),
          { status: res.status, data }
        );
      }
      return data;
    }

    window.Eagle = { PB_URL, pb, api };
    return window.Eagle;
  })();
})();