
/* ================================================================
   Eagle Mining — shared.js
   Supabase client initialization and shared application helpers.

   Load order:
   1. Supabase JS SDK
   2. config.js
   3. shared.js
   4. app.js / admin.js

   All pages must await window.EagleReady before using Eagle.
   ================================================================ */

(function () {
  "use strict";

  window.EagleReady = (async function init() {

    // ------------------------------------------------------------
    // 1. Wait for configuration
    // ------------------------------------------------------------

    const configPromise = window.__EAGLE_CONFIG_READY__;

    if (!configPromise) {
      throw new Error(
        "[eagle] config.js did not expose __EAGLE_CONFIG_READY__."
      );
    }

    let cfg;

    try {
      cfg = await configPromise;
    } catch (error) {
      console.error("[eagle] Configuration loading failed:", error);
      throw new Error("Unable to load Eagle Mining configuration.");
    }

    if (!cfg?.supabase_url || !cfg?.supabase_anon_key) {
      throw new Error(
        "[eagle] Missing Supabase URL or Publishable key."
      );
    }

    // ------------------------------------------------------------
    // 2. Verify Supabase SDK
    // ------------------------------------------------------------

    if (
      !window.supabase ||
      typeof window.supabase.createClient !== "function"
    ) {
      throw new Error(
        "[eagle] Supabase JavaScript SDK is not loaded."
      );
    }

  const SUPABASE_URL = cfg.supabase_url.replace(/\/+$/, "");

    // ------------------------------------------------------------
    // 3. Create the single Supabase client
    // ------------------------------------------------------------

    const supabase = window.supabase.createClient(
      SUPABASE_URL,
      cfg.supabase_anon_key,
      {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
          flowType: "pkce"
        }
      }
    );

    // ------------------------------------------------------------
    // 4. Authentication helpers
    // ------------------------------------------------------------

    async function getCurrentUser() {
      const { data, error } = await supabase.auth.getUser();

      if (error) throw error;

      return data.user;
    }

    async function getSession() {
      const { data, error } = await supabase.auth.getSession();

      if (error) throw error;

      return data.session;
    }

    async function requireUser() {
      const user = await getCurrentUser();

      if (!user) {
        throw new Error("Authentication required.");
      }

      return user;
    }

    async function signOut() {
      const { error } = await supabase.auth.signOut();

      if (error) throw error;

      return true;
    }

    function onAuthStateChange(callback) {
      const { data } = supabase.auth.onAuthStateChange(
        (event, session) => {
          callback(event, session);
        }
      );

      return data.subscription;
    }

    // ------------------------------------------------------------
    // 5. Database RPC helper
    // ------------------------------------------------------------

    async function rpc(functionName, params = {}) {
      const { data, error } = await supabase.rpc(
        functionName,
        params
      );

      if (error) {
        console.error(
          `[eagle] RPC ${functionName} failed:`,
          error
        );

        throw error;
      }

      return data;
    }

    // ------------------------------------------------------------
    // 6. Edge Function helper
    // ------------------------------------------------------------

    async function invokeFunction(functionName, body = {}) {
      const { data, error } = await supabase.functions.invoke(
        functionName,
        { body }
      );

      if (error) {
        console.error(
          `[eagle] Edge Function ${functionName} failed:`,
          error
        );

        throw error;
      }

      return data;
    }

    // ------------------------------------------------------------
    // 7. Standardized error helper
    // ------------------------------------------------------------

    function handleError(error, fallback = "Something went wrong.") {
      console.error("[eagle]", error);

      return (
        error?.message ||
        error?.error_description ||
        fallback
      );
    }

    // ------------------------------------------------------------
    // 8. Expose shared Eagle interface
    // ------------------------------------------------------------

    const Eagle = {
      SUPABASE_URL,
      supabase,

      // Authentication
      auth: supabase.auth,
      getCurrentUser,
      getSession,
      requireUser,
      signOut,
      onAuthStateChange,

      // Database
      db: supabase,
      rpc,

      // Server functions
      functions: supabase.functions,
      invokeFunction,

      // Error handling
      handleError
    };

    window.Eagle = Eagle;

    console.info("[eagle] Supabase client initialized successfully.");

    return Eagle;

  })();

})();
