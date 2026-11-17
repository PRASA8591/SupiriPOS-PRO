# SupiriPOS PRO 🏪⚡
### Commercial-Grade Multi-Tenant Cloud Point of Sale System

[![Python Version](https://img.shields.io/badge/python-3.12%2B-blue.svg)](https://www.python.org/)
[![Framework](https://img.shields.io/badge/FastAPI-0.110%2B-009688.svg)](https://fastapi.tiangolo.com/)
[![Database](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E.svg)](https://supabase.com/)
[![Email Engine](https://img.shields.io/badge/Resend-HTTPS%20API-black.svg)](https://resend.com/)
[![Deployment](https://img.shields.io/badge/Render-Cloud%20Ready-46E3B7.svg)](https://render.com/)
[![License](https://img.shields.io/badge/license-Proprietary-red.svg)](https://prasatek.lk)

**SupiriPOS PRO** is an ultra-fast, multi-tenant cloud Point of Sale (POS) and inventory ERP system purpose-built for supermarkets, grocery stores, bakeries, hardware shops, and retail chains in Sri Lanka and worldwide. Powered by **FastAPI**, **Supabase Cloud PostgreSQL**, **WebSockets**, and the **Resend REST API**, it delivers millisecond billing speeds, real-time inventory synchronization across registers, and enterprise-grade security.

---

## 🌟 Key Features

### 1. 🕵️ Stealth Master Admin Control Panel
* **Hidden Backdoor Interception:** No public buttons or hints. Entering `admin@prasatek.lk` (default password: `PrasaTek@2026`) into the standard terminal login form unlocks the secret **Master Admin Dashboard**.
* **Zero Hardcoded Fallbacks:** Every login dynamically queries the `system_admins` PostgreSQL table in Supabase. Changing the admin password in the portal immediately invalidates the old credentials across all devices.
* **Platform Operations:** Overview KPI metrics (active vs. suspended businesses, open support tickets), store provisioning wizard, granular business management, and staff credential resets.

### 2. 🔐 Two-Stage Security & First-Login Password Enforcement
* **Stage 1 (Terminal Unlock):** Stations lock to a merchant's unique Business Code (e.g., `PT-00001`) authenticated with the Business Master Password.
* **Stage 2 (Cashier Login):** Default initial credentials (`user` / `123`).
* **Mandatory First-Time Credential Change:** New businesses are immediately prompted to replace the temporary `user` / `123` credentials with a personalized username, strong password, and manager name before POS registers open.

### 3. 📧 Resend Email OTP Verification (Store Settings & Danger Zone)
* **Cloud-Friendly REST Email Engine:** Completely bypasses raw SMTP ports (465/587) blocked by cloud providers (like Render), dispatching transactional security emails via the official **Resend HTTPS API** (`https://api.resend.com/emails`).
* **Profile Settings Protection:** Updating Store Name, Physical Address, Contact Phone, Logo, or Receipt Footer requires an encrypted 6-digit OTP code sent to the owner's registered email (`noreply@prasatek.lk`).
* **Store Deletion (Danger Zone):** Permanent store account deletion requires typing `DELETE <BUSINESS_CODE>` combined with a second dedicated Resend deletion OTP.

### 4. 🎧 Full Support Ticket System (Public & POS In-App)
* **Public Landing Page & Login Help:** Customers or locked-out merchants can submit support inquiries from the landing page by providing their **Registered Email Address** (mandatory).
* **POS Header Dropdown Menu:** Logged-in staff can click their **Username** pill in the top navigation to instantly create a support ticket, pre-linked to their business code.
* **Automated Confirmation & Direct Email Replies:** Merchants receive automated confirmation emails. When the Super Admin replies from the Master Admin Panel, the reply is automatically sent straight to the merchant's email inbox via Resend.

### 5. 📖 Bilingual User Guide (English & සිංහල)
* Built-in interactive user guide available in both **English** and **Sinhala (සිංහල)** with a one-click language toggle.
* Covers Terminal Operations, Cashier Billing, Barcode Scanning, Resend OTP Security, Support Tickets, and Master Admin features.

### 6. ⚡ Fast Billing & Hardware Integration
* **Barcode Scanner Ready:** Seamless integration with USB, Bluetooth, and wireless barcode scanners. Pressing Enter automatically pushes items to the active bill.
* **Fast Cash Tender Shortcuts:** Instant buttons (`+500`, `+1,000`, `+5,000`, `Exact`) calculate Change Due (ඉතුරු මුදල) in real time.
* **Thermal Receipt Printing:** Instant 80mm and 58mm thermal receipts with store logos, itemized breakdowns, customer credit balances, and Sinhala text support.
* **Customer Credit Accounts (ණය පාරිභෝගිකයන්):** Track credit sales, repayments, remaining balances, and printable customer payment vouchers.
* **Real-Time WebSockets:** Live stock adjustments and sales propagate across all counters instantly without page reloads.

---

## 🛠️ Technology Stack

| Component | Technology | Purpose |
| :--- | :--- | :--- |
| **Backend Framework** | **Python 3.12+ / FastAPI** | High-performance asynchronous REST API & WebSockets |
| **Database** | **Supabase (PostgreSQL 15+)** | Managed cloud database with high availability & connection pooling |
| **ORM** | **SQLAlchemy 2.0** | Robust relational data modeling & migrations |
| **Email Service** | **Resend REST API (HTTPS)** | Non-blocking transactional emails & security OTP dispatch |
| **Frontend** | **Vanilla JS (ES6+) & HTML5** | Zero npm dependencies, zero build steps, ultra-fast load times |
| **Styling** | **Glassmorphic Dark CSS** | Responsive dark mode theme with modern glowing neon accents |
| **Deployment** | **Docker / Render.com** | Containerized cloud deployment ready for 24/7 production uptime |

---

## ⚙️ Environment Variables Configuration

Create a `.env` file in the root project directory:

```env
# ---------------------------------------------------------------------------
# Database Configuration (Supabase PostgreSQL)
# ---------------------------------------------------------------------------
DATABASE_URL=postgresql://postgres.kkonfrnnqsvuyxpmfpek:[YOUR_SUPABASE_PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require

# ---------------------------------------------------------------------------
# Application Security
# ---------------------------------------------------------------------------
SECRET_KEY=supiripos-pro-prasatek-secure-cloud-key-2026
ENVIRONMENT=production
PORT=8000

# ---------------------------------------------------------------------------
# Resend Transactional Email API (HTTPS)
# ---------------------------------------------------------------------------
RESEND_API_KEY=re_your_resend_api_key_here
RESEND_FROM_EMAIL=PrasaTek System Solutions <noreply@prasatek.lk>
```

> **Security Note:** Never commit your `.env` file to Git. The `.gitignore` is pre-configured to keep secret tokens safe.

---

## 🚀 Local Development Setup

### 1. Clone the Repository
```bash
git clone https://github.com/prasath-prasatek/supiripos-pro.git
cd "SupiriPOS PRO"
```

### 2. Create and Activate Virtual Environment
```bash
# Windows
python -m venv venv
venv\Scripts\activate

# macOS / Linux
python3 -m venv venv
source venv/bin/activate
```

### 3. Install Dependencies
```bash
pip install -r requirements.txt
```

### 4. Run the Development Server
```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

Open your browser at:
`http://localhost:8000`

---

## ☁️ Deployment on Render

SupiriPOS PRO is configured for zero-downtime deployment on [Render](https://render.com).

### Deployment Steps:
1. Push your repository to **GitHub**.
2. Log in to your **Render Dashboard** and click **New + > Web Service**.
3. Connect your GitHub repository.
4. Configure the Web Service settings:
   * **Runtime:** `Python 3`
   * **Build Command:** `pip install -r requirements.txt`
   * **Start Command:** `uvicorn app:app --host 0.0.0.0 --port $PORT`
5. Under **Environment Variables**, add:
   * `DATABASE_URL` (Supabase Connection String)
   * `SECRET_KEY` (Strong random secret)
   * `RESEND_API_KEY` (Your Resend API Key)
   * `RESEND_FROM_EMAIL` (`PrasaTek System Solutions <noreply@prasatek.lk>`)
   * `PYTHON_VERSION` (`3.12.0`)
6. Click **Deploy Web Service**. Render will build and launch SupiriPOS PRO with instant global HTTPS!

---

## 📡 Core API Reference

### 🔐 Authentication
* `POST /api/auth/login` - Stealth universal login (intercepts Super Admin vs. Terminal Cashier).
* `POST /api/auth/unlock-business` - Stage 1 Terminal Unlock using Business Code & Master Password.
* `POST /api/auth/change-initial-credentials` - Mandatory first-time username/password update for new stores.
* `POST /api/auth/pos-logout` - Staff shift logout.

### ⚙️ Business Profile & Security OTP
* `POST /api/business/request-otp` - Generates and sends a 6-digit OTP code to the business owner via Resend HTTPS API.
* `POST /api/business/update-settings` - Applies store updates (name, address, phone, logo, footer) upon valid OTP verification.
* `POST /api/business/delete` - Permanently deletes business tenant and cascaded records upon OTP verification.

### 🎧 Support Tickets
* `POST /api/support/tickets` - Submits a support inquiry from logged-in POS or public landing page with automatic confirmation email.
* `GET /api/support/tickets?business_code={code}` - Lists tickets submitted by a specific business.
* `GET /api/admin/support/tickets` - Master Admin endpoint to view all system-wide tickets.
* `POST /api/admin/support/tickets/{id}/reply` - Super Admin replies to a ticket and automatically delivers the response to the user via Resend API.

### 👑 Master Admin Endpoints
* `GET /api/admin/overview` - Platform analytics & KPIs (Total Stores, Active, Suspended, Open Tickets).
* `GET /api/admin/businesses` - Searchable list of all registered business accounts.
* `POST /api/admin/businesses` - Create/provision a new store account directly.
* `PUT /api/admin/businesses/{id}` - Update business details, status (active/suspended), or reset password.
* `DELETE /api/admin/businesses/{id}` - Admin deletion of a business.
* `PUT /api/admin/profile` - Super Admin profile & password update (dynamically persisted to Supabase).

---

## 👥 Default Initial Credentials

| Role | Username / Identifier | Default Password | Notes |
| :--- | :--- | :--- | :--- |
| **Super Admin** | `admin@prasatek.lk` | `PrasaTek@2026` | Enter into Terminal Login form. Update immediately via Master Admin profile. |
| **New Business Initial Staff** | `user` | `123` | Mandatory change required on first login. |
| **Instant Demo Shop** | `PT-DEMO` | Pre-unlocked | 1-click test supermarket. |

---

## 📄 License & Credits
Developed and maintained by **PrasaTek System Solutions** &bull; Colombo, Sri Lanka.  
All Rights Reserved &copy; 2026.
