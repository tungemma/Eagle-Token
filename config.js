/* ================================================================
   Eagle Token — config.js
   Loads Supabase configuration asynchronously.
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

    if (
      !parsed ||
      typeof parsed.supabase_url !== "string" ||
      !parsed.supabase_url.trim()
    ) {
      throw new Error("Missing valid supabase_url");
    }

    if (
      typeof parsed.supabase_anon_key !== "string" ||
      !parsed.supabase_anon_key.trim()
    ) {
      throw new Error("Missing valid supabase_anon_key");
    }

    const supabaseUrl = parsed.supabase_url.trim().replace(/\/+$/, "");

    if (!/^https:\/\/.+\.supabase\.co$/.test(supabaseUrl)) {
      throw new Error("Invalid Supabase project URL");
    }

    window.__EAGLE_CONFIG__ = {
      supabase_url: supabaseUrl,
      supabase_anon_key: parsed.supabase_anon_key.trim(),
    };

    return window.__EAGLE_CONFIG__;

  } catch (err) {
    console.error(
      "[eagle] FATAL: Supabase configuration failed:",
      err.message
    );
    throw err;

  } finally {
    clearTimeout(timer);
  }
})();