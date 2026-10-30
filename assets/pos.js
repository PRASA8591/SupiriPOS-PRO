/**
 * SupiriPOS PRO - Main Client-Side Controller
 * Powered by PrasaTek System Solutions (https://pos.prasatek.lk)
 * Multi-Tenant Cloud POS with Real-Time WebSockets & Audio Chimes
 */

// Global Application State
const AppState = {
  currentView: 'landing', // 'landing', 'pos-login', 'workspace'
  currentTab: 'dashboard',// 'dashboard', 'billing', 'items', 'stock', 'users', 'reports'
  currentReportsSubTab: 'sales', // 'sales', 'bincard', 'activity'
  business: null,         // { business_code, name, address, phone, receipt_footer, logo_base64 }
  user: null,             // { username, full_name, role_title, permissions }
  pendingAdminUser: null, // Temporary storage during mandatory first-login password change
  stateVersion: null,     // Track delta changes to prevent heavy DOM thrashing
  items: [],              // In-memory cached catalog of items for 0ms instant operations
  filteredItems: [],
  selectedCategory: 'All',
  cart: [],               // Active bill items
  heldBills: [],          // Held carts in memory / localStorage
  paymentMode: 'Cash',
  currentReceiptFormat: '80mm',
  lastInvoice: null,
  activeReportRange: 'today',
  lowStockItems: [],      // Cache of items below alert threshold for interactive review
  socket: null,
  wsReconnectTimer: null,
  syncInterval: null,
  clockInterval: null,
  registeredBizData: null,// Stores generated credentials card info
  prefilledCredentials: false
};

// ---------------------------------------------------------------------------
// Web Audio Synthesizer (Instant feedback without external sound files)
// ---------------------------------------------------------------------------
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) audioCtx = new AudioContext();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playBeep(type = 'scan') {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;

    if (type === 'scan') {
      // High crisp barcode scanner beep
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1750, now);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (type === 'success') {
      // Pleasant checkout success chime
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.setValueAtTime(659.25, now + 0.09); // E5
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === 'error') {
      // Error buzz
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.start(now);
      osc.stop(now + 0.18);
    } else if (type === 'click') {
      // Soft click
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(400, now);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.start(now);
      osc.stop(now + 0.04);
    }
  } catch (e) {
    // Audio context may be restricted before user interaction
  }
}

// ---------------------------------------------------------------------------
// Toast Notification Engine
// ---------------------------------------------------------------------------
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast-msg toast-${type}`;

  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'warning') icon = '⚠️';
  if (type === 'error') icon = '❌';

  toast.innerHTML = `
    <span style="font-size: 16px;">${icon}</span>
    <div style="flex: 1; word-break: break-word;">${message}</div>
    <span style="cursor: pointer; opacity: 0.6; font-size: 14px;" onclick="this.parentElement.remove()">✕</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'all 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ---------------------------------------------------------------------------
// Client-Side Protection & Security
// ---------------------------------------------------------------------------
function initClientProtection() {
  // Prevent context menu
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showToast("SupiriPOS PRO • Protected POS Terminal", "info", 1500);
  });

  // Block F12, Ctrl+Shift+I, Ctrl+U
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J')) || (e.ctrlKey && e.key === 'u')) {
      e.preventDefault();
      showToast("Developer tools restricted on commercial POS station.", "warning", 2000);
    }
    // F9 or F10 shortcut for Complete Sale
    if ((e.key === 'F9' || e.key === 'F10') && AppState.currentView === 'workspace' && AppState.currentTab === 'billing') {
      e.preventDefault();
      completeSaleAndPrint();
    }
  });
}

// ---------------------------------------------------------------------------
// Real-Time WebSocket Multi-Device Synchronization
// ---------------------------------------------------------------------------
function connectWebSocket(businessCode) {
  if (AppState.socket) {
    try { AppState.socket.close(); } catch (e) { }
    AppState.socket = null;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/${businessCode}`;

  try {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[WS] Real-Time Sync connected to ${businessCode}`);
      updateSyncStatusUI(true);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleRealtimeEvent(data);
      } catch (err) {
        console.error("[WS PARSE ERROR]", err);
      }
    };

    ws.onclose = () => {
      console.warn("[WS] Real-Time Sync disconnected. Reconnecting in 3s...");
      updateSyncStatusUI(false);
      clearTimeout(AppState.wsReconnectTimer);
      AppState.wsReconnectTimer = setTimeout(() => {
        if (AppState.business && AppState.business.business_code === businessCode) {
          connectWebSocket(businessCode);
        }
      }, 3000);
    };

    ws.onerror = (err) => {
      console.error("[WS ERROR]", err);
      updateSyncStatusUI(false);
    };

    AppState.socket = ws;
  } catch (e) {
    console.error("[WS CONNECTION FAILED]", e);
    updateSyncStatusUI(false);
  }
}

function updateSyncStatusUI(isSynced) {
  const statusEl = document.getElementById('ws-sync-status');
  const dotEl = document.getElementById('ws-sync-dot');
  const isBrowserOnline = navigator.onLine !== false;

  if (statusEl) {
    if (!isBrowserOnline) {
      statusEl.textContent = "Offline";
      statusEl.style.color = "var(--danger)";
      if (dotEl) dotEl.style.backgroundColor = "var(--danger)";
    } else if (isSynced) {
      statusEl.textContent = "Online • Synced";
      statusEl.style.color = "var(--emerald)";
      if (dotEl) dotEl.style.backgroundColor = "var(--emerald)";
    } else {
      statusEl.textContent = "Offline";
      statusEl.style.color = "var(--danger)";
      if (dotEl) dotEl.style.backgroundColor = "var(--danger)";
    }
  }
}

function handleRealtimeEvent(event) {
  console.log("[REALTIME EVENT RECEIVED]", event);

  if (event.type === 'ITEMS_UPDATED') {
    loadItemsCatalog(AppState.currentTab === 'billing');
    if (AppState.currentTab === 'dashboard') loadDashboardStats();
    if (AppState.currentTab === 'items') loadItemsTable();
    showToast("Product catalog updated by another terminal.", "info", 2500);
  } else if (event.type === 'STOCK_UPDATED') {
    const item = AppState.items.find(i => i.id === event.item_id);
    if (item) {
      item.stock_quantity = event.new_stock;
      if (AppState.currentTab === 'billing') renderBillingItemsGrid();
      if (AppState.currentTab === 'stock') loadStockPage();
      if (AppState.currentTab === 'dashboard') loadDashboardStats();
    }
  } else if (event.type === 'INVOICE_CREATED') {
    loadItemsCatalog(AppState.currentTab === 'billing');
    if (AppState.currentTab === 'dashboard') loadDashboardStats();
    if (AppState.currentTab === 'reports') loadReportsData();
    if (AppState.currentTab === 'stock') loadStockLogs();
  } else if (event.type === 'INVOICE_VOIDED') {
    loadItemsCatalog(AppState.currentTab === 'billing');
    if (AppState.currentTab === 'dashboard') loadDashboardStats();
    if (AppState.currentTab === 'reports') loadReportsData();
    if (AppState.currentTab === 'stock') loadStockLogs();
    showToast(`Invoice #${event.invoice_number} voided. Stock restored.`, "warning", 3000);
  } else if (event.type === 'USERS_UPDATED') {
    if (AppState.currentTab === 'users') loadUsersTable();
    if (AppState.currentTab === 'dashboard') loadDashboardStats();
  }
}

// Smart Delta Sync Polling (8s interval, skips re-render if state_version unchanged or user is typing)
function startPollingFallback() {
  clearInterval(AppState.syncInterval);
  AppState.syncInterval = setInterval(async () => {
    if (!AppState.business) return;
    // Skip re-render if user is actively typing in an input or textarea
    const activeEl = document.activeElement;
    const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
    if (isTyping) return;

    try {
      const res = await fetch(`/api/sync/state?business_code=${AppState.business.business_code}`);
      if (res.ok) {
        updateSyncStatusUI(true);
      }
      const data = await res.json();
      if (AppState.stateVersion !== null && data.state_version !== AppState.stateVersion) {
        AppState.stateVersion = data.state_version;
        await loadItemsCatalog(AppState.currentTab === 'billing');
        if (AppState.currentTab === 'dashboard') loadDashboardStats();
      } else if (AppState.stateVersion === null) {
        AppState.stateVersion = data.state_version;
      }
      checkSystemHealth();
    } catch (e) {
      updateSyncStatusUI(false);
    }
  }, 8000);
}

// ---------------------------------------------------------------------------
// View & Screen Transitions
// ---------------------------------------------------------------------------
function showView(viewId) {
  document.getElementById('view-landing').style.display = 'none';
  document.getElementById('view-pos-login').style.display = 'none';
  document.getElementById('view-workspace').style.display = 'none';

  AppState.currentView = viewId;

  if (viewId === 'landing') {
    document.getElementById('view-landing').style.display = 'flex';
  } else if (viewId === 'pos-login') {
    document.getElementById('view-pos-login').style.display = 'flex';
  } else if (viewId === 'workspace') {
    document.getElementById('view-workspace').style.display = 'flex';
  }
}

function returnToLanding() {
  playBeep('click');
  showView('landing');
}

function switchBusinessTerminal() {
  playBeep('click');
  AppState.business = null;
  AppState.user = null;
  AppState.prefilledCredentials = false;
  localStorage.removeItem('supiripos_biz_session');
  localStorage.removeItem('supiripos_user_session');
  if (AppState.socket) {
    try { AppState.socket.close(); } catch (e) { }
    AppState.socket = null;
  }
  const uCode = document.getElementById('unlock-biz-code');
  const uPass = document.getElementById('unlock-biz-pass');
  if (uCode) uCode.value = '';
  if (uPass) uPass.value = '';
  showView('landing');
  showToast("Terminal unlocked from business.", "info");
}

function logoutStaffUser() {
  playBeep('click');
  if (AppState.business && AppState.user) {
    fetch(`/api/auth/pos-logout?business_code=${encodeURIComponent(AppState.business.business_code)}&username=${encodeURIComponent(AppState.user.username)}`, {
      method: 'POST'
    }).catch(() => { });
  }
  AppState.user = null;
  AppState.prefilledCredentials = false;
  localStorage.removeItem('supiripos_user_session');
  const uInput = document.getElementById('pos-login-username');
  const pInput = document.getElementById('pos-login-password');
  if (uInput) uInput.value = '';
  if (pInput) pInput.value = '';
  showView('pos-login');
  showToast("Staff logged out. Terminal remains locked to business.", "info");
}

// ---------------------------------------------------------------------------
// 3 Landing Gateways
// ---------------------------------------------------------------------------

// Gateway 1: Instant Demo Supermarket (PT-DEMO)
async function launchInstantDemo() {
  playBeep('click');
  showToast("⚡ Connecting to Colombo Supermarket Demo (PT-DEMO)...", "info", 2000);

  try {
    // 1. Unlock PT-DEMO
    const unlockRes = await fetch('/api/auth/unlock-business', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_code: 'PT-DEMO', business_password: '123' })
    });
    const unlockData = await unlockRes.json();
    if (!unlockRes.ok) throw new Error(unlockData.detail || 'Demo unlock failed');

    AppState.business = unlockData.business;

    // 2. POS Login as default admin user
    const loginRes = await fetch('/api/auth/pos-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_code: 'PT-DEMO', username: 'user', password: '123' })
    });
    const loginData = await loginRes.json();
    if (!loginRes.ok) throw new Error(loginData.detail || 'Demo login failed');

    AppState.user = loginData.user;

    // Save to localStorage
    localStorage.setItem('supiripos_biz_session', JSON.stringify(AppState.business));
    localStorage.setItem('supiripos_user_session', JSON.stringify(AppState.user));

    playBeep('success');
    showToast("🎉 Welcome to Supiri Mart Supermarket (PT-DEMO)!", "success", 3000);
    enterWorkspace();
  } catch (err) {
    showToast(`Failed to launch demo: ${err.message}`, "error");
  }
}

// Gateway 2: Business Registration Wizard Modals
function openRegistrationModal() {
  playBeep('click');
  document.getElementById('modal-register').classList.add('active');
  goToRegStep(1);
}

function closeRegistrationModal() {
  playBeep('click');
  document.getElementById('modal-register').classList.remove('active');
}

function goToRegStep(step) {
  document.getElementById('reg-step-number').textContent = step;

  // Toggle step panels
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`reg-step-${i}`);
    const bar = document.getElementById(`reg-bar-${i}`);
    if (el) el.style.display = (i === step) ? 'block' : 'none';
    if (bar) bar.style.background = (i <= step) ? 'var(--emerald)' : 'rgba(255,255,255,0.1)';
  }
}

async function sendRegistrationOTP() {
  const email = document.getElementById('reg-email').value.trim();
  if (!email || !email.includes('@')) {
    showToast("Please enter a valid email address.", "warning");
    return;
  }

  showToast("Sending OTP verification code...", "info", 1500);

  try {
    const res = await fetch('/api/auth/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to send OTP');

    // Show OTP input
    document.getElementById('reg-otp-group').style.display = 'block';

    // Highlight OTP in developer toast banner for effortless testing!
    showToast(`✅ OTP Generated: ${data.otp_code} (Check email or enter this code)`, "success", 7000);
    playBeep('click');
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function verifyOTPAndGoStep2() {
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-master-password').value.trim();
  const otp = document.getElementById('reg-otp-code').value.trim();

  if (!email || !password) {
    showToast("Please fill in email and master password.", "warning");
    return;
  }
  if (!otp) {
    showToast("Please enter the 6-digit OTP code sent to your email.", "warning");
    return;
  }

  try {
    const res = await fetch('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp_code: otp })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'OTP verification failed');

    playBeep('success');
    showToast("Email verified successfully!", "success");
    goToRegStep(2);
  } catch (err) {
    showToast(err.message, "error");
  }
}

let uploadedLogoBase64 = "";
function handleLogoUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      // Compress and resize to max 240px wide for optimal thermal printing
      const canvas = document.createElement('canvas');
      const maxW = 240;
      const scale = Math.min(1, maxW / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      uploadedLogoBase64 = canvas.toDataURL('image/png', 0.85);

      const preview = document.getElementById('reg-logo-preview');
      preview.src = uploadedLogoBase64;
      document.getElementById('reg-logo-preview-box').style.display = 'block';
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

async function completeBusinessRegistration() {
  const email = document.getElementById('reg-email').value.trim();
  const masterPassword = document.getElementById('reg-master-password').value.trim();
  const ownerName = document.getElementById('reg-owner-name').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  const nic = document.getElementById('reg-nic').value.trim();
  const shopName = document.getElementById('reg-shop-name').value.trim();
  const address = document.getElementById('reg-address').value.trim();
  const footer = document.getElementById('reg-receipt-footer').value.trim();

  if (!shopName || !address) {
    showToast("Shop Name and Address are mandatory.", "warning");
    return;
  }

  showToast("Registering business & provisioning database...", "info", 2000);

  try {
    const res = await fetch('/api/auth/register-business', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        master_password: masterPassword,
        owner_name: ownerName,
        phone,
        nic,
        shop_name: shopName,
        address,
        receipt_footer: footer,
        logo_base64: uploadedLogoBase64
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Registration failed');

    AppState.registeredBizData = data;

    // Fill Credentials Card
    document.getElementById('card-shop-name').textContent = data.shop_name;
    document.getElementById('card-business-code').textContent = data.business_code;
    document.getElementById('card-master-password').textContent = data.master_password;

    playBeep('success');
    showToast(`🎉 Registration Complete! Your Code: ${data.business_code}`, "success", 4000);
    goToRegStep(4);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Download Branded Credentials Card as PNG
function downloadCredentialsCard() {
  const data = AppState.registeredBizData;
  if (!data) return;

  const canvas = document.createElement('canvas');
  canvas.width = 680;
  canvas.height = 420;
  const ctx = canvas.getContext('2d');

  // Background
  const gradient = ctx.createLinearGradient(0, 0, 680, 420);
  gradient.addColorStop(0, '#0b1120');
  gradient.addColorStop(1, '#0f172a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 680, 420);

  // Border
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, 660, 400);

  // Title & Header
  ctx.fillStyle = '#10b981';
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText('SupiriPOS PRO', 36, 54);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '13px sans-serif';
  ctx.fillText('POWERED BY PRASATEK SYSTEM SOLUTIONS (pos.prasatek.lk)', 36, 76);

  // Shop Name
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(data.shop_name, 36, 126);

  // Business Code Box
  ctx.fillStyle = 'rgba(6, 182, 212, 0.15)';
  ctx.fillRect(36, 150, 280, 80);
  ctx.strokeStyle = '#06b6d4';
  ctx.strokeRect(36, 150, 280, 80);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px sans-serif';
  ctx.fillText('ASSIGNED BUSINESS CODE:', 50, 175);
  ctx.fillStyle = '#06b6d4';
  ctx.font = 'bold 30px monospace';
  ctx.fillText(data.business_code, 50, 212);

  // Master Password Box
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.fillRect(340, 150, 300, 80);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.strokeRect(340, 150, 300, 80);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px sans-serif';
  ctx.fillText('BUSINESS MASTER PASSWORD:', 354, 175);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px monospace';
  ctx.fillText(data.master_password, 354, 210);

  // Staff Login Details
  ctx.fillStyle = 'rgba(16, 185, 129, 0.12)';
  ctx.fillRect(36, 250, 604, 70);
  ctx.strokeStyle = '#10b981';
  ctx.strokeRect(36, 250, 604, 70);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px sans-serif';
  ctx.fillText('DEFAULT CASHIER / STAFF LOGIN (FULL ACCESS):', 50, 275);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px monospace';
  ctx.fillText(`Username: ${data.default_staff_username}   |   Password: ${data.default_staff_password}`, 50, 304);

  // Footer
  ctx.fillStyle = '#64748b';
  ctx.font = '12px sans-serif';
  ctx.fillText('Keep this card safe. Access your POS station anytime at https://pos.prasatek.lk', 36, 370);

  // Download trigger
  const link = document.createElement('a');
  link.download = `SupiriPOS_Credentials_${data.business_code}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();

  showToast("Credentials card downloaded!", "success");
}

function proceedToUnlockedTerminal() {
  const data = AppState.registeredBizData;
  if (!data) return;
  closeRegistrationModal();

  // Pre-fill terminal unlock modal ONLY right after registration wizard completes
  AppState.prefilledCredentials = true;
  document.getElementById('unlock-biz-code').value = data.business_code;
  document.getElementById('unlock-biz-pass').value = data.master_password;
  openUnlockBizModal(true);
}

// Gateway 3: Business Terminal Unlock
function openUnlockBizModal(keepPrefill = false) {
  playBeep('click');
  if (!keepPrefill && !AppState.prefilledCredentials) {
    const codeEl = document.getElementById('unlock-biz-code');
    const passEl = document.getElementById('unlock-biz-pass');
    if (codeEl) codeEl.value = '';
    if (passEl) passEl.value = '';
  }
  document.getElementById('modal-unlock-biz').classList.add('active');
  document.getElementById('unlock-biz-code').focus();
}

function closeUnlockBizModal() {
  playBeep('click');
  document.getElementById('modal-unlock-biz').classList.remove('remove');
  document.getElementById('modal-unlock-biz').classList.remove('active');
}

async function handleUnlockBiz(e) {
  e.preventDefault();
  const code = document.getElementById('unlock-biz-code').value.trim().toUpperCase();
  const password = document.getElementById('unlock-biz-pass').value.trim();

  if (!code || !password) {
    showToast("Please enter business code and password.", "warning");
    return;
  }

  showToast("Unlocking terminal...", "info", 1500);

  try {
    const res = await fetch('/api/auth/unlock-business', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_code: code, business_password: password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Terminal unlock failed');

    AppState.business = data.business;
    localStorage.setItem('supiripos_biz_session', JSON.stringify(AppState.business));

    closeUnlockBizModal();
    playBeep('success');
    showToast(`Terminal unlocked for ${data.business.name}!`, "success");

    // Transition to Stage 2: Staff Login
    openPOSStaffLogin();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Stage 2: POS Staff Login Screen
// ---------------------------------------------------------------------------
function openPOSStaffLogin() {
  const biz = AppState.business;
  if (!biz) {
    showView('landing');
    return;
  }

  document.getElementById('staff-login-biz-name').textContent = biz.name;
  document.getElementById('staff-login-biz-code').textContent = biz.business_code;
  if (biz.logo_base64) {
    document.getElementById('staff-login-biz-logo').src = biz.logo_base64;
  }

  const uInput = document.getElementById('pos-login-username');
  const pInput = document.getElementById('pos-login-password');
  if (AppState.prefilledCredentials && AppState.registeredBizData) {
    if (uInput) uInput.value = 'user';
    if (pInput) pInput.value = '123';
    AppState.prefilledCredentials = false;
  } else {
    if (uInput) uInput.value = '';
    if (pInput) pInput.value = '';
  }

  showView('pos-login');
  if (uInput) uInput.focus();
}

async function handlePOSLogin(e) {
  e.preventDefault();
  const username = document.getElementById('pos-login-username').value.trim();
  const password = document.getElementById('pos-login-password').value.trim();

  if (!username || !password) {
    showToast("Please enter cashier username and password.", "warning");
    return;
  }

  try {
    const res = await fetch('/api/auth/pos-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_code: AppState.business.business_code,
        username,
        password
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Invalid staff credentials');

    // Check if mandatory first-time credential change is required (default user / 123)
    if (data.user.must_change_password) {
      AppState.pendingAdminUser = data.user;
      openSecureAdminModal(data.user);
      return;
    }

    AppState.user = data.user;
    localStorage.setItem('supiripos_user_session', JSON.stringify(AppState.user));

    playBeep('success');
    showToast(`Welcome, ${data.user.full_name}! Shift opened.`, "success");
    enterWorkspace();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Mandatory First-Time Admin Credential Change Modal
function openSecureAdminModal(userObj) {
  playBeep('warning');
  document.getElementById('secure-admin-fullname').value = (userObj.full_name && userObj.full_name !== 'Default Admin') ? userObj.full_name : (AppState.business?.owner_name || '');
  document.getElementById('secure-admin-username').value = '';
  document.getElementById('secure-admin-password').value = '';
  document.getElementById('secure-admin-confirm').value = '';
  document.getElementById('modal-secure-admin').classList.add('active');
  document.getElementById('secure-admin-username').focus();
}

async function handleSecureAdminSubmit(e) {
  e.preventDefault();
  const fullName = document.getElementById('secure-admin-fullname').value.trim();
  const newUsername = document.getElementById('secure-admin-username').value.trim();
  const newPassword = document.getElementById('secure-admin-password').value.trim();
  const confirmPassword = document.getElementById('secure-admin-confirm').value.trim();

  if (newUsername.toLowerCase() === 'user') {
    showToast("Please choose a personal username other than default 'user'.", "warning");
    return;
  }
  if (newPassword === '123' || newPassword.length < 4) {
    showToast("Please choose a strong password (at least 4 characters, not '123').", "warning");
    return;
  }
  if (newPassword !== confirmPassword) {
    showToast("Passwords do not match! Please re-check.", "error");
    return;
  }

  try {
    const res = await fetch('/api/auth/change-initial-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_code: AppState.business.business_code,
        user_id: AppState.pendingAdminUser.id,
        new_username: newUsername,
        new_password: newPassword,
        full_name: fullName || 'Store Admin'
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to update admin credentials');

    document.getElementById('modal-secure-admin').classList.remove('active');
    AppState.user = data.user;
    AppState.pendingAdminUser = null;
    localStorage.setItem('supiripos_user_session', JSON.stringify(AppState.user));

    playBeep('success');
    showToast("🔐 Admin credentials secured! Opening POS workspace...", "success", 3500);
    enterWorkspace();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Workspace & Navigation (6 Strictly Isolated Tabs)
// ---------------------------------------------------------------------------
function enterWorkspace() {
  const biz = AppState.business;
  const user = AppState.user;

  // Header Details (Compact username, role hidden below 2xl so navbar never overflows)
  document.getElementById('ws-shop-name').textContent = biz.name;
  document.getElementById('ws-shop-name').title = biz.name;
  document.getElementById('ws-shop-code').textContent = biz.business_code;
  if (biz.logo_base64) {
    document.getElementById('ws-shop-logo').src = biz.logo_base64;
  }
  const staffUserEl = document.getElementById('ws-staff-user');
  if (staffUserEl) {
    staffUserEl.textContent = user.full_name || user.username || 'Admin';
    staffUserEl.title = `${user.full_name} • ${user.role_title}`;
  }
  const staffRoleEl = document.getElementById('ws-staff-role');
  if (staffRoleEl) {
    staffRoleEl.textContent = `• ${user.role_title || 'Manager'}`;
  }

  // Apply Role-Based Granular Page Access
  const perms = user.permissions || { billing: true, items: true, stock: true, users: true, reports: true };
  const canViewDashboard = Boolean(perms.reports || perms.users || perms.stock || perms.items);

  document.getElementById('nav-btn-dashboard').style.display = canViewDashboard ? 'inline-flex' : 'none';
  document.getElementById('nav-btn-billing').style.display = perms.billing ? 'inline-flex' : 'none';
  document.getElementById('nav-btn-items').style.display = perms.items ? 'inline-flex' : 'none';
  document.getElementById('nav-btn-stock').style.display = perms.stock ? 'inline-flex' : 'none';
  document.getElementById('nav-btn-users').style.display = perms.users ? 'inline-flex' : 'none';
  document.getElementById('nav-btn-reports').style.display = perms.reports ? 'inline-flex' : 'none';

  // Default landing tab: Overview Dashboard for Admin/Managers, Billing for Cashiers
  let initialTab = 'dashboard';
  if (!perms.reports && !perms.users && perms.billing) {
    initialTab = 'billing';
  } else if (!canViewDashboard) {
    initialTab = 'billing';
  }

  showView('workspace');

  // Connect WebSocket for real-time multi-device sync
  checkSystemHealth();
  connectWebSocket(biz.business_code);
  startPollingFallback();
  startClock();

  // Load Held Bills from localStorage
  loadHeldBills();

  // Pre-load items catalog in memory for 0ms instant search & tab switching
  loadItemsCatalog(true).then(() => {
    switchPOSTab(initialTab);
  });
}

function switchPOSTab(tab) {
  playBeep('click');
  AppState.currentTab = tab;

  // Strict Tab Isolation across all 6 main tabs
  const tabs = ['dashboard', 'billing', 'items', 'stock', 'users', 'reports'];
  tabs.forEach(t => {
    const btn = document.getElementById(`nav-btn-${t}`);
    const sec = document.getElementById(`tab-${t}`);
    const isActive = (t === tab);

    if (btn) {
      btn.className = isActive ? 'btn btn-sm btn-cyan' : 'btn btn-sm btn-glass';
    }
    if (sec) {
      sec.classList.remove('active-tab-flex', 'active-tab-grid');
      if (isActive) {
        if (t === 'billing') {
          sec.classList.add('active-tab-grid');
          sec.style.display = 'grid';
        } else {
          sec.classList.add('active-tab-flex');
          sec.style.display = 'flex';
        }
      } else {
        sec.style.display = 'none';
      }
    }
  });

  // Reset scroll position of workspace main container
  const mainContainer = document.querySelector('#view-workspace > main');
  if (mainContainer) mainContainer.scrollTop = 0;

  // Instant 0ms render from in-memory cache + async background refresh
  if (tab === 'dashboard') {
    loadDashboardStats();
  } else if (tab === 'billing') {
    renderBillingItemsGrid();
    const searchInput = document.getElementById('billing-search-input');
    if (searchInput) searchInput.focus();
  } else if (tab === 'items') {
    loadItemsTable();
  } else if (tab === 'stock') {
    loadStockPage();
  } else if (tab === 'users') {
    loadUsersTable();
  } else if (tab === 'reports') {
    switchReportsSubTab(AppState.currentReportsSubTab || 'sales');
  }
}

// ---------------------------------------------------------------------------
// PAGE 0: 📊 OVERVIEW DASHBOARD & INTERACTIVE LOW STOCK ALERTS
// ---------------------------------------------------------------------------
async function loadDashboardStats() {
  if (!AppState.business) return;
  try {
    const res = await fetch(`/api/dashboard/stats?business_code=${encodeURIComponent(AppState.business.business_code)}`);
    const data = await res.json();
    if (!res.ok) return;

    const todayBills = Number(data.today_bills ?? data.today_count ?? 0);
    let staffCount = Number(data.active_staff_count || data.active_users || AppState.users?.length || 0);
    if (!staffCount || staffCount < 1) {
      try {
        const uRes = await fetch(`/api/users?business_code=${encodeURIComponent(AppState.business.business_code)}`);
        const uList = await uRes.json();
        if (Array.isArray(uList)) {
          AppState.users = uList;
          staffCount = Math.max(uList.length, 1);
        } else {
          staffCount = 1;
        }
      } catch (e) {
        staffCount = 1;
      }
    }

    document.getElementById('dash-kpi-today-sales').textContent = `Rs. ${(data.today_sales || 0).toFixed(2)}`;
    document.getElementById('dash-kpi-today-bills').textContent = `${todayBills} bills completed today`;
    document.getElementById('dash-kpi-week-sales').textContent = `Rs. ${(data.week_sales || 0).toFixed(2)}`;
    document.getElementById('dash-kpi-month-sales').textContent = `Rs. ${(data.month_sales || 0).toFixed(2)}`;
    document.getElementById('dash-kpi-total-items').textContent = data.total_products || AppState.items?.length || 0;
    document.getElementById('dash-kpi-staff-count').textContent = staffCount;
    document.getElementById('dash-kpi-low-stock').textContent = data.low_stock_count || 0;

    AppState.lowStockItems = data.low_stock_items || [];

    // Recent 5 Invoices Live Feed
    const recentBody = document.getElementById('dash-recent-invoices-body');
    if (recentBody) {
      const recent = data.recent_invoices || [];
      if (recent.length === 0) {
        recentBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--text-dim);">No invoices recorded yet today.</td></tr>`;
      } else {
        recentBody.innerHTML = recent.map(inv => {
          const isVoid = inv.status === 'VOIDED';
          const dt = new Date(inv.date_time).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          return `
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.04); ${isVoid ? 'opacity: 0.5;' : ''}">
              <td style="padding: 10px; font-family: var(--font-mono); font-weight: 700; color: var(--cyan);">${inv.invoice_number}</td>
              <td style="padding: 10px; color: var(--text-muted); font-size: 12px;">${dt}</td>
              <td style="padding: 10px;">👤 ${inv.cashier_username}</td>
              <td style="padding: 10px; text-align: right; font-family: var(--font-mono); font-weight: 700; color: var(--emerald);">Rs. ${Number(inv.grand_total).toFixed(2)}</td>
              <td style="padding: 10px; text-align: center;"><span class="badge">${inv.payment_method}</span></td>
              <td style="padding: 10px; text-align: center;">
                ${isVoid ? '<span class="badge badge-danger">VOIDED</span>' : '<span class="badge badge-emerald">PAID</span>'}
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    // Top Selling Items Leaderboard
    const topList = document.getElementById('dash-top-selling-list');
    if (topList) {
      const topItems = data.top_selling_items || [];
      if (topItems.length === 0) {
        topList.innerHTML = `<div style="text-align:center; padding: 24px; color: var(--text-dim);">Complete sales to view top-performing products.</div>`;
      } else {
        topList.innerHTML = topItems.map((item, idx) => {
          const qtyVal = Number(item.qty_sold || item.quantity || item.qty || item.total_qty || item.sold || item.count || 5);
          return `
          <div style="display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-glass); border-radius: 10px;">
            <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
              <span class="badge ${idx === 0 ? 'badge-emerald' : 'badge-cyan'}" style="font-family: var(--font-mono);">#${idx + 1}</span>
              <div style="min-width: 0;">
                <div style="font-size: 13px; font-weight: 700; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.name}</div>
                <div style="font-size: 11px; color: var(--text-muted);">${qtyVal} units sold</div>
              </div>
            </div>
            <div style="font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--emerald); flex-shrink: 0;">
              Rs. ${Number(item.revenue || 0).toFixed(2)}
            </div>
          </div>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.error("[DASHBOARD STATS ERROR]", err);
  }
}

function openLowStockModal() {
  playBeep('click');
  const items = AppState.lowStockItems.length > 0
    ? AppState.lowStockItems
    : AppState.items.filter(i => i.stock_quantity <= i.low_stock_level);

  document.getElementById('low-stock-modal-count').textContent = `${items.length} Items`;
  const tbody = document.getElementById('low-stock-modal-table-body');

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 28px; color: var(--emerald); font-weight: 600;">✅ All products are well-stocked above alert thresholds!</td></tr>`;
  } else {
    tbody.innerHTML = items.map(item => {
      const isOut = item.stock_quantity <= 0;
      const badge = isOut
        ? `<span class="badge badge-danger">OUT OF STOCK (0 ${item.unit})</span>`
        : `<span class="badge badge-warning">${item.stock_quantity} ${item.unit}</span>`;
      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
          <td style="padding: 10px; font-family: var(--font-mono); font-size: 12px; color: var(--text-muted);">${item.code}</td>
          <td style="padding: 10px; font-weight: 700; color: #ffffff;">${item.name}</td>
          <td style="padding: 10px; color: var(--text-muted);">${item.category || 'General'}</td>
          <td style="padding: 10px; text-align: center;">${badge}</td>
          <td style="padding: 10px; text-align: center; font-family: var(--font-mono); color: var(--text-dim);">${item.low_stock_level} ${item.unit}</td>
          <td style="padding: 10px; text-align: right;">
            <button class="btn btn-sm btn-emerald" onclick="quickRestockItem(${item.id})">➕ Restock Now</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  document.getElementById('modal-low-stock').classList.add('active');
}

function closeLowStockModal() {
  playBeep('click');
  document.getElementById('modal-low-stock').classList.remove('active');
}

function quickRestockItem(itemId) {
  closeLowStockModal();
  switchPOSTab('stock');
  setTimeout(() => {
    const selectEl = document.getElementById('stock-adjust-item');
    const typeEl = document.getElementById('stock-adjust-type');
    const qtyEl = document.getElementById('stock-adjust-qty');
    if (selectEl) selectEl.value = String(itemId);
    if (typeEl) typeEl.value = 'IN';
    if (qtyEl) qtyEl.focus();
  }, 100);
}

function startClock() {
  clearInterval(AppState.clockInterval);
  const update = () => {
    const el = document.getElementById('ws-clock');
    if (el) {
      const now = new Date();
      el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  };
  update();
  AppState.clockInterval = setInterval(update, 1000);
}

function toggleFullscreen() {
  playBeep('click');
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => { });
  } else {
    document.exitFullscreen().catch(() => { });
  }
}

// ---------------------------------------------------------------------------
// PAGE 1: 🛒 BILLING TERMINAL & ACTIVE CART
// ---------------------------------------------------------------------------
async function loadItemsCatalog(refreshUI = true) {
  if (!AppState.business) return;
  try {
    const res = await fetch(`/api/items?business_code=${AppState.business.business_code}`);
    AppState.items = await res.json();
    AppState.filteredItems = [...AppState.items];
    if (refreshUI) {
      renderBillingItemsGrid();
    }
  } catch (err) {
    console.error("[CATALOG LOAD ERROR]", err);
  }
}

function selectBillingCategory(category) {
  playBeep('click');
  AppState.selectedCategory = category;

  // Highlight category button
  const buttons = document.querySelectorAll('#billing-categories-bar button');
  buttons.forEach(btn => {
    if (btn.textContent.trim().toLowerCase() === category.toLowerCase() || (category === 'All' && btn.textContent.includes('All'))) {
      btn.className = 'btn btn-sm btn-cyan';
    } else {
      btn.className = 'btn btn-sm btn-glass';
    }
  });

  filterBillingItems();
}

function filterBillingItems() {
  const query = document.getElementById('billing-search-input').value.trim().toLowerCase();
  const cat = AppState.selectedCategory;

  AppState.filteredItems = AppState.items.filter(item => {
    const matchesCat = (cat === 'All') || (item.category && item.category.toLowerCase() === cat.toLowerCase());
    const matchesQuery = !query || item.name.toLowerCase().includes(query) || item.code.toLowerCase().includes(query);
    return matchesCat && matchesQuery;
  });

  renderBillingItemsGrid();
}

function handleBarcodeEnter(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const query = document.getElementById('billing-search-input').value.trim();
    if (!query) return;

    // Search for exact match
    const match = AppState.items.find(i => i.code.toLowerCase() === query.toLowerCase() || i.name.toLowerCase() === query.toLowerCase());
    if (match) {
      addToCart(match);
      document.getElementById('billing-search-input').value = '';
      filterBillingItems();
    } else {
      playBeep('error');
      showToast(`No item found matching "${query}"`, "warning", 2000);
    }
  }
}

function renderBillingItemsGrid() {
  const container = document.getElementById('billing-items-grid');
  if (!container) return;

  if (AppState.filteredItems.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: var(--text-dim); padding: 40px 0;">
        No products found in this category.
      </div>
    `;
    return;
  }

  container.innerHTML = AppState.filteredItems.map(item => {
    let stockBadge = `<span class="badge badge-emerald" style="font-size: 10px;">${item.stock_quantity} ${item.unit}</span>`;
    if (item.stock_quantity <= 0) {
      stockBadge = `<span class="badge badge-danger" style="font-size: 10px;">Out of Stock</span>`;
    } else if (item.stock_quantity <= item.low_stock_level) {
      stockBadge = `<span class="badge badge-warning" style="font-size: 10px;">Low: ${item.stock_quantity}</span>`;
    }

    return `
      <div class="glass-panel glass-panel-interactive" style="padding: 14px; cursor: pointer; display: flex; flex-direction: column; justify-content: space-between; position: relative;" onclick="addToCartById(${item.id})">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: start; gap: 6px; margin-bottom: 6px;">
            <span style="font-family: var(--font-mono); font-size: 10px; color: var(--text-dim);">${item.code}</span>
            ${stockBadge}
          </div>
          <div style="font-size: 13px; font-weight: 700; color: #ffffff; line-height: 1.3; margin-bottom: 6px;">
            ${item.name}
          </div>
          <div style="font-size: 11px; color: var(--text-dim);">${item.category || 'General'}</div>
        </div>

        <div style="margin-top: 10px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-glass); padding-top: 8px;">
          <div style="font-size: 15px; font-weight: 800; color: var(--cyan); font-family: var(--font-mono);">
            Rs. ${item.selling_price.toFixed(2)}
          </div>
          <button class="btn btn-sm btn-cyan" style="padding: 4px 8px; font-size: 11px;" onclick="event.stopPropagation(); addToCartById(${item.id})">
            + Add
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function addToCartById(itemId) {
  const item = AppState.items.find(i => i.id === itemId);
  if (item) addToCart(item);
}

function addToCart(item) {
  playBeep('scan');

  // Check if item already exists in cart
  const existing = AppState.cart.find(c => c.item_id === item.id);
  if (existing) {
    existing.quantity += 1;
    existing.total = (existing.quantity * existing.selling_price) - existing.discount;
  } else {
    AppState.cart.push({
      item_id: item.id,
      code: item.code,
      name: item.name,
      unit: item.unit,
      cost_price: item.cost_price,
      selling_price: item.selling_price,
      quantity: 1,
      discount: 0,
      total: item.selling_price
    });
  }

  renderCartUI();
}

function updateCartQty(index, delta) {
  playBeep('click');
  const cartItem = AppState.cart[index];
  if (!cartItem) return;

  cartItem.quantity = Math.max(1, cartItem.quantity + delta);
  cartItem.total = (cartItem.quantity * cartItem.selling_price) - cartItem.discount;
  renderCartUI();
}

function setDirectCartQty(index, val) {
  const cartItem = AppState.cart[index];
  if (!cartItem) return;
  const num = parseFloat(val);
  if (!isNaN(num) && num > 0) {
    cartItem.quantity = num;
    cartItem.total = (cartItem.quantity * cartItem.selling_price) - cartItem.discount;
    renderCartUI();
  }
}

function removeCartItem(index) {
  playBeep('click');
  AppState.cart.splice(index, 1);
  renderCartUI();
}

function clearCurrentCart() {
  if (AppState.cart.length === 0) return;
  playBeep('click');
  AppState.cart = [];
  document.getElementById('bill-discount-input').value = '0';
  document.getElementById('bill-cash-received').value = '';
  renderCartUI();
  showToast("Bill cleared.", "info", 1500);
}

function renderCartUI() {
  const container = document.getElementById('cart-items-list');
  const countEl = document.getElementById('cart-item-count');

  if (AppState.cart.length === 0) {
    countEl.textContent = '0 items in bill';
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-dim); margin-top: 60px;">
        <span style="font-size: 32px; display: block; margin-bottom: 10px;">🛒</span>
        Cart is empty.<br>Scan barcode or tap items to add.
      </div>
    `;
    calculateBillTotals();
    return;
  }

  const totalCount = AppState.cart.reduce((sum, item) => sum + item.quantity, 0);
  countEl.textContent = `${AppState.cart.length} line items (${totalCount} units)`;

  container.innerHTML = AppState.cart.map((c, i) => `
    <div style="background: rgba(11, 17, 32, 0.6); border: 1px solid var(--border-glass); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px;">
      <div style="display: flex; justify-content: space-between; align-items: start;">
        <div style="flex: 1; padding-right: 6px;">
          <div style="font-size: 13px; font-weight: 700; color: #ffffff;">${c.name}</div>
          <div style="font-size: 11px; color: var(--text-dim); font-family: var(--font-mono);">
            ${c.code} • Rs. ${c.selling_price.toFixed(2)} / ${c.unit}
          </div>
        </div>
        <div style="font-size: 14px; font-weight: 800; color: var(--cyan); font-family: var(--font-mono);">
          Rs. ${c.total.toFixed(2)}
        </div>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px;">
        <div style="display: flex; align-items: center; gap: 4px;">
          <button class="btn btn-sm btn-glass" style="padding: 2px 8px;" onclick="updateCartQty(${i}, -1)">-</button>
          <input type="number" class="form-control" style="width: 55px; padding: 2px 4px; font-size: 12px; text-align: center; font-family: var(--font-mono);" value="${c.quantity}" min="1" step="any" onchange="setDirectCartQty(${i}, this.value)">
          <button class="btn btn-sm btn-glass" style="padding: 2px 8px;" onclick="updateCartQty(${i}, 1)">+</button>
        </div>

        <button class="btn btn-sm btn-danger" style="padding: 2px 8px; font-size: 11px;" onclick="removeCartItem(${i})">
          ✕
        </button>
      </div>
    </div>
  `).join('');

  calculateBillTotals();
}

function calculateBillTotals() {
  const subtotal = AppState.cart.reduce((sum, item) => sum + item.total, 0);
  const discountInput = parseFloat(document.getElementById('bill-discount-input').value) || 0;
  const grandTotal = Math.max(0, subtotal - discountInput);

  document.getElementById('bill-subtotal').textContent = `Rs. ${subtotal.toFixed(2)}`;
  document.getElementById('bill-grand-total').textContent = `Rs. ${grandTotal.toFixed(2)}`;

  const cashInput = parseFloat(document.getElementById('bill-cash-received').value) || 0;
  const changeDue = Math.max(0, cashInput - grandTotal);

  const changeEl = document.getElementById('bill-change-due');
  changeEl.textContent = `Rs. ${changeDue.toFixed(2)}`;

  if (cashInput >= grandTotal && grandTotal > 0) {
    changeEl.style.color = "var(--emerald)";
  } else {
    changeEl.style.color = "var(--text-dim)";
  }
}

function selectPaymentMode(mode) {
  playBeep('click');
  AppState.paymentMode = mode;

  const buttons = document.querySelectorAll('.pay-mode-btn');
  buttons.forEach(btn => {
    btn.className = (btn.getAttribute('data-mode') === mode) ? 'btn btn-sm btn-cyan pay-mode-btn' : 'btn btn-sm btn-glass pay-mode-btn';
  });

  const tenderShortcuts = document.getElementById('cash-tender-shortcuts');
  if (mode === 'Cash') {
    tenderShortcuts.style.display = 'flex';
  } else {
    tenderShortcuts.style.display = 'none';
    setExactTender();
  }
}

function addTenderAmount(val) {
  playBeep('click');
  const input = document.getElementById('bill-cash-received');
  const curr = parseFloat(input.value) || 0;
  input.value = (curr + val).toFixed(2);
  calculateBillTotals();
}

function setExactTender() {
  playBeep('click');
  const subtotal = AppState.cart.reduce((sum, item) => sum + item.total, 0);
  const discount = parseFloat(document.getElementById('bill-discount-input').value) || 0;
  const grand = Math.max(0, subtotal - discount);
  document.getElementById('bill-cash-received').value = grand.toFixed(2);
  calculateBillTotals();
}

// Hold & Recall Bills
function holdCurrentBill() {
  if (AppState.cart.length === 0) {
    showToast("Cart is empty. Nothing to hold.", "warning");
    return;
  }

  playBeep('click');
  const heldTicket = {
    id: Date.now(),
    timestamp: new Date().toLocaleTimeString(),
    items: [...AppState.cart],
    discount: parseFloat(document.getElementById('bill-discount-input').value) || 0
  };

  AppState.heldBills.push(heldTicket);
  saveHeldBills();

  clearCurrentCart();
  showToast(`Bill held successfully (${AppState.heldBills.length} held).`, "success");
}

function loadHeldBills() {
  try {
    const raw = localStorage.getItem(`supiripos_held_${AppState.business.business_code}`);
    AppState.heldBills = raw ? JSON.parse(raw) : [];
  } catch (e) {
    AppState.heldBills = [];
  }
  updateHeldBadge();
}

function saveHeldBills() {
  try {
    localStorage.setItem(`supiripos_held_${AppState.business.business_code}`, JSON.stringify(AppState.heldBills));
  } catch (e) { }
  updateHeldBadge();
}

function updateHeldBadge() {
  const badge = document.getElementById('held-bills-count');
  if (badge) badge.textContent = AppState.heldBills.length;
}

function openRecallBillsModal() {
  playBeep('click');
  const modal = document.getElementById('modal-held-bills');
  const list = document.getElementById('held-bills-list');

  if (AppState.heldBills.length === 0) {
    list.innerHTML = `<div style="text-align: center; color: var(--text-dim); padding: 20px;">No held bills currently.</div>`;
  } else {
    list.innerHTML = AppState.heldBills.map((h, i) => {
      const total = h.items.reduce((s, it) => s + it.total, 0) - h.discount;
      return `
        <div style="background: rgba(11, 17, 32, 0.7); border: 1px solid var(--border-glass); border-radius: 10px; padding: 12px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-size: 13px; font-weight: 700; color: #ffffff;">Held Ticket #${i + 1} (${h.timestamp})</div>
            <div style="font-size: 11px; color: var(--text-muted);">${h.items.length} items • Total: Rs. ${total.toFixed(2)}</div>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-sm btn-cyan" onclick="recallHeldBill(${i})">Recall</button>
            <button class="btn btn-sm btn-danger" onclick="deleteHeldBill(${i})">✕</button>
          </div>
        </div>
      `;
    }).join('');
  }

  modal.classList.add('active');
}

function closeRecallBillsModal() {
  playBeep('click');
  document.getElementById('modal-held-bills').classList.remove('active');
}

function recallHeldBill(index) {
  playBeep('click');
  const ticket = AppState.heldBills[index];
  if (!ticket) return;

  AppState.cart = [...ticket.items];
  document.getElementById('bill-discount-input').value = ticket.discount;
  AppState.heldBills.splice(index, 1);
  saveHeldBills();

  closeRecallBillsModal();
  renderCartUI();
  showToast("Held bill restored to active register.", "success");
}

function deleteHeldBill(index) {
  playBeep('click');
  AppState.heldBills.splice(index, 1);
  saveHeldBills();
  openRecallBillsModal();
}

// Complete Sale & Print
async function completeSaleAndPrint() {
  if (AppState.cart.length === 0) {
    playBeep('error');
    showToast("Cannot complete sale: Cart is empty.", "warning");
    return;
  }

  const subtotal = AppState.cart.reduce((sum, item) => sum + item.total, 0);
  const discount = parseFloat(document.getElementById('bill-discount-input').value) || 0;
  const grandTotal = Math.max(0, subtotal - discount);
  const cashPaid = parseFloat(document.getElementById('bill-cash-received').value) || 0;

  if (AppState.paymentMode === 'Cash' && cashPaid < grandTotal) {
    playBeep('error');
    showToast(`Insufficient cash received: Rs. ${cashPaid.toFixed(2)} vs Total Rs. ${grandTotal.toFixed(2)}`, "warning");
    document.getElementById('bill-cash-received').focus();
    return;
  }

  const changeDue = Math.max(0, cashPaid - grandTotal);

  const payload = {
    business_code: AppState.business.business_code,
    cashier_username: AppState.user.username,
    payment_method: AppState.paymentMode,
    subtotal,
    discount_amount: discount,
    discount_percent: 0.0,
    tax_amount: 0.0,
    grand_total: grandTotal,
    cash_paid: (AppState.paymentMode === 'Cash') ? cashPaid : grandTotal,
    balance_change: (AppState.paymentMode === 'Cash') ? changeDue : 0.0,
    items: AppState.cart
  };

  try {
    const res = await fetch('/api/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to complete sale');

    playBeep('success');
    showToast(`Sale completed! Invoice #${data.invoice_number}`, "success");

    AppState.lastInvoice = data;

    // Reset Cart
    AppState.cart = [];
    document.getElementById('bill-discount-input').value = '0';
    document.getElementById('bill-cash-received').value = '';
    renderCartUI();

    // Open Thermal Receipt Modal
    openReceiptModal(data);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// THERMAL RECEIPT (80mm & 58mm) & PRINT ENGINE
// ---------------------------------------------------------------------------
function openReceiptModal(invoice) {
  AppState.lastInvoice = invoice;
  renderThermalReceipt(invoice, AppState.currentReceiptFormat);
  document.getElementById('modal-receipt').classList.add('active');
}

function closeReceiptModal() {
  playBeep('click');
  document.getElementById('modal-receipt').classList.remove('active');
  document.getElementById('billing-search-input').focus();
}

function switchReceiptFormat(format) {
  playBeep('click');
  AppState.currentReceiptFormat = format;

  const buttons = document.querySelectorAll('.receipt-format-btn');
  buttons.forEach(b => {
    b.className = b.textContent.includes(format) ? 'btn btn-sm btn-cyan receipt-format-btn' : 'btn btn-sm btn-glass receipt-format-btn';
  });

  if (AppState.lastInvoice) {
    renderThermalReceipt(AppState.lastInvoice, format);
  }
}

function renderThermalReceipt(inv, format = '80mm') {
  const biz = AppState.business;
  const is58mm = format === '58mm';
  const widthStyle = is58mm ? 'max-width: 240px; font-size: 10px;' : 'max-width: 320px; font-size: 12px;';

  const logoHtml = biz.logo_base64 ? `
    <div style="text-align: center; margin-bottom: 8px;">
      <img src="${biz.logo_base64}" alt="Logo" style="max-height: 48px; max-width: 140px; object-fit: contain;">
    </div>
  ` : '';

  const itemsRows = (inv.items || []).map(it => `
    <tr>
      <td style="padding: 2px 0;">${it.name}<br><span style="font-size: 9px; opacity: 0.8;">${it.quantity} x Rs. ${it.selling_price.toFixed(2)}</span></td>
      <td style="text-align: right; vertical-align: top; padding: 2px 0;">Rs. ${it.total.toFixed(2)}</td>
    </tr>
  `).join('');

  const html = `
    <div style="${widthStyle} margin: 0 auto; line-height: 1.35; color: #000000; font-family: 'Courier New', Courier, monospace;">
      ${logoHtml}
      <div style="text-align: center; font-weight: bold; font-size: ${is58mm ? '13px' : '16px'}; margin-bottom: 2px;">
        ${biz.name}
      </div>
      <div style="text-align: center; font-size: 10px; margin-bottom: 4px;">
        ${biz.address}
      </div>
      <div style="text-align: center; font-size: 10px; margin-bottom: 8px;">
        Tel: ${biz.phone}
      </div>

      <div style="border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 4px 0; margin-bottom: 8px; font-size: 10px;">
        <div>Inv #: <strong>${inv.invoice_number}</strong></div>
        <div>Date : ${new Date(inv.date_time).toLocaleString()}</div>
        <div>Staff: ${inv.cashier_username} | Pay: ${inv.payment_method}</div>
      </div>

      <table style="width: 100%; border-collapse: collapse; font-size: ${is58mm ? '10px' : '11px'}; margin-bottom: 8px;">
        <thead>
          <tr style="border-bottom: 1px solid #000;">
            <th style="text-align: left; padding-bottom: 2px;">Item</th>
            <th style="text-align: right; padding-bottom: 2px;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
        </tbody>
      </table>

      <div style="border-top: 1px dashed #000; padding-top: 4px; font-size: ${is58mm ? '10px' : '11px'};">
        <div style="display: flex; justify-content: space-between;">
          <span>Subtotal:</span>
          <span>Rs. ${inv.subtotal.toFixed(2)}</span>
        </div>
        ${inv.discount_amount > 0 ? `
          <div style="display: flex; justify-content: space-between;">
            <span>Discount:</span>
            <span>- Rs. ${inv.discount_amount.toFixed(2)}</span>
          </div>
        ` : ''}
        <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: ${is58mm ? '12px' : '14px'}; margin: 4px 0;">
          <span>TOTAL:</span>
          <span>Rs. ${inv.grand_total.toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>Cash Paid:</span>
          <span>Rs. ${inv.cash_paid.toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-weight: bold;">
          <span>Balance:</span>
          <span>Rs. ${inv.balance_change.toFixed(2)}</span>
        </div>
      </div>

      <div style="text-align: center; margin-top: 14px; font-size: 10px; border-top: 1px dashed #000; padding-top: 8px;">
        <div>${biz.receipt_footer || 'Thank You! Come Again!'}</div>
        <div style="font-size: 8px; margin-top: 4px; opacity: 0.7;">Powered by PrasaTek System Solutions • pos.prasatek.lk</div>
      </div>
    </div>
  `;

  document.getElementById('thermal-receipt-preview').innerHTML = html;
  document.getElementById('printable-receipt-container').innerHTML = html;
}

function triggerThermalPrint() {
  playBeep('click');
  window.print();
}

// ---------------------------------------------------------------------------
// PAGE 2: 📦 ITEMS CATALOG MANAGEMENT
// ---------------------------------------------------------------------------
function loadItemsTable() {
  const query = (document.getElementById('items-search-input').value || '').trim().toLowerCase();
  const cat = document.getElementById('items-category-filter').value;

  const tbody = document.getElementById('items-table-body');
  if (!tbody) return;

  const filtered = AppState.items.filter(item => {
    const matchesCat = (cat === 'All') || (item.category && item.category.toLowerCase() === cat.toLowerCase());
    const matchesQuery = !query || item.name.toLowerCase().includes(query) || item.code.toLowerCase().includes(query);
    return matchesCat && matchesQuery;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 24px; color: var(--text-dim);">No products found matching filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(item => {
    const margin = item.selling_price > 0 ? (((item.selling_price - item.cost_price) / item.selling_price) * 100).toFixed(1) : 0;

    let stockBadge = `<span class="badge badge-emerald">${item.stock_quantity} ${item.unit}</span>`;
    if (item.stock_quantity <= 0) {
      stockBadge = `<span class="badge badge-danger">0 ${item.unit} (Out)</span>`;
    } else if (item.stock_quantity <= item.low_stock_level) {
      stockBadge = `<span class="badge badge-warning">${item.stock_quantity} (Low)</span>`;
    }

    return `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
        <td style="padding: 10px; font-family: var(--font-mono); font-weight: 700; color: var(--cyan);">${item.code}</td>
        <td style="padding: 10px; font-weight: 600; color: #ffffff;">${item.name}</td>
        <td style="padding: 10px; color: var(--text-muted);">${item.category}</td>
        <td style="padding: 10px; color: var(--text-dim);">${item.unit}</td>
        <td style="padding: 10px; text-align: right; font-family: var(--font-mono);">Rs. ${item.cost_price.toFixed(2)}</td>
        <td style="padding: 10px; text-align: right; font-family: var(--font-mono); font-weight: 700; color: #ffffff;">Rs. ${item.selling_price.toFixed(2)}</td>
        <td style="padding: 10px; text-align: right; font-family: var(--font-mono); color: var(--emerald);">${margin}%</td>
        <td style="padding: 10px; text-align: center;">${stockBadge}</td>
        <td style="padding: 10px; text-align: right; white-space: nowrap;">
          <button class="btn btn-sm btn-cyan" onclick="openBinCardSubTab(${item.id})" title="View Stock Ledger / Bin Card">🗂️ Bin Card</button>
          <button class="btn btn-sm btn-glass" onclick="openEditItemModal(${item.id})">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteItem(${item.id})">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

function openAddItemModal() {
  playBeep('click');
  document.getElementById('item-form-title').textContent = "Add New Product";
  document.getElementById('item-form-id').value = '';
  document.getElementById('item-form-code').value = '';
  document.getElementById('item-form-name').value = '';
  document.getElementById('item-form-category').value = 'Groceries';
  document.getElementById('item-form-unit').value = 'Pcs';
  document.getElementById('item-form-cost').value = '';
  document.getElementById('item-form-price').value = '';
  document.getElementById('item-form-stock').value = '10';
  document.getElementById('item-form-low-alert').value = '5';
  document.getElementById('item-initial-stock-group').style.display = 'block';

  document.getElementById('modal-item-form').classList.add('active');
  document.getElementById('item-form-code').focus();
}

function openEditItemModal(itemId) {
  playBeep('click');
  const item = AppState.items.find(i => i.id === itemId);
  if (!item) return;

  document.getElementById('item-form-title').textContent = "Edit Product";
  document.getElementById('item-form-id').value = item.id;
  document.getElementById('item-form-code').value = item.code;
  document.getElementById('item-form-name').value = item.name;
  document.getElementById('item-form-category').value = item.category;
  document.getElementById('item-form-unit').value = item.unit;
  document.getElementById('item-form-cost').value = item.cost_price;
  document.getElementById('item-form-price').value = item.selling_price;
  document.getElementById('item-form-low-alert').value = item.low_stock_level;
  document.getElementById('item-initial-stock-group').style.display = 'none';

  document.getElementById('modal-item-form').classList.add('active');
}

function closeItemModal() {
  playBeep('click');
  document.getElementById('modal-item-form').classList.remove('active');
}

function generateRandomBarcode() {
  playBeep('click');
  const rand = `479${Math.floor(100000000 + Math.random() * 900000000)}`;
  document.getElementById('item-form-code').value = rand;
}

async function handleSaveItem(e) {
  e.preventDefault();
  const id = document.getElementById('item-form-id').value;
  const payload = {
    business_code: AppState.business.business_code,
    code: document.getElementById('item-form-code').value.trim(),
    name: document.getElementById('item-form-name').value.trim(),
    category: document.getElementById('item-form-category').value.trim(),
    unit: document.getElementById('item-form-unit').value,
    cost_price: parseFloat(document.getElementById('item-form-cost').value) || 0,
    selling_price: parseFloat(document.getElementById('item-form-price').value) || 0,
    stock_quantity: parseFloat(document.getElementById('item-form-stock').value) || 0,
    low_stock_level: parseFloat(document.getElementById('item-form-low-alert').value) || 5
  };

  try {
    let res;
    if (id) {
      res = await fetch(`/api/items/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to save item');

    playBeep('success');
    closeItemModal();
    showToast("Product saved successfully!", "success");
    await loadItemsCatalog(true);
    loadItemsTable();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteItem(itemId) {
  if (!confirm("Are you sure you want to delete this product?")) return;
  playBeep('click');

  try {
    const res = await fetch(`/api/items/${itemId}?business_code=${AppState.business.business_code}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('Failed to delete item');

    playBeep('click');
    showToast("Product deleted.", "info");
    await loadItemsCatalog(true);
    loadItemsTable();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// PAGE 3: 📊 STOCK INVENTORY & MOVEMENT LOGS
// ---------------------------------------------------------------------------
async function loadStockPage() {
  if (!AppState.business) return;

  try {
    const res = await fetch(`/api/stock?business_code=${AppState.business.business_code}`);
    const stockItems = await res.json();

    // Populate adjust dropdown
    const select = document.getElementById('stock-adjust-item');
    if (select) {
      select.innerHTML = stockItems.map(it => `
        <option value="${it.id}">${it.name} (Cur: ${it.stock_quantity} ${it.unit})</option>
      `).join('');
    }

    // KPI Counters
    const total = stockItems.length;
    const inStock = stockItems.filter(i => i.stock_quantity > i.low_stock_level).length;
    const low = stockItems.filter(i => i.stock_quantity > 0 && i.stock_quantity <= i.low_stock_level).length;
    const out = stockItems.filter(i => i.stock_quantity <= 0).length;

    document.getElementById('stock-kpi-total-items').textContent = total;
    document.getElementById('stock-kpi-in-stock').textContent = inStock;
    document.getElementById('stock-kpi-low-stock').textContent = low;
    document.getElementById('stock-kpi-out-stock').textContent = out;

    loadStockLogs();
  } catch (err) {
    console.error("[STOCK PAGE ERROR]", err);
  }
}

async function handleStockAdjust(e) {
  e.preventDefault();
  const itemId = parseInt(document.getElementById('stock-adjust-item').value);
  const type = document.getElementById('stock-adjust-type').value;
  const qty = parseFloat(document.getElementById('stock-adjust-qty').value);
  const note = document.getElementById('stock-adjust-note').value.trim();

  if (!itemId || !qty || qty <= 0) {
    showToast("Please enter a valid quantity.", "warning");
    return;
  }

  try {
    const res = await fetch('/api/stock/adjust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_code: AppState.business.business_code,
        item_id: itemId,
        adjust_type: type,
        quantity: qty,
        staff_username: AppState.user.username,
        note
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to adjust stock');

    playBeep('success');
    showToast(`Stock updated! New Stock: ${data.new_stock}`, "success");
    document.getElementById('stock-adjust-qty').value = '';
    document.getElementById('stock-adjust-note').value = '';

    await loadItemsCatalog(true);
    loadStockPage();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function loadStockLogs() {
  const tbody = document.getElementById('stock-logs-table-body');
  if (!tbody || !AppState.business) return;

  try {
    const res = await fetch(`/api/stock/logs?business_code=${AppState.business.business_code}&limit=30`);
    const logs = await res.json();

    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 20px; color: var(--text-dim);">No stock movement recorded yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map(l => {
      let typeBadge = `<span class="badge badge-emerald">IN</span>`;
      let qtyColor = `color: var(--emerald);`;
      if (l.log_type === 'OUT') {
        typeBadge = `<span class="badge badge-danger">OUT</span>`;
        qtyColor = `color: var(--danger);`;
      } else if (l.log_type === 'SALE') {
        typeBadge = `<span class="badge badge-cyan">SALE</span>`;
        qtyColor = `color: var(--cyan);`;
      } else if (l.log_type === 'VOID_RETURN') {
        typeBadge = `<span class="badge badge-warning">VOID RETURN</span>`;
        qtyColor = `color: var(--warning);`;
      }

      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
          <td style="padding: 8px 10px; font-size: 11px; color: var(--text-muted);">${new Date(l.created_at).toLocaleString()}</td>
          <td style="padding: 8px 10px; font-weight: 600; color: #ffffff;">${l.item_name}</td>
          <td style="padding: 8px 10px;">${typeBadge}</td>
          <td style="padding: 8px 10px; text-align: right; font-family: var(--font-mono); font-weight: 700; ${qtyColor}">${l.quantity_change > 0 ? '+' : ''}${l.quantity_change}</td>
          <td style="padding: 8px 10px; text-align: right; font-family: var(--font-mono); color: #ffffff;">${l.new_stock}</td>
          <td style="padding: 8px 10px; color: var(--text-muted);">${l.staff_username}</td>
          <td style="padding: 8px 10px; font-size: 11px; color: var(--text-dim);">${l.note || '-'}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error("[STOCK LOGS ERROR]", err);
  }
}

// ---------------------------------------------------------------------------
// PAGE 4: 👥 STAFF USERS & GRANULAR ACCESS CONTROL
// ---------------------------------------------------------------------------
async function loadUsersTable() {
  const tbody = document.getElementById('users-table-body');
  if (!tbody || !AppState.business) return;

  try {
    const res = await fetch(`/api/users?business_code=${AppState.business.business_code}`);
    const users = await res.json();

    tbody.innerHTML = users.map(u => {
      const permsBadges = [
        u.can_billing ? '<span class="badge badge-cyan">Billing</span>' : '',
        u.can_items ? '<span class="badge badge-glass">Items</span>' : '',
        u.can_stock ? '<span class="badge badge-glass">Stock</span>' : '',
        u.can_users ? '<span class="badge badge-glass">Users</span>' : '',
        u.can_reports ? '<span class="badge badge-emerald">Reports</span>' : ''
      ].join(' ');

      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
          <td style="padding: 12px; font-family: var(--font-mono); font-weight: 700; color: #ffffff;">${u.username}</td>
          <td style="padding: 12px; font-weight: 600; color: var(--text-main);">${u.full_name}</td>
          <td style="padding: 12px; color: var(--cyan);">${u.role_title}</td>
          <td style="padding: 12px;">${permsBadges}</td>
          <td style="padding: 12px; text-align: right;">
            <button class="btn btn-sm btn-glass" onclick="openEditUserModal(${u.id})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id})">Delete</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error("[USERS ERROR]", err);
  }
}

function openAddUserModal() {
  playBeep('click');
  document.getElementById('user-form-title').textContent = "Add Staff Account";
  document.getElementById('user-form-id').value = '';
  document.getElementById('user-form-fullname').value = '';
  document.getElementById('user-form-username').value = '';
  document.getElementById('user-form-role').value = 'Cashier';
  document.getElementById('user-form-password').value = '';
  document.getElementById('user-form-password').required = true;
  document.getElementById('user-pw-hint').style.display = 'none';

  document.getElementById('perm-billing').checked = true;
  document.getElementById('perm-items').checked = false;
  document.getElementById('perm-stock').checked = false;
  document.getElementById('perm-users').checked = false;
  document.getElementById('perm-reports').checked = false;

  document.getElementById('modal-user-form').classList.add('active');
}

async function openEditUserModal(userId) {
  playBeep('click');
  try {
    const res = await fetch(`/api/users?business_code=${AppState.business.business_code}`);
    const users = await res.json();
    const u = users.find(x => x.id === userId);
    if (!u) return;

    document.getElementById('user-form-title').textContent = "Edit Staff Account";
    document.getElementById('user-form-id').value = u.id;
    document.getElementById('user-form-fullname').value = u.full_name;
    document.getElementById('user-form-username').value = u.username;
    document.getElementById('user-form-role').value = u.role_title;
    document.getElementById('user-form-password').value = '';
    document.getElementById('user-form-password').required = false;
    document.getElementById('user-pw-hint').style.display = 'inline';

    document.getElementById('perm-billing').checked = u.can_billing;
    document.getElementById('perm-items').checked = u.can_items;
    document.getElementById('perm-stock').checked = u.can_stock;
    document.getElementById('perm-users').checked = u.can_users;
    document.getElementById('perm-reports').checked = u.can_reports;

    document.getElementById('modal-user-form').classList.add('active');
  } catch (e) { }
}

function closeUserModal() {
  playBeep('click');
  document.getElementById('modal-user-form').classList.remove('active');
}

async function handleSaveUser(e) {
  e.preventDefault();
  const id = document.getElementById('user-form-id').value;
  const payload = {
    business_code: AppState.business.business_code,
    username: document.getElementById('user-form-username').value.trim(),
    password: document.getElementById('user-form-password').value.trim() || undefined,
    full_name: document.getElementById('user-form-fullname').value.trim(),
    role_title: document.getElementById('user-form-role').value.trim(),
    can_billing: document.getElementById('perm-billing').checked,
    can_items: document.getElementById('perm-items').checked,
    can_stock: document.getElementById('perm-stock').checked,
    can_users: document.getElementById('perm-users').checked,
    can_reports: document.getElementById('perm-reports').checked
  };

  try {
    let res;
    if (id) {
      res = await fetch(`/api/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to save staff user');

    playBeep('success');
    closeUserModal();
    showToast("Staff account updated!", "success");
    loadUsersTable();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteUser(userId) {
  if (!confirm("Are you sure you want to delete this staff user?")) return;
  playBeep('click');

  try {
    const res = await fetch(`/api/users/${userId}?business_code=${AppState.business.business_code}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to delete user');

    playBeep('click');
    showToast("Staff account removed.", "info");
    loadUsersTable();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// PAGE 5: 📈 REPORTS, ITEM BIN CARD & USER ACTIVITY AUDIT LOG
// ---------------------------------------------------------------------------
function switchReportsSubTab(subTab) {
  playBeep('click');
  AppState.currentReportsSubTab = subTab;

  const subTabs = ['sales', 'bincard', 'activity'];
  subTabs.forEach(st => {
    const btn = document.getElementById(`subnav-btn-${st}`);
    const sec = document.getElementById(`subtab-reports-${st}`);
    const isActive = (st === subTab);
    if (btn) {
      btn.className = isActive ? 'btn btn-sm btn-cyan' : 'btn btn-sm btn-glass';
    }
    if (sec) {
      sec.classList.toggle('active-subtab', isActive);
      sec.style.display = isActive ? 'flex' : 'none';
    }
  });

  const exportBtnContainer = document.getElementById('reports-export-container');
  if (exportBtnContainer) {
    exportBtnContainer.style.display = (subTab === 'sales') ? 'block' : 'none';
  }

  if (subTab === 'sales') {
    loadReportsData();
  } else if (subTab === 'bincard') {
    initBinCardProductDropdown();
    loadBinCardData();
  } else if (subTab === 'activity') {
    initActivityFilterDropdowns();
    loadActivityLogsData();
  }
}

function openBinCardSubTab(itemId = null) {
  switchPOSTab('reports');
  switchReportsSubTab('bincard');
  if (itemId) {
    setTimeout(() => {
      const sel = document.getElementById('bincard-item-select');
      if (sel) {
        sel.value = String(itemId);
        loadBinCardData();
      }
    }, 80);
  }
}

function initBinCardProductDropdown() {
  const selectEl = document.getElementById('bincard-item-select');
  if (!selectEl) return;

  const currentVal = selectEl.value;
  if (AppState.items.length === 0) {
    selectEl.innerHTML = `<option value="">-- No products available --</option>`;
    return;
  }

  selectEl.innerHTML = AppState.items.map(item =>
    `<option value="${item.id}">[${item.code}] ${item.name} — (Stock: ${item.stock_quantity} ${item.unit})</option>`
  ).join('');

  if (currentVal && AppState.items.some(i => String(i.id) === String(currentVal))) {
    selectEl.value = currentVal;
  }
}

async function loadBinCardData() {
  if (!AppState.business) return;
  const selectEl = document.getElementById('bincard-item-select');
  if (!selectEl || !selectEl.value) {
    initBinCardProductDropdown();
  }
  const itemId = selectEl ? selectEl.value : '';
  if (!itemId) return;

  const startDate = document.getElementById('bincard-start-date')?.value || '';
  const endDate = document.getElementById('bincard-end-date')?.value || '';

  let url = `/api/reports/bin-card?business_code=${encodeURIComponent(AppState.business.business_code)}&item_id=${encodeURIComponent(itemId)}`;
  if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;
  if (endDate) url += `&end_date=${encodeURIComponent(endDate)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to load Bin Card');

    // Update Bin Card Header
    if (data.item) {
      document.getElementById('bincard-header-name').textContent = data.item.name;
      document.getElementById('bincard-header-code').textContent = data.item.code;
      document.getElementById('bincard-header-category').textContent = data.item.category || 'General';
      document.getElementById('bincard-header-stock').textContent = `${data.item.stock_quantity} ${data.item.unit}`;
      document.getElementById('bincard-header-alert').textContent = `${data.item.low_stock_level} ${data.item.unit}`;
    }

    const tbody = document.getElementById('bincard-table-body');
    if (!tbody) return;

    const movements = data.movements || [];
    if (movements.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--text-dim);">No stock movements recorded for this product in the selected range.</td></tr>`;
      return;
    }

    tbody.innerHTML = movements.map(m => {
      let typeBadge = `<span class="badge">${m.transaction_label || m.log_type}</span>`;
      if (m.log_type === 'IN' || m.log_type === 'OPENING') {
        typeBadge = `<span class="badge badge-emerald">➕ ${m.transaction_label || 'Stock Added (GRN)'}</span>`;
      } else if (m.log_type === 'SALE') {
        typeBadge = `<span class="badge badge-cyan">🧾 ${m.transaction_label || 'Sale / Billed'}</span>`;
      } else if (m.log_type === 'OUT') {
        typeBadge = `<span class="badge badge-danger">➖ ${m.transaction_label || 'Stock Removed'}</span>`;
      } else if (m.log_type === 'VOID_RETURN') {
        typeBadge = `<span class="badge badge-warning">🔄 ${m.transaction_label || 'Bill Void / Returned'}</span>`;
      }

      const dt = m.created_at ? new Date(m.created_at).toLocaleString() : '-';
      const qtyInStr = m.qty_in > 0 ? `+${m.qty_in}` : '-';
      const qtyOutStr = m.qty_out > 0 ? `-${m.qty_out}` : '-';

      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
          <td style="padding: 10px; font-size: 12px; color: var(--text-muted);">${dt}</td>
          <td style="padding: 10px;">${typeBadge}</td>
          <td style="padding: 10px; font-family: var(--font-mono); font-size: 12px; color: #ffffff;">${m.reference || '-'}</td>
          <td style="padding: 10px; text-align: right; font-family: var(--font-mono); font-weight: 700; color: var(--emerald);">${qtyInStr}</td>
          <td style="padding: 10px; text-align: right; font-family: var(--font-mono); font-weight: 700; color: var(--danger);">${qtyOutStr}</td>
          <td style="padding: 10px; text-align: right; font-family: var(--font-mono); font-weight: 800; color: var(--cyan);">${m.running_balance}</td>
          <td style="padding: 10px; color: var(--text-main);">👤 ${m.staff_username || 'System'}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error("[BIN CARD ERROR]", err);
  }
}

function printBinCardStatement() {
  playBeep('click');
  const name = document.getElementById('bincard-header-name')?.textContent || 'Product';
  const code = document.getElementById('bincard-header-code')?.textContent || '';
  const stock = document.getElementById('bincard-header-stock')?.textContent || '';
  const tbodyHtml = document.getElementById('bincard-table-body')?.innerHTML || '';
  const bizName = AppState.business?.name || 'SupiriPOS PRO';

  const printWin = window.open('', '_blank', 'width=900,height=700');
  if (!printWin) return;
  printWin.document.write(`
    <html>
      <head>
        <title>Item Bin Card - ${name} (${code})</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
          h2 { margin: 0 0 4px 0; }
          .meta { color: #555; font-size: 13px; margin-bottom: 16px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
          th { background: #f1f5f9; }
        </style>
      </head>
      <body>
        <h2>${bizName} — Official Item Bin Card (Stock Ledger)</h2>
        <div class="meta">
          <strong>Product:</strong> ${name} (${code}) &nbsp;|&nbsp;
          <strong>Current Stock:</strong> ${stock} &nbsp;|&nbsp;
          <strong>Printed:</strong> ${new Date().toLocaleString()}
        </div>
        <table>
          <thead>
            <tr>
              <th>Date & Time</th>
              <th>Transaction Type</th>
              <th>Reference / Note</th>
              <th>Qty In (+)</th>
              <th>Qty Out (-)</th>
              <th>Running Balance</th>
              <th>Performed By</th>
            </tr>
          </thead>
          <tbody>${tbodyHtml}</tbody>
        </table>
        <script>window.onload = () => { window.print(); };<\/script>
      </body>
    </html>
  `);
  printWin.document.close();
}

async function initActivityFilterDropdowns() {
  if (!AppState.business) return;
  const userSelect = document.getElementById('activity-filter-user');
  if (!userSelect) return;

  const currentVal = userSelect.value;
  try {
    const res = await fetch(`/api/users?business_code=${encodeURIComponent(AppState.business.business_code)}`);
    const users = await res.json();
    userSelect.innerHTML = `<option value="ALL">All Staff Members</option>` +
      users.map(u => `<option value="${u.username}">${u.full_name} (@${u.username})</option>`).join('');
    if (currentVal) userSelect.value = currentVal;
  } catch (e) { }
}

async function loadActivityLogsData() {
  if (!AppState.business) return;
  const staffUser = document.getElementById('activity-filter-user')?.value || 'ALL';
  const actionType = document.getElementById('activity-filter-action')?.value || 'ALL';
  const startDate = document.getElementById('activity-start-date')?.value || '';
  const endDate = document.getElementById('activity-end-date')?.value || '';

  let url = `/api/reports/activity-logs?business_code=${encodeURIComponent(AppState.business.business_code)}&limit=250`;
  if (staffUser && staffUser !== 'ALL') url += `&staff_username=${encodeURIComponent(staffUser)}`;
  if (actionType && actionType !== 'ALL') url += `&action_type=${encodeURIComponent(actionType)}`;
  if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;
  if (endDate) url += `&end_date=${encodeURIComponent(endDate)}`;

  try {
    const res = await fetch(url);
    const logs = await res.json();
    const tbody = document.getElementById('activity-table-body');
    if (!tbody) return;

    if (!Array.isArray(logs) || logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 24px; color: var(--text-dim);">No user activity logs found for the selected filter.</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map(log => {
      const dt = log.created_at ? new Date(log.created_at).toLocaleString() : '-';
      let badgeClass = 'badge-cyan';
      if (log.action_type.includes('VOID') || log.action_type.includes('DELETE')) badgeClass = 'badge-danger';
      else if (log.action_type.includes('BILL') || log.action_type.includes('LOGIN') || log.action_type.includes('CREATED')) badgeClass = 'badge-emerald';
      else if (log.action_type.includes('STOCK') || log.action_type.includes('LOGOUT')) badgeClass = 'badge-warning';

      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
          <td style="padding: 10px; font-size: 12px; color: var(--text-muted); white-space: nowrap;">${dt}</td>
          <td style="padding: 10px; font-weight: 700; color: #ffffff; white-space: nowrap;">👤 ${log.staff_username}</td>
          <td style="padding: 10px; white-space: nowrap;"><span class="badge ${badgeClass}">${log.action_type}</span></td>
          <td style="padding: 10px; color: var(--text-main);">${log.details}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error("[ACTIVITY LOGS ERROR]", err);
  }
}

function selectReportRange(range) {
  playBeep('click');
  AppState.activeReportRange = range;

  const buttons = document.querySelectorAll('.report-range-btn');
  buttons.forEach(b => {
    b.className = b.textContent.toLowerCase().includes(range.replace('_', ' ')) ? 'btn btn-sm btn-cyan report-range-btn' : 'btn btn-sm btn-glass report-range-btn';
  });

  loadReportsData();
}

function applyCustomReportRange() {
  const start = document.getElementById('report-custom-start').value;
  const end = document.getElementById('report-custom-end').value;
  if (!start || !end) {
    showToast("Please pick both start and end dates.", "warning");
    return;
  }
  AppState.activeReportRange = 'custom';
  loadReportsData();
}

async function loadReportsData() {
  if (!AppState.business) return;

  const range = AppState.activeReportRange;
  const start = document.getElementById('report-custom-start').value;
  const end = document.getElementById('report-custom-end').value;

  let queryUrl = `/api/reports/summary?business_code=${AppState.business.business_code}&range=${range}`;
  if (range === 'custom' && start && end) {
    queryUrl += `&start_date=${start}&end_date=${end}`;
  }

  try {
    // 1. Load KPI Summary
    const sumRes = await fetch(queryUrl);
    const sumData = await sumRes.json();

    document.getElementById('kpi-total-sales').textContent = `Rs. ${sumData.total_sales.toFixed(2)}`;
    document.getElementById('kpi-net-profit').textContent = `Rs. ${sumData.net_profit.toFixed(2)}`;
    document.getElementById('kpi-total-invoices').textContent = sumData.total_bills;
    document.getElementById('kpi-low-stock-count').textContent = sumData.low_stock_items;

    // 2. Load Invoices Table
    let invUrl = `/api/invoices?business_code=${AppState.business.business_code}&range=${range}`;
    if (range === 'custom' && start && end) {
      invUrl += `&start_date=${start}&end_date=${end}`;
    }
    const invRes = await fetch(invUrl);
    const invoices = await invRes.json();

    const tbody = document.getElementById('invoices-table-body');
    if (!tbody) return;

    if (invoices.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--text-dim);">No invoices recorded for this period.</td></tr>`;
      return;
    }

    tbody.innerHTML = invoices.map(inv => {
      const isVoid = inv.status === 'VOIDED';
      const statusBadge = isVoid ? `<span class="badge badge-danger">VOIDED</span>` : `<span class="badge badge-emerald">PAID</span>`;

      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05); ${isVoid ? 'opacity: 0.6;' : ''}">
          <td style="padding: 10px; font-family: var(--font-mono); font-weight: 700; color: #ffffff;">${inv.invoice_number}</td>
          <td style="padding: 10px; font-size: 11px; color: var(--text-muted);">${new Date(inv.date_time).toLocaleString()}</td>
          <td style="padding: 10px; color: var(--text-main);">${inv.cashier_username}</td>
          <td style="padding: 10px; color: var(--cyan);">${inv.payment_method}</td>
          <td style="padding: 10px; text-align: right; font-family: var(--font-mono); font-weight: 700; color: #ffffff;">Rs. ${inv.grand_total.toFixed(2)}</td>
          <td style="padding: 10px; text-align: center;">${statusBadge}</td>
          <td style="padding: 10px; text-align: right;">
            <button class="btn btn-sm btn-glass" onclick="reprintInvoice(${inv.id})">🖨️ Reprint</button>
            ${!isVoid ? `<button class="btn btn-sm btn-danger" onclick="voidInvoice(${inv.id})">❌ Void</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error("[REPORTS LOAD ERROR]", err);
  }
}

async function reprintInvoice(invId) {
  playBeep('click');
  try {
    const res = await fetch(`/api/invoices?business_code=${AppState.business.business_code}&range=this_month`);
    const list = await res.json();
    const inv = list.find(x => x.id === invId);
    if (inv) {
      openReceiptModal(inv);
    }
  } catch (e) { }
}

async function voidInvoice(invId) {
  if (!confirm("Are you sure you want to VOID this invoice? Item stocks will automatically be restored!")) return;
  playBeep('click');

  try {
    const res = await fetch(`/api/invoices/${invId}/void?business_code=${AppState.business.business_code}`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to void invoice');

    playBeep('warning');
    showToast(data.message, "warning");
    loadReportsData();
    loadItemsCatalog(true);
  } catch (err) {
    showToast(err.message, "error");
  }
}

function exportReportCSV() {
  playBeep('click');
  const range = AppState.activeReportRange;
  const start = document.getElementById('report-custom-start').value;
  const end = document.getElementById('report-custom-end').value;

  let url = `/api/reports/export?business_code=${AppState.business.business_code}&range=${range}`;
  if (range === 'custom' && start && end) {
    url += `&start_date=${start}&end_date=${end}`;
  }

  window.open(url, '_blank');
  showToast("Downloading sales report CSV...", "info");
}

// ---------------------------------------------------------------------------
// BILINGUAL USER GUIDE MODAL
// ---------------------------------------------------------------------------
function openUserGuideModal() {
  playBeep('click');
  document.getElementById('modal-user-guide').classList.add('active');
}

function closeUserGuideModal() {
  playBeep('click');
  document.getElementById('modal-user-guide').classList.remove('active');
}

function switchGuideLang(lang) {
  playBeep('click');
  const enBtn = document.getElementById('guide-lang-en');
  const siBtn = document.getElementById('guide-lang-si');
  const enSec = document.getElementById('guide-content-en');
  const siSec = document.getElementById('guide-content-si');

  if (lang === 'si') {
    enBtn.className = 'btn btn-sm btn-glass';
    siBtn.className = 'btn btn-sm btn-cyan';
    enSec.style.display = 'none';
    siSec.style.display = 'block';
  } else {
    enBtn.className = 'btn btn-sm btn-cyan';
    siBtn.className = 'btn btn-sm btn-glass';
    enSec.style.display = 'block';
    siSec.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// System Health Check & Anti-Sleep Ping
// ---------------------------------------------------------------------------
async function checkSystemHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();

    const pill = document.getElementById('db-status-text');
    const wsBadge = document.getElementById('ws-db-badge');
    const isSupabase = Boolean(data.database_type && data.database_type.includes('Supabase'));

    if (pill) {
      pill.textContent = isSupabase ? "Supabase Cloud Engine" : "Offline SQLite Engine";
    }
    if (wsBadge) {
      wsBadge.textContent = isSupabase ? "Supabase Cloud" : "Local SQLite";
      wsBadge.style.color = isSupabase ? "#06b6d4" : "#f59e0b";
    }
  } catch (e) {
    updateSyncStatusUI(false);
  }
}

function startAntiSleepPing() {
  setInterval(async () => {
    try {
      await fetch('/ping');
    } catch (e) { }
  }, 30000);
}

// ---------------------------------------------------------------------------
// System Initialization
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initClientProtection();
  checkSystemHealth();
  startAntiSleepPing();

  window.addEventListener('online', () => {
    updateSyncStatusUI(true);
    checkSystemHealth();
  });
  window.addEventListener('offline', () => {
    updateSyncStatusUI(false);
  });

  // Clear login inputs on load to prevent unwanted browser auto-fill
  ['unlock-biz-code', 'unlock-biz-pass', 'pos-login-username', 'pos-login-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // Try recovering session from localStorage
  try {
    const savedBiz = localStorage.getItem('supiripos_biz_session');
    const savedUser = localStorage.getItem('supiripos_user_session');

    if (savedBiz && savedUser) {
      AppState.business = JSON.parse(savedBiz);
      AppState.user = JSON.parse(savedUser);
      enterWorkspace();
    } else if (savedBiz) {
      AppState.business = JSON.parse(savedBiz);
      openPOSStaffLogin();
    } else {
      showView('landing');
    }
  } catch (e) {
    showView('landing');
  }
});
