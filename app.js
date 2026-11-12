
/* ================================================================
   EAGLE MINING — SUPABASE APP.JS
   Frontend migration from PocketBase to Supabase.
   Supabase JS v2 must load before config.js, shared.js and this file.

   SECURITY:
   - No service_role key in this file.
   - Mining rewards are calculated and credited by Supabase RPCs.
   - Client-side ad timers never grant mining boosts.
   - Task and account-deletion features remain disabled until their
     secure backend functionality is implemented.
================================================================ */

// ── CONFIG & STATE ───────────────────────────────────────────────

let eagle = null;
let pendingVerificationEmail = "";

const SESSION_HOURS = 24;

let currentUser = null;
let miningSession = null;
let uiTicker = null;
let taskRewardsTicker = null;

let socialLinks = {};
let taskRewards = [];

let _txPage = 0;
let _txLoading = false;
let _txAbort = null;
let _txGeneration = 0;
let _miningTickAbort = null;

// ── UI HELPERS ───────────────────────────────────────────────────
function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function escapeAttr(value) {
  return escapeHTML(value);
}
function showScreen(id) {
  ["loadingScreen", "authScreen", "verificationScreen", "mainScreens"].forEach(s => {
    document.getElementById(s)?.classList.toggle("hidden", s !== id);
  });

  const main = id === "mainScreens";
  document.getElementById("nav")?.classList.toggle("hidden", !main);
  document.getElementById("footer")?.classList.toggle("hidden", !main);
}

function showTab(tab) {
  ["home", "mining", "wallet", "partners", "profile"].forEach(s => {
    document.getElementById(s + "Screen")?.classList.toggle("hidden", s !== tab);
  });

  document.querySelectorAll("#nav a").forEach(a => {
    a.classList.toggle("active", a.dataset.screen === tab);
  });
}

function showAlert(containerId, msg, type = "error") {
  const el = document.getElementById(containerId);
  if (!el) return;

  const colors = {
    error: "#ef4444",
    success: "#22c55e",
    info: "var(--accent)"
  };

  const color = colors[type] || colors.error;

  // Use textContent: never insert server/user messages as HTML.
  el.replaceChildren();

  const box = document.createElement("div");
  box.style.cssText = `
    padding:10px 14px;
    border-radius:8px;
    margin-bottom:12px;
    background:rgba(0,0,0,0.3);
    border:1px solid ${color};
    color:${color};
    font-size:13px;
  `;
  box.textContent = String(msg ?? "");
  el.appendChild(box);
}

function clearAlert(id) {
  document.getElementById(id)?.replaceChildren();
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? "";
}

function fmt(n, dec = 4) {
  const value = Number(n || 0);
  return Number.isFinite(value) ? value.toFixed(dec) : (0).toFixed(dec);
}

function fmtDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function fmtDuration(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function escapeAttr(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function getErrorMessage(error, fallback = "Something went wrong.") {
  return error?.message || error?.error_description || fallback;
}

function unwrapRpc(data) {
  if (Array.isArray(data)) return data[0] || {};
  return data || {};
}

// ── SHARED COUNTDOWN ─────────────────────────────────────────────

function startCountdown({ seconds, onTick, onDone }) {
  let remaining = seconds;
  let timer = null;
  let done = false;

  const fire = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    onDone?.();
  };

  onTick?.(remaining);

  timer = setInterval(() => {
    if (done) return;
    remaining--;

    if (remaining <= 0) {
      fire();
      return;
    }

    onTick?.(remaining);
  }, 1000);

  return {
    cancel() {
      done = true;
      clearInterval(timer);
    },
    get remaining() {
      return remaining;
    }
  };
}

// ── PWA INSTALL ──────────────────────────────────────────────────

let deferredPrompt = null;

window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById("pwaBanner")?.classList.add("visible");
});

window.installPWA = async () => {
  if (!deferredPrompt) return;

  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;

  if (outcome === "accepted") {
    document.getElementById("pwaBanner")?.classList.remove("visible");
  }

  deferredPrompt = null;
};

// ── PASSWORD STRENGTH ────────────────────────────────────────────

document.getElementById("regPassword")?.addEventListener("input", function () {
  let score = 0;

  if (this.value.length >= 8) score++;
  if (this.value.length >= 12) score++;
  if (/[A-Z]/.test(this.value)) score++;
  if (/[0-9]/.test(this.value)) score++;
  if (/[^A-Za-z0-9]/.test(this.value)) score++;

  const colors = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#16a34a"];
  const labels = ["Too short", "Weak", "Fair", "Good", "Strong"];

  const fill = document.getElementById("pwStrengthFill");
  const hint = document.getElementById("pwHint");

  if (fill) {
    fill.style.width = `${(score / 5) * 100}%`;
    fill.style.background = colors[score - 1] || "#ef4444";
  }

  if (hint) {
    hint.textContent = this.value ? (labels[score - 1] || "Too short") : "";
  }
});

// ── AVATAR PREVIEW ───────────────────────────────────────────────

document.getElementById("regAvatar")?.addEventListener("change", function () {
  const file = this.files?.[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    showAlert("authAlert", "Please select an image file.");
    this.value = "";
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    showAlert("authAlert", "Avatar must be smaller than 2 MB.");
    this.value = "";
    return;
  }

  const reader = new FileReader();

  reader.onload = e => {
    const preview = document.getElementById("regAvatarPreview");
    if (!preview) return;

    preview.replaceChildren();

    const img = document.createElement("img");
    img.src = e.target.result;
    img.alt = "Avatar preview";
    img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:50%;";

    preview.appendChild(img);
  };

  reader.readAsDataURL(file);
});

document.getElementById("regAvatarPreview")?.addEventListener("click", () => {
  document.getElementById("regAvatar")?.click();
});

// ── AUTH TABS ────────────────────────────────────────────────────

document.getElementById("tabLogin")?.addEventListener("click", () => {
  document.getElementById("loginForm")?.classList.remove("hidden");
  document.getElementById("registerForm")?.classList.add("hidden");
  document.getElementById("tabLogin")?.classList.add("active");
  document.getElementById("tabRegister")?.classList.remove("active");
  clearAlert("authAlert");
});

document.getElementById("tabRegister")?.addEventListener("click", () => {
  document.getElementById("registerForm")?.classList.remove("hidden");
  document.getElementById("loginForm")?.classList.add("hidden");
  document.getElementById("tabRegister")?.classList.add("active");
  document.getElementById("tabLogin")?.classList.remove("active");
  clearAlert("authAlert");
});

// ── VALIDATION ───────────────────────────────────────────────────

function validateRegistrationInputs(username, email, password, confirm) {
  if (!username || username.length < 3) {
    return "Username must be at least 3 characters.";
  }

  if (username.length > 30) {
    return "Username must be 30 characters or fewer.";
  }

  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return "Username: letters, numbers and underscores only.";
  }

  if (!email) return "Email is required.";

  if (!password || password.length < 8) {
    return "Password must be at least 8 characters.";
  }

  if (password !== confirm) return "Passwords do not match.";

  return null;
}

// ── REFERRAL CODE STORAGE ────────────────────────────────────────

function getStoredRef() {
  try {
    const raw = sessionStorage.getItem("eagle_ref");
    if (!raw) return "";

    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);

      if (parsed?.code) {
        const age = Date.now() - (parsed.storedAt || 0);
        if (age < 7 * 24 * 3600 * 1000) return parsed.code;
      }

      return "";
    }

    return raw;
  } catch {
    return "";
  }
}

// ── REGISTER ─────────────────────────────────────────────────────

document.getElementById("registerBtn")?.addEventListener("click", async e => {
  e.preventDefault();
  clearAlert("authAlert");

  const username = document.getElementById("regUsername")?.value.trim();
  const email = document.getElementById("regEmail")?.value.trim();
  const password = document.getElementById("regPassword")?.value;
  const confirm = document.getElementById("regConfirmPassword")?.value;
  const refCode = getStoredRef() ||
    new URLSearchParams(window.location.search).get("ref") || "";

  const inputError = validateRegistrationInputs(
    username, email, password, confirm
  );

  if (inputError) {
    showAlert("authAlert", inputError);
    return;
  }

  const btn = document.getElementById("registerBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Loading…";
  }

  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin + "/",
        data: {
          username,
          referral_code: refCode || null
        }
      }
    });

    if (error) throw error;

    pendingVerificationEmail = email;

    if (data.session && data.user?.email_confirmed_at) {
      currentUser = data.user;
      await initMainApp();
      return;
    }

    setText("verifyEmail", email);
    showScreen("verificationScreen");

    showAlert(
      "verifyAlert",
      "Your account was created. Check your email to verify your address.",
      "success"
    );

  } catch (err) {
    showAlert("authAlert", getErrorMessage(err, "Registration failed."));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Create Account";
    }
  }
});

document.getElementById("regConfirmPassword")?.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("registerBtn")?.click();
  }
});

// ── LOGIN ────────────────────────────────────────────────────────

document.getElementById("loginBtn")?.addEventListener("click", async e => {
  e.preventDefault();
  clearAlert("authAlert");

  const email = document.getElementById("loginEmail")?.value.trim();
  const password = document.getElementById("loginPassword")?.value;

  if (!email || !password) {
    showAlert("authAlert", "Email and password are required.");
    return;
  }

  const btn = document.getElementById("loginBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Loading…";
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;

    currentUser = data.user;
    pendingVerificationEmail = email;

    if (!currentUser?.email_confirmed_at) {
      setText("verifyEmail", email);
      showScreen("verificationScreen");
      return;
    }

    await initMainApp();

  } catch (err) {
    showAlert("authAlert", getErrorMessage(err, "Invalid email or password."));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Login";
    }
  }
});

document.getElementById("loginPassword")?.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("loginBtn")?.click();
  }
});

// ── EMAIL VERIFICATION ───────────────────────────────────────────

document.getElementById("sendVerificationBtn")?.addEventListener("click", async e => {
  e.preventDefault();

  const email = pendingVerificationEmail ||
    currentUser?.email ||
    document.getElementById("loginEmail")?.value.trim();

  if (!email) {
    showAlert("verifyAlert", "Enter your email address first.");
    return;
  }

  const btn = document.getElementById("sendVerificationBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Loading…";
  }

  try {
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: window.location.origin + "/"
      }
    });

    if (error) throw error;

    showAlert("verifyAlert", "Verification email sent. Check your inbox.", "success");

  } catch (err) {
    showAlert("verifyAlert", getErrorMessage(err, "Could not send email."));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Resend Email";
    }
  }
});

document.getElementById("checkVerificationBtn")?.addEventListener("click", async e => {
  e.preventDefault();

  const btn = document.getElementById("checkVerificationBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Loading…";
  }

  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;

    if (!data.user) {
      showAlert("verifyAlert", "Please log in after verifying your email.", "info");
      return;
    }

    if (!data.user.email_confirmed_at) {
      showAlert("verifyAlert", "Not verified yet — check your inbox.", "info");
      return;
    }

    currentUser = data.user;
    await initMainApp();

  } catch (err) {
    showAlert("verifyAlert", getErrorMessage(err, "Could not check verification."));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "I've Verified - Continue";
    }
  }
});

document.getElementById("verificationLogoutBtn")?.addEventListener("click", async e => {
  e.preventDefault();

  await supabase.auth.signOut();
  currentUser = null;
  pendingVerificationEmail = "";

  showScreen("authScreen");
});

// ── AUTH SESSION ─────────────────────────────────────────────────

async function getAuthenticatedUser() {
  const { data, error } = await supabase.auth.getUser();

  if (error) throw error;
  if (!data.user) throw new Error("Please log in again.");

  return data.user;
}

// ── MAIN APP INITIALIZATION ──────────────────────────────────────

async function initMainApp() {
  showScreen("mainScreens");
  showTab("home");

  try {
    currentUser = await getAuthenticatedUser();

    await loadUserData();
    await syncMiningSessionFromServer();

    // These features require backend task tables and APIs.
    taskRewards = [];
    socialLinks = {};
    renderTaskRewards();
    renderSocialTasks();

    updateAllUI();

    loadReferralStats().catch(err => {
      console.warn("[referrals]", err.message);
    });

    clearInterval(taskRewardsTicker);

  } catch (err) {
    console.error("[eagle] initialization failed:", err);
    showAlert("authAlert", getErrorMessage(err, "Unable to load your account."));
    await supabase.auth.signOut();
    showScreen("authScreen");
  }
}



async function uploadUserAvatar(file, userId) {
  if (!file || !userId) {
    throw new Error("Avatar file or user ID is missing.");
  }

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp"
  ];

  if (!allowedTypes.includes(file.type)) {
    throw new Error("Only JPG, PNG and WebP images are allowed.");
  }

  if (file.size > 2 * 1024 * 1024) {
    throw new Error("Avatar must be smaller than 2 MB.");
  }

  const extension = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
  }[file.type];

  const filePath =
    `${userId}/${crypto.randomUUID()}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from("avatars")
    .upload(filePath, file, {
      contentType: file.type,
      upsert: false
    });

  if (uploadError) throw uploadError;

  const { data } = supabase.storage
    .from("avatars")
    .getPublicUrl(filePath);

  const avatarUrl = data.publicUrl;

  const { error: profileError } = await supabase
    .from("profiles")
    .update({ avatar_url: avatarUrl })
    .eq("id", userId);

  if (profileError) {
    await supabase.storage.from("avatars").remove([filePath]);
    throw profileError;
  }

  return avatarUrl;
}
// ── LOAD PROFILE ─────────────────────────────────────────────────

async function loadUserData() {
  const user = await getAuthenticatedUser();

  const { data, error } = await supabase
    .from("profiles")
    .select(`
      id,
      username,
      avatar_url,
      wallet_address,
      referral_code,
      balance,
      lifetime_earned,
      is_admin,
      created_at
    `)
    .eq("id", user.id)
    .single();

  if (error) throw error;

  currentUser = {
    ...user,
    ...data,
    email: user.email,
    balance: Number(data.balance || 0),
    lifetime_earned: Number(data.lifetime_earned || 0),
    created: data.created_at,
    avatar: data.avatar_url,
    mining_rate: 1,
    stored_coins: 0
  };

  return currentUser;
}

// ── SOCIAL TASKS ─────────────────────────────────────────────────
// Disabled until a secure social_links/task backend is implemented.

const TASK_ICONS = {
  twitter: "🐦",
  instagram: "📷",
  telegram: "✈️",
  youtube: "📺",
  video1: "🎥",
  video2: "🎬",
  video3: "🎞️"
};

async function loadSocialLinks() {
  socialLinks = {};
  renderSocialTasks();
}

function renderSocialTasks() {
  const container = document.getElementById("socialTasksList");
  const noMsg = document.getElementById("noTasksMessage");

  if (container) container.replaceChildren();
  if (noMsg) {
    noMsg.textContent = "Tasks are temporarily unavailable.";
    noMsg.style.display = "block";
  }
}

async function claimTask() {
  showAlert(
    "taskAlert",
    "Task rewards are temporarily unavailable while the secure task backend is being implemented.",
    "info"
  );
}

// ── MANUAL TASK REWARDS ──────────────────────────────────────────
// No tasks/task_submissions tables exist in the current schema.

const TASK_META = {
  exchange: {
    icon: "💱",
    inputLabel: "Your exchange UID",
    inputPlaceholder: "e.g. 12345678",
    proofHint: "Enter the UID shown in your exchange profile"
  },
  twitter_follow: {
    icon: "🐦",
    inputLabel: "Your X username",
    inputPlaceholder: "@yourhandle",
    proofHint: "Enter your @handle"
  },
  twitter_retweet: {
    icon: "🔁",
    inputLabel: "Link to your retweet",
    inputPlaceholder: "https://x.com/…/status/…",
    proofHint: "Paste the direct link"
  },
  youtube_sub: {
    icon: "📺",
    inputLabel: "Your YouTube username",
    inputPlaceholder: "@yourchannel",
    proofHint: "Enter your channel handle"
  },
  video_watch: {
    icon: "🎥",
    inputLabel: "Email or username",
    inputPlaceholder: "you@example.com",
    proofHint: "Enter the email or username you used"
  }
};

async function loadTaskRewards() {
  taskRewards = [];
  renderTaskRewards();
}


async function renderTaskRewards() {
  const el = document.getElementById("tasksList");
  if (!el) return;

  el.innerHTML = `
    <div class="bonus-box" style="justify-content:center;">
      <div style="color:var(--text-secondary);font-size:13px;">
        Loading tasks...
      </div>
    </div>
  `;

  try {
    const { data: tasks, error } = await supabase
      .from("tasks")
      .select("id,type,label,description,url,reward")
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw error;

    if (!tasks || tasks.length === 0) {
      el.innerHTML = `
        <div class="bonus-box" style="justify-content:center;">
          <div style="color:var(--text-secondary);font-size:13px;">
            No tasks are currently available. Check back later!
          </div>
        </div>
      `;
      return;
    }

    el.innerHTML = tasks.map(task => `
      <div class="bonus-box" style="
        display:flex;
        flex-direction:column;
        align-items:stretch;
        gap:8px;
        padding:14px;
      ">
        <div style="display:flex;justify-content:space-between;gap:10px;">
          <strong>${escapeHTML(task.label)}</strong>
          <span style="color:var(--success);font-weight:700;white-space:nowrap;">
            +${Number(task.reward).toLocaleString()} EAGLE
          </span>
        </div>

        ${task.description ? `
          <div style="color:var(--text-secondary);font-size:12px;">
            ${escapeHTML(task.description)}
          </div>
        ` : ""}

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          ${task.url ? `
            <a href="${escapeAttr(task.url)}"
               target="_blank"
               rel="noopener noreferrer"
               class="btn btn-secondary"
               style="font-size:12px;padding:8px 12px;">
              Open Task
            </a>
          ` : ""}

          <button type="button"
            class="btn btn-primary"
            style="font-size:12px;padding:8px 12px;"
            onclick="openTaskSubmitModal('${task.id}')">
            Submit Proof
          </button>
        </div>
      </div>
    `).join("");

  } catch (err) {
    console.error("[tasks] Failed to load tasks:", err);

    el.innerHTML = `
      <div style="color:var(--error);font-size:13px;padding:12px;">
        Could not load tasks. Please try again later.
      </div>
    `;
  }
}


let selectedTask = null;

async function openTaskSubmitModal(taskId) {
  const { data: task, error } = await supabase
    .from("tasks")
    .select("id,label,description,reward")
    .eq("id", taskId)
    .eq("active", true)
    .single();

  if (error || !task) {
    showAlert("taskAlert", "This task is no longer available.", "error");
    return;
  }

  selectedTask = task;

  document.getElementById("taskSubmitTitle").textContent = task.label;
  document.getElementById("taskSubmitDesc").textContent =
    task.description || "Complete this task and submit your proof.";

  document.getElementById("taskSubmitHint").textContent =
    `Reward: ${Number(task.reward).toLocaleString()} EAGLE`;

  document.getElementById("taskSubmitInputLabel").textContent =
    "Proof (URL or description)";

  document.getElementById("taskSubmitInput").value = "";
  document.getElementById("taskSubmitError").textContent = "";

  const modal = document.getElementById("taskSubmitModal");
  modal.style.display = "flex";
}

document.getElementById("taskSubmitBtn")?.addEventListener("click", async () => {
  if (!selectedTask) return;

  const button = document.getElementById("taskSubmitBtn");
  const input = document.getElementById("taskSubmitInput");
  const errorEl = document.getElementById("taskSubmitError");

  const proof = input.value.trim();

  if (!proof) {
    errorEl.textContent = "Please enter your proof.";
    return;
  }

  button.disabled = true;
  button.textContent = "Submitting...";
  errorEl.textContent = "";

  try {
    const { error } = await supabase.rpc("submit_task_proof", {
      p_task_id: selectedTask.id,
      p_proof: proof
    });

    if (error) throw error;

    document.getElementById("taskSubmitModal").style.display = "none";

    showAlert("taskAlert", "Proof submitted successfully! Await admin review.", "success");

    selectedTask = null;
    await renderTaskRewards();

  } catch (err) {
    console.error("[tasks] Submission failed:", err);
    errorEl.textContent = err.message || "Could not submit proof.";
  } finally {
    button.disabled = false;
    button.textContent = "Submit";
  }
});

document.getElementById("taskSubmitCancelBtn")?.addEventListener("click", () => {
  const modal = document.getElementById("taskSubmitModal");
  if (modal) modal.style.display = "none";
});

// ── MINING STATUS ───────────────────────────────────────────────

async function syncMiningSessionFromServer() {
  if (!currentUser?.id) {
    miningSession = null;
    stopUiTicker();
    updateMiningUI();
    return;
  }

  const { data, error } = await supabase.rpc("get_mining_status");

  if (error) throw error;

  const status = unwrapRpc(data);

  // Read the server's active session information.
  const { data: sessions, error: sessionError } = await supabase
    .from("mining_sessions")
    .select(`
      id,
      status,
      rate_per_hour,
      session_duration_hours,
      started_at,
      ends_at,
      last_claimed_at,
      total_mined
    `)
    .eq("user_id", currentUser.id)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1);

  if (sessionError) throw sessionError;

  const session = sessions?.[0];

  currentUser.mining_rate = Number(
    status.mining_rate ??
    status.rate_per_hour ??
    session?.rate_per_hour ??
    1
  );

  currentUser.estimated_pending_reward = Number(
    status.estimated_pending_reward || 0
  );

  if (!session) {
    miningSession = null;
    stopUiTicker();
    updateMiningUI();
    return;
  }

  const startTime = new Date(session.started_at).getTime();
  const endTime = new Date(session.ends_at).getTime();

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new Error("The mining session returned invalid dates.");
  }

  miningSession = {
    session_id: session.id,
    startTime,
    endTime,
    rate: Number(session.rate_per_hour || 1),
    coinsAtStart: Number(currentUser.balance || 0)
  };

  startUiTicker();
  updateMiningUI();
}

// ── START MINING ─────────────────────────────────────────────────

document.getElementById("startMiningBtn")?.addEventListener("click", async e => {
  e.preventDefault();

  if (!currentUser) return;

  if (miningSession) {
    showAlert("miningAlert", "You already have an active mining session.", "info");
    return;
  }

  await doStartMining();
});

async function doStartMining() {
  const btn = document.getElementById("startMiningBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳";
  }

  try {
    const { data, error } = await supabase.rpc("start_mining");

    if (error) throw error;

    const result = unwrapRpc(data);

    // Refresh from the database instead of trusting client timestamps.
    await syncMiningSessionFromServer();
    await loadUserData();
    updateAllUI();

    showAlert("miningAlert", "Mining session started successfully!", "success");

  } catch (err) {
    showAlert("miningAlert", getErrorMessage(err, "Failed to start mining."));
    await syncMiningSessionFromServer().catch(() => {});
  } finally {
    if (btn) {
      btn.disabled = Boolean(miningSession);
      btn.textContent = miningSession ? "🔒" : "▶";
    }
  }
}

// ── CLAIM MINING REWARDS ─────────────────────────────────────────

async function claimMiningRewards() {
  if (!currentUser) return;

  const { data, error } = await supabase.rpc("claim_mining");

  if (error) throw error;

  const result = unwrapRpc(data);

  await loadUserData();
  await syncMiningSessionFromServer();

  updateAllUI();

  const earned = Number(
    result.earned ??
    result.amount ??
    result.reward ??
    0
  );

  showAlert(
    "miningAlert",
    `Mining rewards claimed. ${fmt(earned)} EAGLE credited.`,
    "success"
  );

  return result;
}

// ── MINING TICKER ────────────────────────────────────────────────

function startUiTicker() {
  stopUiTicker();

  uiTicker = setInterval(async () => {
    if (!miningSession) {
      stopUiTicker();
      return;
    }

    const now = Date.now();

    if (now >= miningSession.endTime) {
      stopUiTicker();

      try {
        if (_miningTickAbort) _miningTickAbort.abort();

        _miningTickAbort = new AbortController();

        await claimMiningRewards();

      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("[mining] automatic claim failed:", err);
          showAlert(
            "miningAlert",
            "Your session has ended. Please refresh and claim your rewards.",
            "info"
          );

          await loadUserData().catch(() => {});
          await syncMiningSessionFromServer().catch(() => {});
          updateAllUI();
        }
      } finally {
        _miningTickAbort = null;
      }

      return;
    }

    updateMiningUI();
  }, 5000);
}

function stopUiTicker() {
  clearInterval(uiTicker);
  uiTicker = null;
}

// ── MINING UI ────────────────────────────────────────────────────

function updateMiningUI() {
  const btn = document.getElementById("startMiningBtn");
  const statusText = document.getElementById("miningStatusText");
  const statusHome = document.getElementById("miningStatusTextHome");
  const progressCont = document.getElementById("miningProgressBarContainer");
  const homeProgressCont = document.getElementById("homeMiningProgressBarContainer");

  const rate = Number(currentUser?.mining_rate || 1);
  const baseRate = 1;
  const bonusPct = (((rate - baseRate) / baseRate) * 100).toFixed(1);

  setText("baseRate", baseRate.toFixed(2));
  setText("totalRate", rate.toFixed(4));
  setText("bonusRateDisplay", `+${bonusPct}%`);

  if (miningSession) {
    const now = Date.now();
    const elapsed = Math.max(0, (now - miningSession.startTime) / 3600000);
    const totalHrs = Math.max(
      0.001,
      (miningSession.endTime - miningSession.startTime) / 3600000
    );

    const remaining = Math.max(0, miningSession.endTime - now);
    const pct = Math.min(100, (elapsed / totalHrs) * 100);

    const liveCoins =
      Number(currentUser?.balance || 0) +
      Number(currentUser?.estimated_pending_reward || 0);

    if (btn) {
      btn.textContent = "🔒";
      btn.style.background = "#6b7280";
      btn.disabled = true;
    }

    if (statusText) statusText.textContent = "⛏️ Mining…";
    if (statusHome) statusHome.textContent = "⛏️ Mining…";

    if (progressCont) progressCont.style.display = "block";
    if (homeProgressCont) homeProgressCont.style.display = "block";

    const fill = document.getElementById("progressBarFill");
    if (fill) fill.style.width = `${pct.toFixed(1)}%`;

    setText("progressTimePercent", `${pct.toFixed(1)}% · ${fmtDuration(remaining)} left`);
    setText(
      "progressCoinMined",
      `~${fmt(currentUser?.estimated_pending_reward || 0)} EAGLE pending`
    );

    const homeFill = document.getElementById("homeProgressBarFill");
    if (homeFill) homeFill.style.width = `${pct.toFixed(1)}%`;

    setText("homeProgressTimePercent", `${pct.toFixed(1)}% · ${fmtDuration(remaining)} left`);
    setText(
      "homeProgressCoinMined",
      `~${fmt(currentUser?.estimated_pending_reward || 0)} EAGLE pending`
    );

    setText("miningBalance", fmt(liveCoins));
    setText("miningStatusBalance", fmt(liveCoins));

  } else {
    if (btn) {
      btn.textContent = "▶";
      btn.style.background = "";
      btn.disabled = false;
    }

    if (statusText) statusText.textContent = "Inactive";
    if (statusHome) statusHome.textContent = "Inactive";

    if (progressCont) progressCont.style.display = "none";
    if (homeProgressCont) homeProgressCont.style.display = "none";

    setText("miningBalance", fmt(currentUser?.balance));
    setText("miningStatusBalance", fmt(currentUser?.balance));
  }
}

// ── UPDATE ALL UI ────────────────────────────────────────────────

function updateAllUI() {
  if (!currentUser) return;

  const balance = Number(currentUser.balance || 0);
  const stored = Number(currentUser.stored_coins || 0);
  const username = currentUser.username || "User";

  setText("headerBalance", `${fmt(balance, 2)} EAGLE`);
  setText("uname", username);
  setText("balanceTop", `${fmt(balance, 2)} EAGLE`);
  setText("statBalance1", `${fmt(balance, 4)} EAGLE`);
  setText("statStored", `${fmt(stored, 4)} EAGLE`);
  setText("walletBalance", `${fmt(balance, 4)} EAGLE`);

  setText("profUser", username);
  setText("profEmail", currentUser.email || "");
  setText("profBalance", `${fmt(balance, 4)} EAGLE`);
  setText("profMemberSince", fmtDate(currentUser.created_at));

  const profAvatar = document.getElementById("profAvatar");

  if (profAvatar) {
    profAvatar.replaceChildren();

    if (currentUser.avatar_url) {
      const img = document.createElement("img");
      img.src = currentUser.avatar_url;
      img.alt = "Avatar";
      img.style.cssText =
        "width:100%;height:100%;object-fit:cover;border-radius:50%;";
      profAvatar.appendChild(img);
    } else {
      profAvatar.textContent = "👤";
    }
  }

  const adminLink = document.getElementById("adminConsoleLink");

  if (adminLink) {
    adminLink.style.display = currentUser.is_admin ? "block" : "none";
  }

  updateMiningUI();
}

// ── NAVIGATION ───────────────────────────────────────────────────

document.querySelectorAll("#nav a").forEach(a => {
  a.addEventListener("click", e => {
    e.preventDefault();

    const screen = a.dataset.screen;
    showTab(screen);

    if (screen === "partners") loadReferralStats();
    if (screen === "wallet") loadTransactions(true);
    if (screen === "mining") updateMiningUI();
  });
});

document.getElementById("refreshBtn")?.addEventListener("click", async e => {
  e.preventDefault();

  try {
    await loadUserData();
    await syncMiningSessionFromServer();
    updateAllUI();
  } catch (err) {
    showAlert("miningAlert", getErrorMessage(err, "Refresh failed."));
  }
});

// ── REFERRALS ────────────────────────────────────────────────────

function buildReferralLink() {
  const code =
    currentUser?.referral_code ||
    currentUser?.username ||
    currentUser?.id ||
    "";

  return `${window.location.origin}${window.location.pathname}?ref=${encodeURIComponent(code)}`;
}

async function loadReferralStats() {
  if (!currentUser?.id) return;

  setText("referralCode", buildReferralLink());

  try {
    const { data, error } = await supabase
      .from("referrals")
      .select("id,status,reward_amount,created_at")
      .eq("referrer_id", currentUser.id);

    if (error) throw error;

    const referrals = data || [];
    const active = referrals.filter(r =>
      ["qualified", "rewarded", "active"].includes(
        String(r.status || "").toLowerCase()
      )
    );

    const earned = referrals
      .filter(r => r.status === "rewarded")
      .reduce((sum, r) => sum + Number(r.reward_amount || 0), 0);

    setText("totalReferrals", referrals.length);
    setText("activeReferrals", active.length);
    setText("referralEarnings", fmt(earned, 2));

    renderReferralsList(referrals);

  } catch (err) {
    console.warn("[referrals]", err.message);
    renderReferralsList([]);
  }
}

const REFERRAL_REWARD_DISPLAY = 10;

function renderReferralsList(list) {
  const el = document.getElementById("referralsList");
  if (!el) return;

  if (!list.length) {
    el.textContent = "No referrals yet";
    return;
  }

  // The current referral RLS policy does not expose other users'
  // profile details, so do not invent usernames.
  el.innerHTML = list.map(r => `
    <div style="display:flex;justify-content:space-between;align-items:center;
      padding:10px 0;border-bottom:1px solid var(--card-border);">
      <div>
        <div style="font-weight:700;font-size:14px;">Referral</div>
        <div style="font-size:11px;color:var(--text-secondary);">
          Joined ${fmtDate(r.created_at)}
        </div>
      </div>
      <div style="font-size:13px;color:var(--accent);font-weight:600;">
        ${escapeAttr(r.status || "pending")}
      </div>
    </div>
  `).join("");
}

document.getElementById("copyReferralBtn")?.addEventListener("click", async e => {
  e.preventDefault();

  try {
    await navigator.clipboard.writeText(buildReferralLink());

    const btn = document.getElementById("copyReferralBtn");
    const original = btn.textContent;
    btn.textContent = "✅ Copied!";

    setTimeout(() => {
      if (btn) btn.textContent = original;
    }, 2000);

  } catch {
    showAlert("referralAlert", "Could not copy referral link.");
  }
});

document.getElementById("refreshReferralBtn")?.addEventListener("click", e => {
  e.preventDefault();
  loadReferralStats();
});

document.getElementById("quickAction")?.addEventListener("click", async e => {
  e.preventDefault();

  try {
    await navigator.clipboard.writeText(buildReferralLink());
    alert("Referral link copied!");
  } catch {
    alert("Could not copy referral link.");
  }
});

// ── WALLET TRANSACTIONS ──────────────────────────────────────────

async function loadTransactions(reset = true) {
  const listEl = document.getElementById("recentList");
  const noEl = document.getElementById("noTxMsg");
  const moreBtn = document.getElementById("loadMoreTxBtn");

  if (!listEl || _txLoading || !currentUser) return;

  if (reset) {
    _txGeneration++;
    _txPage = 0;
    listEl.replaceChildren();
    if (noEl) noEl.style.display = "none";
  }

  const generation = _txGeneration;

  _txLoading = true;

  if (moreBtn) {
    moreBtn.disabled = true;
    moreBtn.textContent = "Loading…";
  }

  if (_txAbort) _txAbort.abort();
  _txAbort = new AbortController();

  try {
    const from = _txPage * 10;
    const to = from + 9;

    const { data, error, count } = await supabase
      .from("transactions")
      .select(
        "transaction_type,direction,amount,status,description,created_at",
        { count: "exact" }
      )
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: false })
      .range(from, to)
      .abortSignal(_txAbort.signal);

    if (error) throw error;
    if (generation !== _txGeneration) return;

    const records = data || [];

    if (records.length === 0 && reset) {
      if (noEl) noEl.style.display = "block";
      if (moreBtn) moreBtn.style.display = "none";
      return;
    }

    if (noEl) noEl.style.display = "none";

    records.forEach(tx => {
      const isCredit = tx.direction === "credit";
      const sign = isCredit ? "+" : "−";
      const color = isCredit ? "#22c55e" : "#ef4444";

      const row = document.createElement("div");
      row.style.cssText = `
        display:flex;
        justify-content:space-between;
        padding:10px 0;
        border-bottom:1px solid var(--card-border);
      `;

      const left = document.createElement("div");

      const description = document.createElement("div");
      description.style.cssText = "font-weight:600;font-size:14px;";
      description.textContent =
        tx.description || tx.transaction_type || "Transaction";

      const date = document.createElement("div");
      date.style.cssText = "font-size:11px;color:var(--text-secondary);";
      date.textContent = fmtDate(tx.created_at);

      left.append(description, date);

      const amount = document.createElement("div");
      amount.style.cssText = `color:${color};font-weight:700;`;
      amount.textContent = `${sign}${fmt(tx.amount, 4)} EAGLE`;

      row.append(left, amount);
      listEl.appendChild(row);
    });

    const hasMore = from + records.length < (count || 0);

    if (moreBtn) {
      moreBtn.style.display = hasMore ? "block" : "none";
      moreBtn.disabled = false;
      moreBtn.textContent = "Load more";
    }

  } catch (err) {
    if (err.name === "AbortError") return;
    if (generation !== _txGeneration) return;

    console.error("[transactions]", err);

    if (noEl && reset) {
      noEl.textContent = "Could not load transactions.";
      noEl.style.display = "block";
    }

    if (moreBtn) moreBtn.style.display = "none";

  } finally {
    if (generation === _txGeneration) _txLoading = false;
    _txAbort = null;
  }
}

document.getElementById("loadMoreTxBtn")?.addEventListener("click", () => {
  if (_txLoading) return;
  _txPage++;
  loadTransactions(false);
});

// ── WALLET ADDRESS ───────────────────────────────────────────────

document.getElementById("copyAddrBtn")?.addEventListener("click", async e => {
  e.preventDefault();

  const address = currentUser?.wallet_address || "";

  if (!address) {
    alert("No wallet address has been added to your profile.");
    return;
  }

  try {
    await navigator.clipboard.writeText(address);

    const btn = document.getElementById("copyAddrBtn");
    const original = btn.textContent;
    btn.textContent = "✅ Copied!";

    setTimeout(() => {
      if (btn) btn.textContent = original;
    }, 2000);

  } catch {
    alert("Could not copy wallet address.");
  }
});

// ── SEND / RECEIVE PLACEHOLDERS ──────────────────────────────────

function showComingSoon(buttonId) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;

  const original = btn.textContent;
  btn.textContent = "Available later";
  btn.disabled = true;

  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 2000);
}

document.getElementById("sendBtn")?.addEventListener("click", e => {
  e.preventDefault();
  showComingSoon("sendBtn");
});

document.getElementById("receiveBtn")?.addEventListener("click", e => {
  e.preventDefault();
  showComingSoon("receiveBtn");
});

// ── LOGOUT ───────────────────────────────────────────────────────

async function logoutUser() {
  stopUiTicker();
  clearInterval(taskRewardsTicker);

  if (_miningTickAbort) _miningTickAbort.abort();
  if (_txAbort) _txAbort.abort();

  const { error } = await supabase.auth.signOut();

  if (error) {
    console.error("[auth] logout failed:", error);
    alert("Could not log out. Please try again.");
    return;
  }

  currentUser = null;
  miningSession = null;
  taskRewards = [];
  socialLinks = [];
     pendingVerificationEmail = "";

   showScreen("authScreen");

  document.getElementById("recentList")?.replaceChildren();
  document.getElementById("referralsList")?.replaceChildren();
 document.getElementById("profAvatar")?.replaceChildren();
  ["uname", "headerBalance", "balanceTop", "walletBalance",
   "profUser", "profEmail", "profBalance", "profMemberSince"]
    .forEach(id => setText(id, ""));
 }

document.getElementById("logoutBtn")?.addEventListener("click", async e => {
  e.preventDefault();
  await logoutUser();
});

// ── DELETE ACCOUNT ───────────────────────────────────────────────
// Disabled until a secure server-side deletion Edge Function exists.


 // ── DELETE ACCOUNT ───────────────────────────────────────────────

document.getElementById("deleteAccountBtn")?.addEventListener(
  "click",
  async (e) => {
    e.preventDefault();

    const btn = e.currentTarget;
    const originalText = btn.textContent;

    const confirmed = window.confirm(
      "PERMANENT ACCOUNT DELETION\n\n" +
      "This action cannot be undone.\n\n" +
      "Your remaining Eagle balance will be forfeited. " +
      "Your profile and avatar will be removed, and your " +
      "login account will be permanently deleted.\n\n" +
      "Outstanding pending, approved, or processing withdrawals " +
      "must be resolved first.\n\n" +
      "Do you want to continue?"
    );

    if (!confirmed) return;

    const confirmation = window.prompt(
      'Type DELETE to permanently delete your account:'
    );

    if (confirmation !== "DELETE") {
      alert("Account deletion cancelled. Confirmation did not match.");
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = "Deleting account...";

      const { data, error } = await supabase.functions.invoke(
        "delete-account",
        {
          body: { confirmation: "DELETE" }
        }
      );

      if (error) {
        let message = error.message || "Account deletion failed.";

        // Read the server's actual error response when available.
        try {
          if (error.context?.clone) {
            const responseData = await error.context.clone().json();

            if (responseData?.error) {
              message = responseData.error;
            }
          }
        } catch {
          // Keep the original error message.
        }

        throw new Error(message);
      }

      if (!data?.success) {
        throw new Error(
          data?.error || "The server could not complete account deletion."
        );
      }

      // Clear the local authentication session.
      await supabase.auth.signOut({ scope: "local" });

      // Stop account-related frontend activity.
      stopUiTicker();
      clearInterval(taskRewardsTicker);

      if (_miningTickAbort) _miningTickAbort.abort();
      if (_txAbort) _txAbort.abort();

      currentUser = null;
      miningSession = null;
      taskRewards = [];
      socialLinks = [];
      pendingVerificationEmail = "";

      showScreen("authScreen");

      alert(
        "Your Eagle account has been permanently deleted."
      );

    } catch (error) {
      console.error("[auth] Account deletion failed:", error);

      alert(
        error.message || "Account deletion failed. Please try again."
      );

    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
);

// ── CHANGE PASSWORD ──────────────────────────────────────────────

document.getElementById("togglePasswordBtn")?.addEventListener("click", e => {
  e.preventDefault();

  const form = document.getElementById("passwordChangeForm");
  if (form) {
    form.style.display = form.style.display === "none" ? "block" : "none";
  }
});

document.getElementById("changePasswordBtn")?.addEventListener("click", async e => {
  e.preventDefault();

  const current = document.getElementById("currentPassword")?.value || "";
  const newPass = document.getElementById("newPassword")?.value || "";
  const confirm = document.getElementById("confirmNewPassword")?.value || "";

  if (!current) return alert("Enter your current password.");
  if (newPass.length < 8) return alert("New password must be at least 8 characters.");
  if (newPass !== confirm) return alert("Passwords do not match.");

  const btn = document.getElementById("changePasswordBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Loading…";
  }

  try {
    const user = await getAuthenticatedUser();

    // Reauthenticate before changing the password.
    const { error: loginError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: current
    });

    if (loginError) throw new Error("Current password is incorrect.");

    const { error } = await supabase.auth.updateUser({
      password: newPass
    });

    if (error) throw error;

    alert("Password changed successfully!");

    const form = document.getElementById("passwordChangeForm");
    if (form) form.style.display = "none";

    ["currentPassword", "newPassword", "confirmNewPassword"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });

  } catch (err) {
    alert(getErrorMessage(err, "Failed to change password."));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Change Password";
    }
  }
});

// ── BEFORE UNLOAD CLEANUP ────────────────────────────────────────

window.addEventListener("beforeunload", () => {
  stopUiTicker();
  clearInterval(taskRewardsTicker);

  if (_miningTickAbort) _miningTickAbort.abort();
  if (_txAbort) _txAbort.abort();
});

// ── BOOTSTRAP ────────────────────────────────────────────────────

async function bootstrap() {
  showScreen("loadingScreen");

  try {
    eagle = await window.EagleReady;

    if (!eagle?.supabase || !eagle?.auth) {
      throw new Error("Supabase client was not initialized by shared.js.");
    }

    supabase = eagle.supabase;

  } catch (err) {
    console.error("[eagle] configuration failed:", err);

    const loading = document.getElementById("loadingScreen");

    if (loading) {
      loading.replaceChildren();

      const message = document.createElement("div");
      message.style.cssText = "padding:24px;text-align:center;color:#ef4444;";

      const heading = document.createElement("p");
      heading.style.fontWeight = "700";
      heading.textContent = "Configuration failed";

      const detail = document.createElement("p");
      detail.style.fontSize = "13px";
      detail.textContent = getErrorMessage(err, "Unable to load app config.");

      message.append(heading, detail);
      loading.appendChild(message);
    }

    return;
  }

  // Save referral code from a referral link.
  const refParam = new URLSearchParams(window.location.search).get("ref");

  if (refParam) {
    try {
      sessionStorage.setItem("eagle_ref", JSON.stringify({
        code: refParam,
        storedAt: Date.now()
      }));
    } catch (_) {}

    document.getElementById("tabRegister")?.click();
  }

  try {
    const { data, error } = await supabase.auth.getSession();

    if (error) throw error;

    const session = data.session;

    if (session?.user) {
      currentUser = session.user;

      if (!currentUser.email_confirmed_at) {
        pendingVerificationEmail = currentUser.email || "";
        setText("verifyEmail", pendingVerificationEmail);
        showScreen("verificationScreen");
      } else {
        await initMainApp();
      }

    } else {
      showScreen("authScreen");
    }

  } catch (err) {
    console.error("[eagle] session bootstrap failed:", err);
    showScreen("authScreen");
    showAlert("authAlert", getErrorMessage(err, "Unable to restore your session."));
  }
}



// ============================================================
// PROFILE AVATAR UPLOAD — SUPABASE STORAGE
// ============================================================

const profileAvatarInput = document.getElementById("profileAvatarInput");
const profAvatar = document.getElementById("profAvatar");

// Open file picker when user clicks their profile photo
profAvatar?.addEventListener("click", () => {
  profileAvatarInput?.click();
});

// Upload selected avatar
profileAvatarInput?.addEventListener("change", async () => {
  const file = profileAvatarInput.files?.[0];
  if (!file) return;

  try {
    // Validate file type
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

    if (!allowedTypes.includes(file.type)) {
      throw new Error("Please select a JPG, PNG, or WebP image.");
    }

    // Maximum file size: 2 MB
    if (file.size > 2 * 1024 * 1024) {
      throw new Error("Avatar must be smaller than 2 MB.");
    }

    const user = await getAuthenticatedUser();

    if (!user?.id) {
      throw new Error("Please log in before uploading a profile photo.");
    }

    profAvatar.textContent = "Uploading…";

    const extensions = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp"
    };

    const filePath =
      `${user.id}/${crypto.randomUUID()}.${extensions[file.type]}`;

    // Upload image to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, file, {
        cacheControl: "3600",
        contentType: file.type,
        upsert: false
      });

    if (uploadError) throw uploadError;

    // Get public image URL
    const { data: publicData } = supabase.storage
      .from("avatars")
      .getPublicUrl(filePath);

    const avatarUrl = publicData.publicUrl;

    // Save URL in user's profile
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ avatar_url: avatarUrl })
      .eq("id", user.id);

    if (updateError) {
      // Remove uploaded file if profile update fails
      await supabase.storage.from("avatars").remove([filePath]);
      throw updateError;
    }

    // Update local user data
    if (currentUser) {
      currentUser.avatar_url = avatarUrl;
      currentUser.avatar = avatarUrl;
    }

    // Immediately display new avatar
    const img = document.createElement("img");
    img.src = avatarUrl;
    img.alt = "Profile photo";

    profAvatar.replaceChildren(img);

    alert("Profile photo updated successfully.");

  } catch (error) {
    console.error("Avatar upload error:", error);

    // Restore the previous avatar if upload fails
    if (currentUser?.avatar_url) {
      const img = document.createElement("img");
      img.src = currentUser.avatar_url;
      img.alt = "Profile photo";
      profAvatar.replaceChildren(img);
    } else {
      profAvatar.textContent = "👤";
    }

    alert(error.message || "Could not upload profile photo.");

  } finally {
    profileAvatarInput.value = "";
  }
});




// ── START APPLICATION ────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
