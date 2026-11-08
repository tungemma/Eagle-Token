// ── CONFIG ───────────────────────────────────────────────────────
// shared.js exposes EagleReady (a promise) since config.js is now
// async. Every consumer must await it before touching window.Eagle.
let PB_URL, pb, api;

const SESSION_HOURS = 24;      // fallback only — server sends the real value
const AD_WATCH_SECONDS = 15;

// ── APP STATE (display-only, sourced entirely from API) ──────────
let currentUser   = null;
let miningSession = null;
let uiTicker      = null;

// Task rewards state
let taskRewardsTicker = null;

// Transaction pagination
let _txPage    = 1;
let _txLoading = false;
let _txAbort   = null;
let _txGeneration = 0;

// In-flight abort controllers for pollers
let _miningTickAbort = null;

// ── UI HELPERS ───────────────────────────────────────────────────
function showScreen(id) {
  ["loadingScreen","authScreen","verificationScreen","mainScreens"].forEach(s => {
    document.getElementById(s)?.classList.toggle("hidden", s !== id);
  });
  const main = id === "mainScreens";
  document.getElementById("nav")?.classList.toggle("hidden", !main);
  document.getElementById("footer")?.classList.toggle("hidden", !main);
}

function showTab(tab) {
  ["home","mining","wallet","partners","profile"].forEach(s => {
    document.getElementById(s + "Screen")?.classList.toggle("hidden", s !== tab);
  });
  document.querySelectorAll("#nav a").forEach(a =>
    a.classList.toggle("active", a.dataset.screen === tab)
  );
}

function showAlert(containerId, msg, type = "error") {
  const el = document.getElementById(containerId);
  if (!el) return;
  const c = { error: "#ef4444", success: "#22c55e", info: "var(--accent)" }[type] || "#ef4444";
  el.innerHTML = `<div style="padding:10px 14px;border-radius:8px;margin-bottom:12px;
    background:rgba(0,0,0,0.3);border:1px solid ${c};color:${c};font-size:13px;">${msg}</div>`;
}

function clearAlert(id) { const el = document.getElementById(id); if (el) el.innerHTML = ""; }

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function fmt(n, dec = 4) { return parseFloat(n || 0).toFixed(dec); }

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
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
    if (onDone) onDone();
  };

  if (onTick) onTick(remaining);
  timer = setInterval(() => {
    if (done) return;
    remaining -= 1;
    if (remaining <= 0) { fire(); return; }
    if (onTick) onTick(remaining);
  }, 1000);

  return {
    cancel() { done = true; clearInterval(timer); },
    get remaining() { return remaining; },
  };
}

// ── PWA INSTALL ──────────────────────────────────────────────────
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById("pwaBanner").classList.add("visible");
});
window.installPWA = async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === "accepted") document.getElementById("pwaBanner").classList.remove("visible");
  deferredPrompt = null;
};

// ── PASSWORD STRENGTH BAR ────────────────────────────────────────
document.getElementById("regPassword")?.addEventListener("input", function () {
  let score = 0;
  if (this.value.length >= 8)          score++;
  if (this.value.length >= 12)         score++;
  if (/[A-Z]/.test(this.value))        score++;
  if (/[0-9]/.test(this.value))        score++;
  if (/[^A-Za-z0-9]/.test(this.value)) score++;
  const colors = ["#ef4444","#f97316","#eab308","#22c55e","#16a34a"];
  const labels = ["Too short","Weak","Fair","Good","Strong"];
  const fill = document.getElementById("pwStrengthFill");
  const hint = document.getElementById("pwHint");
  if (fill) { fill.style.width = `${(score / 5) * 100}%`; fill.style.background = colors[score - 1] || "#ef4444"; }
  if (hint)   hint.textContent = this.value ? (labels[score - 1] || "Too short") : "";
});

// ── AVATAR PREVIEW ───────────────────────────────────────────────
document.getElementById("regAvatar")?.addEventListener("change", function () {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const p = document.getElementById("regAvatarPreview");
    if (p) p.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
  };
  reader.readAsDataURL(file);
});
document.getElementById("regAvatarPreview")?.addEventListener("click", () =>
  document.getElementById("regAvatar")?.click()
);

// ── AUTH TABS ────────────────────────────────────────────────────
document.getElementById("tabLogin")?.addEventListener("click", () => {
  document.getElementById("loginForm").classList.remove("hidden");
  document.getElementById("registerForm").classList.add("hidden");
  document.getElementById("tabLogin").classList.add("active");
  document.getElementById("tabRegister").classList.remove("active");
  clearAlert("authAlert");
});
document.getElementById("tabRegister")?.addEventListener("click", () => {
  document.getElementById("registerForm").classList.remove("hidden");
  document.getElementById("loginForm").classList.add("hidden");
  document.getElementById("tabRegister").classList.add("active");
  document.getElementById("tabLogin").classList.remove("active");
  clearAlert("authAlert");
});

// ── CLIENT-SIDE VALIDATION ───────────────────────────────────────
function validateRegistrationInputs(username, email, password, confirm) {
  if (!username || username.length < 3) return "Username must be at least 3 characters.";
  if (username.length > 30)             return "Username must be 30 characters or fewer.";
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return "Username: letters, numbers and underscores only.";
  if (!email)                           return "Email is required.";
  if (!password || password.length < 8) return "Password must be at least 8 characters.";
  if (password !== confirm)             return "Passwords do not match.";
  return null;
}

// ── REFERRAL CODE STORAGE (with TTL) ─────────────────────────────
function getStoredRef() {
  try {
    const raw = sessionStorage.getItem("eagle_ref");
    if (!raw) return "";
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.code) {
        const age = Date.now() - (parsed.storedAt || 0);
        if (age < 7 * 24 * 3600 * 1000) return parsed.code;
      }
      return "";
    }
    // legacy string format
    return raw;
  } catch (_) {
    return "";
  }
}

// ── REGISTER ─────────────────────────────────────────────────────
document.getElementById("registerBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  clearAlert("authAlert");

  const username   = document.getElementById("regUsername").value.trim();
  const email      = document.getElementById("regEmail").value.trim();
  const password   = document.getElementById("regPassword").value;
  const confirm    = document.getElementById("regConfirmPassword").value;
  const avatarFile = document.getElementById("regAvatar").files[0];
  const refCode    = getStoredRef() ||
                     new URLSearchParams(window.location.search).get("ref") || "";

  const inputErr = validateRegistrationInputs(username, email, password, confirm);
  if (inputErr) return showAlert("authAlert", inputErr);

  const btn = document.getElementById("registerBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Loading…"; }

  try {
    let referrerId = "";
    if (refCode) {
      try {
        const ref = await api("POST", "/eagle/lookup-referrer", { referral_code: refCode });
        referrerId = ref.id || "";
      } catch (_) {}
    }

    const fd = new FormData();
    fd.append("username",        username);
    fd.append("email",           email);
    fd.append("password",        password);
    fd.append("passwordConfirm", confirm);
    fd.append("name",            username);
    if (referrerId) fd.append("referredBy", referrerId);
    if (avatarFile) fd.append("avatar", avatarFile);

    await pb.collection("users").create(fd);

    try { await pb.collection("users").requestVerification(email); }
    catch (err) { console.warn("[verify] initial send failed:", err); }
    await pb.collection("users").authWithPassword(email, password);

    currentUser = pb.authStore.record;

    setText("verifyEmail", email);
    showScreen("verificationScreen");
  } catch (err) {
    const msg = err?.data?.data
      ? Object.values(err.data.data).map(v => v.message).join(" ")
      : err.message || "Registration failed.";
    showAlert("authAlert", msg);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Create Account"; }
  }
});

document.getElementById("regConfirmPassword")?.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("registerBtn")?.click();
  }
});

// ── LOGIN ────────────────────────────────────────────────────────
document.getElementById("loginBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  clearAlert("authAlert");

  const email    = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  if (!email || !password) return showAlert("authAlert", "Email and password are required.");

  const btn = document.getElementById("loginBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Loading…"; }

  try {
    await pb.collection("users").authWithPassword(email, password);
    currentUser = pb.authStore.record;

    if (!currentUser.verified) {
      setText("verifyEmail", email);
      showScreen("verificationScreen");
    } else {
      await initMainApp();
    }
  } catch (_) {
    showAlert("authAlert", "Invalid email or password.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Login"; }
  }
});

document.getElementById("loginPassword")?.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("loginBtn")?.click();
  }
});

// ── VERIFICATION SCREEN ──────────────────────────────────────────
document.getElementById("sendVerificationBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const email = pb.authStore.record?.email; if (!email) return;

  const btn = document.getElementById("sendVerificationBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Loading…"; }

  try {
    await pb.collection("users").requestVerification(email);
    showAlert("verifyAlert", "Verification email resent!", "success");
  } catch (_) {
    showAlert("verifyAlert", "Could not send email. Try again later.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Resend Email"; }
  }
});

document.getElementById("checkVerificationBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("checkVerificationBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Loading…"; }

  try {
    await pb.collection("users").authRefresh();
    currentUser = pb.authStore.record;

    if (currentUser.verified) {
      await initMainApp();
    } else {
      showAlert("verifyAlert", "Not verified yet — check your inbox.", "info");
    }
  } catch (_) {
    showAlert("verifyAlert", "Could not check verification status.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "I've Verified - Continue"; }
  }
});

document.getElementById("verificationLogoutBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  pb.authStore.clear();
  currentUser = null;
  showScreen("authScreen");
});

// ── INIT MAIN APP ────────────────────────────────────────────────
async function initMainApp() {
  showScreen("mainScreens");
  showTab("home");

  await Promise.all([
    loadUserData(),
    
    loadTaskRewards(),
  ]);

 
  syncMiningSessionFromServer();
  updateAllUI();

  loadReferralStats().catch(() => {});

  clearInterval(taskRewardsTicker);
  taskRewardsTicker = setInterval(() => loadTaskRewards(), 60000);
}

// ── LOAD USER DATA — /eagle/me ───────────────────────────────────
async function loadUserData() {
  try {
    const data = await api("GET", "/eagle/me");
    if (typeof data.completed_tasks === "string") {
      try { data.completed_tasks = JSON.parse(data.completed_tasks); } catch (_) { data.completed_tasks = []; }
    }
    currentUser = data;
  } catch (err) {
    console.warn("[eagle] loadUserData failed:", err.message);
    if (pb.authStore.record) currentUser = pb.authStore.record;
  }
}

// ── LOAD SOCIAL LINKS — /eagle/social-links ──────────────────────
async function loadSocialLinks() {
  try {
    const list = await api("GET", "/eagle/social-links");
    socialLinks = {};
    (list || []).forEach(item => { socialLinks[item.type] = item; });
  } catch (_) {
    socialLinks = {};
  }
}

const TASK_ICONS = {
  twitter: "🐦", instagram: "📷", telegram: "✈️", youtube: "📺",
  video1: "🎥", video2: "🎬", video3: "🎞️",
};

// ── RENDER SOCIAL TASKS ──────────────────────────────────────────
function renderSocialTasks() {
  const container = document.getElementById("socialTasksList");
  const noMsg     = document.getElementById("noTasksMessage");
  if (!container) return;

  const completedTasks = currentUser?.completed_tasks || [];
  const pending = Object.values(socialLinks)
    .filter(link => link.url)
    .filter(link => !completedTasks.includes(link.type));

  if (pending.length === 0) {
    container.innerHTML = "";
    if (noMsg) noMsg.style.display = "block";
    return;
  }
  if (noMsg) noMsg.style.display = "none";

  container.innerHTML = pending.map(link => `
    <div class="bonus-box" style="justify-content:space-between;align-items:center;">
      <div style="display:flex;gap:10px;align-items:center;">
        <div class="bonus-icon">${TASK_ICONS[link.type] || "🔗"}</div>
        <div>
          <div class="bonus-title">${escapeAttr(link.label)}</div>
          <div class="bonus-desc">+0.1 EAGLE/hr boost · 4h per task</div>
        </div>
      </div>
      <button class="btn btn-primary" data-task-id="${escapeAttr(link.type)}"
        data-task-url="${escapeAttr(link.url)}"
        style="padding:8px 14px;font-size:12px;">Go →</button>
    </div>
  `).join("");

  container.querySelectorAll("button[data-task-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      claimTask(btn.dataset.taskId, btn.dataset.taskUrl);
    });
  });
}

// ── CLAIM TASK — /eagle/complete-task ────────────────────────────
async function claimTask(taskId, url) {
  window.open(url, "_blank");

  const btn = document.querySelector(`button[data-task-id="${taskId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "⏳"; }

  // Match server-side TASK_CLAIM_MIN_INTERVAL_SECONDS (10s).
  await new Promise(r => setTimeout(r, 10000));

  try {
    const result = await api("POST", "/eagle/complete-task", { task_id: taskId });
    currentUser.completed_tasks = result.completed_tasks;
    currentUser.mining_rate     = result.new_rate;
    if (currentUser.mining_started_at) currentUser.mining_session_rate = result.new_rate;
    if (miningSession) miningSession.rate = result.new_rate;

    renderSocialTasks();
    updateAllUI();
    showAlert("taskAlert", `✅ Task done! New rate: ${parseFloat(result.new_rate).toFixed(4)} EAGLE/hr`, "success");
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Go →"; }
    const msg = err.status === 409 ? "Already completed."
              : err.status === 429 ? (err.message || "Please slow down.")
              : (err.message || "Task failed.");
    showAlert("taskAlert", msg);
  }
}

// ── TASK REWARDS (Manual-Verification Tasks) ─────────────────────
const TASK_META = {
  exchange:        { icon: "💱", inputLabel: "Your exchange UID",       inputPlaceholder: "e.g. 12345678",           proofHint: "Enter the UID shown in your exchange profile" },
  twitter_follow:  { icon: "🐦", inputLabel: "Your X username",         inputPlaceholder: "@yourhandle",             proofHint: "Enter your @handle so we can verify the follow" },
  twitter_retweet: { icon: "🔁", inputLabel: "Link to your retweet",    inputPlaceholder: "https://x.com/…/status/…", proofHint: "Paste the direct link to your retweet" },
  youtube_sub:     { icon: "📺", inputLabel: "Your YouTube username",   inputPlaceholder: "@yourchannel",            proofHint: "Enter your channel handle or username" },
  video_watch:     { icon: "🎥", inputLabel: "Email or username",       inputPlaceholder: "you@example.com",         proofHint: "Enter the email or username you used" },
};

async function loadTaskRewards() {
  try {
    const data = await api("GET", "/eagle/task/my-submissions");
    taskRewards = data.tasks || [];
    renderTaskRewards();
  } catch (err) {
    console.error("[eagle] loadTaskRewards failed:", err);
  }
}

function renderTaskRewards() {
  const el = document.getElementById("tasksList");
  if (!el) return;

  if (!taskRewards.length) {
    el.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-secondary);font-size:13px;">
      No tasks available right now
    </div>`;
    return;
  }

  el.innerHTML = taskRewards.map(t => {
    const meta   = TASK_META[t.type] || { icon: "🔗" };
    const sub    = t.submission;
    const status = (sub?.status || "pending").toLowerCase();

    let actionHtml;
    if (!sub) {
      actionHtml = `<button class="btn btn-primary" style="padding:8px 14px;font-size:12px;"
        data-action="submit-task" data-task-id="${escapeAttr(t.id)}">Start →</button>`;
    } else if (status === "pending") {
      actionHtml = `<span style="font-size:11px;color:var(--accent);font-family:var(--mono);">⏳ Pending review</span>`;
    } else if (status === "approved") {
      actionHtml = `<span style="font-size:11px;color:var(--success);font-family:var(--mono);">✓ +${t.reward} EAGLE</span>`;
    } else if (status === "rejected") {
      actionHtml = `
        <div style="text-align:right;">
          <div style="font-size:10px;color:var(--error);margin-bottom:4px;">Rejected</div>
          <button class="btn" style="padding:6px 10px;font-size:11px;"
            data-action="submit-task" data-task-id="${escapeAttr(t.id)}">Retry</button>
        </div>`;
    }

    return `
      <div class="bonus-box" style="justify-content:space-between;align-items:center;">
        <div style="display:flex;gap:10px;align-items:center;flex:1;min-width:0;">
          <div class="bonus-icon">${meta.icon}</div>
          <div style="min-width:0;">
            <div class="bonus-title">${escapeAttr(t.label)}</div>
            <div class="bonus-desc">+${t.reward} EAGLE · ${escapeAttr(t.description || "")}</div>
          </div>
        </div>
        ${actionHtml}
      </div>
    `;
  }).join("");

  el.querySelectorAll("button[data-action='submit-task']").forEach(btn => {
    btn.addEventListener("click", () => openTaskSubmitModal(btn.dataset.taskId));
  });
}

function openTaskSubmitModal(taskId) {
  const task = taskRewards.find(t => t.id === taskId);
  if (!task) return;

  const meta = TASK_META[task.type] || {};

  document.getElementById("taskSubmitTitle").textContent      = task.label;
  document.getElementById("taskSubmitDesc").textContent       = task.description || "";
  document.getElementById("taskSubmitHint").textContent       = meta.proofHint || "";
  document.getElementById("taskSubmitInputLabel").textContent = meta.inputLabel || "Proof";

  const input = document.getElementById("taskSubmitInput");
  input.placeholder = meta.inputPlaceholder || "";
  input.value = "";
  document.getElementById("taskSubmitError").textContent = "";

  if (task.url) window.open(task.url, "_blank", "noopener");

  document.getElementById("taskSubmitModal").dataset.taskId = taskId;
  document.getElementById("taskSubmitModal").style.display  = "flex";
  input.focus();
}

document.getElementById("taskSubmitBtn")?.addEventListener("click", async () => {
  const modal  = document.getElementById("taskSubmitModal");
  const taskId = modal.dataset.taskId;
  const proof  = document.getElementById("taskSubmitInput").value.trim();
  const errEl  = document.getElementById("taskSubmitError");
  const btn    = document.getElementById("taskSubmitBtn");

  if (!proof || proof.length < 2) {
    errEl.textContent = "Please enter a valid value.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Submitting…";
  errEl.textContent = "";

  try {
    await api("POST", "/eagle/task/submit", { task_id: taskId, proof });
    modal.style.display = "none";
    await loadTaskRewards();
    showAlert("taskAlert", "✅ Submitted! An admin will review it shortly.", "success");
  } catch (err) {
    errEl.textContent = err.message || "Submission failed.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Submit";
  }
});

document.getElementById("taskSubmitCancelBtn")?.addEventListener("click", () => {
  document.getElementById("taskSubmitModal").style.display = "none";
});

// ── AD MODAL (start mining only) ─────────────────────────────────
const ADSTERRA_CONTAINER_ID = "container-c4eea050a5f2ca00d28a707bf918306f";
const ADSTERRA_SRC = "https://pl30518922.effectivecpmnetwork.com/c4eea050a5f2ca00d28a707bf918306f/invoke.js";
const HILLTOP_DIRECT_URL = "https://sorrowfulpsychology.com/br3oVU0.PF3ipMvibPmqV/JxZ-DN0l3-MpjqU/5fMfz/gP1ULnTLcJyoNjTXkxzTO/Dgko";

function maybeOpenDirectLink() {
  try {
    const last = +localStorage.getItem("eagle_dl_last") || 0;
    if (Date.now() - last < 30 * 60 * 1000) return;
    localStorage.setItem("eagle_dl_last", String(Date.now()));
  } catch (_) {}
  window.open(HILLTOP_DIRECT_URL, "_blank", "noopener");
}

const HILLTOP_BANNER_HTML = `<!doctype html><body style="margin:0;overflow:hidden;display:flex;justify-content:center">
<script>
(function(eos){
var d = document,
    s = d.createElement('script'),
    l = d.currentScript || d.scripts[d.scripts.length - 1];
s.settings = eos || {};
s.src = "\/\/prizefamily.com\/bYX\/V\/s.d\/GnlP0\/YWWccE\/ce\/mx9auzZXUWl_koP\/TkcD0fO\/DFIU2ZMVDpkAtCNSzsQp4QM\/jQYexcMqwH";
s.async = true;
s.referrerPolicy = 'no-referrer-when-downgrade';
l.parentNode.insertBefore(s, l);
})({})
</script>
</body>`;

function loadHilltopBannerInto(containerId) {
  const c = document.getElementById(containerId);
  if (!c) return;
  c.innerHTML = "";
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
  f.setAttribute("scrolling", "no");
  f.style.cssText = "width:300px;height:250px;border:0";
  f.srcdoc = HILLTOP_BANNER_HTML;
  c.appendChild(f);
}

function loadFreshAdCreative() {
  const container = document.getElementById("adCreativeContainer");
  if (!container) return;

  container.innerHTML = `<div id="${ADSTERRA_CONTAINER_ID}"></div>`;

  const s = document.createElement("script");
  s.async = true;
  s.dataset.cfasync = "false";
  s.src = ADSTERRA_SRC;
  s.onerror = () => loadHilltopBannerInto("adCreativeContainer");
  container.appendChild(s);
}

let adModalController = null;
let adModalConfirmHandler = null;

function showAdModal({ title = "Watch ad to continue", actionLabel = "Continue", onConfirm } = {}) {
  const modal     = document.getElementById("adModal");
  const titleEl   = document.getElementById("adModalTitle");
  const timerEl   = document.getElementById("adModalTimer");
  const actionBtn = document.getElementById("adModalActionBtn");
  if (!modal || !actionBtn) return;

  if (adModalController) adModalController.cancel();

  if (titleEl) titleEl.textContent = title;
  loadFreshAdCreative();

  actionBtn.disabled = true;
  if (timerEl) timerEl.textContent = `Ad plays for ${AD_WATCH_SECONDS}s…`;

  modal.style.display = "flex";

  adModalController = startCountdown({
    seconds: AD_WATCH_SECONDS,
    onTick: (remaining) => {
      actionBtn.textContent = `Please wait… ${remaining}s`;
      if (timerEl) timerEl.textContent = `Ad plays for ${remaining}s…`;
    },
    onDone: () => {
      actionBtn.disabled = false;
      actionBtn.textContent = actionLabel;
      if (timerEl) timerEl.textContent = "Ad complete!";
    },
  });

  adModalConfirmHandler = async () => {
    hideAdModal();
    if (onConfirm) await onConfirm();
  };
}

function hideAdModal() {
  const modal = document.getElementById("adModal");
  if (modal) modal.style.display = "none";
  if (adModalController) { adModalController.cancel(); adModalController = null; }
  adModalConfirmHandler = null;
}

document.getElementById("adModalActionBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (adModalConfirmHandler) adModalConfirmHandler();
});

document.getElementById("adModalCancelBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  hideAdModal();
});

// ── MINING SESSION SYNC ──────────────────────────────────────────
async function syncMiningSessionFromServer() {
  if (!currentUser?.mining_started_at) {
    miningSession = null;
    stopUiTicker();
    updateMiningUI();
    return;
  }

  const startTime = new Date(currentUser.mining_started_at).getTime();
  const rate      = parseFloat(currentUser.mining_session_rate || currentUser.mining_rate || 1);

  const endTime   = currentUser.mining_ended_at
    ? new Date(currentUser.mining_ended_at).getTime()
    : startTime + SESSION_HOURS * 3600000;

  miningSession = {
    startTime,
    endTime,
    rate,
    coinsAtStart: parseFloat(currentUser.balance || 0),
  };

  startUiTicker();
  updateMiningUI();
}

// ── MINING BUTTON ────────────────────────────────────────────────
document.getElementById("startMiningBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (!currentUser) return;
  if (miningSession) return;

  showAdModal({
    title: "Watch an ad to start mining",
    actionLabel: "Start Mining ▶",
    onConfirm: async () => {
      const btn = document.getElementById("startMiningBtn");
      if (btn) { btn.disabled = true; btn.textContent = "⏳"; }
      await doStartMining();
      if (btn) { btn.disabled = false; btn.textContent = "▶"; }
    },
  });
});

async function doStartMining() {
  try {
    const result = await api("POST", "/eagle/start-mining");
    miningSession = {
      session_id:   result.session_id,
      startTime:    new Date(result.started_at).getTime(),
      endTime:      new Date(result.ended_at).getTime(),
      rate:         result.rate,
      coinsAtStart: parseFloat(currentUser.balance || 0),
    };
    currentUser.mining_rate         = result.rate;
    currentUser.mining_started_at   = result.started_at;
    currentUser.mining_session_rate = result.rate;
    currentUser.mining_ended_at     = result.ended_at;

    startUiTicker();
    updateMiningUI();
    updateAllUI();
  } catch (err) {
    const msg = err.status === 409
      ? "Mining already active. Refresh to sync."
      : (err.message || "Failed to start mining.");
    showAlert("miningAlert", msg);
  }
}

// ── UI TICKER ────────────────────────────────────────────────────
function startUiTicker() {
  stopUiTicker();
  uiTicker = setInterval(async () => {
    if (!miningSession) { stopUiTicker(); return; }

    const now = Date.now();
    if (now >= miningSession.endTime) {
      stopUiTicker();
      miningSession = null;
      updateMiningUI();

      try {
        if (_miningTickAbort) _miningTickAbort.abort();
        _miningTickAbort = new AbortController();
        const result = await api("POST", "/eagle/claim-session", null, { signal: _miningTickAbort.signal });
        currentUser.balance             = result.new_balance;
        currentUser.mining_started_at   = "";
        currentUser.mining_session_rate = 0;
        currentUser.mining_ended_at     = "";
        updateAllUI();
        showAlert("miningAlert",
          `✅ Session complete! Earned ${fmt(result.earned)} EAGLE`, "success");
      } catch (err) {
        if (err.name !== "AbortError") {
          await loadUserData();
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

// ── UPDATE MINING UI ─────────────────────────────────────────────
function updateMiningUI() {
  const btn              = document.getElementById("startMiningBtn");
  const statusText       = document.getElementById("miningStatusText");
  const statusHome       = document.getElementById("miningStatusTextHome");
  const progressCont     = document.getElementById("miningProgressBarContainer");
  const homeProgressCont = document.getElementById("homeMiningProgressBarContainer");

  const rate          = parseFloat(currentUser?.mining_rate || 1);
  const baseRate      = 1.0;
  const bonusPct      = (((rate - baseRate) / baseRate) * 100).toFixed(1);

  setText("baseRate",        baseRate.toFixed(2));
  setText("totalRate",       rate.toFixed(4));
  setText("bonusRateDisplay", `+${bonusPct}%`);

  if (miningSession) {
    const now        = Date.now();
    const elapsed    = (now - miningSession.startTime) / 3600000;
    const totalHrs   = (miningSession.endTime - miningSession.startTime) / 3600000;
    const remaining  = Math.max(0, miningSession.endTime - now);
    const pct        = Math.min(100, (elapsed / totalHrs) * 100);
    const liveCoins  = miningSession.coinsAtStart + elapsed * miningSession.rate;

    if (btn) { btn.textContent = "🔒"; btn.style.background = "#6b7280"; btn.disabled = true; }
    if (statusText) statusText.textContent = "⛏️ Mining… (locked until complete)";
    if (statusHome) statusHome.textContent = "⛏️ Mining… (locked until complete)";

    if (progressCont)     progressCont.style.display = "block";
    if (homeProgressCont) homeProgressCont.style.display = "block";

    const fill = document.getElementById("progressBarFill");
    if (fill) fill.style.width = `${pct.toFixed(1)}%`;
    setText("progressTimePercent", `${pct.toFixed(1)}% · ${fmtDuration(remaining)} left`);
    setText("progressCoinMined",   `~${fmt(elapsed * miningSession.rate)} EAGLE mined`);

    const homeFill = document.getElementById("homeProgressBarFill");
    if (homeFill) homeFill.style.width = `${pct.toFixed(1)}%`;
    setText("homeProgressTimePercent", `${pct.toFixed(1)}% · ${fmtDuration(remaining)} left`);
    setText("homeProgressCoinMined",   `~${fmt(elapsed * miningSession.rate)} EAGLE mined`);

    setText("miningBalance",       fmt(liveCoins));
    setText("miningStatusBalance", fmt(liveCoins));
  } else {
    if (btn) { btn.textContent = "▶"; btn.style.background = ""; btn.disabled = false; }
    if (statusText) statusText.textContent = "Inactive";
    if (statusHome) statusHome.textContent = "Inactive";

    if (progressCont)     progressCont.style.display = "none";
    if (homeProgressCont) homeProgressCont.style.display = "none";

    setText("miningBalance",       fmt(currentUser?.balance));
    setText("miningStatusBalance", fmt(currentUser?.balance));
  }
}

// ── UPDATE ALL UI ────────────────────────────────────────────────
function updateAllUI() {
  if (!currentUser) return;

  const bal    = parseFloat(currentUser.balance       || 0);
  const stored = parseFloat(currentUser.stored_coins  || 0);
  const uname  = currentUser.username || currentUser.name || "User";

  setText("headerBalance", `${fmt(bal, 2)} EAGLE`);

  setText("uname",        uname);
  setText("balanceTop",   `${fmt(bal, 2)} EAGLE`);
  setText("statBalance1", `${fmt(bal, 4)} EAGLE`);
  setText("statStored",   `${fmt(stored, 4)} EAGLE`);

  setText("walletBalance", `${fmt(bal, 4)} EAGLE`);

  setText("profUser",        uname);
  setText("profEmail",       currentUser.email || "");
  setText("profBalance",     `${fmt(bal, 4)} EAGLE`);
  setText("profMemberSince", fmtDate(currentUser.created));

  const profAvatar = document.getElementById("profAvatar");
  if (profAvatar) {
    if (currentUser.avatar) {
      const avatarUrl = `${PB_URL}/api/files/users/${currentUser.id}/${currentUser.avatar}`;
      profAvatar.innerHTML = `<img src="${avatarUrl}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" alt="Avatar" />`;
    } else {
      profAvatar.textContent = "👤";
    }
  }

  const adminLink = document.getElementById("adminConsoleLink");
  if (adminLink) adminLink.style.display = currentUser.is_admin ? "block" : "none";

  updateMiningUI();
}

// ── NAVIGATION ───────────────────────────────────────────────────
document.querySelectorAll("#nav a").forEach(a => {
  a.addEventListener("click", e => {
    e.preventDefault();
    const screen = a.dataset.screen;
    showTab(screen);
    if (screen === "partners") loadReferralStats();
    if (screen === "wallet")   loadTransactions(true);
    if (screen === "mining")   updateMiningUI();
  });
});

document.getElementById("refreshBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  await loadUserData();
  await syncMiningSessionFromServer();
  updateAllUI();
});

// ── REFERRAL ────────────────────────────────────────────────────
function buildReferralLink() {
  const code = currentUser?.referral_code || currentUser?.username || currentUser?.id || "";
  return `${window.location.origin}${window.location.pathname}?ref=${code}`;
}

async function loadReferralStats() {
  try {
    const data = await api("GET", "/eagle/referral-stats");
    setText("totalReferrals",   data.total  || 0);
    setText("activeReferrals",  data.active || 0);
    setText("referralEarnings", fmt(data.earned || 0, 2));
    renderReferralsList(data.referrals || []);
  } catch (_) {}

  setText("referralCode", buildReferralLink() || "—");
}

const REFERRAL_REWARD_DISPLAY = 10;

function renderReferralsList(list) {
  const el = document.getElementById("referralsList");
  if (!el) return;
  if (!list.length) {
    el.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">No referrals yet</div>`;
    return;
  }
  el.innerHTML = list.map(r => `
    <div style="display:flex;justify-content:space-between;align-items:center;
      padding:10px 0;border-bottom:1px solid var(--card-border);">
      <div>
        <div style="font-weight:700;font-size:14px;">${escapeAttr(r.username || "User")}
          ${r.active === false ? '<span style="font-size:10px;color:var(--text-muted);">(inactive)</span>' : ''}</div>
        <div style="font-size:11px;color:var(--text-secondary);">Joined ${fmtDate(r.created)}</div>
      </div>
      <div style="font-size:13px;color:var(--accent);font-weight:600;">+${REFERRAL_REWARD_DISPLAY} EAGLE</div>
    </div>
  `).join("");
}

document.getElementById("copyReferralBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  navigator.clipboard.writeText(buildReferralLink()).then(() => {
    const btn = document.getElementById("copyReferralBtn");
    const orig = btn.textContent;
    btn.textContent = "✅ Copied!";
    setTimeout(() => btn.textContent = orig, 2000);
  });
});

document.getElementById("refreshReferralBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  loadReferralStats();
});

document.getElementById("quickAction")?.addEventListener("click", (e) => {
  e.preventDefault();
  navigator.clipboard.writeText(buildReferralLink()).then(() => {
    alert("✅ Link Copied Successfully!");
  });
});

// ── WALLET — transactions ───────────────────────────────────────
async function loadTransactions(reset = true) {
  const listEl  = document.getElementById("recentList");
  const noEl    = document.getElementById("noTxMsg");
  const moreBtn = document.getElementById("loadMoreTxBtn");
  if (!listEl || _txLoading) return;

  if (reset) _txGeneration += 1;
  const gen = _txGeneration;

  if (reset) {
    _txPage = 1;
    listEl.innerHTML = "";
    if (noEl) noEl.style.display = "none";
  }

  _txLoading = true;
  if (moreBtn) { moreBtn.disabled = true; moreBtn.textContent = "Loading…"; }

  if (_txAbort) _txAbort.abort();
  _txAbort = new AbortController();

  try {
    const records = await pb.collection("transactions").getList(_txPage, 10, {
      filter: `user="${currentUser.id}"`,
      sort:   "-created",
      signal: _txAbort.signal,
    });

    if (gen !== _txGeneration) return;

    if (records.items.length === 0 && reset) {
      if (noEl) noEl.style.display = "block";
      if (moreBtn) moreBtn.style.display = "none";
      return;
    }

    if (noEl) noEl.style.display = "none";

    const html = records.items.map(tx => {
      const sign  = tx.type === "credit" ? "+" : "−";
      const color = tx.type === "credit" ? "#22c55e" : "#ef4444";
      return `
        <div style="display:flex;justify-content:space-between;padding:10px 0;
          border-bottom:1px solid var(--card-border);">
          <div>
            <div style="font-weight:600;font-size:14px;">${escapeAttr(tx.description || tx.type)}</div>
            <div style="font-size:11px;color:var(--text-secondary);">${fmtDate(tx.created)}</div>
          </div>
          <div style="color:${color};font-weight:700;">${sign}${fmt(tx.amount, 4)} EAGLE</div>
        </div>`;
    }).join("");

    listEl.insertAdjacentHTML("beforeend", html);

    if (moreBtn) {
      const hasMore = _txPage < records.totalPages;
      moreBtn.style.display = hasMore ? "block" : "none";
      moreBtn.disabled = false;
      moreBtn.textContent = "Load more";
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    if (gen !== _txGeneration) return;
    if (noEl && reset) noEl.style.display = "block";
    if (moreBtn) moreBtn.style.display = "none";
  } finally {
    if (gen === _txGeneration) _txLoading = false;
    _txAbort = null;
  }
}

document.getElementById("loadMoreTxBtn")?.addEventListener("click", () => {
  _txPage += 1;
  loadTransactions(false);
});

document.getElementById("copyAddrBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  const addr = currentUser?.wallet_address || currentUser?.id || "";
  navigator.clipboard.writeText(addr).then(() => {
    const btn = document.getElementById("copyAddrBtn");
    const orig = btn.textContent;
    btn.textContent = "✅ Copied!";
    setTimeout(() => btn.textContent = orig, 2000);
  });
});

document.getElementById("sendBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  const btn = document.getElementById("sendBtn");
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = "✅ Features available Later";
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
});

document.getElementById("receiveBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  const btn = document.getElementById("receiveBtn");
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = "✅ Features available Later";
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
});

// ── PROFILE ──────────────────────────────────────────────────────
document.getElementById("logoutBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  stopUiTicker();
  clearInterval(taskRewardsTicker);
  if (_miningTickAbort) _miningTickAbort.abort();
  pb.authStore.clear();
  currentUser   = null;
  miningSession = null;
  taskRewards   = [];
  showScreen("authScreen");
});

// ── DELETE ACCOUNT MODAL ─────────────────────────────────────────
let _deleteAccountResolve = null;

function showDeleteAccountModal() {
  return new Promise((resolve) => {
    _deleteAccountResolve = resolve;
    const pwEl  = document.getElementById("deleteAccountPassword");
    const errEl = document.getElementById("deleteAccountError");
    if (pwEl)  pwEl.value = "";
    if (errEl) errEl.textContent = "";
    document.getElementById("deleteAccountModal").style.display = "flex";
    pwEl?.focus();
  });
}

function hideDeleteAccountModal(result) {
  document.getElementById("deleteAccountModal").style.display = "none";
  const r = _deleteAccountResolve;
  _deleteAccountResolve = null;
  if (r) r(result);
}

document.getElementById("deleteAccountCancelBtn")?.addEventListener("click", () => hideDeleteAccountModal(null));
document.getElementById("deleteAccountConfirmBtn")?.addEventListener("click", () => {
  const pw = document.getElementById("deleteAccountPassword")?.value || "";
  hideDeleteAccountModal(pw);
});
document.getElementById("deleteAccountPassword")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("deleteAccountConfirmBtn")?.click();
  }
});

document.getElementById("deleteAccountBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();

  const sure = confirm(
    "This permanently deletes your account, balance, and mining history. This cannot be undone. Continue?"
  );
  if (!sure) return;

  const password = await showDeleteAccountModal();
  if (!password) return;

  const btn = e.currentTarget;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Deleting…";

  try {
    await api("POST", "/eagle/delete-account", { password });
    stopUiTicker();
    clearInterval(taskRewardsTicker);
    pb.authStore.clear();
    currentUser   = null;
    miningSession = null;
    taskRewards   = [];
    alert("Your account has been deleted.");
    showScreen("authScreen");
  } catch (err) {
    if (err.status === 409) {
      alert(err.message || "You have an active mining session — claim it before deleting your account.");
    } else if (err.status === 401) {
      alert("Incorrect password.");
    } else if (err.status === 429) {
      alert(err.message || "Too many attempts. Please wait and try again.");
    } else {
      alert(err.message || "Failed to delete account.");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
});

// ── CHANGE PASSWORD ──────────────────────────────────────────────
document.getElementById("togglePasswordBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  const form = document.getElementById("passwordChangeForm");
  if (form) form.style.display = form.style.display === "none" ? "block" : "none";
});

document.getElementById("changePasswordBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const current = document.getElementById("currentPassword").value;
  const newPass = document.getElementById("newPassword").value;
  const confirm = document.getElementById("confirmNewPassword").value;

  if (!current)           return alert("Enter your current password.");
  if (newPass.length < 6) return alert("New password must be at least 6 characters.");
  if (newPass !== confirm) return alert("Passwords do not match.");

  const btn = document.getElementById("changePasswordBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Loading…"; }

  try {
    await pb.collection("users").update(currentUser.id, {
      oldPassword:     current,
      password:        newPass,
      passwordConfirm: confirm,
    });
    alert("Password changed successfully!");
    document.getElementById("passwordChangeForm").style.display = "none";
    ["currentPassword","newPassword","confirmNewPassword"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
  } catch (err) {
    alert(err?.data?.message || err.message || "Failed — check your current password.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Change Password"; }
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
    const eagle = await window.EagleReady;
    PB_URL = eagle.PB_URL;
    pb     = eagle.pb;
    api    = eagle.api;
  } catch (err) {
    document.getElementById("loadingScreen").innerHTML =
      `<div style="padding:24px;text-align:center;color:#ef4444;">
         <p style="font-weight:700;margin-bottom:8px;">Configuration failed</p>
         <p style="font-size:13px;">${escapeAttr(err.message || "Unable to load app config")}</p>
       </div>`;
    return;
  }

  const refParam = new URLSearchParams(window.location.search).get("ref");
  if (refParam) {
    sessionStorage.setItem("eagle_ref", JSON.stringify({
      code: refParam,
      storedAt: Date.now(),
    }));
    document.getElementById("tabRegister")?.dispatchEvent(new Event("click"));
  }

  if (pb.authStore.isValid && pb.authStore.record) {
    try {
      await pb.collection("users").authRefresh();
      currentUser = pb.authStore.record;

      if (!currentUser.verified) {
        setText("verifyEmail", currentUser.email || "");
        showScreen("verificationScreen");
      } else {
        await initMainApp();
      }
    } catch (_) {
      pb.authStore.clear();
      showScreen("authScreen");
    }
  } else {
    showScreen("authScreen");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}