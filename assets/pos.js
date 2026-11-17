/**
 * SupiriPOS PRO - Main Client-Side Controller
 * Powered by PrasaTek System Solutions (https://pos.prasatek.lk)
 * Multi-Tenant Cloud POS with Real-Time WebSockets
 */

// Global Application State
const AppState = {
  currentView: 'landing', // 'landing', 'pos-login', 'workspace'
  currentTab: 'dashboard',// 'dashboard', 'billing', 'items', 'stock', 'users', 'reports'
  currentReportsSubTab: 'sales', // 'sales', 'credit', 'bincard', 'activity'
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
  reportInvoices: [],          // All invoices loaded for the selected date range
  filteredReportInvoices: [],  // Invoices after search, staff, and payment method filters
  reportPage: 1,               // Current pagination page on Reports table
  reportPageSize: 25,          // Rows per page on Reports table
  selectedDetailInvoiceId: null,
  lowStockCountSummary: 0,
  users: [],                   // Cached staff accounts for staff name resolution
  lowStockItems: [],           // Cache of items below alert threshold for interactive review
  creditCustomers: [],         // In-memory cached credit customers for 0ms phone lookup
  creditLedger: [],            // Recent credit ledger entries
  creditSummary: {
    total_outstanding_credit: 0,
    active_credit_customers: 0,
    total_customers: 0,
    credit_collected_today: 0
  },
  selectedCreditCustomer: null,// Currently selected customer on Billing when paymentMode === 'Credit'
  creditCustomerFilter: 'all', // 'all', 'active', 'settled'
  activePayCreditCustomerId: null,
  activeHistoryCustomerId: null,
  activeHistoryCustomer: null,
  activeHistoryLedger: [],
  addCustomerFromBilling: false,
  socket: null,
  wsReconnectTimer: null,
  syncInterval: null,
  clockInterval: null,
  registeredBizData: null,// Stores generated credentials card info
  prefilledCredentials: false
};

// ---------------------------------------------------------------------------
// Silent Feedback Stub (All click / beep sounds completely removed)
// ---------------------------------------------------------------------------
function playBeep() {
  // Intentionally silent: all audio / click / beep sounds are disabled
}

// ---------------------------------------------------------------------------
// Safe Number & Staff Identifier Resolution Helpers (No NaN / null / undefined)
// ---------------------------------------------------------------------------
function safeNum(val, fallback = 0) {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function resolveStaffName(record, fallback = 'Admin') {
  if (!record || typeof record !== 'object') return fallback;

  const candidates = [
    record.staff_name,
    record.cashier_name,
    record.staff_display,
    record.staff_username,
    record.cashier_username,
    record.user_name,
    record.username,
    record.cashier,
    record.created_by
  ];

  for (const raw of candidates) {
    if (raw !== null && raw !== undefined) {
      const cleaned = String(raw).trim();
      if (
        cleaned &&
        cleaned.toLowerCase() !== 'undefined' &&
        cleaned.toLowerCase() !== 'null' &&
        cleaned.toLowerCase() !== 'nan'
      ) {
        // Check if we can enrich username with full_name from cached staff list
        if (Array.isArray(AppState.users) && AppState.users.length > 0) {
          const matchedUser = AppState.users.find(
            u =>
              (u.username && u.username.toLowerCase() === cleaned.toLowerCase()) ||
              (u.full_name && u.full_name.toLowerCase() === cleaned.toLowerCase())
          );
          if (matchedUser && matchedUser.full_name) {
            return matchedUser.full_name;
          }
        }
        return cleaned;
      }
    }
  }

  return fallback;
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
// User Page Access Permission Helper & Keyboard Shortcut Access Control
// ---------------------------------------------------------------------------
function hasUserTabPermission(tabName) {
  const user = AppState.user;
  if (!user) return false;

  const perms = user.permissions || {
    billing: user.can_billing !== undefined ? Boolean(user.can_billing) : true,
    items: user.can_items !== undefined ? Boolean(user.can_items) : true,
    stock: user.can_stock !== undefined ? Boolean(user.can_stock) : true,
    users: user.can_users !== undefined ? Boolean(user.can_users) : true,
    reports: user.can_reports !== undefined ? Boolean(user.can_reports) : true
  };

  const normalized = String(tabName || '').toLowerCase();
  if (normalized === 'dashboard') {
    return Boolean(perms.reports || perms.users || perms.stock || perms.items);
  }
  if (normalized === 'billing') return Boolean(perms.billing);
  if (normalized === 'items' || normalized === 'products') return Boolean(perms.items);
  if (normalized === 'stock') return Boolean(perms.stock);
  if (normalized === 'users' || normalized === 'staff') return Boolean(perms.users);
  if (normalized === 'reports') return Boolean(perms.reports);
  if (normalized === 'settings') {
    return Boolean(perms.users || user.role_title === 'Store Manager' || user.role_title === 'Admin');
  }
  if (normalized === 'support') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Client-Side Protection & Security (with Strict Shortcut Access Control)
// ---------------------------------------------------------------------------
function initClientProtection() {
  // Prevent context menu
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showToast("SupiriPOS PRO • Protected POS Terminal", "info", 1500);
  });

  // Keyboard shortcuts & DevTools protection
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J')) || (e.ctrlKey && e.key === 'u')) {
      e.preventDefault();
      showToast("Developer tools restricted on commercial POS station.", "warning", 2000);
      return;
    }

    if (AppState.currentView !== 'workspace') return;

    // F1 - F6 or Alt+1 - Alt+6 tab navigation shortcuts
    const shortcutTabMap = {
      'F1': 'dashboard',
      'F2': 'billing',
      'F3': 'items',
      'F4': 'stock',
      'F5': 'users',
      'F6': 'reports'
    };
    const altKeyMap = {
      '1': 'dashboard',
      '2': 'billing',
      '3': 'items',
      '4': 'stock',
      '5': 'users',
      '6': 'reports'
    };

    const targetTab = shortcutTabMap[e.key] || (e.altKey ? altKeyMap[e.key] : null);
    if (targetTab) {
      e.preventDefault();
      if (!hasUserTabPermission(targetTab)) {
        showToast("⚠️ Access Denied: You do not have permission to access this section.", "warning");
        return;
      }
      switchPOSTab(targetTab);
      return;
    }

    // F9 or F10 shortcut for Complete Sale on Billing tab
    if (e.key === 'F9' || e.key === 'F10') {
      e.preventDefault();
      if (!hasUserTabPermission('billing') || AppState.currentTab !== 'billing') {
        showToast("⚠️ Access Denied: You do not have permission to access this section.", "warning");
        return;
      }
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
  const wsBadge = document.getElementById('ws-db-badge');
  const isBrowserOnline = navigator.onLine !== false;

  if (statusEl) {
    if (!isBrowserOnline) {
      statusEl.textContent = "Offline (Local)";
      statusEl.style.color = "var(--warning)";
      if (dotEl) dotEl.style.backgroundColor = "var(--warning)";
    } else {
      statusEl.textContent = "Online • Synced";
      statusEl.style.color = "var(--emerald)";
      if (dotEl) dotEl.style.backgroundColor = "var(--emerald)";
      if (wsBadge) {
        wsBadge.textContent = "SUPABASE CLOUD ONLINE";
        wsBadge.style.color = "#10b981";
      }
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
    loadCreditCustomersData();
    if (AppState.currentTab === 'dashboard') loadDashboardStats();
    if (AppState.currentTab === 'reports') loadReportsData();
    if (AppState.currentTab === 'stock') loadStockLogs();
  } else if (event.type === 'INVOICE_VOIDED') {
    loadItemsCatalog(AppState.currentTab === 'billing');
    loadCreditCustomersData();
    if (AppState.currentTab === 'dashboard') loadDashboardStats();
    if (AppState.currentTab === 'reports') loadReportsData();
    if (AppState.currentTab === 'stock') loadStockLogs();
    showToast(`Invoice #${event.invoice_number} voided. Stock restored.`, "warning", 3000);
  } else if (event.type === 'CREDIT_UPDATED') {
    loadCreditCustomersData();
    if (AppState.currentTab === 'reports' && AppState.currentReportsSubTab === 'activity') {
      loadActivityLogsData();
    }
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
      if (Array.isArray(data.credit_customers)) {
        AppState.creditCustomers = data.credit_customers;
      }
      if (Array.isArray(data.credit_ledger)) {
        AppState.creditLedger = data.credit_ledger;
      }
      if (AppState.stateVersion !== null && data.state_version !== AppState.stateVersion) {
        AppState.stateVersion = data.state_version;
        await loadItemsCatalog(AppState.currentTab === 'billing');
        if (AppState.currentTab === 'dashboard') loadDashboardStats();
        if (AppState.currentTab === 'reports' && AppState.currentReportsSubTab === 'credit') {
          loadCreditCustomersData();
        }
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
  const landing = document.getElementById('view-landing');
  const posLogin = document.getElementById('view-pos-login');
  const workspace = document.getElementById('view-workspace');
  const masterAdmin = document.getElementById('view-master-admin');

  if (landing) landing.style.display = 'none';
  if (posLogin) posLogin.style.display = 'none';
  if (workspace) workspace.style.display = 'none';
  if (masterAdmin) masterAdmin.style.display = 'none';

  AppState.currentView = viewId;

  if (viewId === 'landing') {
    if (landing) landing.style.display = 'flex';
  } else if (viewId === 'pos-login') {
    if (posLogin) posLogin.style.display = 'flex';
  } else if (viewId === 'workspace') {
    if (workspace) workspace.style.display = 'flex';
  } else if (viewId === 'master-admin') {
    if (masterAdmin) masterAdmin.style.display = 'block';
  }
}

function returnToLanding() {
  showView('landing');
}

function switchBusinessTerminal() {
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
    showToast("🎉 Welcome to Supiri Mart Supermarket (PT-DEMO)!", "success", 3000);
    enterWorkspace();
  } catch (err) {
    showToast(`Failed to launch demo: ${err.message}`, "error");
  }
}

// Gateway 2: Business Registration Wizard Modals
function openRegistrationModal() {
  document.getElementById('modal-register').classList.add('active');
  goToRegStep(1);
}

function closeRegistrationModal() {
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
  const btn = document.getElementById('btn-send-otp');
  const email = document.getElementById('reg-email').value.trim();
  if (!email || !email.includes('@')) {
    showToast("Please enter a valid email address.", "warning");
    return;
  }

  // Instant visual feedback
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-dot"></span> Sending…'; }

  try {
    const res = await fetch('/api/auth/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to send verification email');

    // Reveal OTP input field and focus it
    const otpGroup = document.getElementById('reg-otp-group');
    if (otpGroup) otpGroup.style.display = 'block';
    const otpInput = document.getElementById('reg-otp-code');
    if (otpInput) {
      otpInput.value = '';
      otpInput.focus();
    }

    showToast(
      data.message || `📧 A 6-digit verification code has been sent to ${email}. Please check your inbox.`,
      "success",
      6000
    );
    // Keep button disabled briefly to prevent spam clicks
    if (btn) { btn.innerHTML = '✓ Sent'; }
    setTimeout(() => { if (btn) { btn.disabled = false; btn.innerHTML = 'Send OTP'; } }, 30000);
  } catch (err) {
    showToast(err.message, "error");
    if (btn) { btn.disabled = false; btn.innerHTML = 'Send OTP'; }
  }
}

async function verifyOTPAndGoStep2() {
  const btn = document.getElementById('btn-verify-otp');
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

  // Instant visual feedback
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-dot"></span> Verifying…'; }

  try {
    const res = await fetch('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp_code: otp })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'OTP verification failed');
    showToast("Email verified successfully!", "success");
    if (btn) { btn.disabled = false; btn.innerHTML = 'Verify & Continue ➔'; }
    goToRegStep(2);
  } catch (err) {
    showToast(err.message, "error");
    if (btn) { btn.disabled = false; btn.innerHTML = 'Verify & Continue ➔'; }
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
  const btn = document.getElementById('btn-complete-reg');
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

  // Instant visual feedback
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-dot"></span> Registering…'; }

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
    showToast(`🎉 Registration Complete! Your Code: ${data.business_code}`, "success", 4000);
    if (btn) { btn.disabled = false; btn.innerHTML = '🚀 Complete Registration'; }
    goToRegStep(4);
  } catch (err) {
    showToast(err.message, "error");
    if (btn) { btn.disabled = false; btn.innerHTML = '🚀 Complete Registration'; }
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
  document.getElementById('modal-unlock-biz').classList.remove('remove');
  document.getElementById('modal-unlock-biz').classList.remove('active');
}

async function handleUnlockBiz(e) {
  e.preventDefault();
  const rawCode = document.getElementById('unlock-biz-code').value.trim();
  const password = document.getElementById('unlock-biz-pass').value.trim();

  if (!rawCode || !password) {
    showToast("Please enter business code and password.", "warning");
    return;
  }

  showToast("Unlocking terminal...", "info", 1500);

  try {
    const res = await fetch('/api/auth/unlock-business', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_code: rawCode, business_password: password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Terminal unlock failed');

    // Stealth Master Admin Interception
    if (data.role === 'super_admin') {
      localStorage.setItem('supiripos_admin_token', data.token);
      localStorage.setItem('supiripos_admin_email', data.admin_email);
      closeUnlockBizModal();
      showToast("👑 Master Control Panel Activated", "success", 2500);
      openMasterAdminPanel();
      return;
    }

    AppState.business = data.business;
    localStorage.setItem('supiripos_biz_session', JSON.stringify(AppState.business));

    closeUnlockBizModal();
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
        business_code: AppState.business ? AppState.business.business_code : '',
        username,
        password
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Invalid staff credentials');

    // Stealth Master Admin Interception
    if (data.role === 'super_admin') {
      localStorage.setItem('supiripos_admin_token', data.token);
      localStorage.setItem('supiripos_admin_email', data.admin_email);
      showToast("👑 Master Control Panel Activated", "success", 2500);
      openMasterAdminPanel();
      return;
    }

    // Check if mandatory first-time credential change is required (default user / 123)
    if (data.user && data.user.must_change_password) {
      AppState.pendingAdminUser = data.user;
      openSecureAdminModal(data.user);
      return;
    }

    AppState.user = data.user;
    localStorage.setItem('supiripos_user_session', JSON.stringify(AppState.user));
    showToast(`Welcome, ${data.user.full_name}! Shift opened.`, "success");
    enterWorkspace();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Mandatory First-Time Admin Credential Change Modal
function openSecureAdminModal(userObj) {
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
        business_code: AppState.business ? AppState.business.business_code : '',
        user_id: AppState.pendingAdminUser ? AppState.pendingAdminUser.id : null,
        current_username: AppState.pendingAdminUser ? AppState.pendingAdminUser.username : 'user',
        current_password: '123',
        new_username: newUsername,
        new_password: newPassword,
        new_full_name: fullName || 'Store Admin',
        full_name: fullName || 'Store Admin'
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to update admin credentials');

    document.getElementById('modal-secure-admin').classList.remove('active');
    AppState.user = data.user;
    AppState.pendingAdminUser = null;
    localStorage.setItem('supiripos_user_session', JSON.stringify(AppState.user));
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

  // Header Details: Keep ONLY official /assets/logo.png, Business Code badge, and Status (no shop name in header)
  const wsCodeEl = document.getElementById('ws-shop-code');
  if (wsCodeEl) wsCodeEl.textContent = biz.business_code;

  const wsLogoEl = document.getElementById('ws-shop-logo');
  if (wsLogoEl) wsLogoEl.src = '/assets/logo.png';

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

  // Pre-load credit customers in memory for 0ms phone lookup on Billing
  loadCreditCustomersData();

  // Pre-load items catalog in memory for 0ms instant search & tab switching
  loadItemsCatalog(true).then(() => {
    switchPOSTab(initialTab);
  });
}

function switchPOSTab(tab) {
  let normalizedTab = String(tab || '').toLowerCase();
  if (normalizedTab === 'products') normalizedTab = 'items';
  if (normalizedTab === 'staff') normalizedTab = 'users';

  // Strictly enforce user page access permissions before switching tabs
  if (!hasUserTabPermission(normalizedTab)) {
    showToast("⚠️ Access Denied: You do not have permission to access this section.", "warning");
    return false;
  }

  AppState.currentTab = normalizedTab;

  // Strict Tab Isolation across all 8 main tabs
  const tabs = ['dashboard', 'billing', 'items', 'stock', 'users', 'reports', 'settings', 'support'];
  tabs.forEach(t => {
    const btn = document.getElementById(`nav-btn-${t}`);
    const sec = document.getElementById(`tab-${t}`);
    const isActive = (t === normalizedTab);

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
  if (normalizedTab === 'dashboard') {
    loadDashboardStats();
  } else if (normalizedTab === 'billing') {
    renderBillingItemsGrid();
    const searchInput = document.getElementById('billing-search-input');
    if (searchInput) searchInput.focus();
  } else if (normalizedTab === 'items') {
    loadItemsTable();
  } else if (normalizedTab === 'stock') {
    loadStockPage();
  } else if (normalizedTab === 'users') {
    loadUsersTable();
  } else if (normalizedTab === 'reports') {
    switchReportsSubTab(AppState.currentReportsSubTab || 'sales');
  } else if (normalizedTab === 'settings') {
    loadBusinessSettingsForm();
  } else if (normalizedTab === 'support') {
    loadMerchantSupportTickets();
  }
  return true;
}
const switchPosTab = switchPOSTab;

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
          const dt = inv.date_time ? new Date(inv.date_time).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
          const staffDisplay = resolveStaffName(inv, 'Admin');
          return `
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.04); ${isVoid ? 'opacity: 0.5;' : ''}">
              <td style="padding: 11px 10px; font-family: var(--font-mono); font-weight: 700; color: var(--cyan); white-space: nowrap;">${inv.invoice_number}</td>
              <td style="padding: 11px 10px; color: var(--text-muted); font-size: 13px; white-space: nowrap;">${dt}</td>
              <td style="padding: 11px 10px; font-size: 13.5px; white-space: nowrap;">👤 ${staffDisplay}</td>
              <td style="padding: 11px 10px; text-align: right; font-family: var(--font-mono); font-size: 14px; font-weight: 700; color: var(--emerald); white-space: nowrap;">Rs. ${safeNum(inv.grand_total).toFixed(2)}</td>
              <td style="padding: 11px 10px; text-align: center; white-space: nowrap;"><span class="badge">${inv.payment_method || 'Cash'}</span></td>
              <td style="padding: 11px 10px; text-align: center; white-space: nowrap;">
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
          <div style="display: flex; align-items: center; justify-content: space-between; padding: 11px 14px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-glass); border-radius: 10px;">
            <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
              <span class="badge ${idx === 0 ? 'badge-emerald' : 'badge-cyan'}" style="font-family: var(--font-mono); font-size: 12px;">#${idx + 1}</span>
              <div style="min-width: 0;">
                <div style="font-size: 14px; font-weight: 700; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.name}</div>
                <div style="font-size: 12.5px; color: var(--text-muted);">${qtyVal} units sold</div>
              </div>
            </div>
            <div style="font-family: var(--font-mono); font-size: 14px; font-weight: 700; color: var(--emerald); flex-shrink: 0;">
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
          <td style="padding: 10px; font-family: var(--font-mono); font-size: 13px; color: var(--text-muted);">${item.code}</td>
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
  document.getElementById('modal-low-stock').classList.remove('active');
}

function quickRestockItem(itemId) {
  if (!hasUserTabPermission('stock')) {
    showToast("⚠️ Access Denied: You do not have permission to access this section.", "warning");
    return;
  }
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
      showToast(`No item found matching "${query}"`, "warning", 2000);
    }
  }
}

function renderBillingItemsGrid() {
  const container = document.getElementById('billing-items-grid');
  if (!container) return;

  if (AppState.filteredItems.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: var(--text-dim); padding: 40px 0; font-size: 14px;">
        No products found in this category.
      </div>
    `;
    return;
  }

  container.innerHTML = AppState.filteredItems.map(item => {
    let stockBadge = `<span class="badge badge-emerald" style="font-size: 11px;">${item.stock_quantity} ${item.unit}</span>`;
    if (item.stock_quantity <= 0) {
      stockBadge = `<span class="badge badge-danger" style="font-size: 11px;">Out of Stock</span>`;
    } else if (item.stock_quantity <= item.low_stock_level) {
      stockBadge = `<span class="badge badge-warning" style="font-size: 11px;">Low: ${item.stock_quantity}</span>`;
    }

    return `
      <div class="glass-panel glass-panel-interactive" style="padding: 14px; cursor: pointer; display: flex; flex-direction: column; justify-content: space-between; position: relative;" onclick="addToCartById(${item.id})">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: start; gap: 6px; margin-bottom: 6px;">
            <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-dim);">${item.code}</span>
            ${stockBadge}
          </div>
          <div style="font-size: 14px; font-weight: 700; color: #ffffff; line-height: 1.3; margin-bottom: 6px;">
            ${item.name}
          </div>
          <div style="font-size: 12px; color: var(--text-dim);">${item.category || 'General'}</div>
        </div>

        <div style="margin-top: 10px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-glass); padding-top: 8px;">
          <div style="font-size: 16px; font-weight: 800; color: var(--cyan); font-family: var(--font-mono);">
            Rs. ${item.selling_price.toFixed(2)}
          </div>
          <button class="btn btn-sm btn-cyan" style="padding: 5px 10px; font-size: 12.5px;" onclick="event.stopPropagation(); addToCartById(${item.id})">
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
  AppState.cart.splice(index, 1);
  renderCartUI();
}

function clearCurrentCart() {
  if (AppState.cart.length === 0) return;
  AppState.cart = [];
  document.getElementById('bill-discount-input').value = '0';
  document.getElementById('bill-cash-received').value = '';
  const creditPhoneEl = document.getElementById('billing-credit-phone-input');
  if (creditPhoneEl) creditPhoneEl.value = '';
  AppState.selectedCreditCustomer = null;
  handleBillingCreditPhoneInput('');
  renderCartUI();
  showToast("Bill cleared.", "info", 1500);
}

function renderCartUI() {
  const container = document.getElementById('cart-items-list');
  const countEl = document.getElementById('cart-item-count');

  if (AppState.cart.length === 0) {
    countEl.textContent = '0 items in bill';
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-dim); margin-top: 60px; font-size: 14px;">
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
    <div style="background: rgba(11, 17, 32, 0.65); border: 1px solid var(--border-glass); border-radius: 10px; padding: 11px; display: flex; flex-direction: column; gap: 6px;">
      <div style="display: flex; justify-content: space-between; align-items: start;">
        <div style="flex: 1; padding-right: 6px;">
          <div style="font-size: 14px; font-weight: 700; color: #ffffff;">${c.name}</div>
          <div style="font-size: 12px; color: var(--text-dim); font-family: var(--font-mono);">
            ${c.code} • Rs. ${c.selling_price.toFixed(2)} / ${c.unit}
          </div>
        </div>
        <div style="font-size: 15px; font-weight: 800; color: var(--cyan); font-family: var(--font-mono);">
          Rs. ${c.total.toFixed(2)}
        </div>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px;">
        <div style="display: flex; align-items: center; gap: 5px;">
          <button class="btn btn-sm btn-glass" style="padding: 3px 9px; font-size: 13px;" onclick="updateCartQty(${i}, -1)">-</button>
          <input type="number" class="form-control" style="width: 60px; padding: 3px 5px; font-size: 13px; text-align: center; font-family: var(--font-mono);" value="${c.quantity}" min="1" step="any" onchange="setDirectCartQty(${i}, this.value)">
          <button class="btn btn-sm btn-glass" style="padding: 3px 9px; font-size: 13px;" onclick="updateCartQty(${i}, 1)">+</button>
        </div>

        <button class="btn btn-sm btn-danger" style="padding: 3px 9px; font-size: 12px;" onclick="removeCartItem(${i})">
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
  const changeEl = document.getElementById('bill-change-due');
  const changeLabelEl = document.getElementById('bill-change-due-label');

  if (AppState.paymentMode === 'Credit') {
    const creditAdded = Math.max(0, grandTotal - cashInput);
    if (changeLabelEl) {
      changeLabelEl.textContent = "Credit Added (ණයට එකතුව)";
      changeLabelEl.style.color = "var(--warning)";
    }
    changeEl.textContent = `Rs. ${creditAdded.toFixed(2)}`;
    changeEl.style.color = "var(--warning)";

    if (AppState.selectedCreditCustomer) {
      const prevBal = safeNum(AppState.selectedCreditCustomer.credit_balance);
      const newBal = prevBal + creditAdded;
      const prevEl = document.getElementById('billing-credit-prev-balance');
      const newEl = document.getElementById('billing-credit-new-balance');
      if (prevEl) prevEl.textContent = `Rs. ${prevBal.toFixed(2)}`;
      if (newEl) newEl.textContent = `Rs. ${newBal.toFixed(2)}`;
    }
  } else {
    const changeDue = Math.max(0, cashInput - grandTotal);
    if (changeLabelEl) {
      changeLabelEl.textContent = "Balance / Change (ඉතුරු)";
      changeLabelEl.style.color = "var(--emerald)";
    }
    changeEl.textContent = `Rs. ${changeDue.toFixed(2)}`;

    if (cashInput >= grandTotal && grandTotal > 0) {
      changeEl.style.color = "var(--emerald)";
    } else {
      changeEl.style.color = "var(--text-dim)";
    }
  }
}

function selectPaymentMode(mode) {
  AppState.paymentMode = mode;

  const buttons = document.querySelectorAll('.pay-mode-btn');
  buttons.forEach(btn => {
    btn.className = (btn.getAttribute('data-mode') === mode) ? 'btn btn-sm btn-cyan pay-mode-btn' : 'btn btn-sm btn-glass pay-mode-btn';
  });

  const tenderShortcuts = document.getElementById('cash-tender-shortcuts');
  const creditPanel = document.getElementById('billing-credit-customer-panel');
  const cashLabel = document.getElementById('bill-cash-received-label');

  if (mode === 'Credit') {
    if (tenderShortcuts) tenderShortcuts.style.display = 'none';
    if (creditPanel) creditPanel.style.display = 'flex';
    if (cashLabel) cashLabel.textContent = 'Down Payment / Cash Now (අත්තිකාරම්)';
    document.getElementById('bill-cash-received').value = '0';
    calculateBillTotals();
    const phoneInput = document.getElementById('billing-credit-phone-input');
    if (phoneInput) {
      handleBillingCreditPhoneInput(phoneInput.value || '');
      phoneInput.focus();
    }
  } else if (mode === 'Cash') {
    if (tenderShortcuts) tenderShortcuts.style.display = 'flex';
    if (creditPanel) creditPanel.style.display = 'none';
    if (cashLabel) cashLabel.textContent = 'Cash Received (රු.)';
    calculateBillTotals();
  } else {
    if (tenderShortcuts) tenderShortcuts.style.display = 'none';
    if (creditPanel) creditPanel.style.display = 'none';
    if (cashLabel) cashLabel.textContent = 'Cash Received (රු.)';
    setExactTender();
  }
}

function normalizeClientPhone(phoneStr) {
  return String(phoneStr || '').replace(/[^\d+]/g, '').trim();
}

let _creditLookupTimer = null;
function handleBillingCreditPhoneInput(rawPhone) {
  const cleanPhone = normalizeClientPhone(rawPhone);
  const foundCard = document.getElementById('billing-credit-found-card');
  const notFoundCard = document.getElementById('billing-credit-notfound-card');
  const statusBadge = document.getElementById('billing-credit-status-badge');

  if (!cleanPhone) {
    AppState.selectedCreditCustomer = null;
    if (foundCard) foundCard.style.display = 'none';
    if (notFoundCard) notFoundCard.style.display = 'none';
    if (statusBadge) {
      statusBadge.className = 'badge badge-warning';
      statusBadge.textContent = 'Required';
    }
    return;
  }

  // 1. Instant 0ms lookup against in-memory cached creditCustomers
  const localMatch = (AppState.creditCustomers || []).find(
    c => normalizeClientPhone(c.phone) === cleanPhone
  );

  if (localMatch) {
    selectBillingCreditCustomer(localMatch);
    return;
  }

  // Partial match if user typed at least 9 digits
  if (cleanPhone.length >= 9) {
    const suffixMatch = (AppState.creditCustomers || []).find(
      c => normalizeClientPhone(c.phone).endsWith(cleanPhone.slice(-9))
    );
    if (suffixMatch) {
      selectBillingCreditCustomer(suffixMatch);
      return;
    }
  }

  // Not found locally yet
  AppState.selectedCreditCustomer = null;
  if (foundCard) foundCard.style.display = 'none';
  if (notFoundCard) {
    notFoundCard.style.display = cleanPhone.length >= 1 ? 'flex' : 'none';
  }
  if (statusBadge) {
    statusBadge.className = 'badge badge-danger';
    statusBadge.textContent = 'Not Found';
  }

  // Also check server via debounced lookup if 9+ digits entered
  clearTimeout(_creditLookupTimer);
  if (cleanPhone.length >= 9 && AppState.business) {
    _creditLookupTimer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/customers/lookup?business_code=${encodeURIComponent(AppState.business.business_code)}&phone=${encodeURIComponent(cleanPhone)}`
        );
        const data = await res.json();
        if (res.ok && data.found && data.customer) {
          // Upsert into AppState.creditCustomers
          const idx = AppState.creditCustomers.findIndex(c => c.id === data.customer.id);
          if (idx >= 0) AppState.creditCustomers[idx] = data.customer;
          else AppState.creditCustomers.unshift(data.customer);
          selectBillingCreditCustomer(data.customer);
        }
      } catch (e) { }
    }, 180);
  }
}

function selectBillingCreditCustomer(customer) {
  AppState.selectedCreditCustomer = customer;
  const foundCard = document.getElementById('billing-credit-found-card');
  const notFoundCard = document.getElementById('billing-credit-notfound-card');
  const statusBadge = document.getElementById('billing-credit-status-badge');

  if (notFoundCard) notFoundCard.style.display = 'none';
  if (statusBadge) {
    statusBadge.className = 'badge badge-emerald';
    statusBadge.textContent = '✓ Selected';
  }
  if (foundCard) {
    foundCard.style.display = 'block';
    const nameEl = document.getElementById('billing-credit-cust-name');
    const addrEl = document.getElementById('billing-credit-cust-address');
    const prevEl = document.getElementById('billing-credit-prev-balance');
    const newEl = document.getElementById('billing-credit-new-balance');

    const subtotal = AppState.cart.reduce((sum, item) => sum + item.total, 0);
    const discountInput = parseFloat(document.getElementById('bill-discount-input')?.value) || 0;
    const grandTotal = Math.max(0, subtotal - discountInput);
    const cashInput = parseFloat(document.getElementById('bill-cash-received')?.value) || 0;
    const creditAdded = Math.max(0, grandTotal - cashInput);
    const prevBal = safeNum(customer.credit_balance);
    const newBal = prevBal + creditAdded;

    if (nameEl) nameEl.textContent = `${customer.name} (${customer.phone})`;
    if (addrEl) addrEl.textContent = customer.address || 'No address provided';
    if (prevEl) prevEl.textContent = `Rs. ${prevBal.toFixed(2)}`;
    if (newEl) newEl.textContent = `Rs. ${newBal.toFixed(2)}`;
  }
}

function openAddCreditCustomerModal(fromBilling = true) {
  AppState.addCustomerFromBilling = Boolean(fromBilling);
  const phoneInputEl = document.getElementById('credit-cust-form-phone');
  const nameInputEl = document.getElementById('credit-cust-form-name');
  const addrInputEl = document.getElementById('credit-cust-form-address');

  const billingPhone = document.getElementById('billing-credit-phone-input')?.value || '';
  const searchPhone = document.getElementById('credit-customers-search-input')?.value || '';
  const prefillPhone = fromBilling ? normalizeClientPhone(billingPhone) : normalizeClientPhone(searchPhone);

  if (phoneInputEl) phoneInputEl.value = prefillPhone || '';
  if (nameInputEl) nameInputEl.value = '';
  if (addrInputEl) addrInputEl.value = '';

  const modal = document.getElementById('modal-add-credit-customer');
  if (modal) modal.classList.add('active');

  setTimeout(() => {
    if (prefillPhone && nameInputEl) {
      nameInputEl.focus();
    } else if (phoneInputEl) {
      phoneInputEl.focus();
    }
  }, 60);
}

function closeAddCreditCustomerModal() {
  const modal = document.getElementById('modal-add-credit-customer');
  if (modal) modal.classList.remove('active');
}

async function handleSaveCreditCustomer(e) {
  e.preventDefault();
  if (!AppState.business) return;

  const phone = normalizeClientPhone(document.getElementById('credit-cust-form-phone')?.value || '');
  const name = (document.getElementById('credit-cust-form-name')?.value || '').trim();
  const address = (document.getElementById('credit-cust-form-address')?.value || '').trim();

  if (!phone) {
    showToast("Please enter customer mobile number.", "warning");
    return;
  }
  if (!name) {
    showToast("Please enter customer full name.", "warning");
    return;
  }

  const staffUser = AppState.user?.username || AppState.user?.full_name || 'Admin';

  try {
    const res = await fetch('/api/customers/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_code: AppState.business.business_code,
        phone,
        name,
        address,
        staff_user: staffUser
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to save customer');

    const savedCust = data.customer;
    if (savedCust) {
      const existingIdx = AppState.creditCustomers.findIndex(c => c.id === savedCust.id);
      if (existingIdx >= 0) {
        AppState.creditCustomers[existingIdx] = savedCust;
      } else {
        AppState.creditCustomers.unshift(savedCust);
      }
    }

    closeAddCreditCustomerModal();
    showToast(`Customer "${name}" (${phone}) registered!`, "success");

    if (AppState.addCustomerFromBilling && savedCust) {
      const billingPhoneEl = document.getElementById('billing-credit-phone-input');
      if (billingPhoneEl) billingPhoneEl.value = savedCust.phone;
      selectBillingCreditCustomer(savedCust);
    }

    loadCreditCustomersData();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function addTenderAmount(val) {
  const input = document.getElementById('bill-cash-received');
  const curr = parseFloat(input.value) || 0;
  input.value = (curr + val).toFixed(2);
  calculateBillTotals();
}

function setExactTender() {
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
  document.getElementById('modal-held-bills').classList.remove('active');
}

function recallHeldBill(index) {
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
  AppState.heldBills.splice(index, 1);
  saveHeldBills();
  openRecallBillsModal();
}

// Complete Sale & Print
async function completeSaleAndPrint() {
  if (AppState.cart.length === 0) {
    showToast("Cannot complete sale: Cart is empty.", "warning");
    return;
  }

  const subtotal = AppState.cart.reduce((sum, item) => sum + item.total, 0);
  const discount = parseFloat(document.getElementById('bill-discount-input').value) || 0;
  const grandTotal = Math.max(0, subtotal - discount);
  const cashPaid = parseFloat(document.getElementById('bill-cash-received').value) || 0;

  if (AppState.paymentMode === 'Cash' && cashPaid < grandTotal) {
    showToast(`Insufficient cash received: Rs. ${cashPaid.toFixed(2)} vs Total Rs. ${grandTotal.toFixed(2)}`, "warning");
    document.getElementById('bill-cash-received').focus();
    return;
  }

  // Validate Credit Customer selection when payment mode is Credit ("ණයට")
  if (AppState.paymentMode === 'Credit') {
    if (!AppState.selectedCreditCustomer) {
      showToast("⚠️ Please enter a Customer Mobile Number and select or register a Credit Customer for ණයට (Credit) sales!", "warning", 4500);
      const phoneInput = document.getElementById('billing-credit-phone-input');
      if (phoneInput) phoneInput.focus();
      return;
    }
  }

  const changeDue = Math.max(0, cashPaid - grandTotal);
  const activeStaffUsername = (
    AppState.user?.username ||
    AppState.user?.full_name ||
    AppState.user?.staff_name ||
    'Admin'
  );

  const isCreditSale = AppState.paymentMode === 'Credit';
  const selectedCust = isCreditSale ? AppState.selectedCreditCustomer : null;

  const payload = {
    business_code: AppState.business.business_code,
    cashier_username: activeStaffUsername,
    payment_method: AppState.paymentMode || 'Cash',
    subtotal,
    discount_amount: discount,
    discount_percent: 0.0,
    tax_amount: 0.0,
    grand_total: grandTotal,
    cash_paid: isCreditSale ? Math.max(0, cashPaid) : ((AppState.paymentMode === 'Cash') ? cashPaid : grandTotal),
    balance_change: (AppState.paymentMode === 'Cash') ? changeDue : 0.0,
    customer_id: selectedCust ? selectedCust.id : null,
    customer_name: selectedCust ? selectedCust.name : 'Walk-in Customer',
    customer_phone: selectedCust ? selectedCust.phone : '',
    customer_address: selectedCust ? (selectedCust.address || '') : '',
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
    showToast(`Sale completed! Invoice #${data.invoice_number}`, "success");

    AppState.lastInvoice = data;

    // Refresh Credit Customers cache so updated balance is immediately reflected
    if (isCreditSale) {
      loadCreditCustomersData();
    }

    // Reset Cart & Credit Customer input
    AppState.cart = [];
    document.getElementById('bill-discount-input').value = '0';
    document.getElementById('bill-cash-received').value = '';
    const creditPhoneEl = document.getElementById('billing-credit-phone-input');
    if (creditPhoneEl) creditPhoneEl.value = '';
    AppState.selectedCreditCustomer = null;
    handleBillingCreditPhoneInput('');
    if (isCreditSale) {
      selectPaymentMode('Cash');
    } else {
      renderCartUI();
    }

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
  document.getElementById('modal-receipt').classList.remove('active');
  document.getElementById('billing-search-input').focus();
}

function switchReceiptFormat(format) {
  AppState.currentReceiptFormat = format;

  const buttons = document.querySelectorAll('.receipt-format-btn');
  buttons.forEach(b => {
    b.className = b.textContent.includes(format) ? 'btn btn-sm btn-cyan receipt-format-btn' : 'btn btn-sm btn-glass receipt-format-btn';
  });

  if (AppState.lastInvoice) {
    if (AppState.lastInvoice._isCreditPaymentReceipt) {
      renderCreditPaymentReceipt(AppState.lastInvoice, format);
    } else {
      renderThermalReceipt(AppState.lastInvoice, format);
    }
  }
}

function renderThermalReceipt(inv, format = '80mm') {
  const biz = AppState.business || {};
  const is58mm = format === '58mm';
  const widthStyle = is58mm ? 'max-width: 240px; font-size: 10px;' : 'max-width: 320px; font-size: 12px;';

  const logoHtml = biz.logo_base64 ? `
    <div style="text-align: center; margin-bottom: 8px;">
      <img src="${biz.logo_base64}" alt="Logo" style="max-height: 48px; max-width: 140px; object-fit: contain;">
    </div>
  ` : '';

  const itemsRows = (inv.items || []).map(it => {
    const qty = safeNum(it.quantity, 1);
    const unitPrice = safeNum(it.selling_price ?? it.unit_price, 0);
    const lineTotal = safeNum(it.total, qty * unitPrice);
    return `
      <tr>
        <td style="padding: 2px 0;">${it.name || 'Item'}<br><span style="font-size: 9px; opacity: 0.8;">${qty} x Rs. ${unitPrice.toFixed(2)}</span></td>
        <td style="text-align: right; vertical-align: top; padding: 2px 0;">Rs. ${lineTotal.toFixed(2)}</td>
      </tr>
    `;
  }).join('');

  const staffDisplay = resolveStaffName(inv, 'Admin');
  const subtotal = safeNum(inv.subtotal, safeNum(inv.grand_total));
  const discountAmount = safeNum(inv.discount_amount);
  const grandTotal = safeNum(inv.grand_total);
  const cashPaid = safeNum(inv.cash_paid, grandTotal);
  const balanceChange = safeNum(inv.balance_change);
  const isCredit = String(inv.payment_method || '').toUpperCase() === 'CREDIT' || safeNum(inv.credit_added) > 0;
  const creditAdded = isCredit ? safeNum(inv.credit_added, Math.max(0, grandTotal - cashPaid)) : 0;
  const prevCreditBal = safeNum(inv.previous_credit_balance);
  const totalOutBal = safeNum(inv.new_credit_balance ?? inv.customer_credit_balance, prevCreditBal + creditAdded);

  const creditCustomerBlock = isCredit ? `
    <div style="border-top: 1px dashed #000; margin-top: 6px; padding-top: 6px; font-size: ${is58mm ? '10px' : '11px'};">
      <div style="font-weight: bold; text-align: center; margin-bottom: 3px;">--- CREDIT SALE (ණය බිල්පත) ---</div>
      <div>Customer : <strong>${inv.customer_name || 'Credit Customer'}</strong></div>
      ${inv.customer_phone ? `<div>Mobile   : ${inv.customer_phone}</div>` : ''}
      <div style="display: flex; justify-content: space-between; margin-top: 3px;">
        <span>Previous Credit Bal:</span>
        <span>Rs. ${prevCreditBal.toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-weight: bold;">
        <span>This Bill Credit:</span>
        <span>+ Rs. ${creditAdded.toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-weight: bold; border-top: 1px solid #000; margin-top: 3px; padding-top: 3px;">
        <span>TOTAL OUTSTANDING:</span>
        <span>Rs. ${totalOutBal.toFixed(2)}</span>
      </div>
    </div>
  ` : '';

  const html = `
    <div style="${widthStyle} margin: 0 auto; line-height: 1.35; color: #000000; font-family: 'Courier New', Courier, monospace;">
      ${logoHtml}
      <div style="text-align: center; font-weight: bold; font-size: ${is58mm ? '13px' : '16px'}; margin-bottom: 2px;">
        ${biz.name || 'SupiriPOS PRO'}
      </div>
      <div style="text-align: center; font-size: 10px; margin-bottom: 4px;">
        ${biz.address || ''}
      </div>
      <div style="text-align: center; font-size: 10px; margin-bottom: 8px;">
        Tel: ${biz.phone || ''}
      </div>

      <div style="border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 4px 0; margin-bottom: 8px; font-size: 10px;">
        <div>Inv #: <strong>${inv.invoice_number}</strong></div>
        <div>Date : ${inv.date_time ? new Date(inv.date_time).toLocaleString() : new Date().toLocaleString()}</div>
        <div>Staff: ${staffDisplay} | Pay: ${inv.payment_method || 'Cash'}</div>
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
          <span>Rs. ${subtotal.toFixed(2)}</span>
        </div>
        ${discountAmount > 0 ? `
          <div style="display: flex; justify-content: space-between;">
            <span>Discount:</span>
            <span>- Rs. ${discountAmount.toFixed(2)}</span>
          </div>
        ` : ''}
        <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: ${is58mm ? '12px' : '14px'}; margin: 4px 0;">
          <span>TOTAL:</span>
          <span>Rs. ${grandTotal.toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>${isCredit ? 'Cash Paid Now:' : 'Cash Paid:'}</span>
          <span>Rs. ${cashPaid.toFixed(2)}</span>
        </div>
        ${!isCredit ? `
          <div style="display: flex; justify-content: space-between; font-weight: bold;">
            <span>Balance:</span>
            <span>Rs. ${balanceChange.toFixed(2)}</span>
          </div>
        ` : ''}
      </div>

      ${creditCustomerBlock}

      <div style="text-align: center; margin-top: 14px; font-size: 10px; border-top: 1px dashed #000; padding-top: 8px;">
        <div>${biz.receipt_footer || 'Thank You! Come Again!'}</div>
        <div style="font-size: 8px; margin-top: 4px; opacity: 0.7;">Powered by PrasaTek System Solutions • pos.prasatek.lk</div>
      </div>
    </div>
  `;

  document.getElementById('thermal-receipt-preview').innerHTML = html;
  document.getElementById('printable-receipt-container').innerHTML = html;
}

function renderCreditPaymentReceipt(paymentData, format = '80mm') {
  const biz = AppState.business || {};
  const is58mm = format === '58mm';
  const widthStyle = is58mm ? 'max-width: 240px; font-size: 10px;' : 'max-width: 320px; font-size: 12px;';

  const logoHtml = biz.logo_base64 ? `
    <div style="text-align: center; margin-bottom: 8px;">
      <img src="${biz.logo_base64}" alt="Logo" style="max-height: 48px; max-width: 140px; object-fit: contain;">
    </div>
  ` : '';

  const cust = paymentData.customer || {};
  const prevBal = safeNum(paymentData.previous_balance);
  const paidAmt = safeNum(paymentData.amount_paid);
  const newBal = safeNum(paymentData.new_balance);
  const staffDisplay = paymentData.staff_user || resolveStaffName(AppState.user, 'Admin');
  const dtStr = paymentData.ledger_entry?.created_at
    ? new Date(paymentData.ledger_entry.created_at).toLocaleString()
    : new Date().toLocaleString();

  const html = `
    <div style="${widthStyle} margin: 0 auto; line-height: 1.4; color: #000000; font-family: 'Courier New', Courier, monospace;">
      ${logoHtml}
      <div style="text-align: center; font-weight: bold; font-size: ${is58mm ? '13px' : '16px'}; margin-bottom: 2px;">
        ${biz.name || 'SupiriPOS PRO'}
      </div>
      <div style="text-align: center; font-size: 10px; margin-bottom: 4px;">
        ${biz.address || ''}
      </div>
      <div style="text-align: center; font-size: 10px; margin-bottom: 8px;">
        Tel: ${biz.phone || ''}
      </div>

      <div style="border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 5px 0; margin-bottom: 8px; text-align: center; font-weight: bold; font-size: ${is58mm ? '11px' : '13px'};">
        CREDIT PAYMENT RECEIPT<br>
        <span style="font-size: 10px; font-weight: normal;">(ණය ගෙවීම් ලදුපත)</span>
      </div>

      <div style="font-size: 10px; margin-bottom: 8px;">
        <div>Date     : ${dtStr}</div>
        <div>Customer : <strong>${cust.name || '-'}</strong></div>
        <div>Mobile   : ${cust.phone || '-'}</div>
        <div>Method   : ${paymentData.payment_method || 'Cash'}</div>
        <div>Staff    : ${staffDisplay}</div>
        ${paymentData.reference_note ? `<div>Note     : ${paymentData.reference_note}</div>` : ''}
      </div>

      <div style="border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 6px 0; font-size: ${is58mm ? '10px' : '11px'};">
        <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
          <span>Previous Credit Balance:</span>
          <span>Rs. ${prevBal.toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: ${is58mm ? '12px' : '13px'}; margin: 4px 0;">
          <span>AMOUNT PAID (ගෙවූ මුදල):</span>
          <span>- Rs. ${paidAmt.toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-weight: bold; border-top: 1px solid #000; padding-top: 4px; margin-top: 4px;">
          <span>REMAINING BALANCE (ඉතිරි ණය):</span>
          <span>Rs. ${newBal.toFixed(2)}</span>
        </div>
      </div>

      <div style="text-align: center; margin-top: 14px; font-size: 10px; padding-top: 4px;">
        <div>Thank You For Your Payment!</div>
        <div style="font-size: 8px; margin-top: 4px; opacity: 0.7;">Powered by PrasaTek System Solutions • pos.prasatek.lk</div>
      </div>
    </div>
  `;

  document.getElementById('thermal-receipt-preview').innerHTML = html;
  document.getElementById('printable-receipt-container').innerHTML = html;
}

function triggerThermalPrint() {
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
  document.getElementById('modal-item-form').classList.remove('active');
}

function generateRandomBarcode() {
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

  try {
    const res = await fetch(`/api/items/${itemId}?business_code=${AppState.business.business_code}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('Failed to delete item');
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
        staff_username: AppState.user?.username || AppState.user?.full_name || 'Admin',
        note
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to adjust stock');
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

      const staffDisplay = resolveStaffName(l, 'System User');
      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
          <td style="padding: 8px 10px; font-size: 11px; color: var(--text-muted); white-space: nowrap;">${l.created_at ? new Date(l.created_at).toLocaleString() : '-'}</td>
          <td style="padding: 8px 10px; font-weight: 600; color: #ffffff;">${l.item_name || '-'}</td>
          <td style="padding: 8px 10px; white-space: nowrap;">${typeBadge}</td>
          <td style="padding: 8px 10px; text-align: right; font-family: var(--font-mono); font-weight: 700; ${qtyColor}">${safeNum(l.quantity_change) > 0 ? '+' : ''}${safeNum(l.quantity_change)}</td>
          <td style="padding: 8px 10px; text-align: right; font-family: var(--font-mono); color: #ffffff;">${safeNum(l.new_stock)}</td>
          <td style="padding: 8px 10px; color: var(--text-muted); white-space: nowrap;">👤 ${staffDisplay}</td>
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
    AppState.users = Array.isArray(users) ? users : [];

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
    closeUserModal();
    showToast("Staff account updated!", "success");
    loadUsersTable();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteUser(userId) {
  if (!confirm("Are you sure you want to delete this staff user?")) return;

  try {
    const res = await fetch(`/api/users/${userId}?business_code=${AppState.business.business_code}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to delete user');
    showToast("Staff account removed.", "info");
    loadUsersTable();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// PAGE 5: 📈 REPORTS, ITEM BIN CARD, CREDIT CUSTOMERS & USER ACTIVITY AUDIT LOG
// ---------------------------------------------------------------------------
function switchReportsSubTab(subTab) {
  AppState.currentReportsSubTab = subTab;

  const subTabs = ['sales', 'credit', 'bincard', 'activity'];
  subTabs.forEach(st => {
    const btn = document.getElementById(`subnav-btn-${st}`);
    const sec = document.getElementById(`subtab-reports-${st}`);
    const isActive = (st === subTab);
    if (btn) {
      btn.className = isActive ? 'btn btn-sm btn-cyan whitespace-nowrap' : 'btn btn-sm btn-glass whitespace-nowrap';
    }
    if (sec) {
      sec.classList.toggle('active-subtab', isActive);
      sec.style.display = isActive ? 'flex' : 'none';
    }
  });

  const exportBtnContainer = document.getElementById('reports-export-container');
  if (exportBtnContainer) {
    exportBtnContainer.style.display = (subTab === 'sales') ? 'flex' : 'none';
  }

  if (subTab === 'sales') {
    loadReportsData();
  } else if (subTab === 'credit') {
    loadCreditCustomersData();
  } else if (subTab === 'bincard') {
    initBinCardProductDropdown();
    loadBinCardData();
  } else if (subTab === 'activity') {
    initActivityFilterDropdowns();
    loadActivityLogsData();
  }
}

function openBinCardSubTab(itemId = null) {
  if (!switchPOSTab('reports')) return;
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
    `<option value="${item.id}">[${item.code}] ${item.name} — (Stock: ${safeNum(item.stock_quantity)} ${item.unit || 'Pcs'})</option>`
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
      document.getElementById('bincard-header-name').textContent = data.item.name || '-';
      document.getElementById('bincard-header-code').textContent = data.item.code || '-';
      document.getElementById('bincard-header-category').textContent = data.item.category || 'General';
      document.getElementById('bincard-header-stock').textContent = `${safeNum(data.item.stock_quantity)} ${data.item.unit || 'Pcs'}`;
      document.getElementById('bincard-header-alert').textContent = `${safeNum(data.item.low_stock_level)} ${data.item.unit || 'Pcs'}`;
    }

    const tbody = document.getElementById('bincard-table-body');
    if (!tbody) return;

    const movements = data.movements || [];
    if (movements.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--text-dim);">No stock movements recorded for this product in the selected range.</td></tr>`;
      return;
    }

    tbody.innerHTML = movements.map(m => {
      let typeBadge = `<span class="badge">${m.transaction_label || m.log_type || 'MOVEMENT'}</span>`;
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
      const qtyIn = safeNum(m.qty_in);
      const qtyOut = safeNum(m.qty_out);
      const qtyInStr = qtyIn > 0 ? `+${qtyIn}` : '-';
      const qtyOutStr = qtyOut > 0 ? `-${qtyOut}` : '-';
      const runningBal = (m.running_balance !== undefined && m.running_balance !== null)
        ? safeNum(m.running_balance)
        : safeNum(m.new_stock);
      const staffDisplay = resolveStaffName(m, 'System User');

      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
          <td style="padding: 10px; font-size: 12px; color: var(--text-muted); white-space: nowrap;">${dt}</td>
          <td style="padding: 10px; white-space: nowrap;">${typeBadge}</td>
          <td style="padding: 10px; font-family: var(--font-mono); font-size: 12px; color: #ffffff;">${m.reference || m.note || '-'}</td>
          <td style="padding: 10px; text-align: right; font-family: var(--font-mono); font-weight: 700; color: var(--emerald); white-space: nowrap;">${qtyInStr}</td>
          <td style="padding: 10px; text-align: right; font-family: var(--font-mono); font-weight: 700; color: var(--danger); white-space: nowrap;">${qtyOutStr}</td>
          <td style="padding: 10px; text-align: right; font-family: var(--font-mono); font-weight: 800; color: var(--cyan); white-space: nowrap;">${runningBal}</td>
          <td style="padding: 10px; color: var(--text-main); white-space: nowrap;">👤 ${staffDisplay}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error("[BIN CARD ERROR]", err);
  }
}

function printBinCardStatement() {
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
    if (Array.isArray(users)) {
      AppState.users = users;
      userSelect.innerHTML = `<option value="ALL">All Staff Members</option>` +
        users.map(u => `<option value="${u.username}">${u.full_name || u.username} (@${u.username})</option>`).join('');
      if (currentVal) userSelect.value = currentVal;
    }
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
      const actionStr = String(log.action_type || 'ACTIVITY');
      let badgeClass = 'badge-cyan';
      if (actionStr.includes('VOID') || actionStr.includes('DELETE')) badgeClass = 'badge-danger';
      else if (actionStr.includes('BILL') || actionStr.includes('LOGIN') || actionStr.includes('CREATED')) badgeClass = 'badge-emerald';
      else if (actionStr.includes('STOCK') || actionStr.includes('LOGOUT')) badgeClass = 'badge-warning';

      const staffDisplay = resolveStaffName(log, 'System User');

      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
          <td style="padding: 10px 12px; font-size: 12px; color: var(--text-muted); white-space: nowrap;">${dt}</td>
          <td style="padding: 10px 12px; font-weight: 700; color: #ffffff; white-space: nowrap;">👤 ${staffDisplay}</td>
          <td style="padding: 10px 12px; white-space: nowrap;"><span class="badge ${badgeClass}">${actionStr}</span></td>
          <td style="padding: 10px 12px; color: var(--text-main);">${log.details || '-'}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error("[ACTIVITY LOGS ERROR]", err);
  }
}

// ---------------------------------------------------------------------------
// ADVANCED SALES REPORTS: DATE RANGES, MULTI-FILTERS, KPIs, ANALYTICS & EXPORT
// ---------------------------------------------------------------------------
function formatLocalDateISO(dateObj) {
  const yr = dateObj.getFullYear();
  const mo = String(dateObj.getMonth() + 1).padStart(2, '0');
  const da = String(dateObj.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${da}`;
}

function updateReportRangePillStyles(activeRange) {
  const buttons = document.querySelectorAll('.report-range-btn');
  buttons.forEach(b => {
    const btnRange = b.getAttribute('data-range');
    if (btnRange) {
      b.className = (btnRange === activeRange) ? 'btn btn-sm btn-cyan report-range-btn' : 'btn btn-sm btn-glass report-range-btn';
    } else {
      const matches = b.textContent.toLowerCase().includes(activeRange.replace('_', ' '));
      b.className = matches ? 'btn btn-sm btn-cyan report-range-btn' : 'btn btn-sm btn-glass report-range-btn';
    }
  });
}

function selectReportRange(range) {
  AppState.activeReportRange = range;
  updateReportRangePillStyles(range);

  const now = new Date();
  const startInput = document.getElementById('report-custom-start');
  const endInput = document.getElementById('report-custom-end');

  if (startInput && endInput) {
    if (range === 'today') {
      const todayStr = formatLocalDateISO(now);
      startInput.value = todayStr;
      endInput.value = todayStr;
    } else if (range === 'yesterday') {
      const yest = new Date(now);
      yest.setDate(now.getDate() - 1);
      const yestStr = formatLocalDateISO(yest);
      startInput.value = yestStr;
      endInput.value = yestStr;
    } else if (range === 'this_week') {
      const dayOfWeek = now.getDay(); // 0 (Sun) - 6 (Sat)
      const diffToMonday = (dayOfWeek === 0 ? -6 : 1) - dayOfWeek;
      const monday = new Date(now);
      monday.setDate(now.getDate() + diffToMonday);
      startInput.value = formatLocalDateISO(monday);
      endInput.value = formatLocalDateISO(now);
    } else if (range === 'this_month') {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      startInput.value = formatLocalDateISO(firstDay);
      endInput.value = formatLocalDateISO(now);
    } else if (range === 'custom') {
      if (!startInput.value || !endInput.value) {
        const todayStr = formatLocalDateISO(now);
        if (!startInput.value) startInput.value = todayStr;
        if (!endInput.value) endInput.value = todayStr;
      }
      startInput.focus();
    }
  }

  loadReportsData();
}

function applyCustomReportRange() {
  const start = document.getElementById('report-custom-start')?.value || '';
  const end = document.getElementById('report-custom-end')?.value || '';
  if (!start || !end) {
    showToast("Please pick both Start Date and End Date.", "warning");
    return;
  }
  AppState.activeReportRange = 'custom';
  updateReportRangePillStyles('custom');
  loadReportsData();
}

function normalizeInvoiceRecord(inv) {
  const items = Array.isArray(inv.items) ? inv.items : [];
  let calcCost = 0;
  let calcQty = 0;

  const normalizedItems = items.map(it => {
    const qty = safeNum(it.quantity, 1);
    const costPrice = safeNum(it.cost_price, 0);
    const sellingPrice = safeNum(it.selling_price ?? it.unit_price, 0);
    const lineDiscount = safeNum(it.discount, 0);
    const lineTotal = safeNum(it.total, Math.max(0, (qty * sellingPrice) - lineDiscount));
    calcCost += qty * costPrice;
    calcQty += qty;

    return {
      ...it,
      code: it.code || '-',
      name: it.name || 'Item',
      unit: it.unit || 'Pcs',
      quantity: qty,
      cost_price: costPrice,
      selling_price: sellingPrice,
      discount: lineDiscount,
      total: lineTotal
    };
  });

  const subtotal = safeNum(inv.subtotal, safeNum(inv.grand_total));
  const discountAmount = safeNum(inv.discount_amount);
  const taxAmount = safeNum(inv.tax_amount);
  const grandTotal = safeNum(inv.grand_total, Math.max(0, subtotal - discountAmount + taxAmount));
  const estimatedCost = safeNum(inv.estimated_cost, calcCost);
  const estimatedProfit = (inv.status === 'VOIDED')
    ? 0
    : safeNum(inv.estimated_profit, grandTotal - estimatedCost);
  const totalQuantity = safeNum(inv.total_quantity, calcQty);
  const staffDisplay = resolveStaffName(inv, 'Admin');
  const rawUsername = (
    inv.cashier_username &&
    String(inv.cashier_username).trim().toLowerCase() !== 'undefined' &&
    String(inv.cashier_username).trim().toLowerCase() !== 'null'
  ) ? String(inv.cashier_username).trim() : staffDisplay;

  return {
    ...inv,
    invoice_number: inv.invoice_number || `INV-${inv.id || '0000'}`,
    cashier_username: rawUsername,
    staff_name: staffDisplay,
    staff_display: staffDisplay,
    customer_name: inv.customer_name || 'Walk-in Customer',
    payment_method: inv.payment_method || 'Cash',
    subtotal,
    discount_amount: discountAmount,
    tax_amount: taxAmount,
    grand_total: grandTotal,
    cash_paid: safeNum(inv.cash_paid, grandTotal),
    balance_change: safeNum(inv.balance_change, 0),
    estimated_cost: estimatedCost,
    estimated_profit: estimatedProfit,
    item_count: normalizedItems.length,
    total_quantity: totalQuantity,
    status: inv.status || 'COMPLETED',
    items: normalizedItems
  };
}

function populateReportStaffFilter() {
  const selectEl = document.getElementById('report-staff-filter');
  if (!selectEl) return;

  const previousValue = selectEl.value || 'ALL';
  const staffMap = new Map(); // key (lowercase) -> { value, label }

  // 1. Add from registered staff accounts
  if (Array.isArray(AppState.users)) {
    AppState.users.forEach(u => {
      const uname = String(u.username || '').trim();
      const fname = String(u.full_name || uname || 'Admin').trim();
      if (uname) {
        staffMap.set(uname.toLowerCase(), {
          value: uname,
          label: fname !== uname ? `${fname} (@${uname})` : fname
        });
      }
    });
  }

  // 2. Add any additional staff identifiers present on invoices
  if (Array.isArray(AppState.reportInvoices)) {
    AppState.reportInvoices.forEach(inv => {
      const display = resolveStaffName(inv, 'Admin');
      const uname = String(inv.cashier_username || display).trim();
      const key = uname.toLowerCase();
      if (key && !staffMap.has(key)) {
        // Also check if display already exists by full name
        const existsByLabel = Array.from(staffMap.values()).some(
          entry => entry.label.toLowerCase().includes(display.toLowerCase())
        );
        if (!existsByLabel) {
          staffMap.set(key, { value: uname, label: display });
        }
      }
    });
  }

  let optionsHtml = `<option value="ALL">👤 All Staff Members</option>`;
  staffMap.forEach(entry => {
    optionsHtml += `<option value="${entry.value}">${entry.label}</option>`;
  });

  selectEl.innerHTML = optionsHtml;

  if (previousValue && Array.from(selectEl.options).some(opt => opt.value === previousValue)) {
    selectEl.value = previousValue;
  } else {
    selectEl.value = 'ALL';
  }
}

async function loadReportsData() {
  if (!AppState.business) return;

  const range = AppState.activeReportRange || 'today';
  const start = document.getElementById('report-custom-start')?.value || '';
  const end = document.getElementById('report-custom-end')?.value || '';

  updateReportRangePillStyles(range);

  // Ensure staff users list is cached so staff names map cleanly
  if (!Array.isArray(AppState.users) || AppState.users.length === 0) {
    try {
      const uRes = await fetch(`/api/users?business_code=${encodeURIComponent(AppState.business.business_code)}`);
      const uList = await uRes.json();
      if (Array.isArray(uList)) AppState.users = uList;
    } catch (e) { }
  }

  let queryUrl = `/api/reports/summary?business_code=${encodeURIComponent(AppState.business.business_code)}&range=${encodeURIComponent(range)}`;
  let invUrl = `/api/invoices?business_code=${encodeURIComponent(AppState.business.business_code)}&range=${encodeURIComponent(range)}`;
  if (range === 'custom' && start && end) {
    queryUrl += `&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`;
    invUrl += `&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`;
  }

  try {
    const [sumRes, invRes] = await Promise.all([
      fetch(queryUrl),
      fetch(invUrl)
    ]);

    if (sumRes.ok) {
      const sumData = await sumRes.json();
      AppState.lowStockCountSummary = safeNum(sumData.low_stock_items);
      const lowStockEl = document.getElementById('kpi-low-stock-count');
      if (lowStockEl) lowStockEl.textContent = AppState.lowStockCountSummary;
    }

    const rawInvoices = invRes.ok ? await invRes.json() : [];
    AppState.reportInvoices = Array.isArray(rawInvoices)
      ? rawInvoices.map(normalizeInvoiceRecord)
      : [];

    populateReportStaffFilter();
    applyReportClientFilters(true);
  } catch (err) {
    console.error("[REPORTS LOAD ERROR]", err);
  }
}

function applyReportClientFilters(resetPage = true) {
  const searchQuery = (document.getElementById('report-search-input')?.value || '').trim().toLowerCase();
  const staffFilter = document.getElementById('report-staff-filter')?.value || 'ALL';
  const paymentFilter = document.getElementById('report-payment-filter')?.value || 'ALL';

  const allInvoices = Array.isArray(AppState.reportInvoices) ? AppState.reportInvoices : [];

  AppState.filteredReportInvoices = allInvoices.filter(inv => {
    // 1. Staff Member Filter
    if (staffFilter !== 'ALL') {
      const target = staffFilter.toLowerCase();
      const matchesStaff =
        (inv.cashier_username && inv.cashier_username.toLowerCase() === target) ||
        (inv.staff_display && inv.staff_display.toLowerCase() === target) ||
        (inv.staff_name && inv.staff_name.toLowerCase() === target);
      if (!matchesStaff) return false;
    }

    // 2. Payment Method Filter
    if (paymentFilter !== 'ALL') {
      const methodUpper = String(inv.payment_method || 'Cash').toUpperCase();
      const filterUpper = paymentFilter.toUpperCase();
      if (filterUpper === 'QR') {
        if (!methodUpper.includes('QR') && !methodUpper.includes('ONLINE') && !methodUpper.includes('BANK') && !methodUpper.includes('TRANSFER')) {
          return false;
        }
      } else if (methodUpper !== filterUpper) {
        return false;
      }
    }

    // 3. Real-Time Search Filter (Invoice ID, Customer Name, Staff Member, Payment Method, or Item Name/Code)
    if (searchQuery) {
      const invNoMatch = String(inv.invoice_number || '').toLowerCase().includes(searchQuery);
      const custMatch = String(inv.customer_name || '').toLowerCase().includes(searchQuery);
      const staffMatch =
        String(inv.staff_display || '').toLowerCase().includes(searchQuery) ||
        String(inv.cashier_username || '').toLowerCase().includes(searchQuery);
      const payMatch = String(inv.payment_method || '').toLowerCase().includes(searchQuery);
      const itemMatch = Array.isArray(inv.items) && inv.items.some(
        it =>
          String(it.name || '').toLowerCase().includes(searchQuery) ||
          String(it.code || '').toLowerCase().includes(searchQuery)
      );

      if (!invNoMatch && !custMatch && !staffMatch && !payMatch && !itemMatch) {
        return false;
      }
    }

    return true;
  });

  if (resetPage) {
    AppState.reportPage = 1;
  }

  renderFilteredReportsUI();
}

function resetReportFilters() {
  const searchEl = document.getElementById('report-search-input');
  const staffEl = document.getElementById('report-staff-filter');
  const payEl = document.getElementById('report-payment-filter');

  if (searchEl) searchEl.value = '';
  if (staffEl) staffEl.value = 'ALL';
  if (payEl) payEl.value = 'ALL';

  applyReportClientFilters(true);
  showToast("Report filters reset.", "info", 1500);
}

function renderFilteredReportsUI() {
  const filtered = Array.isArray(AppState.filteredReportInvoices) ? AppState.filteredReportInvoices : [];
  const validBills = filtered.filter(inv => inv.status !== 'VOIDED');
  const voidedCount = filtered.length - validBills.length;

  // 1. Audit & Compute All 5 KPI Summary Cards (Zero NaN / null / undefined guaranteed)
  const totalRevenue = validBills.reduce((sum, inv) => sum + safeNum(inv.grand_total), 0);
  const netProfit = validBills.reduce((sum, inv) => sum + safeNum(inv.estimated_profit), 0);
  const totalBillsCount = validBills.length;
  const avgBillValue = totalBillsCount > 0 ? (totalRevenue / totalBillsCount) : 0;
  const totalDiscounts = validBills.reduce((sum, inv) => sum + safeNum(inv.discount_amount), 0);
  const discountedBillsCount = validBills.filter(inv => safeNum(inv.discount_amount) > 0).length;
  const totalUnitsSold = validBills.reduce((sum, inv) => sum + safeNum(inv.total_quantity), 0);
  const profitMarginPct = totalRevenue > 0 ? ((netProfit / totalRevenue) * 100) : 0;

  const elSales = document.getElementById('kpi-total-sales');
  const elSalesSub = document.getElementById('kpi-total-sales-sub');
  const elProfit = document.getElementById('kpi-net-profit');
  const elProfitSub = document.getElementById('kpi-profit-margin-sub') || document.getElementById('kpi-net-profit-sub');
  const elInvoices = document.getElementById('kpi-total-invoices');
  const elItemsSub = document.getElementById('kpi-total-items-sub') || document.getElementById('kpi-total-items-sold');
  const elAvgBill = document.getElementById('kpi-avg-bill-value');
  const elDiscounts = document.getElementById('kpi-total-discounts');
  const elDiscountSub = document.getElementById('kpi-discount-bills-sub');

  if (elSales) elSales.textContent = `Rs. ${safeNum(totalRevenue).toFixed(2)}`;
  if (elSalesSub) {
    elSalesSub.textContent = voidedCount > 0
      ? `${totalBillsCount} paid • ${voidedCount} voided excluded`
      : `Gross sales across ${totalBillsCount} paid bills`;
  }
  if (elProfit) elProfit.textContent = `Rs. ${safeNum(netProfit).toFixed(2)}`;
  if (elProfitSub) elProfitSub.textContent = `Margin: ${safeNum(profitMarginPct).toFixed(1)}% of revenue`;
  if (elInvoices) elInvoices.textContent = String(totalBillsCount);
  if (elItemsSub) elItemsSub.textContent = `${safeNum(totalUnitsSold)} total units sold`;
  if (elAvgBill) elAvgBill.textContent = `Rs. ${safeNum(avgBillValue).toFixed(2)}`;
  if (elDiscounts) elDiscounts.textContent = `Rs. ${safeNum(totalDiscounts).toFixed(2)}`;
  if (elDiscountSub) elDiscountSub.textContent = `${discountedBillsCount} discounted bill${discountedBillsCount === 1 ? '' : 's'}`;

  // 2. Render Payment Method Analytics Breakdown
  renderPaymentBreakdownAnalytics(validBills, totalRevenue);

  // 3. Render Staff Performance Summary Breakdown
  renderStaffBreakdownAnalytics(validBills, totalRevenue);

  // 4. Render Paginated Invoices Table
  renderPaginatedInvoicesTable(filtered);
}

function renderPaymentBreakdownAnalytics(validBills, totalRevenue) {
  const container = document.getElementById('report-payment-breakdown');
  const badgeEl = document.getElementById('payment-breakdown-badge');
  if (!container) return;

  const buckets = {
    Cash: { label: '💵 Cash', count: 0, amount: 0, color: '#10b981', badgeClass: 'badge-emerald' },
    Card: { label: '💳 Card (Visa/Master)', count: 0, amount: 0, color: '#06b6d4', badgeClass: 'badge-cyan' },
    QR: { label: '📱 Online / QR / Bank', count: 0, amount: 0, color: '#a855f7', badgeClass: 'badge-glass' },
    Credit: { label: '📒 Customer Credit', count: 0, amount: 0, color: '#f59e0b', badgeClass: 'badge-warning' }
  };

  validBills.forEach(inv => {
    const rawMethod = String(inv.payment_method || 'Cash').toUpperCase();
    const amt = safeNum(inv.grand_total);
    if (rawMethod.includes('CARD')) {
      buckets.Card.count += 1;
      buckets.Card.amount += amt;
    } else if (rawMethod.includes('QR') || rawMethod.includes('ONLINE') || rawMethod.includes('BANK') || rawMethod.includes('TRANSFER')) {
      buckets.QR.count += 1;
      buckets.QR.amount += amt;
    } else if (rawMethod.includes('CREDIT')) {
      buckets.Credit.count += 1;
      buckets.Credit.amount += amt;
    } else {
      buckets.Cash.count += 1;
      buckets.Cash.amount += amt;
    }
  });

  const activeMethodsCount = Object.values(buckets).filter(b => b.count > 0).length;
  if (badgeEl) {
    badgeEl.textContent = `${activeMethodsCount} Active Method${activeMethodsCount === 1 ? '' : 's'}`;
  }

  container.innerHTML = Object.values(buckets).map(b => {
    const pct = totalRevenue > 0 ? ((b.amount / totalRevenue) * 100) : 0;
    return `
      <div style="background: rgba(11, 17, 32, 0.55); border: 1px solid var(--border-glass); border-radius: 10px; padding: 10px 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 13.5px; font-weight: 700; color: #ffffff;">${b.label}</span>
            <span class="badge ${b.badgeClass}" style="font-size: 11px;">${b.count} bill${b.count === 1 ? '' : 's'}</span>
          </div>
          <div style="text-align: right;">
            <span style="font-family: var(--font-mono); font-size: 14px; font-weight: 800; color: #ffffff;">Rs. ${safeNum(b.amount).toFixed(2)}</span>
            <span style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted); margin-left: 6px;">(${safeNum(pct).toFixed(1)}%)</span>
          </div>
        </div>
        <div style="width: 100%; height: 6px; background: rgba(255, 255, 255, 0.06); border-radius: 999px; overflow: hidden;">
          <div style="width: ${Math.min(100, Math.max(0, pct)).toFixed(1)}%; height: 100%; background: ${b.color}; border-radius: 999px; transition: width 0.3s ease;"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderStaffBreakdownAnalytics(validBills, totalRevenue) {
  const container = document.getElementById('report-staff-breakdown');
  const badgeEl = document.getElementById('staff-breakdown-badge');
  if (!container) return;

  if (validBills.length === 0) {
    if (badgeEl) badgeEl.textContent = '0 Staff Active';
    container.innerHTML = `<div style="text-align: center; padding: 24px; color: var(--text-dim); font-size: 13px;">No completed sales in the current filter to rank staff performance.</div>`;
    return;
  }

  const staffStats = new Map();
  validBills.forEach(inv => {
    const staffName = resolveStaffName(inv, 'Admin');
    const key = staffName.toLowerCase();
    if (!staffStats.has(key)) {
      staffStats.set(key, {
        name: staffName,
        username: inv.cashier_username || staffName,
        bills: 0,
        sales: 0,
        profit: 0,
        itemsSold: 0
      });
    }
    const entry = staffStats.get(key);
    entry.bills += 1;
    entry.sales += safeNum(inv.grand_total);
    entry.profit += safeNum(inv.estimated_profit);
    entry.itemsSold += safeNum(inv.total_quantity);
  });

  const sortedStaff = Array.from(staffStats.values()).sort((a, b) => b.sales - a.sales);
  if (badgeEl) {
    badgeEl.textContent = `${sortedStaff.length} Staff Member${sortedStaff.length === 1 ? '' : 's'}`;
  }

  container.innerHTML = sortedStaff.map((st, idx) => {
    const sharePct = totalRevenue > 0 ? ((st.sales / totalRevenue) * 100) : 0;
    const avgBill = st.bills > 0 ? (st.sales / st.bills) : 0;
    return `
      <div style="background: rgba(11, 17, 32, 0.55); border: 1px solid var(--border-glass); border-radius: 10px; padding: 10px 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
            <span class="badge ${idx === 0 ? 'badge-emerald' : 'badge-cyan'}" style="font-family: var(--font-mono); font-size: 11px;">#${idx + 1}</span>
            <div style="min-width: 0;">
              <div style="font-size: 13.5px; font-weight: 700; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                👤 ${st.name}
              </div>
              <div style="font-size: 11.5px; color: var(--text-muted);">
                ${st.bills} bill${st.bills === 1 ? '' : 's'} • Avg: Rs. ${safeNum(avgBill).toFixed(2)} • ${safeNum(st.itemsSold)} units
              </div>
            </div>
          </div>
          <div style="text-align: right; flex-shrink: 0;">
            <div style="font-family: var(--font-mono); font-size: 14px; font-weight: 800; color: var(--emerald);">Rs. ${safeNum(st.sales).toFixed(2)}</div>
            <div style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted);">${safeNum(sharePct).toFixed(1)}% of sales</div>
          </div>
        </div>
        <div style="width: 100%; height: 6px; background: rgba(255, 255, 255, 0.06); border-radius: 999px; overflow: hidden;">
          <div style="width: ${Math.min(100, Math.max(0, sharePct)).toFixed(1)}%; height: 100%; background: linear-gradient(90deg, #06b6d4, #10b981); border-radius: 999px; transition: width 0.3s ease;"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderPaginatedInvoicesTable(filtered) {
  const tbody = document.getElementById('invoices-table-body');
  const countBadge = document.getElementById('invoices-filtered-count-badge');
  const pageInfoEl = document.getElementById('reports-page-info');
  const pageIndEl = document.getElementById('reports-page-indicator');
  const prevBtn = document.getElementById('reports-prev-btn');
  const nextBtn = document.getElementById('reports-next-btn');

  if (!tbody) return;

  const totalRecords = filtered.length;
  if (countBadge) {
    countBadge.textContent = `${totalRecords} Invoice${totalRecords === 1 ? '' : 's'}`;
  }

  const pageSize = Math.max(1, parseInt(AppState.reportPageSize, 10) || 25);
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  if (AppState.reportPage > totalPages) AppState.reportPage = totalPages;
  if (AppState.reportPage < 1) AppState.reportPage = 1;

  const startIdx = (AppState.reportPage - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, totalRecords);
  const pageSlice = filtered.slice(startIdx, endIdx);

  if (pageInfoEl) {
    pageInfoEl.textContent = totalRecords === 0
      ? 'Showing 0 to 0 of 0 transactions'
      : `Showing ${startIdx + 1} to ${endIdx} of ${totalRecords} transactions`;
  }
  if (pageIndEl) {
    pageIndEl.textContent = `Page ${AppState.reportPage} of ${totalPages}`;
  }
  if (prevBtn) prevBtn.disabled = (AppState.reportPage <= 1);
  if (nextBtn) nextBtn.disabled = (AppState.reportPage >= totalPages);

  if (pageSlice.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 28px; color: var(--text-dim);">No sales transactions match the selected date range and filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = pageSlice.map(inv => {
    const isVoid = inv.status === 'VOIDED';
    const statusBadge = isVoid
      ? `<span class="badge badge-danger">VOIDED</span>`
      : `<span class="badge badge-emerald">PAID</span>`;

    const dtObj = inv.date_time ? new Date(inv.date_time) : null;
    const dateStr = dtObj && !isNaN(dtObj)
      ? dtObj.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' })
      : '-';
    const timeStr = dtObj && !isNaN(dtObj)
      ? dtObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';

    const staffDisplay = resolveStaffName(inv, 'Admin');
    const lineCount = safeNum(inv.item_count, (inv.items || []).length);
    const unitCount = safeNum(inv.total_quantity, lineCount);
    const discountVal = safeNum(inv.discount_amount);
    const grandTotalVal = safeNum(inv.grand_total);

    let payBadgeClass = 'badge-emerald';
    const mUpper = String(inv.payment_method || 'Cash').toUpperCase();
    if (mUpper.includes('CARD')) payBadgeClass = 'badge-cyan';
    else if (mUpper.includes('QR') || mUpper.includes('ONLINE')) payBadgeClass = 'badge-glass';
    else if (mUpper.includes('CREDIT')) payBadgeClass = 'badge-warning';

    return `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: background 0.15s ease; ${isVoid ? 'opacity: 0.6;' : ''}"
          onclick="openInvoiceDetailsModal(${inv.id})"
          onmouseover="this.style.background='rgba(6, 182, 212, 0.06)'"
          onmouseout="this.style.background='transparent'">
        <td style="padding: 11px 12px; font-family: var(--font-mono); font-weight: 700; color: var(--cyan); white-space: nowrap;">
          ${inv.invoice_number}
        </td>
        <td style="padding: 11px 12px; font-size: 12.5px; color: var(--text-muted); white-space: nowrap;">
          <span style="color: #ffffff; font-weight: 600;">${dateStr}</span>
          <span style="color: var(--text-dim); margin-left: 4px; font-family: var(--font-mono);">${timeStr}</span>
        </td>
        <td style="padding: 11px 12px; color: #ffffff; font-weight: 600; white-space: nowrap;">
          <span style="display: inline-flex; align-items: center; gap: 5px; background: rgba(255,255,255,0.05); padding: 3px 9px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);">
            👤 ${staffDisplay}
          </span>
        </td>
        <td style="padding: 11px 12px; text-align: center; font-family: var(--font-mono); font-size: 12.5px; color: var(--text-muted); white-space: nowrap;">
          ${lineCount} (${unitCount} u)
        </td>
        <td style="padding: 11px 12px; text-align: center; white-space: nowrap;">
          <span class="badge ${payBadgeClass}">${inv.payment_method || 'Cash'}</span>
        </td>
        <td style="padding: 11px 12px; text-align: right; font-family: var(--font-mono); font-size: 12.5px; color: ${discountVal > 0 ? '#f59e0b' : 'var(--text-dim)'}; white-space: nowrap;">
          ${discountVal > 0 ? `- Rs. ${discountVal.toFixed(2)}` : '-'}
        </td>
        <td style="padding: 11px 12px; text-align: right; font-family: var(--font-mono); font-size: 14px; font-weight: 800; color: var(--emerald); white-space: nowrap;">
          Rs. ${grandTotalVal.toFixed(2)}
        </td>
        <td style="padding: 11px 12px; text-align: center; white-space: nowrap;">${statusBadge}</td>
        <td style="padding: 11px 12px; text-align: right; white-space: nowrap;" onclick="event.stopPropagation();">
          <button class="btn btn-sm btn-cyan" onclick="openInvoiceDetailsModal(${inv.id})" title="Inspect Full Bill Breakdown">👁️ View</button>
          <button class="btn btn-sm btn-glass" onclick="reprintInvoice(${inv.id})" title="Thermal Reprint">🖨️ Reprint</button>
          ${!isVoid ? `<button class="btn btn-sm btn-danger" onclick="voidInvoice(${inv.id})" title="Void Bill & Restore Stock">❌ Void</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

function prevReportPage() {
  if (AppState.reportPage > 1) {
    AppState.reportPage -= 1;
    renderPaginatedInvoicesTable(AppState.filteredReportInvoices);
    const wrap = document.getElementById('reports-invoices-table-wrapper');
    if (wrap) wrap.scrollTop = 0;
  }
}

function nextReportPage() {
  const total = AppState.filteredReportInvoices.length;
  const maxPage = Math.max(1, Math.ceil(total / (AppState.reportPageSize || 25)));
  if (AppState.reportPage < maxPage) {
    AppState.reportPage += 1;
    renderPaginatedInvoicesTable(AppState.filteredReportInvoices);
    const wrap = document.getElementById('reports-invoices-table-wrapper');
    if (wrap) wrap.scrollTop = 0;
  }
}

function changeReportPageSize(sizeVal) {
  AppState.reportPageSize = Math.max(1, parseInt(sizeVal, 10) || 25);
  AppState.reportPage = 1;
  renderPaginatedInvoicesTable(AppState.filteredReportInvoices);
}

// ---------------------------------------------------------------------------
// INTERACTIVE TRANSACTION DETAILS & BILL REPRINT MODAL
// ---------------------------------------------------------------------------
function openInvoiceDetailsModal(invId) {
  const inv = (AppState.reportInvoices || []).find(x => Number(x.id) === Number(invId));
  if (!inv) {
    showToast("Invoice details not found in current list.", "warning");
    return;
  }

  AppState.selectedDetailInvoiceId = inv.id;
  const isVoid = inv.status === 'VOIDED';
  const staffDisplay = resolveStaffName(inv, 'Admin');
  const dtStr = inv.date_time ? new Date(inv.date_time).toLocaleString() : '-';

  const invNoEl = document.getElementById('inv-detail-number') || document.getElementById('detail-modal-inv-no');
  const statusEl = document.getElementById('inv-detail-status') || document.getElementById('detail-modal-status-badge');
  const dtEl = document.getElementById('inv-detail-datetime') || document.getElementById('detail-modal-datetime');
  const staffEl = document.getElementById('inv-detail-staff') || document.getElementById('detail-modal-staff');
  const payEl = document.getElementById('inv-detail-payment') || document.getElementById('detail-modal-payment');
  const itemsCountEl = document.getElementById('inv-detail-items-count') || document.getElementById('detail-modal-items-count');

  if (invNoEl) invNoEl.textContent = inv.invoice_number;
  if (statusEl) {
    statusEl.className = isVoid ? 'badge badge-danger' : 'badge badge-emerald';
    statusEl.textContent = isVoid ? 'VOIDED' : 'PAID';
  }
  if (dtEl) dtEl.textContent = `📅 ${dtStr}`;
  if (staffEl) staffEl.textContent = `👤 ${staffDisplay}`;
  if (payEl) {
    const custSuffix = (inv.customer_name && inv.customer_name !== 'Walk-in Customer')
      ? ` • ${inv.customer_name}`
      : '';
    payEl.textContent = `💳 ${inv.payment_method || 'Cash'}${custSuffix}`;
  }
  if (itemsCountEl) {
    itemsCountEl.textContent = `${safeNum(inv.item_count, (inv.items || []).length)} Line Items (${safeNum(inv.total_quantity)} Units)`;
  }

  const tbody = document.getElementById('inv-detail-items-body') || document.getElementById('detail-modal-items-tbody');
  if (tbody) {
    const items = Array.isArray(inv.items) ? inv.items : [];
    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 18px; color: var(--text-dim);">No line items recorded on this bill.</td></tr>`;
    } else {
      tbody.innerHTML = items.map((it, idx) => {
        const qty = safeNum(it.quantity, 1);
        const unitPrice = safeNum(it.selling_price ?? it.unit_price, 0);
        const disc = safeNum(it.discount, 0);
        const lineTotal = safeNum(it.total, Math.max(0, (qty * unitPrice) - disc));
        return `
          <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
            <td style="padding: 9px 12px; font-family: var(--font-mono); font-size: 12px; color: var(--text-dim); white-space: nowrap;">${idx + 1}</td>
            <td style="padding: 9px 12px; font-weight: 600; color: #ffffff;">
              ${it.name || 'Item'}
              <div style="font-family: var(--font-mono); font-size: 11px; color: var(--cyan);">${it.code || '-'}</div>
            </td>
            <td style="padding: 9px 12px; text-align: center; font-family: var(--font-mono); color: #ffffff; white-space: nowrap;">${qty} ${it.unit || 'Pcs'}</td>
            <td style="padding: 9px 12px; text-align: right; font-family: var(--font-mono); color: var(--text-muted); white-space: nowrap;">Rs. ${unitPrice.toFixed(2)}</td>
            <td style="padding: 9px 12px; text-align: right; font-family: var(--font-mono); color: ${disc > 0 ? '#f59e0b' : 'var(--text-dim)'}; white-space: nowrap;">
              ${disc > 0 ? `- Rs. ${disc.toFixed(2)}` : '-'}
            </td>
            <td style="padding: 9px 12px; text-align: right; font-family: var(--font-mono); font-weight: 700; color: var(--emerald); white-space: nowrap;">Rs. ${lineTotal.toFixed(2)}</td>
          </tr>
        `;
      }).join('');
    }
  }

  const subEl = document.getElementById('inv-detail-subtotal') || document.getElementById('detail-modal-subtotal');
  const discEl = document.getElementById('inv-detail-discount') || document.getElementById('detail-modal-discount');
  const profitEl = document.getElementById('inv-detail-profit');
  const taxEl = document.getElementById('detail-modal-tax');
  const grandEl = document.getElementById('inv-detail-grand-total') || document.getElementById('detail-modal-grand-total');
  const cashEl = document.getElementById('inv-detail-cash-paid') || document.getElementById('detail-modal-cash-paid');
  const changeEl = document.getElementById('inv-detail-balance') || document.getElementById('detail-modal-change');
  const voidBtn = document.getElementById('inv-detail-void-btn') || document.getElementById('detail-modal-void-btn');

  if (subEl) subEl.textContent = `Rs. ${safeNum(inv.subtotal).toFixed(2)}`;
  if (discEl) discEl.textContent = `- Rs. ${safeNum(inv.discount_amount).toFixed(2)}`;
  if (profitEl) profitEl.textContent = `Rs. ${safeNum(inv.estimated_profit).toFixed(2)}`;
  if (taxEl) taxEl.textContent = `Rs. ${safeNum(inv.tax_amount).toFixed(2)}`;
  if (grandEl) grandEl.textContent = `Rs. ${safeNum(inv.grand_total).toFixed(2)}`;
  if (cashEl) cashEl.textContent = `Rs. ${safeNum(inv.cash_paid).toFixed(2)}`;
  if (changeEl) changeEl.textContent = `Rs. ${safeNum(inv.balance_change).toFixed(2)}`;
  if (voidBtn) voidBtn.style.display = isVoid ? 'none' : 'inline-flex';

  const modal = document.getElementById('modal-invoice-details');
  if (modal) modal.classList.add('active');
}

function closeInvoiceDetailsModal() {
  const modal = document.getElementById('modal-invoice-details');
  if (modal) modal.classList.remove('active');
}

function reprintFromDetailsModal() {
  const invId = AppState.selectedDetailInvoiceId;
  if (!invId) return;
  closeInvoiceDetailsModal();
  reprintInvoice(invId);
}

function voidFromDetailsModal() {
  const invId = AppState.selectedDetailInvoiceId;
  if (!invId) return;
  closeInvoiceDetailsModal();
  voidInvoice(invId);
}

async function reprintInvoice(invId) {
  try {
    let inv = (AppState.reportInvoices || []).find(x => Number(x.id) === Number(invId));
    if (!inv) {
      const res = await fetch(`/api/invoices?business_code=${encodeURIComponent(AppState.business.business_code)}&range=this_month`);
      const list = await res.json();
      if (Array.isArray(list)) {
        const found = list.find(x => Number(x.id) === Number(invId));
        if (found) inv = normalizeInvoiceRecord(found);
      }
    }
    if (inv) {
      openReceiptModal(inv);
    } else {
      showToast("Could not locate invoice for reprint.", "warning");
    }
  } catch (e) {
    showToast("Failed to load invoice for reprint.", "error");
  }
}

async function voidInvoice(invId) {
  if (!confirm("Are you sure you want to VOID this invoice? Item stocks will automatically be restored!")) return;

  try {
    const staffUser = AppState.user?.username || AppState.user?.full_name || 'Admin';
    const res = await fetch(`/api/invoices/${invId}/void?business_code=${encodeURIComponent(AppState.business.business_code)}&staff_username=${encodeURIComponent(staffUser)}`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to void invoice');
    showToast(data.message || "Invoice voided & stock restored.", "warning");
    loadReportsData();
    loadItemsCatalog(true);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// EXPORT TO CSV / EXCEL & PRINT / SAVE AS PDF (FILTER-AWARE)
// ---------------------------------------------------------------------------
function escapeCSVCell(val) {
  const str = String(val ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function exportReportCSV() {
  const filtered = Array.isArray(AppState.filteredReportInvoices) ? AppState.filteredReportInvoices : [];
  if (filtered.length === 0) {
    showToast("No transactions in the current filter to export.", "warning");
    return;
  }

  const bizName = AppState.business?.name || 'SupiriPOS PRO';
  const bizCode = AppState.business?.business_code || 'POS';
  const rangeLabel = (AppState.activeReportRange || 'today').toUpperCase();
  const staffFilter = document.getElementById('report-staff-filter')?.value || 'ALL';
  const payFilter = document.getElementById('report-payment-filter')?.value || 'ALL';
  const searchQuery = document.getElementById('report-search-input')?.value || '';

  const validBills = filtered.filter(i => i.status !== 'VOIDED');
  const totalRevenue = validBills.reduce((s, i) => s + safeNum(i.grand_total), 0);
  const totalProfit = validBills.reduce((s, i) => s + safeNum(i.estimated_profit), 0);
  const totalDiscount = validBills.reduce((s, i) => s + safeNum(i.discount_amount), 0);
  const totalTax = validBills.reduce((s, i) => s + safeNum(i.tax_amount), 0);
  const avgBill = validBills.length > 0 ? (totalRevenue / validBills.length) : 0;

  const rows = [];
  rows.push([`${bizName} (${bizCode}) — Official Sales & Profit Report`]);
  rows.push([`Generated At`, new Date().toLocaleString(), `Date Range`, rangeLabel, `Staff Filter`, staffFilter, `Payment Filter`, payFilter, `Search Query`, searchQuery || 'None']);
  rows.push([]);
  rows.push([
    'Invoice Number',
    'Date & Time',
    'Staff Member',
    'Payment Method',
    'Status',
    'Line Items',
    'Total Units',
    'Subtotal (Rs.)',
    'Discount (Rs.)',
    'Tax (Rs.)',
    'Grand Total (Rs.)',
    'Estimated Cost (Rs.)',
    'Estimated Net Profit (Rs.)',
    'Purchased Items Breakdown'
  ]);

  filtered.forEach(inv => {
    const dtStr = inv.date_time ? new Date(inv.date_time).toLocaleString() : '-';
    const staffDisplay = resolveStaffName(inv, 'Admin');
    const itemsSummary = (inv.items || [])
      .map(it => `${it.name} (${safeNum(it.quantity)} x Rs.${safeNum(it.selling_price).toFixed(2)})`)
      .join(' | ');

    rows.push([
      inv.invoice_number,
      dtStr,
      staffDisplay,
      inv.payment_method || 'Cash',
      inv.status === 'VOIDED' ? 'VOIDED' : 'PAID',
      safeNum(inv.item_count, (inv.items || []).length),
      safeNum(inv.total_quantity),
      safeNum(inv.subtotal).toFixed(2),
      safeNum(inv.discount_amount).toFixed(2),
      safeNum(inv.tax_amount).toFixed(2),
      safeNum(inv.grand_total).toFixed(2),
      safeNum(inv.estimated_cost).toFixed(2),
      safeNum(inv.estimated_profit).toFixed(2),
      itemsSummary
    ]);
  });

  rows.push([]);
  rows.push(['SUMMARY TOTALS (PAID BILLS ONLY)']);
  rows.push(['Total Paid Transactions', validBills.length]);
  rows.push(['Total Gross Revenue (Rs.)', totalRevenue.toFixed(2)]);
  rows.push(['Estimated Net Profit (Rs.)', totalProfit.toFixed(2)]);
  rows.push(['Average Bill Value (Rs.)', avgBill.toFixed(2)]);
  rows.push(['Total Discounts Given (Rs.)', totalDiscount.toFixed(2)]);
  rows.push(['Total Tax Collected (Rs.)', totalTax.toFixed(2)]);

  const csvContent = '\uFEFF' + rows.map(r => r.map(escapeCSVCell).join(',')).join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const dateStamp = formatLocalDateISO(new Date());
  link.href = url;
  link.setAttribute('download', `SupiriPOS_Sales_Report_${bizCode}_${rangeLabel}_${dateStamp}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast(`Exported ${filtered.length} filtered transactions to CSV / Excel!`, "success");
}

function printSalesReportPDF() {
  const filtered = Array.isArray(AppState.filteredReportInvoices) ? AppState.filteredReportInvoices : [];
  if (filtered.length === 0) {
    showToast("No transactions in the current filter to print.", "warning");
    return;
  }

  const biz = AppState.business || {};
  const validBills = filtered.filter(i => i.status !== 'VOIDED');
  const totalRevenue = validBills.reduce((s, i) => s + safeNum(i.grand_total), 0);
  const netProfit = validBills.reduce((s, i) => s + safeNum(i.estimated_profit), 0);
  const totalDiscounts = validBills.reduce((s, i) => s + safeNum(i.discount_amount), 0);
  const avgBill = validBills.length > 0 ? (totalRevenue / validBills.length) : 0;

  const rangeLabel = (AppState.activeReportRange || 'today').replace('_', ' ').toUpperCase();
  const staffFilter = document.getElementById('report-staff-filter')?.value || 'ALL';
  const payFilter = document.getElementById('report-payment-filter')?.value || 'ALL';

  const rowsHtml = filtered.map(inv => {
    const dtStr = inv.date_time ? new Date(inv.date_time).toLocaleString() : '-';
    const staffDisplay = resolveStaffName(inv, 'Admin');
    const isVoid = inv.status === 'VOIDED';
    return `
      <tr style="${isVoid ? 'color: #999; text-decoration: line-through;' : ''}">
        <td><strong>${inv.invoice_number}</strong></td>
        <td>${dtStr}</td>
        <td>${staffDisplay}</td>
        <td>${inv.payment_method || 'Cash'}</td>
        <td style="text-align: center;">${safeNum(inv.item_count)} (${safeNum(inv.total_quantity)} u)</td>
        <td style="text-align: right;">Rs. ${safeNum(inv.discount_amount).toFixed(2)}</td>
        <td style="text-align: right;"><strong>Rs. ${safeNum(inv.grand_total).toFixed(2)}</strong></td>
        <td style="text-align: center;">${isVoid ? 'VOIDED' : 'PAID'}</td>
      </tr>
    `;
  }).join('');

  const printWin = window.open('', '_blank', 'width=1050,height=800');
  if (!printWin) {
    showToast("Pop-up blocked! Please allow pop-ups to print or save PDF.", "warning");
    return;
  }

  printWin.document.write(`
    <html>
      <head>
        <title>${biz.name || 'SupiriPOS PRO'} — Sales & Financial Report</title>
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; padding: 28px; color: #0f172a; }
          .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f172a; padding-bottom: 14px; margin-bottom: 18px; }
          .header h1 { margin: 0 0 4px 0; font-size: 22px; }
          .header p { margin: 2px 0; font-size: 12px; color: #475569; }
          .kpi-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 20px; }
          .kpi-box { border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px 12px; background: #f8fafc; }
          .kpi-box .lbl { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 700; }
          .kpi-box .val { font-size: 16px; font-weight: 800; color: #0f172a; margin-top: 4px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th, td { border: 1px solid #cbd5e1; padding: 7px 9px; text-align: left; }
          th { background: #e2e8f0; font-weight: 700; text-transform: uppercase; font-size: 11px; }
          .footer { margin-top: 20px; font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid #cbd5e1; padding-top: 10px; }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <h1>${biz.name || 'SupiriPOS PRO'} — Official Sales & Financial Report</h1>
            <p>${biz.address || ''} ${biz.phone ? '• Tel: ' + biz.phone : ''}</p>
            <p><strong>Period:</strong> ${rangeLabel} &nbsp;|&nbsp; <strong>Staff Filter:</strong> ${staffFilter} &nbsp;|&nbsp; <strong>Payment Filter:</strong> ${payFilter}</p>
          </div>
          <div style="text-align: right;">
            <p><strong>Business Code:</strong> ${biz.business_code || '-'}</p>
            <p><strong>Generated By:</strong> ${resolveStaffName(AppState.user, 'Admin')}</p>
            <p><strong>Printed:</strong> ${new Date().toLocaleString()}</p>
          </div>
        </div>

        <div class="kpi-grid">
          <div class="kpi-box">
            <div class="lbl">Total Revenue</div>
            <div class="val">Rs. ${totalRevenue.toFixed(2)}</div>
          </div>
          <div class="kpi-box">
            <div class="lbl">Estimated Net Profit</div>
            <div class="val">Rs. ${netProfit.toFixed(2)}</div>
          </div>
          <div class="kpi-box">
            <div class="lbl">Total Paid Bills</div>
            <div class="val">${validBills.length}</div>
          </div>
          <div class="kpi-box">
            <div class="lbl">Average Bill Value</div>
            <div class="val">Rs. ${avgBill.toFixed(2)}</div>
          </div>
          <div class="kpi-box">
            <div class="lbl">Total Discounts</div>
            <div class="val">Rs. ${totalDiscounts.toFixed(2)}</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Invoice #</th>
              <th>Date & Time</th>
              <th>Staff Member</th>
              <th>Method</th>
              <th style="text-align: center;">Items</th>
              <th style="text-align: right;">Discount</th>
              <th style="text-align: right;">Grand Total</th>
              <th style="text-align: center;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>

        <div class="footer">
          Powered by PrasaTek System Solutions • SupiriPOS PRO Cloud Enterprise POS
        </div>
        <script>window.onload = () => { window.print(); };<\/script>
      </body>
    </html>
  `);
  printWin.document.close();
}

// ---------------------------------------------------------------------------
// SUB-TAB 4: 💳 CREDIT CUSTOMERS & REPAYMENT / SETTLEMENT SYSTEM ("ණයට")
// ---------------------------------------------------------------------------
async function loadCreditCustomersData() {
  if (!AppState.business) return;

  try {
    const res = await fetch(`/api/customers?business_code=${encodeURIComponent(AppState.business.business_code)}`);
    if (!res.ok) return;
    const data = await res.json();

    AppState.creditCustomers = Array.isArray(data.customers) ? data.customers : [];
    AppState.creditLedger = Array.isArray(data.recent_ledger) ? data.recent_ledger : [];
    AppState.creditSummary = data.summary || {
      total_outstanding_credit: 0,
      active_credit_customers: 0,
      total_customers: AppState.creditCustomers.length,
      credit_collected_today: 0
    };

    // Update selectedCreditCustomer in Billing if currently selected
    if (AppState.selectedCreditCustomer) {
      const updatedCust = AppState.creditCustomers.find(c => c.id === AppState.selectedCreditCustomer.id);
      if (updatedCust) {
        AppState.selectedCreditCustomer = updatedCust;
        if (AppState.paymentMode === 'Credit') {
          selectBillingCreditCustomer(updatedCust);
        }
      }
    }

    renderCreditSummaryKPIs();
    renderCreditCustomersTable();
  } catch (err) {
    console.error("[CREDIT CUSTOMERS LOAD ERROR]", err);
  }
}

function renderCreditSummaryKPIs() {
  const sum = AppState.creditSummary || {};
  const customers = Array.isArray(AppState.creditCustomers) ? AppState.creditCustomers : [];

  const totalOut = safeNum(
    sum.total_outstanding_credit,
    customers.reduce((acc, c) => acc + Math.max(0, safeNum(c.credit_balance)), 0)
  );
  const activeCount = safeNum(
    sum.active_credit_customers,
    customers.filter(c => safeNum(c.credit_balance) > 0.009).length
  );
  const totalCount = safeNum(sum.total_customers, customers.length);
  const collectedToday = safeNum(sum.credit_collected_today, 0);

  const elOut = document.getElementById('credit-kpi-total-outstanding');
  const elActive = document.getElementById('credit-kpi-active-customers');
  const elTotalSub = document.getElementById('credit-kpi-total-customers-sub');
  const elCollected = document.getElementById('credit-kpi-collected-today');

  if (elOut) elOut.textContent = `Rs. ${totalOut.toFixed(2)}`;
  if (elActive) elActive.textContent = String(activeCount);
  if (elTotalSub) elTotalSub.textContent = `Out of ${totalCount} registered credit customer${totalCount === 1 ? '' : 's'}`;
  if (elCollected) elCollected.textContent = `Rs. ${collectedToday.toFixed(2)}`;
}

function selectCreditCustomerFilter(filterType) {
  AppState.creditCustomerFilter = filterType || 'all';
  const btns = document.querySelectorAll('.credit-filter-btn');
  btns.forEach(btn => {
    const f = btn.getAttribute('data-filter');
    btn.className = (f === AppState.creditCustomerFilter)
      ? 'btn btn-sm btn-cyan credit-filter-btn'
      : 'btn btn-sm btn-glass credit-filter-btn';
  });
  renderCreditCustomersTable();
}

function renderCreditCustomersTable() {
  const tbody = document.getElementById('credit-customers-table-body');
  if (!tbody) return;

  const query = (document.getElementById('credit-customers-search-input')?.value || '').trim().toLowerCase();
  const filterMode = AppState.creditCustomerFilter || 'all';
  const allCustomers = Array.isArray(AppState.creditCustomers) ? AppState.creditCustomers : [];

  const filtered = allCustomers.filter(c => {
    const bal = safeNum(c.credit_balance);
    if (filterMode === 'active' && bal <= 0.009) return false;
    if (filterMode === 'settled' && bal > 0.009) return false;

    if (query) {
      const nameMatch = String(c.name || '').toLowerCase().includes(query);
      const phoneMatch = String(c.phone || '').toLowerCase().includes(query);
      const addrMatch = String(c.address || '').toLowerCase().includes(query);
      if (!nameMatch && !phoneMatch && !addrMatch) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 28px; color: var(--text-dim);">
          No credit customers match the current search or filter.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(c => {
    const bal = safeNum(c.credit_balance);
    const hasDebt = bal > 0.009;
    const balColor = hasDebt ? '#ef4444' : 'var(--emerald)';
    const balBadge = hasDebt
      ? `<span class="badge badge-danger" style="margin-left: 6px; font-size: 10px;">DUE</span>`
      : `<span class="badge badge-emerald" style="margin-left: 6px; font-size: 10px;">SETTLED</span>`;

    const lastDt = (c.last_transaction_at || c.updated_at || c.created_at)
      ? new Date(c.last_transaction_at || c.updated_at || c.created_at).toLocaleString()
      : '-';

    let lastTypeBadge = '';
    if (c.last_transaction_type === 'CREDIT_SALE') {
      lastTypeBadge = `<div style="font-size: 11px; color: var(--warning);">🧾 Credit Bill (+Rs. ${safeNum(c.last_transaction_amount).toFixed(2)})</div>`;
    } else if (c.last_transaction_type === 'PAYMENT_RECEIVED') {
      lastTypeBadge = `<div style="font-size: 11px; color: var(--emerald);">💵 Payment (-Rs. ${safeNum(c.last_transaction_amount).toFixed(2)})</div>`;
    } else if (c.last_transaction_type === 'VOID_REVERSAL') {
      lastTypeBadge = `<div style="font-size: 11px; color: var(--cyan);">🔄 Void Reversal (-Rs. ${safeNum(c.last_transaction_amount).toFixed(2)})</div>`;
    }

    return `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
        <td style="padding: 12px; font-weight: 800; color: #ffffff; white-space: nowrap;">
          👤 ${c.name || '-'}
        </td>
        <td style="padding: 12px; font-family: var(--font-mono); font-weight: 700; color: var(--cyan); white-space: nowrap;">
          📱 ${c.phone || '-'}
        </td>
        <td style="padding: 12px; color: var(--text-muted); font-size: 13px;">
          ${c.address || '-'}
        </td>
        <td style="padding: 12px; text-align: right; font-family: var(--font-mono); font-size: 15px; font-weight: 800; color: ${balColor}; white-space: nowrap;">
          Rs. ${bal.toFixed(2)} ${balBadge}
        </td>
        <td style="padding: 12px; font-size: 12px; color: var(--text-muted); white-space: nowrap;">
          <div>${lastDt}</div>
          ${lastTypeBadge}
        </td>
        <td style="padding: 12px; text-align: right; white-space: nowrap;">
          <button class="btn btn-sm btn-emerald" style="margin-right: 6px;"
            onclick="openPayCreditModal(${c.id})"
            ${!hasDebt ? 'disabled style="opacity: 0.45; cursor: not-allowed; margin-right: 6px;"' : ''}>
            💵 Update / Pay Credit
          </button>
          <button class="btn btn-sm btn-cyan" onclick="openCreditHistoryModal(${c.id})">
            📜 Credit History
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function openPayCreditModal(customerId) {
  const cust = (AppState.creditCustomers || []).find(c => Number(c.id) === Number(customerId));
  if (!cust) {
    showToast("Customer record not found.", "warning");
    return;
  }

  AppState.activePayCreditCustomerId = cust.id;
  const currentBal = safeNum(cust.credit_balance);

  const nameEl = document.getElementById('pay-credit-cust-name');
  const phoneEl = document.getElementById('pay-credit-cust-phone');
  const balEl = document.getElementById('pay-credit-current-balance');
  const amtInput = document.getElementById('pay-credit-amount-input');
  const methodSel = document.getElementById('pay-credit-method-select');
  const noteInput = document.getElementById('pay-credit-note-input');

  if (nameEl) nameEl.textContent = cust.name || 'Customer';
  if (phoneEl) phoneEl.textContent = `📱 ${cust.phone || ''} ${cust.address ? '• ' + cust.address : ''}`;
  if (balEl) balEl.textContent = `Rs. ${currentBal.toFixed(2)}`;
  if (amtInput) {
    amtInput.value = currentBal > 0 ? currentBal.toFixed(2) : '';
    amtInput.max = String(currentBal);
  }
  if (methodSel) methodSel.value = 'Cash';
  if (noteInput) noteInput.value = '';

  updateCreditPaymentPreview();

  const modal = document.getElementById('modal-pay-credit');
  if (modal) modal.classList.add('active');
  setTimeout(() => {
    if (amtInput) {
      amtInput.focus();
      amtInput.select();
    }
  }, 60);
}

function closePayCreditModal() {
  const modal = document.getElementById('modal-pay-credit');
  if (modal) modal.classList.remove('active');
}

function fillFullCreditPayment() {
  const cust = (AppState.creditCustomers || []).find(c => Number(c.id) === Number(AppState.activePayCreditCustomerId));
  if (!cust) return;
  const amtInput = document.getElementById('pay-credit-amount-input');
  if (amtInput) {
    amtInput.value = safeNum(cust.credit_balance).toFixed(2);
    updateCreditPaymentPreview();
  }
}

function updateCreditPaymentPreview() {
  const cust = (AppState.creditCustomers || []).find(c => Number(c.id) === Number(AppState.activePayCreditCustomerId));
  const currentBal = cust ? safeNum(cust.credit_balance) : 0;
  const payAmt = safeNum(document.getElementById('pay-credit-amount-input')?.value, 0);
  const remaining = Math.max(0, currentBal - payAmt);

  const previewEl = document.getElementById('pay-credit-remaining-preview');
  if (previewEl) {
    previewEl.textContent = `Rs. ${remaining.toFixed(2)}`;
    previewEl.style.color = remaining <= 0.009 ? 'var(--emerald)' : 'var(--warning)';
  }
}

async function submitCreditPayment(andPrintReceipt = false) {
  if (!AppState.business) return;
  const cust = (AppState.creditCustomers || []).find(c => Number(c.id) === Number(AppState.activePayCreditCustomerId));
  if (!cust) {
    showToast("No credit customer selected.", "warning");
    return;
  }

  const amountPaid = safeNum(document.getElementById('pay-credit-amount-input')?.value, 0);
  const currentBal = safeNum(cust.credit_balance);
  if (amountPaid <= 0) {
    showToast("Please enter a valid payment amount greater than Rs. 0.", "warning");
    return;
  }
  if (amountPaid > currentBal + 0.05) {
    showToast(`Payment amount (Rs. ${amountPaid.toFixed(2)}) exceeds current credit balance (Rs. ${currentBal.toFixed(2)}).`, "warning");
    return;
  }

  const paymentMethod = document.getElementById('pay-credit-method-select')?.value || 'Cash';
  const referenceNote = (document.getElementById('pay-credit-note-input')?.value || '').trim();
  const staffUser = AppState.user?.username || AppState.user?.full_name || 'Admin';

  try {
    const res = await fetch('/api/customers/pay-credit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_code: AppState.business.business_code,
        customer_id: cust.id,
        customer_phone: cust.phone,
        amount_paid: amountPaid,
        payment_method: paymentMethod,
        reference_note: referenceNote || `Credit Payment (${paymentMethod})`,
        staff_user: staffUser
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to record credit payment');

    closePayCreditModal();
    showToast(
      `✅ Credit payment of Rs. ${safeNum(data.amount_paid).toFixed(2)} recorded for ${cust.name}! New Balance: Rs. ${safeNum(data.new_balance).toFixed(2)}`,
      "success",
      4500
    );

    await loadCreditCustomersData();

    // If Credit History Modal is currently open for this customer, refresh it too
    const historyModal = document.getElementById('modal-credit-history');
    if (historyModal && historyModal.classList.contains('active') && Number(AppState.activeHistoryCustomerId) === Number(cust.id)) {
      openCreditHistoryModal(cust.id);
    }

    if (andPrintReceipt) {
      const receiptData = {
        ...data,
        _isCreditPaymentReceipt: true,
        payment_method: paymentMethod,
        reference_note: referenceNote,
        staff_user: staffUser
      };
      AppState.lastInvoice = receiptData;
      renderCreditPaymentReceipt(receiptData, AppState.currentReceiptFormat);
      document.getElementById('modal-receipt').classList.add('active');
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function openCreditHistoryModal(customerId) {
  if (!AppState.business) return;
  AppState.activeHistoryCustomerId = customerId;

  try {
    const res = await fetch(
      `/api/customers/${encodeURIComponent(customerId)}/ledger?business_code=${encodeURIComponent(AppState.business.business_code)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to load customer credit history');

    const cust = data.customer || {};
    const ledger = Array.isArray(data.ledger) ? data.ledger : [];
    AppState.activeHistoryCustomer = cust;
    AppState.activeHistoryLedger = ledger;

    const nameEl = document.getElementById('credit-history-cust-name');
    const metaEl = document.getElementById('credit-history-cust-meta');
    const balEl = document.getElementById('credit-history-cust-balance');
    const tbody = document.getElementById('credit-history-table-body');

    const bal = safeNum(cust.credit_balance);
    if (nameEl) nameEl.textContent = `👤 ${cust.name || 'Customer'}`;
    if (metaEl) metaEl.textContent = `📱 ${cust.phone || '-'} • 📍 ${cust.address || 'No address specified'}`;
    if (balEl) {
      balEl.textContent = `Rs. ${bal.toFixed(2)}`;
      balEl.style.color = bal > 0.009 ? 'var(--warning)' : 'var(--emerald)';
    }

    if (tbody) {
      if (ledger.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--text-dim);">No credit transactions recorded for this customer yet.</td></tr>`;
      } else {
        tbody.innerHTML = ledger.map(entry => {
          const dtStr = entry.created_at ? new Date(entry.created_at).toLocaleString() : '-';
          const isSale = entry.transaction_type === 'CREDIT_SALE';
          const isPay = entry.transaction_type === 'PAYMENT_RECEIVED';

          let typeBadge = `<span class="badge badge-cyan">${entry.transaction_type}</span>`;
          let amtStr = `Rs. ${safeNum(entry.amount).toFixed(2)}`;
          let amtColor = '#ffffff';

          if (isSale) {
            typeBadge = `<span class="badge badge-warning">🧾 CREDIT BILL (ණයට ගැනීම)</span>`;
            amtStr = `+ Rs. ${safeNum(entry.amount).toFixed(2)}`;
            amtColor = '#f59e0b';
          } else if (isPay) {
            typeBadge = `<span class="badge badge-emerald">💵 PAYMENT RECEIVED (ණය ගෙවීම)</span>`;
            amtStr = `- Rs. ${safeNum(entry.amount).toFixed(2)}`;
            amtColor = '#10b981';
          } else if (entry.transaction_type === 'VOID_REVERSAL') {
            typeBadge = `<span class="badge badge-cyan">🔄 VOID REVERSAL</span>`;
            amtStr = `- Rs. ${safeNum(entry.amount).toFixed(2)}`;
            amtColor = '#06b6d4';
          }

          return `
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
              <td style="padding: 10px 12px; font-size: 12px; color: var(--text-muted); white-space: nowrap;">${dtStr}</td>
              <td style="padding: 10px 12px; white-space: nowrap;">${typeBadge}</td>
              <td style="padding: 10px 12px; color: #ffffff; font-size: 12.5px;">${entry.reference_note || '-'}</td>
              <td style="padding: 10px 12px; font-size: 12px; color: var(--text-muted); white-space: nowrap;">${entry.payment_method || '-'}</td>
              <td style="padding: 10px 12px; font-size: 12px; color: var(--text-main); white-space: nowrap;">👤 ${entry.staff_user || 'Admin'}</td>
              <td style="padding: 10px 12px; text-align: right; font-family: var(--font-mono); font-weight: 800; color: ${amtColor}; white-space: nowrap;">${amtStr}</td>
              <td style="padding: 10px 12px; text-align: right; font-family: var(--font-mono); font-weight: 800; color: var(--cyan); white-space: nowrap;">Rs. ${safeNum(entry.balance_after).toFixed(2)}</td>
            </tr>
          `;
        }).join('');
      }
    }

    const modal = document.getElementById('modal-credit-history');
    if (modal) modal.classList.add('active');
  } catch (err) {
    showToast(err.message, "error");
  }
}

function closeCreditHistoryModal() {
  const modal = document.getElementById('modal-credit-history');
  if (modal) modal.classList.remove('active');
}

function openPayCreditFromHistoryModal() {
  const custId = AppState.activeHistoryCustomerId;
  if (!custId) return;
  openPayCreditModal(custId);
}

function printCustomerCreditStatement() {
  const cust = AppState.activeHistoryCustomer;
  const ledger = Array.isArray(AppState.activeHistoryLedger) ? AppState.activeHistoryLedger : [];
  const biz = AppState.business || {};
  if (!cust) return;

  const rowsHtml = ledger.map(entry => {
    const dtStr = entry.created_at ? new Date(entry.created_at).toLocaleString() : '-';
    const isSale = entry.transaction_type === 'CREDIT_SALE';
    const typeLabel = isSale
      ? 'CREDIT BILL (ණයට ගැනීම)'
      : (entry.transaction_type === 'PAYMENT_RECEIVED' ? 'PAYMENT RECEIVED (ණය ගෙවීම)' : entry.transaction_type);
    const sign = isSale ? '+' : '-';
    return `
      <tr>
        <td>${dtStr}</td>
        <td><strong>${typeLabel}</strong></td>
        <td>${entry.reference_note || '-'}</td>
        <td>${entry.payment_method || '-'}</td>
        <td>${entry.staff_user || 'Admin'}</td>
        <td style="text-align: right;">${sign} Rs. ${safeNum(entry.amount).toFixed(2)}</td>
        <td style="text-align: right;"><strong>Rs. ${safeNum(entry.balance_after).toFixed(2)}</strong></td>
      </tr>
    `;
  }).join('');

  const printWin = window.open('', '_blank', 'width=960,height=720');
  if (!printWin) {
    showToast("Pop-up blocked! Please allow pop-ups to print statement.", "warning");
    return;
  }

  printWin.document.write(`
    <html>
      <head>
        <title>Credit Statement — ${cust.name} (${cust.phone})</title>
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; padding: 28px; color: #0f172a; }
          .header { display: flex; justify-content: space-between; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 18px; }
          h2 { margin: 0 0 4px 0; }
          p { margin: 2px 0; font-size: 12.5px; color: #475569; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 12px; }
          th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; }
          th { background: #e2e8f0; text-transform: uppercase; font-size: 11px; }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <h2>${biz.name || 'SupiriPOS PRO'} — Customer Credit Ledger Statement</h2>
            <p><strong>Customer:</strong> ${cust.name} &nbsp;|&nbsp; <strong>Mobile:</strong> ${cust.phone} &nbsp;|&nbsp; <strong>Address:</strong> ${cust.address || '-'}</p>
          </div>
          <div style="text-align: right;">
            <p><strong>Current Credit Balance:</strong> Rs. ${safeNum(cust.credit_balance).toFixed(2)}</p>
            <p><strong>Printed:</strong> ${new Date().toLocaleString()}</p>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Date & Time</th>
              <th>Transaction Type</th>
              <th>Reference / Note</th>
              <th>Method</th>
              <th>Staff</th>
              <th style="text-align: right;">Amount (Rs.)</th>
              <th style="text-align: right;">Balance After (Rs.)</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="7" style="text-align:center;">No transactions found</td></tr>'}
          </tbody>
        </table>
        <script>window.onload = () => { window.print(); };<\/script>
      </body>
    </html>
  `);
  printWin.document.close();
}

// ---------------------------------------------------------------------------
// BILINGUAL USER GUIDE MODAL
// ---------------------------------------------------------------------------
function openUserGuideModal() {
  document.getElementById('modal-user-guide').classList.add('active');
}

function closeUserGuideModal() {
  document.getElementById('modal-user-guide').classList.remove('active');
}

function switchGuideLang(lang) {
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
    const pillBadge = document.getElementById('db-connection-pill');
    const wsBadge = document.getElementById('ws-db-badge');
    const syncStatus = document.getElementById('ws-sync-status');
    const syncDot = document.getElementById('ws-sync-dot');

    const isOnline = data.status === 'healthy' || Boolean(data.database_alive);

    if (pill) {
      pill.textContent = "SUPABASE CLOUD ONLINE";
    }
    if (pillBadge) {
      pillBadge.className = isOnline ? "badge badge-emerald" : "badge badge-emerald";
    }
    if (wsBadge) {
      wsBadge.textContent = "SUPABASE CLOUD ONLINE";
      wsBadge.style.color = "#10b981";
    }
    if (syncStatus) {
      syncStatus.textContent = "Online • Synced";
      syncStatus.style.color = "var(--emerald)";
    }
    if (syncDot) {
      syncDot.style.backgroundColor = "var(--emerald)";
    }
  } catch (e) {
    updateSyncStatusUI(true);
  }
}

function startAntiSleepPing() {
  setInterval(async () => {
    try {
      await fetch('/ping');
    } catch (e) { }
  }, 30000);
}

// ===========================================================================
// SECTION: MASTER ADMIN / DEVELOPER CONTROL PANEL CONTROLLER
// ===========================================================================

const AdminState = {
  businesses: [],
  filter: 'all', // 'all' | 'active' | 'suspended'
  searchTerm: '',
  loading: false
};

function getAdminToken() {
  return localStorage.getItem('supiripos_admin_token') || '';
}

function getAdminAuthHeaders() {
  const token = getAdminToken();
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token,
    'x-admin-token': token
  };
}

function escapeAdminHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function openMasterAdminPanel() {
  const email = localStorage.getItem('supiripos_admin_email') || 'admin@prasatek.lk';
  const emailEl = document.getElementById('master-admin-email-display');
  if (emailEl) emailEl.textContent = email;

  showView('master-admin');
  await Promise.all([
    loadAdminOverviewStats(),
    loadAdminBusinesses()
  ]);
}

async function loadAdminOverviewStats() {
  try {
    const res = await fetch('/api/admin/overview-stats', {
      headers: getAdminAuthHeaders()
    });
    if (res.status === 401 || res.status === 403) {
      logoutMasterAdmin();
      showToast("Admin session expired. Please sign in again.", "warning");
      return;
    }
    const data = await res.json();
    if (data.success) {
      const totalEl = document.getElementById('admin-stat-total-biz');
      const activeEl = document.getElementById('admin-stat-active-biz');
      const suspEl = document.getElementById('admin-stat-suspended-biz');
      const itemsEl = document.getElementById('admin-stat-total-items');
      const revEl = document.getElementById('admin-stat-total-rev');

      if (totalEl) totalEl.textContent = data.total_businesses || 0;
      if (activeEl) activeEl.textContent = data.active_businesses || 0;
      if (suspEl) suspEl.textContent = data.suspended_businesses || 0;
      if (itemsEl) itemsEl.textContent = data.total_items || 0;
      if (revEl) {
        revEl.textContent = "Rs. " + Number(data.total_revenue || 0).toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        });
      }

      const openTicketsEl = document.getElementById('admin-stat-open-tickets');
      const openTicketsSub = document.getElementById('admin-stat-open-tickets-sub');
      const ticketsBadge = document.getElementById('admin-tickets-badge');
      const openCount = data.open_support_tickets ?? (data.stats && data.stats.open_support_tickets) ?? 0;
      if (openTicketsEl) openTicketsEl.textContent = openCount;
      if (openTicketsSub) openTicketsSub.textContent = `${openCount} Pending Replies`;
      if (ticketsBadge) ticketsBadge.textContent = openCount;
    }
  } catch (err) {
    console.error("Failed to load admin stats:", err);
  }
}

async function loadAdminBusinesses() {
  AdminState.loading = true;
  const tbody = document.getElementById('admin-biz-table-body');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 32px; color: var(--text-dim);">Loading stores...</td></tr>`;
  }

  try {
    const res = await fetch('/api/admin/businesses', {
      headers: getAdminAuthHeaders()
    });
    if (res.status === 401 || res.status === 403) {
      logoutMasterAdmin();
      showToast("Admin session expired. Please sign in again.", "warning");
      return;
    }
    const data = await res.json();
    if (data.success) {
      AdminState.businesses = data.businesses || [];
      filterAdminBusinesses();
    } else {
      showToast(data.detail || "Failed to load businesses.", "error");
    }
  } catch (err) {
    console.error("Failed to load businesses:", err);
    showToast("Network error loading businesses.", "error");
  } finally {
    AdminState.loading = false;
  }
}

function setAdminFilter(filter) {
  AdminState.filter = filter;
  const btnAll = document.getElementById('admin-filter-all');
  const btnActive = document.getElementById('admin-filter-active');
  const btnSuspended = document.getElementById('admin-filter-suspended');

  [btnAll, btnActive, btnSuspended].forEach(btn => {
    if (btn) {
      btn.classList.remove('btn-cyan');
      btn.classList.add('btn-glass');
    }
  });

  if (filter === 'all' && btnAll) {
    btnAll.classList.remove('btn-glass');
    btnAll.classList.add('btn-cyan');
  } else if (filter === 'active' && btnActive) {
    btnActive.classList.remove('btn-glass');
    btnActive.classList.add('btn-cyan');
  } else if (filter === 'suspended' && btnSuspended) {
    btnSuspended.classList.remove('btn-glass');
    btnSuspended.classList.add('btn-cyan');
  }

  filterAdminBusinesses();
}

function filterAdminBusinesses() {
  const input = document.getElementById('admin-search-input');
  const term = (input ? input.value : '').toLowerCase().trim();
  AdminState.searchTerm = term;

  let list = AdminState.businesses || [];

  // Filter by status
  if (AdminState.filter === 'active') {
    list = list.filter(b => b.is_active === true);
  } else if (AdminState.filter === 'suspended') {
    list = list.filter(b => b.is_active === false);
  }

  // Filter by search query
  if (term) {
    list = list.filter(b => {
      const matchName = (b.name || '').toLowerCase().includes(term);
      const matchCode = (b.business_code || '').toLowerCase().includes(term);
      const matchOwner = (b.owner_name || '').toLowerCase().includes(term);
      const matchEmail = (b.email || '').toLowerCase().includes(term);
      const matchPhone = (b.phone || '').toLowerCase().includes(term);
      const matchAddress = (b.address || '').toLowerCase().includes(term);
      return matchName || matchCode || matchOwner || matchEmail || matchPhone || matchAddress;
    });
  }

  renderAdminBusinessesTable(list);
}

function renderAdminBusinessesTable(list) {
  const tbody = document.getElementById('admin-biz-table-body');
  const badge = document.getElementById('admin-biz-count-badge');
  if (badge) {
    badge.textContent = `${list.length} ${list.length === 1 ? 'Store' : 'Stores'}`;
  }
  if (!tbody) return;

  if (!list || list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 48px; color: var(--text-dim);">
          <div style="font-size: 32px; margin-bottom: 8px;">🏬</div>
          <div style="font-size: 15px; font-weight: 600; color: #ffffff;">No businesses found</div>
          <div style="font-size: 12px; margin-top: 4px;">Try adjusting your search query or filters.</div>
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  list.forEach(b => {
    const isActive = b.is_active !== false;
    const stats = b.stats || {};
    const createdDate = b.created_at ? b.created_at.split('T')[0] : '—';
    const totalSalesFormatted = Number(stats.total_sales || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });

    html += `
      <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05); transition: background 0.15s ease;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
        <!-- Store Name & Code -->
        <td style="padding: 14px 16px;">
          <div style="font-weight: 700; color: #ffffff; font-size: 14px;">${escapeAdminHtml(b.name)}</div>
          <div style="font-family: var(--font-mono); font-size: 11px; color: var(--cyan); margin-top: 2px; font-weight: 600;">${escapeAdminHtml(b.business_code)}</div>
        </td>

        <!-- Owner & Contact -->
        <td style="padding: 14px 16px;">
          <div style="font-weight: 600; color: #f1f5f9; font-size: 13px;">${escapeAdminHtml(b.owner_name || '—')}</div>
          <div style="font-size: 11px; color: var(--text-dim); margin-top: 2px;">
            <span>${escapeAdminHtml(b.phone || '—')}</span> • <span>${escapeAdminHtml(b.email || '—')}</span>
          </div>
        </td>

        <!-- Address -->
        <td style="padding: 14px 16px;">
          <div style="font-size: 12px; color: var(--text-muted); max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeAdminHtml(b.address || '')}">
            ${escapeAdminHtml(b.address || '—')}
          </div>
        </td>

        <!-- Status -->
        <td style="padding: 14px 16px;">
          ${isActive 
            ? '<span class="badge badge-emerald" style="font-size: 11px; font-weight: 700; padding: 3px 10px;">ACTIVE</span>' 
            : '<span class="badge" style="background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); font-size: 11px; font-weight: 700; padding: 3px 10px;">SUSPENDED</span>'}
        </td>

        <!-- Stats -->
        <td style="padding: 14px 16px;">
          <div style="font-size: 12px; color: #f1f5f9; font-weight: 600;">${stats.products_count || 0} items • ${stats.invoices_count || 0} bills</div>
          <div style="font-size: 11px; color: #fbbf24; font-family: var(--font-mono); margin-top: 2px;">Rs. ${totalSalesFormatted}</div>
        </td>

        <!-- Joined -->
        <td style="padding: 14px 16px;">
          <span style="font-size: 11px; color: var(--text-dim);">${createdDate}</span>
        </td>

        <!-- Actions -->
        <td style="padding: 14px 16px; text-align: right;">
          <div style="display: flex; align-items: center; justify-content: flex-end; gap: 6px;">
            <button class="btn btn-sm btn-glass" onclick="openViewBusinessModal(${b.id})" title="View Details" style="padding: 4px 8px; font-size: 11px;">
              👁️ View
            </button>
            <button class="btn btn-sm btn-glass" onclick="openEditBusinessModal(${b.id})" title="Edit Business" style="padding: 4px 8px; font-size: 11px;">
              ✏️ Edit
            </button>
            ${isActive 
              ? `<button class="btn btn-sm btn-glass" onclick="toggleBusinessStatus(${b.id}, false)" title="Suspend Store" style="padding: 4px 8px; font-size: 11px; color: #fca5a5; border-color: rgba(239,68,68,0.3);">⏸️ Suspend</button>`
              : `<button class="btn btn-sm btn-glass" onclick="toggleBusinessStatus(${b.id}, true)" title="Activate Store" style="padding: 4px 8px; font-size: 11px; color: var(--emerald); border-color: rgba(16,185,129,0.3);">▶️ Activate</button>`
            }
            <button class="btn btn-sm btn-glass" onclick="confirmDeleteBusiness(${b.id}, '${escapeAdminHtml(b.name).replace(/'/g, "\\'")}')" title="Delete Business" style="padding: 4px 8px; font-size: 11px; color: #ef4444; border-color: rgba(239, 68, 68, 0.4);">
              🗑️
            </button>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// ---------------------------------------------------------------------------
// MASTER ADMIN: Create New Business Account
// ---------------------------------------------------------------------------
function openCreateBusinessModal() {
  const form = document.getElementById('form-admin-create-biz');
  if (form) form.reset();
  const termUser = document.getElementById('admin-new-term-user');
  const termPass = document.getElementById('admin-new-term-pass');
  if (termUser) termUser.value = 'user';
  if (termPass) termPass.value = '123';

  const modal = document.getElementById('modal-admin-create-biz');
  if (modal) modal.classList.add('active');
  const firstInput = document.getElementById('admin-new-shop-name');
  if (firstInput) firstInput.focus();
}

function closeCreateBusinessModal() {
  const modal = document.getElementById('modal-admin-create-biz');
  if (modal) modal.classList.remove('active');
}

async function handleAdminCreateBusiness(e) {
  e.preventDefault();
  const name = document.getElementById('admin-new-shop-name').value.trim();
  const owner_name = document.getElementById('admin-new-owner-name').value.trim();
  const email = document.getElementById('admin-new-email').value.trim();
  const phone = document.getElementById('admin-new-phone').value.trim();
  const nic = document.getElementById('admin-new-nic').value.trim();
  const address = document.getElementById('admin-new-address').value.trim();
  const master_password = document.getElementById('admin-new-master-pass').value.trim();
  const terminal_username = document.getElementById('admin-new-term-user').value.trim();
  const terminal_password = document.getElementById('admin-new-term-pass').value.trim();

  if (!name || !owner_name || !email || !phone || !address || !master_password) {
    showToast("Please fill all required business fields.", "warning");
    return;
  }

  const btn = document.getElementById('btn-admin-submit-create');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Provisioning...";
  }

  try {
    const res = await fetch('/api/admin/businesses', {
      method: 'POST',
      headers: getAdminAuthHeaders(),
      body: JSON.stringify({
        name,
        owner_name,
        email,
        phone,
        nic,
        address,
        master_password,
        terminal_username,
        terminal_password
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to provision business");

    closeCreateBusinessModal();
    showToast(`Store '${data.business.name}' created with code: ${data.business.business_code}`, "success", 4000);
    await Promise.all([loadAdminOverviewStats(), loadAdminBusinesses()]);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Create Store Account";
    }
  }
}

// ---------------------------------------------------------------------------
// MASTER ADMIN: Edit Business Details
// ---------------------------------------------------------------------------
function openEditBusinessModal(id) {
  const b = AdminState.businesses.find(item => item.id === id);
  if (!b) {
    showToast("Store record not found", "error");
    return;
  }

  document.getElementById('admin-edit-biz-id').value = b.id;
  const badge = document.getElementById('admin-edit-biz-badge');
  if (badge) badge.textContent = b.business_code;

  document.getElementById('admin-edit-shop-name').value = b.name || '';
  document.getElementById('admin-edit-owner-name').value = b.owner_name || '';
  document.getElementById('admin-edit-email').value = b.email || '';
  document.getElementById('admin-edit-phone').value = b.phone || '';
  document.getElementById('admin-edit-nic').value = b.nic || '';
  document.getElementById('admin-edit-address').value = b.address || '';
  document.getElementById('admin-edit-status').value = b.is_active ? 'active' : 'suspended';

  document.getElementById('admin-edit-master-pass').value = '';
  document.getElementById('admin-edit-term-pass').value = '';

  const modal = document.getElementById('modal-admin-edit-biz');
  if (modal) modal.classList.add('active');
}

function closeEditBusinessModal() {
  const modal = document.getElementById('modal-admin-edit-biz');
  if (modal) modal.classList.remove('active');
}

async function handleAdminEditBusiness(e) {
  e.preventDefault();
  const id = document.getElementById('admin-edit-biz-id').value;
  const name = document.getElementById('admin-edit-shop-name').value.trim();
  const owner_name = document.getElementById('admin-edit-owner-name').value.trim();
  const email = document.getElementById('admin-edit-email').value.trim();
  const phone = document.getElementById('admin-edit-phone').value.trim();
  const nic = document.getElementById('admin-edit-nic').value.trim();
  const address = document.getElementById('admin-edit-address').value.trim();
  const statusStr = document.getElementById('admin-edit-status').value;
  const master_password = document.getElementById('admin-edit-master-pass').value.trim();
  const terminal_password = document.getElementById('admin-edit-term-pass').value.trim();

  if (!name || !owner_name || !email || !phone || !address) {
    showToast("Please fill all required store fields.", "warning");
    return;
  }

  const payload = {
    name,
    owner_name,
    email,
    phone,
    nic,
    address,
    is_active: statusStr === 'active'
  };

  if (master_password) payload.master_password = master_password;
  if (terminal_password) payload.terminal_password = terminal_password;

  const btn = document.getElementById('btn-admin-submit-edit');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving...";
  }

  try {
    const res = await fetch(`/api/admin/businesses/${id}`, {
      method: 'PUT',
      headers: getAdminAuthHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to update store");

    closeEditBusinessModal();
    showToast(data.message || "Store updated successfully.", "success");
    await Promise.all([loadAdminOverviewStats(), loadAdminBusinesses()]);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save Changes";
    }
  }
}

// ---------------------------------------------------------------------------
// MASTER ADMIN: View Business Details Modal
// ---------------------------------------------------------------------------
function openViewBusinessModal(id) {
  const b = AdminState.businesses.find(item => item.id === id);
  if (!b) return;

  const titleEl = document.getElementById('admin-view-title');
  const badgeEl = document.getElementById('admin-view-status-badge');
  const contentEl = document.getElementById('admin-view-content');

  if (titleEl) titleEl.textContent = b.name;
  if (badgeEl) {
    if (b.is_active !== false) {
      badgeEl.className = "badge badge-emerald";
      badgeEl.textContent = "ACTIVE";
    } else {
      badgeEl.className = "badge";
      badgeEl.style.cssText = "background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.35);";
      badgeEl.textContent = "SUSPENDED";
    }
  }

  const stats = b.stats || {};
  const totalSalesFormatted = Number(stats.total_sales || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  if (contentEl) {
    contentEl.innerHTML = `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px;">
        <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; border: 1px solid var(--border-glass);">
          <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Business Code</div>
          <div style="font-size: 15px; font-weight: 800; color: var(--cyan); font-family: var(--font-mono); margin-top: 3px;">${escapeAdminHtml(b.business_code)}</div>
        </div>
        <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; border: 1px solid var(--border-glass);">
          <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Joined Date</div>
          <div style="font-size: 14px; font-weight: 600; color: #ffffff; margin-top: 3px;">${b.created_at ? b.created_at.replace('T', ' ').substring(0, 19) : '—'}</div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px;">
        <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; border: 1px solid var(--border-glass);">
          <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Owner Name</div>
          <div style="font-size: 14px; font-weight: 600; color: #ffffff; margin-top: 3px;">${escapeAdminHtml(b.owner_name || '—')}</div>
          <div style="font-size: 11px; color: var(--text-dim); margin-top: 2px;">NIC: ${escapeAdminHtml(b.nic || 'Not specified')}</div>
        </div>
        <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; border: 1px solid var(--border-glass);">
          <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Contact Info</div>
          <div style="font-size: 13px; font-weight: 600; color: #ffffff; margin-top: 3px;">${escapeAdminHtml(b.phone || '—')}</div>
          <div style="font-size: 11px; color: var(--cyan); margin-top: 2px;">${escapeAdminHtml(b.email || '—')}</div>
        </div>
      </div>

      <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; border: 1px solid var(--border-glass); margin-bottom: 16px;">
        <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Registered Physical Address</div>
        <div style="font-size: 13px; color: #e2e8f0; margin-top: 3px;">${escapeAdminHtml(b.address || '—')}</div>
      </div>

      <div style="background: rgba(16, 185, 129, 0.05); padding: 14px; border-radius: 8px; border: 1px solid rgba(16, 185, 129, 0.2);">
        <div style="font-size: 12px; font-weight: 700; color: var(--emerald); margin-bottom: 8px;">Store Activity Metrics</div>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; text-align: center;">
          <div>
            <div style="font-size: 18px; font-weight: 800; color: #ffffff;">${stats.users_count || 1}</div>
            <div style="font-size: 10px; color: var(--text-dim);">Users</div>
          </div>
          <div>
            <div style="font-size: 18px; font-weight: 800; color: #c084fc;">${stats.products_count || 0}</div>
            <div style="font-size: 10px; color: var(--text-dim);">Products</div>
          </div>
          <div>
            <div style="font-size: 18px; font-weight: 800; color: var(--cyan);">${stats.invoices_count || 0}</div>
            <div style="font-size: 10px; color: var(--text-dim);">Bills</div>
          </div>
          <div>
            <div style="font-size: 15px; font-weight: 800; color: #fbbf24; font-family: var(--font-mono);">Rs. ${totalSalesFormatted}</div>
            <div style="font-size: 10px; color: var(--text-dim);">Gross Sales</div>
          </div>
        </div>
      </div>
    `;
  }

  const modal = document.getElementById('modal-admin-view-biz');
  if (modal) modal.classList.add('active');
}

function closeViewBusinessModal() {
  const modal = document.getElementById('modal-admin-view-biz');
  if (modal) modal.classList.remove('active');
}

// ---------------------------------------------------------------------------
// MASTER ADMIN: Suspend / Activate Business
// ---------------------------------------------------------------------------
async function toggleBusinessStatus(id, newStatus) {
  const b = AdminState.businesses.find(item => item.id === id);
  const actionText = newStatus ? "activate" : "suspend";
  const name = b ? b.name : "this business";

  if (!confirm(`Are you sure you want to ${actionText} '${name}'?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/businesses/${id}`, {
      method: 'PUT',
      headers: getAdminAuthHeaders(),
      body: JSON.stringify({ is_active: newStatus })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `Failed to ${actionText} business`);

    showToast(`Store '${name}' ${newStatus ? 'activated' : 'suspended'} successfully.`, "success");
    await Promise.all([loadAdminOverviewStats(), loadAdminBusinesses()]);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// MASTER ADMIN: Delete Business
// ---------------------------------------------------------------------------
async function confirmDeleteBusiness(id, name) {
  const warning = `DANGER: Are you sure you want to permanently delete store '${name}'?\n\nThis will permanently delete all:\n- Products & inventory logs\n- Customer invoices & credit ledgers\n- Staff user accounts & logs\n\nThis action CANNOT be undone!`;
  if (!confirm(warning)) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/businesses/${id}`, {
      method: 'DELETE',
      headers: getAdminAuthHeaders()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to delete business");

    showToast(`Store '${name}' was permanently deleted.`, "info", 3500);
    await Promise.all([loadAdminOverviewStats(), loadAdminBusinesses()]);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// MASTER ADMIN: Super Admin Profile & Credentials Settings
// ---------------------------------------------------------------------------
function openAdminCredentialsModal() {
  const currEmail = localStorage.getItem('supiripos_admin_email') || 'admin@prasatek.lk';
  const emailInput = document.getElementById('admin-set-new-email');
  if (emailInput) emailInput.value = currEmail;

  const currPass = document.getElementById('admin-set-curr-pass');
  const newPass = document.getElementById('admin-set-new-pass');
  const confPass = document.getElementById('admin-set-confirm-pass');
  if (currPass) currPass.value = '';
  if (newPass) newPass.value = '';
  if (confPass) confPass.value = '';

  const modal = document.getElementById('modal-admin-settings');
  if (modal) modal.classList.add('active');
}

function closeAdminCredentialsModal() {
  const modal = document.getElementById('modal-admin-settings');
  if (modal) modal.classList.remove('active');
}

async function handleAdminProfileUpdate(e) {
  e.preventDefault();
  const current_password = document.getElementById('admin-set-curr-pass').value.trim();
  const new_email = document.getElementById('admin-set-new-email').value.trim();
  const new_password = document.getElementById('admin-set-new-pass').value.trim();
  const confirm_password = document.getElementById('admin-set-confirm-pass').value.trim();

  if (!current_password) {
    showToast("Please enter your current admin password.", "warning");
    return;
  }

  if (new_password && new_password !== confirm_password) {
    showToast("New passwords do not match.", "error");
    return;
  }

  if (new_password && new_password.length < 8) {
    showToast("New password must be at least 8 characters long.", "warning");
    return;
  }

  const payload = { current_password };
  if (new_email) payload.new_email = new_email;
  if (new_password) payload.new_password = new_password;

  const btn = document.getElementById('btn-admin-submit-profile');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Updating...";
  }

  try {
    const res = await fetch('/api/admin/profile', {
      method: 'PUT',
      headers: getAdminAuthHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to update admin profile");

    if (data.token) {
      localStorage.setItem('supiripos_admin_token', data.token);
    }
    if (data.admin_email) {
      localStorage.setItem('supiripos_admin_email', data.admin_email);
      const emailEl = document.getElementById('master-admin-email-display');
      if (emailEl) emailEl.textContent = data.admin_email;
    }

    closeAdminCredentialsModal();
    showToast("Super Admin credentials updated successfully!", "success", 3500);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Update Credentials";
    }
  }
}

// ---------------------------------------------------------------------------
// MASTER ADMIN: Logout
// ---------------------------------------------------------------------------
function logoutMasterAdmin() {
  localStorage.removeItem('supiripos_admin_token');
  localStorage.removeItem('supiripos_admin_email');
  showToast("Master Admin session ended.", "info", 2000);
  showView('landing');
}

// ===========================================================================
// SECTION: BUSINESS SETTINGS & DELETION WITH RESEND OTP VERIFICATION
// ===========================================================================
const BizOtpState = {
  action: 'UPDATE_SETTINGS', // 'UPDATE_SETTINGS' | 'DELETE_BUSINESS'
  pendingPayload: null
};

function updateLogoPreview() {
  const input = document.getElementById('biz-set-logo');
  const preview = document.getElementById('biz-set-logo-preview');
  if (input && preview) {
    preview.src = input.value.trim() || '/assets/logo.png';
  }
}

function loadBusinessSettingsForm() {
  const biz = AppState.business;
  if (!biz) return;

  const codeBadge = document.getElementById('biz-set-badge-code');
  if (codeBadge) codeBadge.textContent = biz.business_code;

  const nameInput = document.getElementById('biz-set-name');
  if (nameInput) nameInput.value = biz.name || '';

  const ownerInput = document.getElementById('biz-set-owner');
  if (ownerInput) ownerInput.value = biz.owner_name || '';

  const emailInput = document.getElementById('biz-set-email');
  if (emailInput) emailInput.value = biz.email || '';

  const phoneInput = document.getElementById('biz-set-phone');
  if (phoneInput) phoneInput.value = biz.phone || '';

  const addressInput = document.getElementById('biz-set-address');
  if (addressInput) addressInput.value = biz.address || '';

  const footerInput = document.getElementById('biz-set-footer');
  if (footerInput) footerInput.value = biz.receipt_footer || 'Thank You! Come Again! / ස්තූතියි! නැවත එන්න!';

  const logoInput = document.getElementById('biz-set-logo');
  if (logoInput) {
    logoInput.value = biz.logo_base64 || '/assets/logo.png';
    updateLogoPreview();
  }
}

async function initiateBusinessSettingsUpdate() {
  const biz = AppState.business;
  if (!biz) {
    showToast("No active business session found.", "error");
    return;
  }

  const name = document.getElementById('biz-set-name').value.trim();
  const owner_name = document.getElementById('biz-set-owner').value.trim();
  const phone = document.getElementById('biz-set-phone').value.trim();
  const address = document.getElementById('biz-set-address').value.trim();
  const receipt_footer = document.getElementById('biz-set-footer').value.trim();
  const logo_base64 = document.getElementById('biz-set-logo').value.trim();

  if (!name || !owner_name || !phone || !address) {
    showToast("Please fill all required store fields.", "warning");
    return;
  }

  BizOtpState.action = 'UPDATE_SETTINGS';
  BizOtpState.pendingPayload = {
    name,
    owner_name,
    phone,
    address,
    receipt_footer,
    logo_base64
  };

  const btn = document.getElementById('btn-save-biz-settings');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Requesting Security Code...";
  }

  try {
    const res = await fetch('/api/business/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_code: biz.business_code,
        action: 'UPDATE_SETTINGS'
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to dispatch verification code.");

    openBizOtpModal('UPDATE_SETTINGS', data.masked_email || biz.email);
    showToast(`Verification code sent to ${data.masked_email || 'owner email'}.`, "info", 4000);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "💾 Save Profile Changes (Sends OTP)";
    }
  }
}

async function initiateBusinessDeletion() {
  const biz = AppState.business;
  if (!biz) return;

  const confirmMsg = `CRITICAL WARNING:\nAre you sure you want to delete '${biz.name}' (${biz.business_code})?\n\nThis will permanently delete all:\n- Products & Inventory\n- Customer Bills & Invoices\n- Credit Customer Ledgers\n- Staff User Accounts\n\nA security code will be sent to the owner's email to authorize deletion.`;
  if (!confirm(confirmMsg)) {
    return;
  }

  BizOtpState.action = 'DELETE_BUSINESS';
  BizOtpState.pendingPayload = null;

  showToast("Requesting deletion security code...", "info", 2000);

  try {
    const res = await fetch('/api/business/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_code: biz.business_code,
        action: 'DELETE_BUSINESS'
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to dispatch deletion code.");

    openBizOtpModal('DELETE_BUSINESS', data.masked_email || biz.email);
    showToast(`⚠️ Deletion verification code sent to ${data.masked_email || 'owner email'}.`, "warning", 5000);
  } catch (err) {
    showToast(err.message, "error");
  }
}

function openBizOtpModal(action, maskedEmail) {
  const titleEl = document.getElementById('biz-otp-title');
  const badgeEl = document.getElementById('biz-otp-action-badge');
  const emailEl = document.getElementById('biz-otp-target-email');
  const codeInput = document.getElementById('biz-otp-code');
  const submitBtn = document.getElementById('btn-biz-otp-submit');

  if (emailEl) emailEl.textContent = maskedEmail || 'owner email';
  if (codeInput) codeInput.value = '';

  if (action === 'DELETE_BUSINESS') {
    if (titleEl) titleEl.textContent = "⚠️ Confirm Store Deletion";
    if (badgeEl) {
      badgeEl.className = "badge badge-rose";
      badgeEl.style.cssText = "background: rgba(239,68,68,0.2); color: #f87171; border: 1px solid rgba(239,68,68,0.4);";
      badgeEl.textContent = "PERMANENT DELETION";
    }
    if (submitBtn) {
      submitBtn.className = "btn btn-danger btn-lg";
      submitBtn.textContent = "Authorize Permanent Deletion";
    }
  } else {
    if (titleEl) titleEl.textContent = "🔐 Security Verification";
    if (badgeEl) {
      badgeEl.className = "badge badge-cyan";
      badgeEl.style.cssText = "";
      badgeEl.textContent = "PROFILE UPDATE";
    }
    if (submitBtn) {
      submitBtn.className = "btn btn-emerald btn-lg";
      submitBtn.textContent = "Confirm & Save Changes";
    }
  }

  const modal = document.getElementById('modal-biz-otp');
  if (modal) modal.classList.add('active');
  if (codeInput) codeInput.focus();
}

function closeBizOtpModal() {
  const modal = document.getElementById('modal-biz-otp');
  if (modal) modal.classList.remove('active');
}

async function handleBizOtpSubmit(e) {
  e.preventDefault();
  const biz = AppState.business;
  if (!biz) return;

  const otpCode = document.getElementById('biz-otp-code').value.trim();
  if (!otpCode || otpCode.length !== 6) {
    showToast("Please enter a valid 6-digit verification code.", "warning");
    return;
  }

  const submitBtn = document.getElementById('btn-biz-otp-submit');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Verifying...";
  }

  try {
    if (BizOtpState.action === 'DELETE_BUSINESS') {
      const res = await fetch('/api/business/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_code: biz.business_code,
          otp_code: otpCode
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Deletion failed.");

      closeBizOtpModal();
      showToast(data.message || "Business deleted permanently.", "info", 5000);
      switchBusinessTerminal();
    } else {
      // UPDATE_SETTINGS
      const payload = Object.assign({}, BizOtpState.pendingPayload, {
        business_code: biz.business_code,
        otp_code: otpCode
      });

      const res = await fetch('/api/business/update-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to update business settings.");

      closeBizOtpModal();
      showToast(data.message || "Store profile updated successfully!", "success", 4000);

      if (data.business) {
        AppState.business = Object.assign({}, AppState.business, data.business);
        localStorage.setItem('supiripos_biz_session', JSON.stringify(AppState.business));

        const shopNameEl = document.getElementById('ws-shop-name');
        if (shopNameEl) shopNameEl.textContent = data.business.name;
        const shopLogoEl = document.getElementById('ws-shop-logo');
        if (shopLogoEl && data.business.logo_base64) shopLogoEl.src = data.business.logo_base64;

        loadBusinessSettingsForm();
      }
    }
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = (BizOtpState.action === 'DELETE_BUSINESS') ? "Authorize Permanent Deletion" : "Confirm & Save Changes";
    }
  }
}

// ===========================================================================
// SECTION: MERCHANT SUPPORT TICKETS
// ===========================================================================
async function loadMerchantSupportTickets() {
  const biz = AppState.business;
  if (!biz) return;

  const container = document.getElementById('merchant-support-tickets-list');
  const countBadge = document.getElementById('merchant-tickets-count-badge');
  if (container) {
    container.innerHTML = `<div style="text-align: center; padding: 30px; color: var(--text-dim); font-size: 13px;">Loading support tickets...</div>`;
  }

  try {
    const res = await fetch(`/api/support/tickets?business_code=${encodeURIComponent(biz.business_code)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to load support tickets.");

    const tickets = data.tickets || [];
    if (countBadge) countBadge.textContent = `${tickets.length} ${tickets.length === 1 ? 'Ticket' : 'Tickets'}`;

    if (!container) return;

    if (tickets.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: var(--text-dim);">
          <div style="font-size: 32px; margin-bottom: 8px;">🎧</div>
          <div style="font-size: 15px; font-weight: 600; color: #ffffff;">No support tickets submitted yet</div>
          <div style="font-size: 12px; margin-top: 4px;">Use the form on the left to submit an inquiry anytime.</div>
        </div>
      `;
      return;
    }

    let html = '';
    tickets.forEach(t => {
      const isResolved = (t.status === 'resolved');
      const dateStr = t.created_at ? t.created_at.replace('T', ' ').substring(0, 16) : '—';
      const repliedStr = t.replied_at ? t.replied_at.replace('T', ' ').substring(0, 16) : '';

      html += `
        <div class="glass-panel" style="padding: 16px; border-color: ${isResolved ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.35)'};">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <div style="font-size: 14px; font-weight: 700; color: #ffffff;">
              <span style="color: var(--cyan); font-family: var(--font-mono); font-size: 12px;">#${t.id}</span> &bull; ${escapeAdminHtml(t.subject)}
            </div>
            ${isResolved 
              ? '<span class="badge badge-emerald" style="font-size: 11px;">RESOLVED</span>' 
              : '<span class="badge badge-warning" style="font-size: 11px;">OPEN</span>'}
          </div>

          <div style="font-size: 11px; color: var(--text-dim); margin-bottom: 8px;">
            Submitted on ${dateStr}
          </div>

          <div style="font-size: 13px; color: #cbd5e1; line-height: 1.5; white-space: pre-wrap; background: rgba(0,0,0,0.25); padding: 10px; border-radius: 6px; margin-bottom: 8px;">${escapeAdminHtml(t.message)}</div>

          ${t.admin_reply ? `
            <div style="background: rgba(16, 185, 129, 0.08); border-left: 3px solid var(--emerald); padding: 10px 14px; border-radius: 6px; margin-top: 8px;">
              <div style="font-size: 11px; font-weight: 700; color: var(--emerald); margin-bottom: 3px;">
                💬 Official PrasaTek Response ${repliedStr ? `(${repliedStr})` : ''}:
              </div>
              <div style="font-size: 13px; color: #ffffff; line-height: 1.5; white-space: pre-wrap;">${escapeAdminHtml(t.admin_reply)}</div>
            </div>
          ` : `
            <div style="font-size: 11.5px; color: #f59e0b; display: flex; align-items: center; gap: 5px; margin-top: 6px;">
              <span>⏳</span> <span>Our technical support team is reviewing your ticket.</span>
            </div>
          `}
        </div>
      `;
    });

    container.innerHTML = html;
  } catch (err) {
    console.error("Failed to load merchant tickets:", err);
    if (container) {
      container.innerHTML = `<div style="text-align: center; padding: 20px; color: #ef4444; font-size: 13px;">Error loading tickets: ${escapeAdminHtml(err.message)}</div>`;
    }
  }
}

async function handleCreateSupportTicket(e) {
  e.preventDefault();
  const biz = AppState.business;
  if (!biz) return;

  const subject = document.getElementById('support-ticket-subject').value.trim();
  const message = document.getElementById('support-ticket-message').value.trim();

  if (!subject || !message) {
    showToast("Please enter ticket subject and message details.", "warning");
    return;
  }

  const btn = document.getElementById('btn-submit-support-ticket');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Submitting Ticket...";
  }

  try {
    const res = await fetch('/api/support/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_code: biz.business_code,
        subject,
        message
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to submit ticket.");

    document.getElementById('form-create-support-ticket').reset();
    showToast(data.message || `Support ticket #${data.ticket.id} submitted successfully!`, "success", 4000);
    await loadMerchantSupportTickets();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🚀 Submit Support Ticket";
    }
  }
}

// ===========================================================================
// SECTION: MASTER ADMIN SUPPORT TICKETS CONTROLLER
// ===========================================================================
const AdminSupportState = {
  tickets: [],
  filter: 'all', // 'all' | 'open' | 'resolved'
  searchTerm: '',
  currentTicket: null
};

function switchMasterAdminTab(tab) {
  const btnStores = document.getElementById('admin-nav-tab-stores');
  const btnSupport = document.getElementById('admin-nav-tab-support');
  const secStores = document.getElementById('admin-sec-stores');
  const secSupport = document.getElementById('admin-sec-support');

  if (tab === 'support') {
    if (btnStores) { btnStores.classList.remove('btn-cyan'); btnStores.classList.add('btn-glass'); }
    if (btnSupport) { btnSupport.classList.remove('btn-glass'); btnSupport.classList.add('btn-cyan'); }
    if (secStores) secStores.style.display = 'none';
    if (secSupport) secSupport.style.display = 'block';
    loadAdminSupportTickets();
  } else {
    if (btnSupport) { btnSupport.classList.remove('btn-cyan'); btnSupport.classList.add('btn-glass'); }
    if (btnStores) { btnStores.classList.remove('btn-glass'); btnStores.classList.add('btn-cyan'); }
    if (secSupport) secSupport.style.display = 'none';
    if (secStores) secStores.style.display = 'block';
    loadAdminBusinesses();
  }
}

async function loadAdminSupportTickets() {
  const tbody = document.getElementById('admin-tickets-table-body');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: var(--text-dim);">Loading support tickets...</td></tr>`;
  }

  try {
    const res = await fetch('/api/admin/support/tickets', {
      headers: getAdminAuthHeaders()
    });
    if (res.status === 401 || res.status === 403) {
      logoutMasterAdmin();
      return;
    }
    const data = await res.json();
    if (data.success) {
      AdminSupportState.tickets = data.tickets || [];
      const openCount = data.open_count || 0;

      const badge = document.getElementById('admin-tickets-badge');
      if (badge) badge.textContent = openCount;

      const statOpen = document.getElementById('admin-stat-open-tickets');
      if (statOpen) statOpen.textContent = openCount;

      const statOpenSub = document.getElementById('admin-stat-open-tickets-sub');
      if (statOpenSub) statOpenSub.textContent = `${openCount} Pending Replies`;

      filterAdminSupportTickets();
    }
  } catch (err) {
    console.error("Failed to load admin support tickets:", err);
  }
}

function setAdminTicketFilter(filter) {
  AdminSupportState.filter = filter;
  ['all', 'open', 'resolved'].forEach(f => {
    const btn = document.getElementById(`admin-ticket-filter-${f}`);
    if (btn) {
      if (f === filter) {
        btn.classList.remove('btn-glass');
        btn.classList.add('btn-cyan');
      } else {
        btn.classList.remove('btn-cyan');
        btn.classList.add('btn-glass');
      }
    }
  });
  filterAdminSupportTickets();
}

function filterAdminSupportTickets() {
  const input = document.getElementById('admin-tickets-search-input');
  const term = (input ? input.value : '').toLowerCase().trim();
  AdminSupportState.searchTerm = term;

  let list = AdminSupportState.tickets || [];

  if (AdminSupportState.filter === 'open') {
    list = list.filter(t => t.status === 'open');
  } else if (AdminSupportState.filter === 'resolved') {
    list = list.filter(t => t.status === 'resolved');
  }

  if (term) {
    list = list.filter(t => {
      const matchSub = (t.subject || '').toLowerCase().includes(term);
      const matchMsg = (t.message || '').toLowerCase().includes(term);
      const matchStore = (t.business_name || '').toLowerCase().includes(term);
      const matchCode = (t.business_code || '').toLowerCase().includes(term);
      const matchEmail = (t.owner_email || '').toLowerCase().includes(term);
      return matchSub || matchMsg || matchStore || matchCode || matchEmail;
    });
  }

  renderAdminSupportTicketsTable(list);
}

function renderAdminSupportTicketsTable(list) {
  const tbody = document.getElementById('admin-tickets-table-body');
  const badge = document.getElementById('admin-tickets-count-badge');
  if (badge) {
    badge.textContent = `${list.length} ${list.length === 1 ? 'Ticket' : 'Tickets'}`;
  }
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 48px; color: var(--text-dim);">
          <div style="font-size: 32px; margin-bottom: 8px;">🎧</div>
          <div style="font-size: 15px; font-weight: 600; color: #ffffff;">No support tickets found</div>
          <div style="font-size: 12px; margin-top: 4px;">No tickets match your active filter.</div>
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  list.forEach(t => {
    const isResolved = (t.status === 'resolved');
    const dateStr = t.created_at ? t.created_at.replace('T', ' ').substring(0, 16) : '—';

    html += `
      <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05); transition: background 0.15s ease;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
        <!-- Ticket # -->
        <td style="padding: 14px 16px; font-family: var(--font-mono); font-weight: 700; color: var(--cyan);">
          #${t.id}
        </td>

        <!-- Store & Location -->
        <td style="padding: 14px 16px;">
          <div style="font-weight: 700; color: #ffffff;">${escapeAdminHtml(t.business_name || 'Store')}</div>
          <div style="font-size: 11px; color: var(--cyan); font-family: var(--font-mono); margin-top: 2px;">${escapeAdminHtml(t.business_code)}</div>
        </td>

        <!-- Owner & Email -->
        <td style="padding: 14px 16px;">
          <div style="font-weight: 600; color: #f1f5f9; font-size: 13px;">${escapeAdminHtml(t.owner_name || '—')}</div>
          <div style="font-size: 11px; color: var(--text-dim); margin-top: 2px; font-family: var(--font-mono);">${escapeAdminHtml(t.owner_email || '—')}</div>
        </td>

        <!-- Subject & Inquiry -->
        <td style="padding: 14px 16px;">
          <div style="font-weight: 700; color: #ffffff; font-size: 13.5px;">${escapeAdminHtml(t.subject)}</div>
          <div style="font-size: 12px; color: var(--text-muted); max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 3px;" title="${escapeAdminHtml(t.message)}">
            ${escapeAdminHtml(t.message)}
          </div>
          ${t.admin_reply ? `
            <div style="font-size: 11px; color: var(--emerald); margin-top: 4px;">
              ✓ Replied: ${escapeAdminHtml(t.admin_reply.substring(0, 60))}...
            </div>
          ` : ''}
        </td>

        <!-- Status -->
        <td style="padding: 14px 16px;">
          ${isResolved
            ? '<span class="badge badge-emerald" style="font-size: 11px; padding: 3px 10px;">RESOLVED</span>'
            : '<span class="badge badge-warning" style="font-size: 11px; padding: 3px 10px;">OPEN</span>'}
        </td>

        <!-- Created -->
        <td style="padding: 14px 16px; font-size: 11.5px; color: var(--text-dim);">
          ${dateStr}
        </td>

        <!-- Actions -->
        <td style="padding: 14px 16px; text-align: right;">
          <button class="btn btn-sm btn-emerald" onclick="openAdminTicketReplyModal(${t.id})" style="padding: 4px 12px; font-size: 11.5px; display: inline-flex; align-items: center; gap: 5px;">
            <span>💬 Reply</span>
          </button>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

function openAdminTicketReplyModal(ticketId) {
  const t = AdminSupportState.tickets.find(item => item.id === ticketId);
  if (!t) return;
  AdminSupportState.currentTicket = t;

  document.getElementById('admin-reply-ticket-id').value = t.id;
  document.getElementById('admin-reply-ticket-badge').textContent = `#${t.id}`;
  document.getElementById('admin-reply-ticket-subject').textContent = t.subject;
  document.getElementById('admin-reply-ticket-store').textContent = t.business_name || t.business_code;
  document.getElementById('admin-reply-ticket-owner').textContent = t.owner_name || 'Owner';
  document.getElementById('admin-reply-ticket-email').textContent = t.owner_email || 'No email';
  document.getElementById('admin-reply-ticket-message').textContent = t.message;

  const statusBadge = document.getElementById('admin-reply-ticket-status-badge');
  if (statusBadge) {
    statusBadge.className = (t.status === 'resolved') ? "badge badge-emerald" : "badge badge-warning";
    statusBadge.textContent = t.status.toUpperCase();
  }

  const replyText = document.getElementById('admin-reply-text');
  if (replyText) replyText.value = t.admin_reply || '';

  const statusSelect = document.getElementById('admin-reply-status');
  if (statusSelect) statusSelect.value = t.status || 'resolved';

  const modal = document.getElementById('modal-admin-reply-ticket');
  if (modal) modal.classList.add('active');
  if (replyText) replyText.focus();
}

function closeAdminTicketReplyModal() {
  const modal = document.getElementById('modal-admin-reply-ticket');
  if (modal) modal.classList.remove('active');
}

async function handleAdminSendTicketReply(e) {
  e.preventDefault();
  const ticketId = document.getElementById('admin-reply-ticket-id').value;
  const reply_message = document.getElementById('admin-reply-text').value.trim();
  const status = document.getElementById('admin-reply-status').value;

  if (!reply_message) {
    showToast("Please enter an official reply message.", "warning");
    return;
  }

  const btn = document.getElementById('btn-admin-submit-reply');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending Email Reply...";
  }

  try {
    const res = await fetch(`/api/admin/support/tickets/${ticketId}/reply`, {
      method: 'POST',
      headers: getAdminAuthHeaders(),
      body: JSON.stringify({
        reply_message,
        status
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to dispatch email reply.");

    closeAdminTicketReplyModal();
    showToast(data.message || "Official reply dispatched via Resend email!", "success", 4000);
    await loadAdminSupportTickets();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🚀 Send Email Reply via Resend";
    }
  }
}

// ===========================================================================
// SECTION: PUBLIC SUPPORT TICKET MODAL (LANDING & LOGIN PAGE)
// ===========================================================================
function openPublicSupportModal() {
  const modal = document.getElementById('modal-public-support');
  if (!modal) return;

  const emailInput = document.getElementById('public-ticket-email');
  const bizCodeInput = document.getElementById('public-ticket-bizcode');

  if (AppState.business) {
    if (emailInput && AppState.business.email) emailInput.value = AppState.business.email;
    if (bizCodeInput && AppState.business.business_code) bizCodeInput.value = AppState.business.business_code;
  } else {
    const unlockCode = document.getElementById('unlock-biz-code');
    if (unlockCode && unlockCode.value && bizCodeInput) {
      bizCodeInput.value = unlockCode.value.trim().toUpperCase();
    }
  }

  modal.classList.add('active');
}

function closePublicSupportModal() {
  const modal = document.getElementById('modal-public-support');
  if (modal) modal.classList.remove('active');
}

async function handlePublicSupportSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('public-ticket-email').value.trim();
  const name = document.getElementById('public-ticket-name').value.trim();
  const business_code = document.getElementById('public-ticket-bizcode').value.trim().toUpperCase();
  const subject = document.getElementById('public-ticket-subject').value.trim();
  const message = document.getElementById('public-ticket-message').value.trim();

  if (!email || !subject || !message) {
    showToast("Please enter your registered email address, subject, and message.", "warning");
    return;
  }

  const btn = document.getElementById('btn-submit-public-ticket');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Submitting Ticket...";
  }

  try {
    const res = await fetch('/api/support/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, business_code, subject, message })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to submit support ticket.");

    closePublicSupportModal();
    const form = document.getElementById('form-public-support');
    if (form) form.reset();
    showToast(data.message || `Support ticket #${data.ticket.id} submitted! Confirmation email sent to ${email}.`, "success", 6000);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🚀 Submit Support Ticket";
    }
  }
}

// ===========================================================================
// SECTION: POS USER DROPDOWN MENU
// ===========================================================================
function togglePosUserDropdown(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  const menu = document.getElementById('pos-user-dropdown-menu');
  if (!menu) return;

  const isVisible = (menu.style.display === 'block');
  if (isVisible) {
    menu.style.display = 'none';
  } else {
    const nameEl = document.getElementById('dropdown-user-name');
    const codeEl = document.getElementById('dropdown-biz-code');
    const roleEl = document.getElementById('dropdown-role-title');

    if (nameEl) nameEl.textContent = (AppState.user && (AppState.user.full_name || AppState.user.username)) || 'Staff User';
    if (codeEl) codeEl.textContent = (AppState.business && AppState.business.business_code) || 'PT-STORE';
    if (roleEl) roleEl.textContent = (AppState.user && AppState.user.role_title) || 'Store Manager';

    menu.style.display = 'block';
  }
}

function closePosUserDropdown() {
  const menu = document.getElementById('pos-user-dropdown-menu');
  if (menu) menu.style.display = 'none';
}

window.addEventListener('click', (e) => {
  const container = document.getElementById('pos-user-dropdown-container');
  const menu = document.getElementById('pos-user-dropdown-menu');
  if (container && menu && !container.contains(e.target)) {
    menu.style.display = 'none';
  }
});

// ===========================================================================
// SECTION: POS USER DROPDOWN - QUICK SUPPORT TICKET MODAL
// ===========================================================================
function openPosSupportModal() {
  const modal = document.getElementById('modal-pos-ticket');
  if (!modal) return;

  const bizNameEl = document.getElementById('pos-ticket-modal-bizname');
  const bizCodeEl = document.getElementById('pos-ticket-modal-bizcode');

  if (bizNameEl && AppState.business) bizNameEl.textContent = AppState.business.name || 'Your Store';
  if (bizCodeEl && AppState.business) bizCodeEl.textContent = AppState.business.business_code || '';

  modal.classList.add('active');
}

function closePosSupportModal() {
  const modal = document.getElementById('modal-pos-ticket');
  if (modal) modal.classList.remove('active');
}

async function handlePosModalTicketSubmit(e) {
  e.preventDefault();
  if (!AppState.business) {
    showToast("No active store session found.", "error");
    return;
  }

  const subject = document.getElementById('pos-modal-ticket-subject').value.trim();
  const message = document.getElementById('pos-modal-ticket-message').value.trim();

  if (!subject || !message) {
    showToast("Subject and message are required.", "warning");
    return;
  }

  const btn = document.getElementById('btn-submit-pos-modal-ticket');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Submitting...";
  }

  try {
    const res = await fetch('/api/support/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_code: AppState.business.business_code,
        subject,
        message
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to submit support ticket.");

    closePosSupportModal();
    const form = document.getElementById('form-pos-modal-ticket');
    if (form) form.reset();
    showToast(data.message || `Support Ticket #${data.ticket.id} created! Confirmation email sent to ${AppState.business.email || 'your email'}.`, "success", 6000);

    // Refresh tickets list if on support tab
    if (typeof loadMerchantSupportTickets === 'function') {
      loadMerchantSupportTickets();
    }
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🚀 Submit Ticket";
    }
  }
}

// ===========================================================================
// SECTION: POS USER DROPDOWN - BUSINESS SETTINGS MODAL
// ===========================================================================
let modalPendingLogoBase64 = null;

function openBusinessSettingsModal() {
  if (!AppState.business) {
    showToast("No active store session found.", "error");
    return;
  }

  const modal = document.getElementById('modal-pos-settings');
  if (!modal) return;

  const b = AppState.business;
  const nameInput = document.getElementById('modal-set-name');
  const ownerInput = document.getElementById('modal-set-owner');
  const phoneInput = document.getElementById('modal-set-phone');
  const emailInput = document.getElementById('modal-set-email');
  const addressInput = document.getElementById('modal-set-address');
  const footerInput = document.getElementById('modal-set-footer');
  const logoPreview = document.getElementById('modal-set-logo-preview');

  if (nameInput) nameInput.value = b.name || '';
  if (ownerInput) ownerInput.value = b.owner_name || '';
  if (phoneInput) phoneInput.value = b.phone || '';
  if (emailInput) emailInput.value = b.email || '';
  if (addressInput) addressInput.value = b.address || '';
  if (footerInput) footerInput.value = b.receipt_footer || '';
  if (logoPreview) logoPreview.src = b.logo_base64 || '/assets/logo.png';
  modalPendingLogoBase64 = b.logo_base64 || null;

  modal.classList.add('active');
}

function closeBusinessSettingsModal() {
  const modal = document.getElementById('modal-pos-settings');
  if (modal) modal.classList.remove('active');
}

function previewModalLogo(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function(e) {
      modalPendingLogoBase64 = e.target.result;
      const preview = document.getElementById('modal-set-logo-preview');
      if (preview) preview.src = modalPendingLogoBase64;
    };
    reader.readAsDataURL(input.files[0]);
  }
}

async function handleModalSettingsSubmit(e) {
  e.preventDefault();
  if (!AppState.business) return;

  const name = document.getElementById('modal-set-name').value.trim();
  const owner_name = document.getElementById('modal-set-owner').value.trim();
  const phone = document.getElementById('modal-set-phone').value.trim();
  const address = document.getElementById('modal-set-address').value.trim();
  const receipt_footer = document.getElementById('modal-set-footer').value.trim();

  if (!name || !owner_name) {
    showToast("Store name and owner name are required.", "warning");
    return;
  }

  const payload = {
    name,
    owner_name,
    phone,
    address,
    receipt_footer,
    logo_base64: modalPendingLogoBase64
  };

  BizOtpState.action = 'UPDATE_SETTINGS';
  BizOtpState.pendingPayload = payload;

  closeBusinessSettingsModal();

  // Trigger Resend OTP request
  showToast("Requesting security verification code via Resend...", "info", 3000);

  try {
    const res = await fetch('/api/business/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_code: AppState.business.business_code,
        action: 'UPDATE_SETTINGS'
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to dispatch verification code.");

    openBizOtpModal('UPDATE_SETTINGS', data.masked_email || AppState.business.email);
    showToast(data.message || `Verification code sent to ${data.masked_email || AppState.business.email}`, "info", 5000);
  } catch (err) {
    showToast(err.message, "error");
  }
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
    const savedAdminToken = localStorage.getItem('supiripos_admin_token');
    if (savedAdminToken) {
      openMasterAdminPanel();
      return;
    }

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
