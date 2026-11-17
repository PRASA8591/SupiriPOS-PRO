"""
SupiriPOS PRO - Cloud Point of Sale Platform
Powered by PrasaTek System Solutions (https://pos.prasatek.lk)
Multi-Tenant Architecture with Real-Time Multi-Device WebSockets & Dual-Database Engine
"""

import os
import sys
import json
import random
import logging
import hashlib
import hmac
import urllib.parse
import threading
import requests
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Optional, Any

from fastapi import (
    FastAPI, WebSocket, WebSocketDisconnect, HTTPException,
    Depends, Request, Response, Query
)
from fastapi.middleware.cors import CORSMiddleware
# pyrefly: ignore[missing-import]
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from sqlalchemy import (
    create_engine, Column, Integer, String, Float,
    Boolean, Text, DateTime, desc, func, text
)
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Setup Logging & Configuration
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("SupiriPOS")

# Load environment variables (override=True forces fresh values from .env)
ENV_FILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
load_dotenv(dotenv_path=ENV_FILE_PATH, override=True)

DATABASE_URL = os.getenv("DATABASE_URL", "")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
SECRET_KEY = os.getenv("SECRET_KEY", "supiripos-prasatek-secret-key-2026")
# Resend HTTPS REST API Configuration (Port 443 HTTPS - 100% cloud-native)
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "").strip()
RESEND_FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL", "PrasaTek System Solutions <noreply@prasatek.lk>").strip()

if not RESEND_API_KEY:
    logger.warning("[RESEND CONFIG] RESEND_API_KEY is not set in environment or .env. Please configure RESEND_API_KEY for email delivery.")


def send_resend_email_detailed(to_email: str, subject: str, html_content: str, plain_text: str = "") -> tuple[bool, str]:
    """
    Sends an email using the Resend HTTPS REST API (https://api.resend.com/emails).
    Uses standard HTTPS Port 443 with Bearer token authentication.
    100% cloud-safe: completely eliminates SMTP timeouts, port restrictions, and handshake latency.
    """
    load_dotenv(dotenv_path=ENV_FILE_PATH, override=True)
    api_key = os.getenv("RESEND_API_KEY", RESEND_API_KEY).strip()
    from_email = os.getenv("RESEND_FROM_EMAIL", RESEND_FROM_EMAIL).strip()

    if not api_key:
        err_msg = "Missing RESEND_API_KEY in environment (.env)"
        logger.error(f"[RESEND ERROR] {err_msg}")
        return False, err_msg

    url = "https://api.resend.com/emails"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "from": from_email,
        "to": [to_email],
        "subject": subject,
        "html": html_content
    }
    if plain_text:
        payload["text"] = plain_text

    logger.info(
        f"[RESEND DISPATCH] Sending email to '{to_email}' from '{from_email}' | Subject: '{subject}'"
    )

    try:
        res = requests.post(url, json=payload, headers=headers, timeout=20)
        if res.status_code in (200, 201):
            res_data = res.json() if res.text else {}
            email_id = res_data.get("id", "ok")
            logger.info(
                f"[RESEND SUCCESS] Email successfully delivered to '{to_email}' via Resend API (ID: {email_id})!"
            )
            return True, ""
        else:
            err_detail = f"Resend API error ({res.status_code}): {res.text}"
            logger.error(f"[RESEND ERROR] Failed sending to '{to_email}' — {err_detail}")
            return False, err_detail
    except Exception as e:
        err_detail = f"Resend request exception: {type(e).__name__}: {e}"
        logger.error(f"[RESEND EXCEPTION] Failed sending to '{to_email}' — {err_detail}")
        return False, err_detail


def send_email_detailed(to_email: str, subject: str, html_content: str, plain_text: str = "") -> tuple[bool, str]:
    """Unified email dispatcher routing directly to Resend HTTPS REST API."""
    return send_resend_email_detailed(to_email, subject, html_content, plain_text)


def send_email_in_background(
    to_email: str,
    subject: str,
    html_content: str,
    plain_text: str = "",
    context_label: str = "Email"
) -> threading.Thread:
    """
    Fires Resend email delivery in a detached background daemon thread.
    Returns immediately (<2ms) so FastAPI endpoints respond instantly without waiting for network transmission.
    Logs all diagnostic results to the console.
    """
    def _worker():
        logger.info(f"[{context_label}] [BG-THREAD STARTED] Sending email to '{to_email}'...")
        ok, err = send_resend_email_detailed(to_email, subject, html_content, plain_text)
        if ok:
            logger.info(f"[{context_label}] [BG-THREAD SUCCESS] Email to '{to_email}' delivered successfully.")
        else:
            logger.error(f"[{context_label}] [BG-THREAD FAILED] Email to '{to_email}' failed: {err}")

    thread = threading.Thread(target=_worker, daemon=True, name=f"Email-{to_email}")
    thread.start()
    return thread


def send_smtp_email(to_email: str, subject: str, html_content: str, plain_text: str = "", background: bool = False) -> bool:
    """Backward-compatible wrapper routing to Resend API."""
    if background:
        send_email_in_background(to_email, subject, html_content, plain_text)
        return True
    ok, _ = send_resend_email_detailed(to_email, subject, html_content, plain_text)
    return ok


def send_email(to_email: str, subject: str, html_content: str, plain_text: str = "", background: bool = True):
    """Standard email dispatcher defaulting to non-blocking background delivery."""
    if background:
        return send_email_in_background(to_email, subject, html_content, plain_text)
    return send_smtp_email(to_email, subject, html_content, plain_text, background=False)

# ---------------------------------------------------------------------------
# Supabase Cloud Database Engine (via database.py)
# ---------------------------------------------------------------------------
from database import (
    Base, engine, SessionLocal, get_db,
    ACTIVE_DB_TYPE, DB_STATUS_NOTE, format_database_url
)

# ---------------------------------------------------------------------------
# Database Models (Strict Multi-Tenant Isolation by business_code)
# ---------------------------------------------------------------------------
class Business(Base):
    __tablename__ = "businesses"
    id = Column(Integer, primary_key=True, index=True)
    business_code = Column(String(30), unique=True, index=True, nullable=False)
    name = Column(String(200), nullable=False)
    owner_name = Column(String(150), nullable=False)
    email = Column(String(150), index=True, nullable=False)
    phone = Column(String(100), nullable=False)
    nic = Column(String(50), nullable=True)
    address = Column(Text, nullable=False)
    receipt_footer = Column(Text, default="Thank You! Come Again! / ස්තූතියි! නැවත එන්න!")
    logo_base64 = Column(Text, nullable=True)
    master_password_hash = Column(String(255), nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class SystemAdmin(Base):
    __tablename__ = "system_admins"
    id = Column(Integer, primary_key=True, index=True)
    admin_email = Column(String(150), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

class POSUser(Base):
    __tablename__ = "pos_users"
    id = Column(Integer, primary_key=True, index=True)
    business_code = Column(String(30), index=True, nullable=False)
    username = Column(String(100), index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(150), nullable=False)
    role_title = Column(String(100), default="Cashier")
    can_billing = Column(Boolean, default=True)
    can_items = Column(Boolean, default=True)
    can_stock = Column(Boolean, default=True)
    can_users = Column(Boolean, default=True)
    can_reports = Column(Boolean, default=True)
    must_change_password = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class Item(Base):
    __tablename__ = "items"
    id = Column(Integer, primary_key=True, index=True)
    business_code = Column(String(30), index=True, nullable=False)
    code = Column(String(100), index=True, nullable=False)  # Barcode / Item Code
    name = Column(String(250), nullable=False)
    category = Column(String(100), default="General")
    unit = Column(String(50), default="Pcs")  # Pcs, Kg, Ltr, Box, Packet
    cost_price = Column(Float, default=0.0)
    selling_price = Column(Float, default=0.0)
    stock_quantity = Column(Float, default=0.0)
    low_stock_level = Column(Float, default=5.0)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class StockLog(Base):
    __tablename__ = "stock_logs"
    id = Column(Integer, primary_key=True, index=True)
    business_code = Column(String(30), index=True, nullable=False)
    item_id = Column(Integer, index=True, nullable=False)
    item_code = Column(String(100), nullable=False)
    item_name = Column(String(250), nullable=False)
    log_type = Column(String(50), nullable=False)  # IN, OUT, SALE, VOID_RETURN
    quantity_change = Column(Float, nullable=False)
    previous_stock = Column(Float, default=0.0)
    new_stock = Column(Float, default=0.0)
    staff_username = Column(String(100), default="System")
    note = Column(Text, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)

class Invoice(Base):
    __tablename__ = "invoices"
    id = Column(Integer, primary_key=True, index=True)
    business_code = Column(String(30), index=True, nullable=False)
    invoice_number = Column(String(100), unique=True, index=True, nullable=False)
    date_time = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    cashier_username = Column(String(100), nullable=False)
    payment_method = Column(String(50), default="Cash")  # Cash, Card, QR, Credit
    subtotal = Column(Float, default=0.0)
    discount_amount = Column(Float, default=0.0)
    discount_percent = Column(Float, default=0.0)
    tax_amount = Column(Float, default=0.0)
    grand_total = Column(Float, default=0.0)
    cash_paid = Column(Float, default=0.0)
    balance_change = Column(Float, default=0.0)
    customer_name = Column(String(150), nullable=True)
    customer_phone = Column(String(50), nullable=True)
    status = Column(String(30), default="PAID")  # PAID, VOIDED
    items_json = Column(Text, nullable=False)  # JSON Array of items purchased
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)

class ActivityLog(Base):
    __tablename__ = "activity_logs"
    id = Column(Integer, primary_key=True, index=True)
    business_code = Column(String(30), index=True, nullable=False)
    username = Column(String(100), index=True, nullable=False)
    action_type = Column(String(50), index=True, nullable=False)
    details = Column(Text, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)

class OTPVerification(Base):
    __tablename__ = "otp_verifications"
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(150), index=True, nullable=False)
    otp_code = Column(String(10), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    is_verified = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class CreditCustomer(Base):
    __tablename__ = "credit_customers"
    id = Column(Integer, primary_key=True, index=True)
    business_code = Column(String(30), index=True, nullable=False)
    phone = Column(String(50), index=True, nullable=False)
    name = Column(String(150), nullable=False)
    address = Column(Text, default="")
    credit_balance = Column(Float, default=0.0)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

class CreditLedger(Base):
    __tablename__ = "credit_ledger"
    id = Column(Integer, primary_key=True, index=True)
    business_code = Column(String(30), index=True, nullable=False)
    customer_id = Column(Integer, index=True, nullable=False)
    customer_phone = Column(String(50), index=True, nullable=False)
    transaction_type = Column(String(40), index=True, nullable=False)  # CREDIT_SALE or PAYMENT_RECEIVED
    amount = Column(Float, default=0.0)
    balance_after = Column(Float, default=0.0)
    payment_method = Column(String(50), default="Cash")  # Cash, Card, Bank/QR, Invoice
    reference_note = Column(Text, default="")
    staff_user = Column(String(100), default="Admin")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)

class SupportTicket(Base):
    __tablename__ = "support_tickets"
    id = Column(Integer, primary_key=True, index=True)
    business_id = Column(Integer, nullable=True, index=True)
    business_code = Column(String(30), index=True, nullable=False)
    business_name = Column(String(150), nullable=True)
    owner_email = Column(String(150), nullable=True)
    owner_name = Column(String(150), nullable=True)
    phone = Column(String(50), nullable=True)
    category = Column(String(50), default="Technical Issue", index=True)
    priority = Column(String(30), default="Normal", index=True)
    subject = Column(String(250), nullable=False)
    message = Column(Text, nullable=False)
    attachment_name = Column(String(255), nullable=True)
    attachment_data = Column(Text, nullable=True)
    status = Column(String(30), default="open", index=True)  # open, resolved
    admin_reply = Column(Text, nullable=True)
    replied_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

# Create tables & perform safe migrations
try:
    Base.metadata.create_all(bind=engine)
    logger.info("[DB] All database tables verified / created successfully.")
    
    # Safe column migration check for pos_users, businesses, and support_tickets
    with engine.connect() as conn:
        try:
            if engine.dialect.name == "sqlite":
                res = conn.execute(text("PRAGMA table_info(pos_users)")).fetchall()
                cols = [r[1] for r in res]
                if "must_change_password" not in cols:
                    conn.execute(text("ALTER TABLE pos_users ADD COLUMN must_change_password BOOLEAN DEFAULT 0"))
                    conn.commit()

                b_res = conn.execute(text("PRAGMA table_info(businesses)")).fetchall()
                b_cols = [r[1] for r in b_res]
                if "is_active" not in b_cols:
                    conn.execute(text("ALTER TABLE businesses ADD COLUMN is_active BOOLEAN DEFAULT 1"))
                    conn.commit()

                s_res = conn.execute(text("PRAGMA table_info(support_tickets)")).fetchall()
                s_cols = [r[1] for r in s_res]
                if "phone" not in s_cols:
                    conn.execute(text("ALTER TABLE support_tickets ADD COLUMN phone VARCHAR(50)"))
                if "category" not in s_cols:
                    conn.execute(text("ALTER TABLE support_tickets ADD COLUMN category VARCHAR(50) DEFAULT 'Technical Issue'"))
                if "priority" not in s_cols:
                    conn.execute(text("ALTER TABLE support_tickets ADD COLUMN priority VARCHAR(30) DEFAULT 'Normal'"))
                if "attachment_name" not in s_cols:
                    conn.execute(text("ALTER TABLE support_tickets ADD COLUMN attachment_name VARCHAR(255)"))
                if "attachment_data" not in s_cols:
                    conn.execute(text("ALTER TABLE support_tickets ADD COLUMN attachment_data TEXT"))
                conn.commit()
            else:
                conn.execute(text("ALTER TABLE pos_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE"))
                conn.execute(text("ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE"))
                conn.execute(text("ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS phone VARCHAR(50)"))
                conn.execute(text("ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'Technical Issue'"))
                conn.execute(text("ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS priority VARCHAR(30) DEFAULT 'Normal'"))
                conn.execute(text("ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255)"))
                conn.execute(text("ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS attachment_data TEXT"))
                conn.commit()
        except Exception as mig_err:
            logger.info(f"[DB] Migration check: {mig_err}")
except Exception as e:
    logger.error(f"[DB ERROR] Error creating tables: {e}")

def log_activity(db: Session, business_code: str, username: str, action_type: str, details: str):
    """Utility helper to record an enterprise activity audit log entry"""
    try:
        act = ActivityLog(
            business_code=business_code,
            username=username or "System",
            action_type=action_type,
            details=details,
            created_at=datetime.now(timezone.utc)
        )
        db.add(act)
        db.commit()
    except Exception as e:
        logger.warning(f"[LOG ERROR] Failed to record activity log: {e}")

# ---------------------------------------------------------------------------
# Password Hashing Helpers
# ---------------------------------------------------------------------------
def hash_password(password: str) -> str:
    """Simple robust SHA-256 with project salt for multi-tenant passwords"""
    salt = "prasatek_supiripos_salt_"
    return hashlib.sha256((salt + password).encode('utf-8')).hexdigest()

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return hash_password(plain_password) == hashed_password

# ---------------------------------------------------------------------------
# Super Admin Authentication & Signed Token Helpers
# ---------------------------------------------------------------------------
def generate_admin_token(admin_email: str) -> str:
    clean_email = admin_email.strip().lower()
    timestamp = int(datetime.now(timezone.utc).timestamp())
    raw = f"{clean_email}:{timestamp}:{SECRET_KEY}"
    sig = hashlib.sha256(raw.encode('utf-8')).hexdigest()
    return f"{clean_email}:{timestamp}:{sig}"

def verify_admin_token(token: str) -> Optional[str]:
    try:
        parts = token.split(":")
        if len(parts) != 3:
            return None
        email, ts_str, sig = parts
        ts = int(ts_str)
        now_ts = int(datetime.now(timezone.utc).timestamp())
        if now_ts - ts > 7 * 86400 or now_ts < ts - 60:
            return None
        raw = f"{email}:{ts_str}:{SECRET_KEY}"
        expected_sig = hashlib.sha256(raw.encode('utf-8')).hexdigest()
        if hmac.compare_digest(sig, expected_sig):
            return email
        return None
    except Exception:
        return None

def get_current_admin(request: Request, db: Session = Depends(get_db)) -> SystemAdmin:
    auth_header = request.headers.get("Authorization", "")
    token = ""
    if auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
    elif "x-admin-token" in request.headers:
        token = request.headers["x-admin-token"].strip()

    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized: Super Admin access required.")

    admin_email = verify_admin_token(token)
    if not admin_email:
        raise HTTPException(status_code=401, detail="Invalid or expired Super Admin token.")

    admin = db.query(SystemAdmin).filter(func.lower(SystemAdmin.admin_email) == admin_email.lower()).first()
    if not admin:
        raise HTTPException(status_code=401, detail="Super Admin account not found.")

    return admin

# ---------------------------------------------------------------------------
# Real-Time WebSocket Multi-Device Synchronization Manager
# ---------------------------------------------------------------------------
class RealtimeConnectionManager:
    """
    Maintains active WebSocket connections grouped strictly by business_code.
    Broadcasts real-time events to all active devices logged into that business.
    """
    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {}
        self.business_version: Dict[str, int] = {}

    async def connect(self, websocket: WebSocket, business_code: str):
        await websocket.accept()
        if business_code not in self.active_connections:
            self.active_connections[business_code] = []
        self.active_connections[business_code].append(websocket)
        logger.info(f"[WS] Client connected for {business_code}. Active count: {len(self.active_connections[business_code])}")

    def disconnect(self, websocket: WebSocket, business_code: str):
        if business_code in self.active_connections:
            if websocket in self.active_connections[business_code]:
                self.active_connections[business_code].remove(websocket)
            if not self.active_connections[business_code]:
                del self.active_connections[business_code]
        logger.info(f"[WS] Client disconnected from {business_code}")

    async def broadcast(self, business_code: str, message: dict):
        # Increment version for polling fallback clients
        self.business_version[business_code] = self.business_version.get(business_code, 0) + 1
        message["version"] = self.business_version[business_code]
        message["timestamp"] = datetime.now(timezone.utc).isoformat()

        if business_code in self.active_connections:
            dead_connections = []
            for connection in self.active_connections[business_code]:
                try:
                    await connection.send_json(message)
                except Exception as e:
                    dead_connections.append(connection)
            for dead in dead_connections:
                self.disconnect(dead, business_code)

ws_manager = RealtimeConnectionManager()

# ---------------------------------------------------------------------------
# Demo Supermarket Auto-Seeding (PT-DEMO)
# ---------------------------------------------------------------------------
def seed_demo_supermarket(db: Session):
    """
    Pre-populates the instant Demo Supermarket (PT-DEMO) with Sri Lankan items,
    realistic stock counts, sample sales invoices, and default staff credentials.
    """
    demo_biz = db.query(Business).filter(Business.business_code == "PT-DEMO").first()
    if not demo_biz:
        logger.info("[SEED] Seeding Demo Supermarket (PT-DEMO)...")
        demo_biz = Business(
            business_code="PT-DEMO",
            name="Supiri Mart Supermarket (Colombo 07)",
            owner_name="Prasanna Fernando",
            email="demo@prasatek.lk",
            phone="+94 11 234 5678 / +94 77 123 4567",
            nic="198512345678",
            address="No. 45/A, Galle Road, Colombo 03, Sri Lanka",
            receipt_footer="Thank You for Shopping at Supiri Mart! / ස්තූතියි! නැවත එන්න!",
            logo_base64="/assets/logo.png",
            master_password_hash=hash_password("123")
        )
        db.add(demo_biz)
        db.commit()

        # Create Default Staff User
        demo_user = POSUser(
            business_code="PT-DEMO",
            username="user",
            password_hash=hash_password("123"),
            full_name="Supiri Admin",
            role_title="Store Manager / Senior Cashier",
            can_billing=True,
            can_items=True,
            can_stock=True,
            can_users=True,
            can_reports=True
        )
        db.add(demo_user)

        # Seed Authentic Sri Lankan Retail Items
        sample_items = [
            ("001", "Keeri Samba Rice 5kg", "Groceries", "Pcs", 1150.0, 1350.0, 45.0, 10.0),
            ("002", "Anchor Full Cream Milk Powder 400g", "Dairy", "Pcs", 980.0, 1120.0, 60.0, 15.0),
            ("003", "Munchee Super Cream Cracker 500g", "Snacks", "Pcs", 380.0, 450.0, 85.0, 15.0),
            ("004", "Maliban Lemon Puff 200g", "Snacks", "Pcs", 210.0, 260.0, 70.0, 15.0),
            ("005", "Dilmah Premium Ceylon Tea 200g", "Beverages", "Pcs", 520.0, 640.0, 35.0, 10.0),
            ("006", "Sunlight Lemon Fresh Soap 115g", "Household", "Pcs", 110.0, 140.0, 120.0, 20.0),
            ("007", "Clogard Herbal Toothpaste 120g", "Personal Care", "Pcs", 190.0, 240.0, 40.0, 10.0),
            ("008", "Fortune Pure Coconut Oil 1L", "Groceries", "Ltr", 680.0, 790.0, 25.0, 5.0),
            ("009", "Elephant House Ginger Beer (EGB) 500ml", "Beverages", "Pcs", 180.0, 220.0, 50.0, 12.0),
            ("010", "Maggi 2-Minute Chicken Noodles 73g", "Groceries", "Packet", 130.0, 160.0, 110.0, 25.0),
            ("011", "DSI Classic Hawai Slippers", "Apparel", "Pcs", 550.0, 750.0, 18.0, 5.0),
            ("012", "Red Dhal (Mysore Parippu) 1kg", "Groceries", "Kg", 290.0, 340.0, 65.0, 15.0),
            ("013", "White Crystal Sugar 1kg", "Groceries", "Kg", 240.0, 275.0, 80.0, 20.0),
            ("014", "Prima All-Purpose Flour 1kg", "Groceries", "Packet", 210.0, 250.0, 4.0, 10.0), # Low stock
            ("015", "Harischandra Pure Coffee 100g", "Beverages", "Packet", 270.0, 320.0, 0.0, 8.0), # Out of stock
        ]

        created_items = []
        for code, name, cat, unit, cost, price, stock, low in sample_items:
            item = Item(
                business_code="PT-DEMO",
                code=code,
                name=name,
                category=cat,
                unit=unit,
                cost_price=cost,
                selling_price=price,
                stock_quantity=stock,
                low_stock_level=low
            )
            db.add(item)
            created_items.append(item)

        db.commit()

        # Seed initial stock logs
        for item in created_items:
            if item.stock_quantity > 0:
                log = StockLog(
                    business_code="PT-DEMO",
                    item_id=item.id,
                    item_code=item.code,
                    item_name=item.name,
                    log_type="IN",
                    quantity_change=item.stock_quantity,
                    previous_stock=0.0,
                    new_stock=item.stock_quantity,
                    staff_username="user",
                    note="Initial Inventory Stock In"
                )
                db.add(log)

        # Seed realistic past sales invoices for reports
        today = datetime.now(timezone.utc)
        yesterday = today - timedelta(days=1)

        sample_invoices = [
            {
                "inv_no": "INV-DEMO-001",
                "dt": yesterday.replace(hour=10, minute=30),
                "items": [
                    {"item_id": 1, "code": "001", "name": "Keeri Samba Rice 5kg", "unit": "Pcs", "cost_price": 1150.0, "selling_price": 1350.0, "quantity": 1, "discount": 0.0, "total": 1350.0},
                    {"item_id": 3, "code": "003", "name": "Munchee Super Cream Cracker 500g", "unit": "Pcs", "cost_price": 380.0, "selling_price": 450.0, "quantity": 2, "discount": 0.0, "total": 900.0}
                ],
                "subtotal": 2250.0, "discount": 50.0, "grand_total": 2200.0, "cash_paid": 2500.0, "change": 300.0, "method": "Cash"
            },
            {
                "inv_no": "INV-DEMO-002",
                "dt": yesterday.replace(hour=15, minute=45),
                "items": [
                    {"item_id": 2, "code": "002", "name": "Anchor Full Cream Milk Powder 400g", "unit": "Pcs", "cost_price": 980.0, "selling_price": 1120.0, "quantity": 1, "discount": 0.0, "total": 1120.0},
                    {"item_id": 5, "code": "005", "name": "Dilmah Premium Ceylon Tea 200g", "unit": "Pcs", "cost_price": 520.0, "selling_price": 640.0, "quantity": 1, "discount": 0.0, "total": 640.0}
                ],
                "subtotal": 1760.0, "discount": 0.0, "grand_total": 1760.0, "cash_paid": 1760.0, "change": 0.0, "method": "Card"
            },
            {
                "inv_no": "INV-DEMO-003",
                "dt": today.replace(hour=9, minute=15),
                "items": [
                    {"item_id": 8, "code": "008", "name": "Fortune Pure Coconut Oil 1L", "unit": "Ltr", "cost_price": 680.0, "selling_price": 790.0, "quantity": 2, "discount": 0.0, "total": 1580.0},
                    {"item_id": 12, "code": "012", "name": "Red Dhal (Mysore Parippu) 1kg", "unit": "Kg", "cost_price": 290.0, "selling_price": 340.0, "quantity": 2, "discount": 0.0, "total": 680.0},
                    {"item_id": 13, "code": "013", "name": "White Crystal Sugar 1kg", "unit": "Kg", "cost_price": 240.0, "selling_price": 275.0, "quantity": 3, "discount": 0.0, "total": 825.0}
                ],
                "subtotal": 3085.0, "discount": 85.0, "grand_total": 3000.0, "cash_paid": 5000.0, "change": 2000.0, "method": "Cash"
            }
        ]

        for sinv in sample_invoices:
            inv = Invoice(
                business_code="PT-DEMO",
                invoice_number=sinv["inv_no"],
                date_time=sinv["dt"],
                cashier_username="user",
                payment_method=sinv["method"],
                subtotal=sinv["subtotal"],
                discount_amount=sinv["discount"],
                discount_percent=0.0,
                tax_amount=0.0,
                grand_total=sinv["grand_total"],
                cash_paid=sinv["cash_paid"],
                balance_change=sinv["change"],
                status="PAID",
                items_json=json.dumps(sinv["items"])
            )
            db.add(inv)

        db.commit()
        logger.info("[SEED] Demo Supermarket PT-DEMO seeded successfully!")

    # Seed sample Credit Customers for PT-DEMO if none exist yet
    try:
        existing_cust_count = db.query(CreditCustomer).filter(CreditCustomer.business_code == "PT-DEMO").count()
        if existing_cust_count == 0:
            now_dt = datetime.now(timezone.utc)
            c1 = CreditCustomer(
                business_code="PT-DEMO",
                phone="0771234567",
                name="Nimal Perera",
                address="No. 18, Temple Road, Mount Lavinia",
                credit_balance=2450.0,
                created_at=now_dt - timedelta(days=5),
                updated_at=now_dt - timedelta(days=1)
            )
            c2 = CreditCustomer(
                business_code="PT-DEMO",
                phone="0719876543",
                name="Kamani Jayawardena",
                address="42/B, Station Road, Dehiwala",
                credit_balance=1350.0,
                created_at=now_dt - timedelta(days=3),
                updated_at=now_dt - timedelta(hours=6)
            )
            c3 = CreditCustomer(
                business_code="PT-DEMO",
                phone="0765554433",
                name="Ruwan Bandara",
                address="No. 9, High Level Road, Nugegoda",
                credit_balance=0.0,
                created_at=now_dt - timedelta(days=7),
                updated_at=now_dt - timedelta(days=2)
            )
            db.add_all([c1, c2, c3])
            db.commit()
            db.refresh(c1)
            db.refresh(c2)
            db.refresh(c3)

            db.add_all([
                CreditLedger(
                    business_code="PT-DEMO",
                    customer_id=c1.id,
                    customer_phone=c1.phone,
                    transaction_type="CREDIT_SALE",
                    amount=3450.0,
                    balance_after=3450.0,
                    payment_method="Invoice",
                    reference_note="Credit Bill #INV-PT-DEMO-CR01",
                    staff_user="Supiri Admin",
                    created_at=now_dt - timedelta(days=2)
                ),
                CreditLedger(
                    business_code="PT-DEMO",
                    customer_id=c1.id,
                    customer_phone=c1.phone,
                    transaction_type="PAYMENT_RECEIVED",
                    amount=1000.0,
                    balance_after=2450.0,
                    payment_method="Cash",
                    reference_note="Partial Cash Settlement",
                    staff_user="Supiri Admin",
                    created_at=now_dt - timedelta(hours=3)
                ),
                CreditLedger(
                    business_code="PT-DEMO",
                    customer_id=c2.id,
                    customer_phone=c2.phone,
                    transaction_type="CREDIT_SALE",
                    amount=1350.0,
                    balance_after=1350.0,
                    payment_method="Invoice",
                    reference_note="Credit Bill #INV-PT-DEMO-CR02",
                    staff_user="Supiri Admin",
                    created_at=now_dt - timedelta(hours=6)
                )
            ])
            db.commit()
    except Exception as seed_cr_err:
        logger.warning(f"[SEED CREDIT] {seed_cr_err}")

def seed_system_admin(db: Session):
    """
    Ensures at least one Super Admin exists in system_admins table.
    Default: admin@prasatek.lk / PrasaTek@2026
    """
    try:
        count = db.query(SystemAdmin).count()
        if count == 0:
            default_admin = SystemAdmin(
                admin_email="admin@prasatek.lk",
                password_hash=hash_password("PrasaTek@2026")
            )
            db.add(default_admin)
            db.commit()
            logger.info("[ADMIN SEED] Default Super Admin account seeded: admin@prasatek.lk")
    except Exception as e:
        logger.warning(f"[ADMIN SEED WARNING] Could not seed default admin: {e}")

# Initialize Demo Shop & Super Admin in DB
try:
    with SessionLocal() as db_session:
        seed_demo_supermarket(db_session)
        seed_system_admin(db_session)
except Exception as seed_err:
    logger.warning(f"[SEED WARNING] Seed check: {seed_err}")

# ---------------------------------------------------------------------------
# FastAPI App Initialization
# ---------------------------------------------------------------------------
app = FastAPI(
    title="SupiriPOS PRO",
    description="Commercial-Grade Multi-Tenant Cloud POS Web Application Powered by PrasaTek System Solutions",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Helper: Business Code Generation
# ---------------------------------------------------------------------------
def generate_next_business_code(db: Session) -> str:
    """Generates sequential codes: PT-00001, PT-00002, etc."""
    all_codes = db.query(Business.business_code).filter(
        Business.business_code.like("PT-%"),
        Business.business_code != "PT-DEMO"
    ).all()
    
    max_num = 0
    for (b_code,) in all_codes:
        parts = b_code.split("-")
        if len(parts) == 2 and parts[1].isdigit():
            num = int(parts[1])
            if num > max_num:
                max_num = num
                
    next_num = max_num + 1
    return f"PT-{next_num:05d}"

# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------
class SendOTPRequest(BaseModel):
    email: str

class VerifyOTPRequest(BaseModel):
    email: str
    otp_code: str

class RegisterBusinessRequest(BaseModel):
    email: str
    master_password: str
    owner_name: str
    phone: str
    nic: Optional[str] = ""
    shop_name: str
    address: str
    receipt_footer: Optional[str] = "Thank You! Come Again! / ස්තූතියි! නැවත එන්න!"
    logo_base64: Optional[str] = ""

class UnlockBusinessRequest(BaseModel):
    business_code: str
    business_password: str

class POSLoginRequest(BaseModel):
    business_code: str
    username: str
    password: str

class StealthLoginRequest(BaseModel):
    username: str
    password: str
    business_code: Optional[str] = None

class AdminCreateBusinessRequest(BaseModel):
    name: str
    owner_name: str
    email: str
    phone: str
    address: str
    master_password: str
    nic: Optional[str] = ""
    terminal_username: Optional[str] = "user"
    terminal_password: Optional[str] = "123"
    business_code: Optional[str] = None
    is_active: Optional[bool] = True

class AdminUpdateBusinessRequest(BaseModel):
    name: Optional[str] = None
    owner_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    nic: Optional[str] = None
    is_active: Optional[bool] = None
    master_password: Optional[str] = None
    terminal_password: Optional[str] = None

class AdminProfileUpdateRequest(BaseModel):
    new_email: Optional[str] = None
    current_password: str
    new_password: Optional[str] = None

class ItemCreateUpdateRequest(BaseModel):
    business_code: str
    code: str
    name: str
    category: str = "General"
    unit: str = "Pcs"
    cost_price: float = 0.0
    selling_price: float = 0.0
    stock_quantity: Optional[float] = 0.0
    low_stock_level: float = 5.0

class StockAdjustRequest(BaseModel):
    business_code: str
    item_id: int
    adjust_type: str  # "IN" or "OUT"
    quantity: float
    staff_username: str = "Staff"
    note: Optional[str] = ""

class CartItemModel(BaseModel):
    item_id: int
    code: str
    name: str
    unit: str = "Pcs"
    cost_price: float = 0.0
    selling_price: float = 0.0
    quantity: float = 1.0
    discount: float = 0.0
    total: float = 0.0

class CreateInvoiceRequest(BaseModel):
    business_code: str
    cashier_username: str
    payment_method: str = "Cash"
    subtotal: float
    discount_amount: float = 0.0
    discount_percent: float = 0.0
    tax_amount: float = 0.0
    grand_total: float
    cash_paid: float
    balance_change: float
    customer_id: Optional[int] = None
    customer_name: Optional[str] = ""
    customer_phone: Optional[str] = ""
    customer_address: Optional[str] = ""
    items: List[CartItemModel]

class CreateCreditCustomerRequest(BaseModel):
    business_code: str
    phone: str
    name: str
    address: Optional[str] = ""
    staff_user: Optional[str] = "Admin"

class PayCreditRequest(BaseModel):
    business_code: str
    customer_id: int
    amount_paid: float
    payment_method: str = "Cash"
    note: Optional[str] = ""
    staff_user: Optional[str] = "Admin"

class UserCreateUpdateRequest(BaseModel):
    business_code: str
    username: str
    password: Optional[str] = None
    full_name: str
    role_title: str = "Cashier"
    can_billing: bool = True
    can_items: bool = True
    can_stock: bool = True
    can_users: bool = True
    can_reports: bool = True

class ChangeInitialCredentialsRequest(BaseModel):
    business_code: str
    user_id: Optional[int] = None
    current_username: Optional[str] = "user"
    current_password: Optional[str] = "123"
    new_username: str
    new_password: str
    new_full_name: Optional[str] = None
    full_name: Optional[str] = None

class BusinessRequestOTPRequest(BaseModel):
    business_code: str
    action: str = "UPDATE_SETTINGS"  # "UPDATE_SETTINGS" or "DELETE_BUSINESS"

class BusinessUpdateSettingsRequest(BaseModel):
    business_code: str
    otp_code: str
    name: str
    owner_name: Optional[str] = None
    phone: str
    address: str
    receipt_footer: Optional[str] = None
    logo_base64: Optional[str] = None

class BusinessDeleteRequest(BaseModel):
    business_code: str
    otp_code: str

class SupportTicketCreateRequest(BaseModel):
    business_code: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    name: Optional[str] = None
    category: Optional[str] = "Technical Issue"
    priority: Optional[str] = "Normal"
    subject: str
    message: str
    attachment_name: Optional[str] = None
    attachment_data: Optional[str] = None

class AdminTicketReplyRequest(BaseModel):
    reply_message: Optional[str] = None
    reply: Optional[str] = None
    status: Optional[str] = "resolved"

class LogoutRequest(BaseModel):
    business_code: str
    username: str

# ---------------------------------------------------------------------------
# Health & Status Endpoints
# ---------------------------------------------------------------------------
@app.get("/ping")
def ping():
    return {"status": "pong", "time": datetime.now(timezone.utc).isoformat()}

@app.get("/api/health")
def health(db: Session = Depends(get_db)):
    db_alive = True
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        db_alive = False
        
    return {
        "status": "healthy" if db_alive else "degraded",
        "app": "SupiriPOS PRO",
        "provider": "PrasaTek System Solutions",
        "database_type": ACTIVE_DB_TYPE,
        "database_mode": "SUPABASE CLOUD ONLINE",
        "database_alive": db_alive,
        "note": DB_STATUS_NOTE,
        "time": datetime.now(timezone.utc).isoformat()
    }

# ---------------------------------------------------------------------------
# Real-Time WebSocket Endpoint
# ---------------------------------------------------------------------------
@app.websocket("/ws/{business_code}")
async def websocket_endpoint(websocket: WebSocket, business_code: str):
    await ws_manager.connect(websocket, business_code)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                # If client sent a ping, reply with pong
                if msg.get("type") == "PING":
                    await websocket.send_json({"type": "PONG", "timestamp": datetime.now(timezone.utc).isoformat()})
            except Exception:
                pass
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket, business_code)
    except Exception as e:
        logger.error(f"[WS ERROR] {e}")
        ws_manager.disconnect(websocket, business_code)

def _normalize_phone(phone_str: str) -> str:
    """Normalize phone number for fast matching while preserving original formatting"""
    if not phone_str:
        return ""
    digits = "".join(ch for ch in str(phone_str) if ch.isdigit())
    # Normalize +9477... -> 077... for Sri Lankan numbers
    if digits.startswith("94") and len(digits) == 11:
        digits = "0" + digits[2:]
    return digits or str(phone_str).strip()

def _build_credit_customers_payload(db: Session, business_code: str):
    customers = db.query(CreditCustomer).filter(
        CreditCustomer.business_code == business_code
    ).order_by(desc(CreditCustomer.credit_balance), CreditCustomer.name.asc()).all()

    recent_ledger = db.query(CreditLedger).filter(
        CreditLedger.business_code == business_code
    ).order_by(desc(CreditLedger.created_at)).limit(100).all()

    # Map customer_id -> latest ledger entry
    last_tx_map = {}
    for entry in recent_ledger:
        if entry.customer_id not in last_tx_map:
            last_tx_map[entry.customer_id] = {
                "id": entry.id,
                "transaction_type": entry.transaction_type,
                "amount": round(float(entry.amount or 0.0), 2),
                "balance_after": round(float(entry.balance_after or 0.0), 2),
                "payment_method": entry.payment_method or "Cash",
                "reference_note": entry.reference_note or "",
                "staff_user": entry.staff_user or "Admin",
                "created_at": entry.created_at.isoformat() if entry.created_at else ""
            }

    customers_list = []
    for c in customers:
        last_tx = last_tx_map.get(c.id)
        customers_list.append({
            "id": c.id,
            "business_code": c.business_code,
            "phone": c.phone,
            "phone_normalized": _normalize_phone(c.phone),
            "name": c.name,
            "address": c.address or "",
            "credit_balance": round(float(c.credit_balance or 0.0), 2),
            "created_at": c.created_at.isoformat() if c.created_at else "",
            "updated_at": c.updated_at.isoformat() if c.updated_at else "",
            "last_transaction": last_tx
        })

    ledger_list = [{
        "id": l.id,
        "business_code": l.business_code,
        "customer_id": l.customer_id,
        "customer_phone": l.customer_phone,
        "transaction_type": l.transaction_type,
        "amount": round(float(l.amount or 0.0), 2),
        "balance_after": round(float(l.balance_after or 0.0), 2),
        "payment_method": l.payment_method or "Cash",
        "reference_note": l.reference_note or "",
        "staff_user": l.staff_user or "Admin",
        "created_at": l.created_at.isoformat() if l.created_at else ""
    } for l in recent_ledger]

    return customers_list, ledger_list

@app.get("/api/sync/state")
def get_sync_state(business_code: str, db: Session = Depends(get_db)):
    """Fast polling fallback with delta state tracking + instant credit customer cache"""
    items_count = db.query(Item).filter(Item.business_code == business_code).count()
    invoices_count = db.query(Invoice).filter(Invoice.business_code == business_code).count()
    ledger_count = db.query(CreditLedger).filter(CreditLedger.business_code == business_code).count()
    customers_list, ledger_list = _build_credit_customers_payload(db, business_code)
    version_num = ws_manager.business_version.get(business_code, 1)
    state_ver = f"v{version_num}_i{items_count}_inv{invoices_count}_cr{len(customers_list)}_lg{ledger_count}"
    return {
        "business_code": business_code,
        "version": version_num,
        "state_version": state_ver,
        "items_count": items_count,
        "invoices_count": invoices_count,
        "credit_customers": customers_list,
        "credit_ledger": ledger_list,
        "server_time": datetime.now(timezone.utc).isoformat()
    }

# ---------------------------------------------------------------------------
# Auth Gateways: OTP, Registration, Unlock & POS Login
# ---------------------------------------------------------------------------
@app.post("/api/auth/send-otp")
def send_otp(req: SendOTPRequest, db: Session = Depends(get_db)):
    load_dotenv(dotenv_path=ENV_FILE_PATH, override=True)
    email_clean = req.email.strip().lower()
    if not email_clean or "@" not in email_clean:
        raise HTTPException(status_code=400, detail="Invalid email address.")

    otp = f"{random.randint(100000, 999999)}"
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=10)

    # Save to DB
    otp_record = OTPVerification(
        email=email_clean,
        otp_code=otp,
        expires_at=expires_at,
        is_verified=False
    )
    db.add(otp_record)
    db.commit()

    sender_from_name = "PrasaTek System Solutions"

    html_content = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SupiriPOS PRO Verification Code</title>
    </head>
    <body style="margin: 0; padding: 30px 15px; background-color: #0b1120; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f8fafc;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 540px; margin: 0 auto; background-color: #0f172a; border-radius: 16px; border: 1px solid #1e293b; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);">
            <tr>
                <td style="padding: 32px 28px 24px 28px; text-align: left;">
                    <div style="margin-bottom: 4px;">
                        <span style="font-size: 24px; font-weight: 800; color: #10b981; letter-spacing: -0.5px;">SupiriPOS <span style="color: #38bdf8;">PRO</span></span>
                    </div>
                    <p style="margin: 0 0 16px 0; font-size: 13px; color: #94a3b8; font-weight: 500;">Next-Gen Cloud Point of Sale System</p>
                    <div style="height: 1px; width: 100%; background: linear-gradient(90deg, #10b981 0%, rgba(16, 185, 129, 0.1) 100%); margin-bottom: 24px;"></div>
                    
                    <h2 style="margin: 0 0 10px 0; font-size: 20px; font-weight: 700; color: #f8fafc;">Verify Your Business Email</h2>
                    <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #cbd5e1;">
                        Thank you for choosing SupiriPOS PRO. Please use the 6-digit verification code below to verify your email and complete your store registration.
                    </p>

                    <div style="background: #1e293b; border: 1.5px dashed #10b981; border-radius: 12px; padding: 22px 16px; text-align: center; margin: 24px 0;">
                        <span style="font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #10b981; display: block; margin-bottom: 6px;">Single-Use Verification Code</span>
                        <div style="font-size: 40px; font-weight: 800; letter-spacing: 8px; color: #ffffff; font-family: 'Courier New', Courier, monospace; margin: 4px 0; text-shadow: 0 2px 10px rgba(16, 185, 129, 0.3);">{otp}</div>
                        <p style="margin: 6px 0 0 0; font-size: 12px; color: #94a3b8;">⏱ Code expires in <strong style="color: #f1f5f9;">10 minutes</strong>. Never share this code.</p>
                    </div>

                    <p style="font-size: 13px; color: #64748b; line-height: 1.5; margin: 0 0 24px 0;">
                        If you did not request this verification code, please ignore this email or contact our support team.
                    </p>

                    <div style="border-top: 1px solid #1e293b; padding-top: 20px; text-align: center;">
                        <p style="margin: 0 0 6px 0; font-size: 13px; font-weight: 700; color: #f1f5f9;">PrasaTek System Solutions</p>
                        <p style="margin: 0 0 6px 0; font-size: 12px; color: #94a3b8;">
                            <a href="https://www.prasatek.lk" style="color: #10b981; text-decoration: none; font-weight: 600;">www.prasatek.lk</a>
                            &nbsp;&bull;&nbsp;
                            <a href="mailto:info@prasatek.lk" style="color: #38bdf8; text-decoration: none;">info@prasatek.lk</a>
                        </p>
                        <p style="margin: 0; font-size: 11px; color: #64748b; font-style: italic;">Smart POS &amp; Enterprise Software Solutions — Sri Lanka</p>
                    </div>
                </td>
            </tr>
        </table>
    </body>
    </html>
    """
    plain_text = (
        f"SupiriPOS PRO — Next-Gen Cloud POS\n\n"
        f"Your 6-Digit Business Verification Code: {otp}\n"
        f"This code will expire in 10 minutes.\n\n"
        f"If you did not request this code, please ignore this email.\n\n"
        f"----------------------------------------\n"
        f"PrasaTek System Solutions\n"
        f"Website: https://www.prasatek.lk\n"
        f"Support: info@prasatek.lk\n"
        f"Smart POS & Enterprise Software Solutions — Sri Lanka\n"
    )

    # Non-blocking: fire the email in a background daemon thread so the API
    # responds instantly (<30ms) and never times out on Render cloud hosting.
    send_email_in_background(
        to_email=email_clean,
        subject=f"Your SupiriPOS PRO Verification Code: {otp}",
        html_content=html_content,
        plain_text=plain_text,
        context_label="OTP-VERIFY"
    )

    return {
        "success": True,
        "email_sent": True,
        "message": f"A 6-digit verification code has been sent to {email_clean}. Please check your email inbox."
    }

@app.post("/api/auth/verify-otp")
def verify_otp(req: VerifyOTPRequest, db: Session = Depends(get_db)):
    email_clean = req.email.strip().lower()
    record = db.query(OTPVerification).filter(
        OTPVerification.email == email_clean,
        OTPVerification.otp_code == req.otp_code.strip(),
        OTPVerification.is_verified == False
    ).order_by(desc(OTPVerification.created_at)).first()

    if not record:
        raise HTTPException(status_code=400, detail="Invalid OTP code. Please check and try again.")

    # Check expiry
    # Normalize datetime comparison
    now = datetime.now(timezone.utc)
    exp = record.expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)

    if now > exp:
        raise HTTPException(status_code=400, detail="OTP code has expired. Please request a new one.")

    record.is_verified = True
    db.commit()
    return {"success": True, "message": "Email verified successfully."}

@app.post("/api/auth/register-business")
def register_business(req: RegisterBusinessRequest, db: Session = Depends(get_db)):
    email_clean = req.email.strip().lower()
    
    # Generate sequential business code: PT-00001, PT-00002...
    business_code = generate_next_business_code(db)

    # Use default logo if not provided
    logo_val = req.logo_base64 if req.logo_base64 else "/assets/logo.png"

    # Create Business
    new_biz = Business(
        business_code=business_code,
        name=req.shop_name.strip(),
        owner_name=req.owner_name.strip(),
        email=email_clean,
        phone=req.phone.strip(),
        nic=req.nic.strip() if req.nic else "",
        address=req.address.strip(),
        receipt_footer=req.receipt_footer.strip() if req.receipt_footer else "Thank You! Come Again! / ස්තූතියි! නැවත එන්න!",
        logo_base64=logo_val,
        master_password_hash=hash_password(req.master_password)
    )
    db.add(new_biz)
    db.commit()
    db.refresh(new_biz)

    # Create default staff user: user / 123
    default_user = POSUser(
        business_code=business_code,
        username="user",
        password_hash=hash_password("123"),
        full_name="Default Admin",
        role_title="Store Manager",
        can_billing=True,
        can_items=True,
        can_stock=True,
        can_users=True,
        can_reports=True,
        must_change_password=True
    )
    db.add(default_user)
    db.commit()

    log_activity(db, business_code, "System", "BUSINESS_REGISTERED", f"Business '{new_biz.name}' registered with initial admin account.")

    # Send official Welcome Email via Resend HTTPS API (non-blocking background thread)
    welcome_html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to SupiriPOS PRO</title>
    </head>
    <body style="margin: 0; padding: 30px 15px; background-color: #0b1120; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f8fafc;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 580px; margin: 0 auto; background-color: #0f172a; border-radius: 16px; border: 1px solid #1e293b; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);">
            <tr>
                <td style="padding: 32px 28px 24px 28px; text-align: left;">
                    <div style="margin-bottom: 4px;">
                        <span style="font-size: 24px; font-weight: 800; color: #10b981; letter-spacing: -0.5px;">SupiriPOS <span style="color: #38bdf8;">PRO</span></span>
                    </div>
                    <p style="margin: 0 0 16px 0; font-size: 13px; color: #94a3b8; font-weight: 500;">Next-Gen Cloud Point of Sale System</p>
                    <div style="height: 1px; width: 100%; background: linear-gradient(90deg, #10b981 0%, rgba(16, 185, 129, 0.1) 100%); margin-bottom: 24px;"></div>

                    <h2 style="margin: 0 0 10px 0; font-size: 22px; font-weight: 700; color: #f8fafc;">🎉 Congratulations &amp; Welcome to SupiriPOS PRO!</h2>
                    <p style="margin: 0 0 8px 0; font-size: 15px; color: #e2e8f0;">Hello <strong>{new_biz.owner_name}</strong>,</p>
                    <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #cbd5e1;">
                        Your cloud POS store account for <strong>{new_biz.name}</strong> has been successfully registered and initialized! You can now start managing inventory, processing rapid sales, and tracking real-time profits.
                    </p>

                    <div style="background: #1e293b; border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 12px; padding: 22px 20px; margin: 24px 0;">
                        <h3 style="margin: 0 0 14px 0; font-size: 13px; font-weight: 700; color: #10b981; text-transform: uppercase; letter-spacing: 1px;">Store Credentials &amp; Access</h3>
                        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                            <tr>
                                <td style="padding: 7px 0; color: #94a3b8; width: 42%;">Store / Business Name:</td>
                                <td style="padding: 7px 0; color: #f8fafc; font-weight: 700;">{new_biz.name}</td>
                            </tr>
                            <tr>
                                <td style="padding: 7px 0; color: #94a3b8;">Location / Store Code:</td>
                                <td style="padding: 7px 0; color: #38bdf8; font-family: monospace; font-weight: 700; font-size: 16px;">{business_code}</td>
                            </tr>
                            <tr>
                                <td style="padding: 7px 0; color: #94a3b8;">Master Password:</td>
                                <td style="padding: 7px 0; color: #10b981; font-family: monospace; font-weight: 700; font-size: 16px;">{req.master_password}</td>
                            </tr>
                        </table>

                        <div style="margin-top: 16px; padding-top: 14px; border-top: 1px dashed rgba(255,255,255,0.12);">
                            <p style="margin: 0 0 4px 0; font-size: 12px; font-weight: 700; color: #fbbf24;">⚡ Initial Admin POS Login:</p>
                            <p style="margin: 0; font-size: 13px; color: #cbd5e1;">
                                Username: <span style="background: rgba(0,0,0,0.4); padding: 2px 7px; border-radius: 4px; color: #ffffff; font-family: monospace; font-weight: 600;">user</span>
                                &nbsp;&nbsp;|&nbsp;&nbsp;
                                Password: <span style="background: rgba(0,0,0,0.4); padding: 2px 7px; border-radius: 4px; color: #ffffff; font-family: monospace; font-weight: 600;">123</span>
                            </p>
                            <p style="margin: 6px 0 0 0; font-size: 11px; color: #94a3b8;">(You will be prompted to set your personal Admin credentials upon first login)</p>
                        </div>
                    </div>

                    <div style="background: rgba(245, 158, 11, 0.08); border-left: 4px solid #f59e0b; border-radius: 6px; padding: 12px 16px; margin: 20px 0;">
                        <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #fde68a;">
                            🔒 <strong>Security Tip:</strong> Please keep your Location / Store Code and Master Password strictly confidential. Never share your Master Password with cashiers or unauthorized personnel.
                        </p>
                    </div>

                    <p style="font-size: 13px; color: #94a3b8; line-height: 1.6; margin: 0 0 24px 0;">
                        Need assistance getting started or connecting receipt printers, barcode scanners, and scales? Our technical support team is ready to help you anytime.
                    </p>

                    <div style="border-top: 1px solid #1e293b; padding-top: 20px; text-align: center;">
                        <p style="margin: 0 0 6px 0; font-size: 13px; font-weight: 700; color: #f1f5f9;">PrasaTek System Solutions</p>
                        <p style="margin: 0 0 6px 0; font-size: 12px; color: #94a3b8;">
                            <a href="https://www.prasatek.lk" style="color: #10b981; text-decoration: none; font-weight: 600;">www.prasatek.lk</a>
                            &nbsp;&bull;&nbsp;
                            <a href="mailto:info@prasatek.lk" style="color: #38bdf8; text-decoration: none;">info@prasatek.lk</a>
                        </p>
                        <p style="margin: 0; font-size: 11px; color: #64748b; font-style: italic;">Smart POS &amp; Enterprise Software Solutions — Sri Lanka</p>
                    </div>
                </td>
            </tr>
        </table>
    </body>
    </html>
    """

    welcome_plain = (
        f"🎉 Congratulations & Welcome to SupiriPOS PRO!\n\n"
        f"Hello {new_biz.owner_name},\n"
        f"Your cloud POS store account for '{new_biz.name}' has been successfully registered!\n\n"
        f"--- STORE CREDENTIALS & ACCESS ---\n"
        f"Store / Business Name: {new_biz.name}\n"
        f"Location / Store Code: {business_code}\n"
        f"Master Password: {req.master_password}\n\n"
        f"--- INITIAL ADMIN POS LOGIN ---\n"
        f"Username: user\n"
        f"Password: 123\n"
        f"(You will be prompted to set your personal Admin credentials on first login)\n\n"
        f"SECURITY TIP: Please keep your Store Code and Master Password strictly confidential. "
        f"Never share your Master Password with cashiers or unauthorized personnel.\n\n"
        f"----------------------------------------\n"
        f"PrasaTek System Solutions\n"
        f"Website: https://www.prasatek.lk\n"
        f"Support: info@prasatek.lk\n"
        f"Smart POS & Enterprise Software Solutions — Sri Lanka\n"
    )

    try:
        # Non-blocking: send welcome email in background daemon thread
        send_email_in_background(
            to_email=email_clean,
            subject=f"🎉 Congratulations! Your SupiriPOS PRO Account is Ready",
            html_content=welcome_html,
            plain_text=welcome_plain,
            context_label="WELCOME-CREDENTIALS"
        )
    except Exception as email_err:
        logger.warning(f"[WELCOME EMAIL ERROR] Could not dispatch welcome email to {email_clean}: {email_err}")

    logger.info(f"[REGISTER] New Business registered: {business_code} ({req.shop_name})")

    return {
        "success": True,
        "business_code": business_code,
        "shop_name": new_biz.name,
        "master_password": req.master_password,
        "default_staff_username": "user",
        "default_staff_password": "123",
        "message": "Business successfully registered and initialized!"
    }

@app.post("/api/auth/unlock-business")
def unlock_business(req: UnlockBusinessRequest, db: Session = Depends(get_db)):
    """Stage 1: Business Terminal Unlock with Stealth Super Admin Interception"""
    raw_input = req.business_code.strip()

    # Stealth Super Admin Check
    admin = db.query(SystemAdmin).filter(func.lower(SystemAdmin.admin_email) == raw_input.lower()).first()
    if admin:
        if verify_password(req.business_password, admin.password_hash):
            return {
                "status": "success",
                "success": True,
                "role": "super_admin",
                "admin_email": admin.admin_email,
                "token": generate_admin_token(admin.admin_email),
                "message": "Super Admin authenticated"
            }
        else:
            raise HTTPException(status_code=401, detail="Incorrect credentials.")

    code_clean = raw_input.upper()
    biz = db.query(Business).filter(Business.business_code == code_clean).first()

    if not biz:
        raise HTTPException(status_code=404, detail="Business code not found. Please verify and try again.")

    if getattr(biz, "is_active", True) is False:
        raise HTTPException(status_code=403, detail="This business account has been suspended by system administration. Please contact PrasaTek Support.")

    if not verify_password(req.business_password, biz.master_password_hash):
        raise HTTPException(status_code=401, detail="Incorrect Business Master Password.")

    return {
        "success": True,
        "business": {
            "business_code": biz.business_code,
            "name": biz.name,
            "owner_name": biz.owner_name,
            "address": biz.address,
            "phone": biz.phone,
            "receipt_footer": biz.receipt_footer,
            "logo_base64": biz.logo_base64
        }
    }

@app.post("/api/auth/pos-login")
def pos_login(req: POSLoginRequest, db: Session = Depends(get_db)):
    """Stage 2: POS Staff Login with Stealth Super Admin Interception"""
    raw_user = req.username.strip()

    # Stealth Super Admin Check
    admin = db.query(SystemAdmin).filter(func.lower(SystemAdmin.admin_email) == raw_user.lower()).first()
    if admin:
        if verify_password(req.password, admin.password_hash):
            return {
                "status": "success",
                "success": True,
                "role": "super_admin",
                "admin_email": admin.admin_email,
                "token": generate_admin_token(admin.admin_email),
                "message": "Super Admin authenticated"
            }
        else:
            raise HTTPException(status_code=401, detail="Incorrect credentials.")

    code_clean = req.business_code.strip().upper()
    username_clean = raw_user.lower()

    # Verify business is active
    biz = db.query(Business).filter(Business.business_code == code_clean).first()
    if biz and getattr(biz, "is_active", True) is False:
        raise HTTPException(status_code=403, detail="This business account has been suspended by system administration. Please contact PrasaTek Support.")

    user = db.query(POSUser).filter(
        POSUser.business_code == code_clean,
        POSUser.username == username_clean
    ).first()

    if not user:
        raise HTTPException(status_code=404, detail="Staff user not found in this business.")

    if not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect staff password.")

    log_activity(db, user.business_code, user.username, "LOGIN", f"Staff login from terminal as {user.role_title}")

    return {
        "success": True,
        "user": {
            "id": user.id,
            "business_code": user.business_code,
            "username": user.username,
            "full_name": user.full_name,
            "role_title": user.role_title,
            "must_change_password": getattr(user, "must_change_password", False),
            "permissions": {
                "billing": user.can_billing,
                "items": user.can_items,
                "stock": user.can_stock,
                "users": user.can_users,
                "reports": user.can_reports
            }
        }
    }

@app.post("/api/auth/login")
def universal_login(req: StealthLoginRequest, db: Session = Depends(get_db)):
    """Stealth Universal Login Interception Endpoint"""
    raw_user = req.username.strip()

    # 1. Check system_admins
    admin = db.query(SystemAdmin).filter(func.lower(SystemAdmin.admin_email) == raw_user.lower()).first()
    if admin:
        if verify_password(req.password, admin.password_hash):
            return {
                "status": "success",
                "success": True,
                "role": "super_admin",
                "admin_email": admin.admin_email,
                "token": generate_admin_token(admin.admin_email),
                "message": "Super Admin authenticated"
            }
        else:
            raise HTTPException(status_code=401, detail="Invalid username or password.")

    # 2. Check regular POS user if business_code provided
    if req.business_code:
        code_clean = req.business_code.strip().upper()
        biz = db.query(Business).filter(Business.business_code == code_clean).first()
        if biz and getattr(biz, "is_active", True) is False:
            raise HTTPException(status_code=403, detail="This business account has been suspended by system administration.")

        user = db.query(POSUser).filter(
            POSUser.business_code == code_clean,
            POSUser.username == raw_user.lower()
        ).first()
        if user and verify_password(req.password, user.password_hash):
            log_activity(db, user.business_code, user.username, "LOGIN", f"Staff login from terminal as {user.role_title}")
            must_change = getattr(user, "must_change_password", False)
            return {
                "status": "success",
                "success": True,
                "role": "pos_user",
                "must_change_password": must_change,
                "user": {
                    "id": user.id,
                    "business_code": user.business_code,
                    "username": user.username,
                    "full_name": user.full_name,
                    "role_title": user.role_title,
                    "must_change_password": must_change,
                    "permissions": {
                        "billing": user.can_billing,
                        "items": user.can_items,
                        "stock": user.can_stock,
                        "users": user.can_users,
                        "reports": user.can_reports
                    }
                }
            }

    raise HTTPException(status_code=401, detail="Invalid username or password.")

@app.post("/api/auth/pos-logout")
def pos_logout(req: LogoutRequest, db: Session = Depends(get_db)):
    """Records staff logout event in activity logs"""
    log_activity(db, req.business_code, req.username, "LOGOUT", f"Staff {req.username} logged out from terminal")
    return {"success": True}

@app.post("/api/auth/change-initial-credentials")
def change_initial_credentials(req: ChangeInitialCredentialsRequest, db: Session = Depends(get_db)):
    """Forces first-time password & username change for default user/123 admin account"""
    code_clean = req.business_code.strip().upper()
    curr_user_clean = (req.current_username or "user").strip().lower()
    new_user_clean = req.new_username.strip().lower()

    user = None
    if req.user_id:
        user = db.query(POSUser).filter(
            POSUser.id == req.user_id,
            POSUser.business_code == code_clean
        ).first()

    if not user:
        user = db.query(POSUser).filter(
            POSUser.business_code == code_clean,
            func.lower(POSUser.username) == curr_user_clean
        ).first()

    if not user:
        # Fallback: look for initial user flagged with must_change_password
        user = db.query(POSUser).filter(
            POSUser.business_code == code_clean,
            POSUser.must_change_password == True
        ).first()

    if not user:
        raise HTTPException(status_code=404, detail="Staff account not found in this business.")

    curr_pass = req.current_password or "123"
    if not verify_password(curr_pass, user.password_hash) and not getattr(user, "must_change_password", False):
        raise HTTPException(status_code=401, detail="Current credentials could not be verified.")

    if not new_user_clean or len(new_user_clean) < 3:
        raise HTTPException(status_code=400, detail="New username must be at least 3 characters.")

    if not req.new_password or len(req.new_password) < 4:
        raise HTTPException(status_code=400, detail="New password must be at least 4 characters.")

    if new_user_clean != user.username.lower():
        existing = db.query(POSUser).filter(
            POSUser.business_code == code_clean,
            func.lower(POSUser.username) == new_user_clean,
            POSUser.id != user.id
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail=f"Username '{new_user_clean}' is already in use by another staff user.")

    user.username = new_user_clean
    user.password_hash = hash_password(req.new_password)
    
    name_to_set = req.new_full_name or req.full_name
    if name_to_set and name_to_set.strip():
        user.full_name = name_to_set.strip()
    user.must_change_password = False
    db.commit()
    db.refresh(user)

    log_activity(db, code_clean, user.username, "ADMIN_CREDENTIALS_CHANGED",
                 f"Secured initial admin account. New username: '{user.username}'")

    return {
        "success": True,
        "message": "Admin credentials secured successfully!",
        "user": {
            "id": user.id,
            "business_code": user.business_code,
            "username": user.username,
            "full_name": user.full_name,
            "role_title": user.role_title,
            "must_change_password": False,
            "permissions": {
                "billing": user.can_billing,
                "items": user.can_items,
                "stock": user.can_stock,
                "users": user.can_users,
                "reports": user.can_reports
            }
        }
    }

# ---------------------------------------------------------------------------
# Business Profile Management
# ---------------------------------------------------------------------------
@app.get("/api/business/profile")
def get_business_profile(business_code: str, db: Session = Depends(get_db)):
    biz = db.query(Business).filter(Business.business_code == business_code).first()
    if not biz:
        raise HTTPException(status_code=404, detail="Business not found.")
    return {
        "business_code": biz.business_code,
        "name": biz.name,
        "owner_name": biz.owner_name,
        "email": biz.email,
        "phone": biz.phone,
        "address": biz.address,
        "receipt_footer": biz.receipt_footer,
        "logo_base64": biz.logo_base64
    }

# ---------------------------------------------------------------------------
# Items Management (Product Catalog)
# ---------------------------------------------------------------------------
@app.get("/api/items")
def get_items(
    business_code: str,
    search: Optional[str] = None,
    category: Optional[str] = None,
    db: Session = Depends(get_db)
):
    query = db.query(Item).filter(Item.business_code == business_code)
    if search:
        search_fmt = f"%{search.strip()}%"
        query = query.filter((Item.name.ilike(search_fmt)) | (Item.code.ilike(search_fmt)))
    if category and category.lower() != "all":
        query = query.filter(Item.category.ilike(category.strip()))

    items = query.order_by(Item.name.asc()).all()
    return items

@app.post("/api/items")
async def create_item(req: ItemCreateUpdateRequest, db: Session = Depends(get_db)):
    # Check if item code already exists for this business
    existing = db.query(Item).filter(
        Item.business_code == req.business_code,
        Item.code == req.code.strip()
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Item code/barcode '{req.code}' already exists.")

    new_item = Item(
        business_code=req.business_code,
        code=req.code.strip(),
        name=req.name.strip(),
        category=req.category.strip(),
        unit=req.unit.strip(),
        cost_price=float(req.cost_price),
        selling_price=float(req.selling_price),
        stock_quantity=float(req.stock_quantity or 0.0),
        low_stock_level=float(req.low_stock_level)
    )
    db.add(new_item)
    db.commit()
    db.refresh(new_item)

    # If initial stock > 0, write stock log
    if new_item.stock_quantity > 0:
        log = StockLog(
            business_code=req.business_code,
            item_id=new_item.id,
            item_code=new_item.code,
            item_name=new_item.name,
            log_type="IN",
            quantity_change=new_item.stock_quantity,
            previous_stock=0.0,
            new_stock=new_item.stock_quantity,
            staff_username="Staff",
            note="Initial Stock Added with Item Creation"
        )
        db.add(log)
        db.commit()

    # Real-time WebSocket Broadcast
    await ws_manager.broadcast(req.business_code, {
        "type": "ITEMS_UPDATED",
        "action": "CREATE",
        "item_id": new_item.id
    })

    log_activity(db, req.business_code, "Staff", "ITEM_CREATED",
                 f"Added product '{new_item.name}' ({new_item.code}) - Selling: Rs. {new_item.selling_price:.2f}")

    return new_item

@app.put("/api/items/{item_id}")
async def update_item(item_id: int, req: ItemCreateUpdateRequest, db: Session = Depends(get_db)):
    item = db.query(Item).filter(Item.id == item_id, Item.business_code == req.business_code).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")

    # Check unique code collision
    existing = db.query(Item).filter(
        Item.business_code == req.business_code,
        Item.code == req.code.strip(),
        Item.id != item_id
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Another item is already using code '{req.code}'.")

    item.code = req.code.strip()
    item.name = req.name.strip()
    item.category = req.category.strip()
    item.unit = req.unit.strip()
    item.cost_price = float(req.cost_price)
    item.selling_price = float(req.selling_price)
    item.low_stock_level = float(req.low_stock_level)
    item.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(item)

    await ws_manager.broadcast(req.business_code, {
        "type": "ITEMS_UPDATED",
        "action": "UPDATE",
        "item_id": item.id
    })

    log_activity(db, req.business_code, "Staff", "ITEM_UPDATED",
                 f"Updated product '{item.name}' ({item.code})")

    return item

@app.delete("/api/items/{item_id}")
async def delete_item(item_id: int, business_code: str, db: Session = Depends(get_db)):
    item = db.query(Item).filter(Item.id == item_id, Item.business_code == business_code).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")

    deleted_name = item.name
    deleted_code = item.code
    db.delete(item)
    db.commit()

    await ws_manager.broadcast(business_code, {
        "type": "ITEMS_UPDATED",
        "action": "DELETE",
        "item_id": item_id
    })

    log_activity(db, business_code, "Staff", "ITEM_DELETED",
                 f"Deleted product '{deleted_name}' ({deleted_code})")

    return {"success": True, "message": "Item deleted."}

# ---------------------------------------------------------------------------
# Stock Management & Inventory Logs
# ---------------------------------------------------------------------------
@app.get("/api/stock")
def get_stock(business_code: str, db: Session = Depends(get_db)):
    items = db.query(Item).filter(Item.business_code == business_code).order_by(Item.name.asc()).all()
    result = []
    for it in items:
        status_badge = "IN_STOCK"
        if it.stock_quantity <= 0:
            status_badge = "OUT_OF_STOCK"
        elif it.stock_quantity <= it.low_stock_level:
            status_badge = "LOW_STOCK"

        result.append({
            "id": it.id,
            "code": it.code,
            "name": it.name,
            "category": it.category,
            "unit": it.unit,
            "cost_price": it.cost_price,
            "selling_price": it.selling_price,
            "stock_quantity": it.stock_quantity,
            "low_stock_level": it.low_stock_level,
            "status": status_badge
        })
    return result

@app.post("/api/stock/adjust")
async def adjust_stock(req: StockAdjustRequest, db: Session = Depends(get_db)):
    item = db.query(Item).filter(Item.id == req.item_id, Item.business_code == req.business_code).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")

    prev_stock = item.stock_quantity
    qty = abs(float(req.quantity))

    if req.adjust_type == "IN":
        new_stock = prev_stock + qty
        change = qty
    elif req.adjust_type == "OUT":
        new_stock = max(0.0, prev_stock - qty)
        change = -qty
    else:
        raise HTTPException(status_code=400, detail="Invalid adjust_type. Must be 'IN' or 'OUT'.")

    item.stock_quantity = new_stock
    item.updated_at = datetime.now(timezone.utc)

    log = StockLog(
        business_code=req.business_code,
        item_id=item.id,
        item_code=item.code,
        item_name=item.name,
        log_type=req.adjust_type,
        quantity_change=change,
        previous_stock=prev_stock,
        new_stock=new_stock,
        staff_username=req.staff_username,
        note=req.note or ""
    )
    db.add(log)
    db.commit()

    # Real-Time WebSocket broadcast
    await ws_manager.broadcast(req.business_code, {
        "type": "STOCK_UPDATED",
        "item_id": item.id,
        "new_stock": new_stock
    })

    action_text = "Stock Added (IN)" if req.adjust_type == "IN" else "Stock Removed (OUT)"
    details = f"{action_text}: {qty} {item.unit} for '{item.name}'"
    if req.note:
        details += f" (Ref: {req.note})"
    log_activity(db, req.business_code, req.staff_username, "STOCK_ADJUST", details)

    return {
        "success": True,
        "item_id": item.id,
        "previous_stock": prev_stock,
        "new_stock": new_stock
    }

@app.get("/api/stock/logs")
def get_stock_logs(business_code: str, limit: int = 50, db: Session = Depends(get_db)):
    logs = db.query(StockLog).filter(
        StockLog.business_code == business_code
    ).order_by(desc(StockLog.created_at)).limit(limit).all()
    return logs

# ---------------------------------------------------------------------------
# Credit Customers & Repayment Ledger Endpoints ("ණයට" & Settlements)
# ---------------------------------------------------------------------------
@app.get("/api/customers")
def get_credit_customers(business_code: str, db: Session = Depends(get_db)):
    customers_list, ledger_list = _build_credit_customers_payload(db, business_code)

    total_outstanding = sum(float(c["credit_balance"] or 0.0) for c in customers_list)
    active_count = sum(1 for c in customers_list if float(c["credit_balance"] or 0.0) > 0)

    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_payments = db.query(CreditLedger).filter(
        CreditLedger.business_code == business_code,
        CreditLedger.transaction_type == "PAYMENT_RECEIVED",
        CreditLedger.created_at >= today_start
    ).all()
    collected_today = sum(float(p.amount or 0.0) for p in today_payments)

    return {
        "customers": customers_list,
        "recent_ledger": ledger_list,
        "summary": {
            "total_outstanding_credit": round(total_outstanding, 2),
            "active_credit_customers": active_count,
            "total_customers": len(customers_list),
            "credit_collected_today": round(collected_today, 2)
        }
    }

@app.get("/api/customers/lookup")
def lookup_credit_customer(business_code: str, phone: str = "", db: Session = Depends(get_db)):
    clean_phone = (phone or "").strip()
    norm_target = _normalize_phone(clean_phone)
    if not clean_phone:
        return {"found": False, "customer": None}

    customers = db.query(CreditCustomer).filter(CreditCustomer.business_code == business_code).all()
    matched = None
    for c in customers:
        if c.phone.strip() == clean_phone or (_normalize_phone(c.phone) == norm_target and len(norm_target) >= 7):
            matched = c
            break

    if not matched:
        return {"found": False, "customer": None}

    return {
        "found": True,
        "customer": {
            "id": matched.id,
            "business_code": matched.business_code,
            "phone": matched.phone,
            "phone_normalized": _normalize_phone(matched.phone),
            "name": matched.name,
            "address": matched.address or "",
            "credit_balance": round(float(matched.credit_balance or 0.0), 2),
            "created_at": matched.created_at.isoformat() if matched.created_at else "",
            "updated_at": matched.updated_at.isoformat() if matched.updated_at else ""
        }
    }

@app.post("/api/customers/create")
async def create_credit_customer(req: CreateCreditCustomerRequest, db: Session = Depends(get_db)):
    phone_clean = (req.phone or "").strip()
    name_clean = (req.name or "").strip()
    addr_clean = (req.address or "").strip()
    staff_ident = (req.staff_user or "Admin").strip() or "Admin"

    if not phone_clean:
        raise HTTPException(status_code=400, detail="Customer mobile number is required.")
    if not name_clean:
        raise HTTPException(status_code=400, detail="Customer name is required.")

    norm_target = _normalize_phone(phone_clean)
    existing_all = db.query(CreditCustomer).filter(CreditCustomer.business_code == req.business_code).all()
    for c in existing_all:
        if c.phone.strip() == phone_clean or (norm_target and _normalize_phone(c.phone) == norm_target):
            # Update name/address if provided and return existing customer
            c.name = name_clean
            if addr_clean:
                c.address = addr_clean
            c.updated_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(c)
            return {
                "success": True,
                "already_existed": True,
                "customer": {
                    "id": c.id,
                    "business_code": c.business_code,
                    "phone": c.phone,
                    "phone_normalized": _normalize_phone(c.phone),
                    "name": c.name,
                    "address": c.address or "",
                    "credit_balance": round(float(c.credit_balance or 0.0), 2),
                    "created_at": c.created_at.isoformat() if c.created_at else "",
                    "updated_at": c.updated_at.isoformat() if c.updated_at else ""
                }
            }

    new_cust = CreditCustomer(
        business_code=req.business_code,
        phone=phone_clean,
        name=name_clean,
        address=addr_clean,
        credit_balance=0.0,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc)
    )
    db.add(new_cust)
    db.commit()
    db.refresh(new_cust)

    log_activity(
        db,
        req.business_code,
        staff_ident,
        "CUSTOMER_CREATED",
        f"Registered credit customer '{new_cust.name}' ({new_cust.phone}) - {new_cust.address or 'No address'}"
    )

    await ws_manager.broadcast(req.business_code, {
        "type": "CREDIT_UPDATED",
        "action": "CUSTOMER_CREATED",
        "customer_id": new_cust.id
    })

    return {
        "success": True,
        "customer": {
            "id": new_cust.id,
            "business_code": new_cust.business_code,
            "phone": new_cust.phone,
            "phone_normalized": _normalize_phone(new_cust.phone),
            "name": new_cust.name,
            "address": new_cust.address or "",
            "credit_balance": 0.0,
            "created_at": new_cust.created_at.isoformat() if new_cust.created_at else "",
            "updated_at": new_cust.updated_at.isoformat() if new_cust.updated_at else ""
        }
    }

@app.post("/api/customers/pay-credit")
async def pay_customer_credit(req: PayCreditRequest, db: Session = Depends(get_db)):
    if req.amount_paid <= 0:
        raise HTTPException(status_code=400, detail="Payment amount must be greater than Rs. 0.00.")

    cust = db.query(CreditCustomer).filter(
        CreditCustomer.id == req.customer_id,
        CreditCustomer.business_code == req.business_code
    ).first()
    if not cust:
        raise HTTPException(status_code=404, detail="Credit customer not found.")

    staff_ident = (req.staff_user or "Admin").strip() or "Admin"
    prev_balance = round(float(cust.credit_balance or 0.0), 2)
    amt_paid = round(float(req.amount_paid), 2)
    new_balance = round(max(0.0, prev_balance - amt_paid), 2)

    cust.credit_balance = new_balance
    cust.updated_at = datetime.now(timezone.utc)

    today_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    receipt_no = f"CRPAY-{req.business_code}-{today_str}-{random.randint(1000, 9999)}"
    ref_note = (req.note or "").strip() or f"Credit Settlement #{receipt_no}"

    ledger_entry = CreditLedger(
        business_code=req.business_code,
        customer_id=cust.id,
        customer_phone=cust.phone,
        transaction_type="PAYMENT_RECEIVED",
        amount=amt_paid,
        balance_after=new_balance,
        payment_method=req.payment_method or "Cash",
        reference_note=ref_note,
        staff_user=staff_ident,
        created_at=datetime.now(timezone.utc)
    )
    db.add(ledger_entry)
    db.commit()
    db.refresh(cust)
    db.refresh(ledger_entry)

    log_activity(
        db,
        req.business_code,
        staff_ident,
        "CREDIT_PAYMENT",
        f"Credit payment Rs. {amt_paid:.2f} ({req.payment_method}) received from '{cust.name}' ({cust.phone}). Balance: Rs. {prev_balance:.2f} -> Rs. {new_balance:.2f}"
    )

    await ws_manager.broadcast(req.business_code, {
        "type": "CREDIT_UPDATED",
        "action": "PAYMENT_RECEIVED",
        "customer_id": cust.id,
        "new_balance": new_balance
    })

    return {
        "success": True,
        "receipt_number": receipt_no,
        "previous_balance": prev_balance,
        "amount_paid": amt_paid,
        "new_balance": new_balance,
        "customer": {
            "id": cust.id,
            "business_code": cust.business_code,
            "phone": cust.phone,
            "phone_normalized": _normalize_phone(cust.phone),
            "name": cust.name,
            "address": cust.address or "",
            "credit_balance": new_balance,
            "updated_at": cust.updated_at.isoformat() if cust.updated_at else ""
        },
        "ledger_entry": {
            "id": ledger_entry.id,
            "customer_id": ledger_entry.customer_id,
            "customer_phone": ledger_entry.customer_phone,
            "transaction_type": ledger_entry.transaction_type,
            "amount": amt_paid,
            "balance_after": new_balance,
            "payment_method": ledger_entry.payment_method,
            "reference_note": ledger_entry.reference_note,
            "staff_user": ledger_entry.staff_user,
            "created_at": ledger_entry.created_at.isoformat() if ledger_entry.created_at else ""
        }
    }

@app.get("/api/customers/{customer_id}/ledger")
def get_customer_credit_ledger(customer_id: int, business_code: str, db: Session = Depends(get_db)):
    cust = db.query(CreditCustomer).filter(
        CreditCustomer.id == customer_id,
        CreditCustomer.business_code == business_code
    ).first()
    if not cust:
        raise HTTPException(status_code=404, detail="Credit customer not found.")

    entries = db.query(CreditLedger).filter(
        CreditLedger.business_code == business_code,
        CreditLedger.customer_id == customer_id
    ).order_by(desc(CreditLedger.created_at)).limit(300).all()

    return {
        "customer": {
            "id": cust.id,
            "business_code": cust.business_code,
            "phone": cust.phone,
            "name": cust.name,
            "address": cust.address or "",
            "credit_balance": round(float(cust.credit_balance or 0.0), 2),
            "created_at": cust.created_at.isoformat() if cust.created_at else "",
            "updated_at": cust.updated_at.isoformat() if cust.updated_at else ""
        },
        "ledger": [{
            "id": l.id,
            "customer_id": l.customer_id,
            "customer_phone": l.customer_phone,
            "transaction_type": l.transaction_type,
            "amount": round(float(l.amount or 0.0), 2),
            "balance_after": round(float(l.balance_after or 0.0), 2),
            "payment_method": l.payment_method or "Cash",
            "reference_note": l.reference_note or "",
            "staff_user": l.staff_user or "Admin",
            "created_at": l.created_at.isoformat() if l.created_at else ""
        } for l in entries]
    }

# ---------------------------------------------------------------------------
# Invoices & Billing (Real-Time Stock Deduction, Credit Ledger & Reprinting)
# ---------------------------------------------------------------------------
@app.post("/api/invoices")
async def create_invoice(req: CreateInvoiceRequest, db: Session = Depends(get_db)):
    if not req.items:
        raise HTTPException(status_code=400, detail="Invoice must contain at least one item.")

    staff_ident = (req.cashier_username or "Admin").strip() or "Admin"
    is_credit_sale = str(req.payment_method or "").strip().upper() == "CREDIT"

    # Validate Credit Customer if payment_method is Credit ("ණයට")
    credit_customer = None
    if is_credit_sale:
        if req.customer_id:
            credit_customer = db.query(CreditCustomer).filter(
                CreditCustomer.id == req.customer_id,
                CreditCustomer.business_code == req.business_code
            ).first()
        if not credit_customer and req.customer_phone:
            norm_p = _normalize_phone(req.customer_phone)
            all_custs = db.query(CreditCustomer).filter(
                CreditCustomer.business_code == req.business_code
            ).all()
            for c in all_custs:
                if c.phone.strip() == req.customer_phone.strip() or (norm_p and _normalize_phone(c.phone) == norm_p):
                    credit_customer = c
                    break
        if not credit_customer:
            raise HTTPException(
                status_code=400,
                detail="Please select or register a Credit Customer (ණය ගනුදෙනුකරු) before completing a Credit bill."
            )

    # Generate sequential or timestamped invoice number
    today_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    rand_suffix = f"{random.randint(1000, 9999)}"
    inv_number = f"INV-{req.business_code}-{today_str}-{rand_suffix}"

    # Parse and verify items, deduct stock
    processed_items = []
    for cart_it in req.items:
        item = db.query(Item).filter(Item.id == cart_it.item_id, Item.business_code == req.business_code).first()
        if item:
            prev = item.stock_quantity
            item.stock_quantity = max(0.0, prev - cart_it.quantity)
            item.updated_at = datetime.now(timezone.utc)

            # Record stock movement log
            log = StockLog(
                business_code=req.business_code,
                item_id=item.id,
                item_code=item.code,
                item_name=item.name,
                log_type="SALE",
                quantity_change=-cart_it.quantity,
                previous_stock=prev,
                new_stock=item.stock_quantity,
                staff_username=staff_ident,
                note=f"Sale Invoice #{inv_number}"
            )
            db.add(log)

            processed_items.append({
                "item_id": item.id,
                "code": item.code,
                "name": item.name,
                "unit": item.unit,
                "cost_price": item.cost_price,
                "selling_price": cart_it.selling_price,
                "quantity": cart_it.quantity,
                "discount": cart_it.discount,
                "total": cart_it.total
            })

    net_payable = round(float(req.grand_total or 0.0), 2)
    cash_received = round(float(req.cash_paid or 0.0), 2)
    prev_credit_balance = 0.0
    credit_added = 0.0
    updated_credit_balance = 0.0
    cust_name_final = (req.customer_name or "").strip()
    cust_phone_final = (req.customer_phone or "").strip()
    cust_addr_final = (req.customer_address or "").strip()

    if is_credit_sale and credit_customer:
        prev_credit_balance = round(float(credit_customer.credit_balance or 0.0), 2)
        credit_added = round(max(0.0, net_payable - cash_received), 2)
        updated_credit_balance = round(prev_credit_balance + credit_added, 2)

        credit_customer.credit_balance = updated_credit_balance
        credit_customer.updated_at = datetime.now(timezone.utc)
        cust_name_final = credit_customer.name
        cust_phone_final = credit_customer.phone
        cust_addr_final = credit_customer.address or ""

        # Record CREDIT_SALE entry in credit_ledger
        ledger_rec = CreditLedger(
            business_code=req.business_code,
            customer_id=credit_customer.id,
            customer_phone=credit_customer.phone,
            transaction_type="CREDIT_SALE",
            amount=credit_added,
            balance_after=updated_credit_balance,
            payment_method="Invoice",
            reference_note=f"Invoice #{inv_number} (Bill: Rs. {net_payable:.2f}, Paid: Rs. {cash_received:.2f})",
            staff_user=staff_ident,
            created_at=datetime.now(timezone.utc)
        )
        db.add(ledger_rec)

    invoice = Invoice(
        business_code=req.business_code,
        invoice_number=inv_number,
        date_time=datetime.now(timezone.utc),
        cashier_username=staff_ident,
        payment_method="Credit" if is_credit_sale else (req.payment_method or "Cash"),
        subtotal=float(req.subtotal or 0.0),
        discount_amount=float(req.discount_amount or 0.0),
        discount_percent=float(req.discount_percent or 0.0),
        tax_amount=float(req.tax_amount or 0.0),
        grand_total=net_payable,
        cash_paid=cash_received,
        balance_change=float(req.balance_change or 0.0),
        customer_name=cust_name_final,
        customer_phone=cust_phone_final,
        status="PAID",
        items_json=json.dumps(processed_items)
    )
    db.add(invoice)
    db.commit()
    db.refresh(invoice)

    # Real-time WebSocket Broadcast to all other devices in this business
    await ws_manager.broadcast(req.business_code, {
        "type": "INVOICE_CREATED",
        "invoice_id": invoice.id,
        "invoice_number": invoice.invoice_number,
        "grand_total": invoice.grand_total,
        "is_credit": is_credit_sale
    })
    if is_credit_sale and credit_customer:
        await ws_manager.broadcast(req.business_code, {
            "type": "CREDIT_UPDATED",
            "action": "CREDIT_SALE",
            "customer_id": credit_customer.id,
            "new_balance": updated_credit_balance
        })

    if is_credit_sale and credit_customer:
        log_activity(
            db,
            req.business_code,
            staff_ident,
            "BILL_CREATED",
            f"Created Credit Invoice #{inv_number} for {cust_name_final} ({cust_phone_final}) - Credit Added: Rs. {credit_added:.2f} | New Credit Balance: Rs. {updated_credit_balance:.2f}"
        )
    else:
        log_activity(
            db,
            req.business_code,
            staff_ident,
            "BILL_CREATED",
            f"Created Invoice #{inv_number} ({req.payment_method}) - Total: Rs. {req.grand_total:.2f}"
        )

    return {
        "success": True,
        "id": invoice.id,
        "invoice_id": invoice.id,
        "invoice_number": invoice.invoice_number,
        "date_time": invoice.date_time.isoformat(),
        "cashier_username": staff_ident,
        "staff_username": staff_ident,
        "staff_name": staff_ident,
        "cashier_name": staff_ident,
        "payment_method": invoice.payment_method,
        "subtotal": float(invoice.subtotal or 0.0),
        "discount_amount": float(invoice.discount_amount or 0.0),
        "tax_amount": float(invoice.tax_amount or 0.0),
        "grand_total": float(invoice.grand_total or 0.0),
        "cash_paid": float(invoice.cash_paid or 0.0),
        "balance_change": float(invoice.balance_change or 0.0),
        "customer_id": credit_customer.id if credit_customer else None,
        "customer_name": cust_name_final or "Walk-in Customer",
        "customer_phone": cust_phone_final,
        "customer_address": cust_addr_final,
        "previous_credit_balance": prev_credit_balance,
        "credit_added": credit_added,
        "customer_credit_balance": updated_credit_balance,
        "status": invoice.status,
        "items": processed_items
    }

@app.get("/api/invoices")
def get_invoices(
    business_code: str,
    range: str = "today",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db)
):
    query = db.query(Invoice).filter(Invoice.business_code == business_code)

    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    if range == "today":
        query = query.filter(Invoice.date_time >= today_start)
    elif range == "yesterday":
        yesterday_start = today_start - timedelta(days=1)
        query = query.filter(Invoice.date_time >= yesterday_start, Invoice.date_time < today_start)
    elif range == "this_week":
        week_start = today_start - timedelta(days=today_start.weekday())
        query = query.filter(Invoice.date_time >= week_start)
    elif range == "this_month":
        month_start = today_start.replace(day=1)
        query = query.filter(Invoice.date_time >= month_start)
    elif range == "custom" and start_date and end_date:
        try:
            s_dt = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
            e_dt = datetime.fromisoformat(end_date).replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
            query = query.filter(Invoice.date_time >= s_dt, Invoice.date_time <= e_dt)
        except Exception:
            pass

    invoices = query.order_by(desc(Invoice.date_time)).limit(500).all()

    # Map usernames to full display names if available
    users = db.query(POSUser).filter(POSUser.business_code == business_code).all()
    user_display_map = {}
    for u in users:
        if u.username:
            user_display_map[u.username.lower()] = u.full_name or u.username

    # Map customer phones to credit customer records
    credit_customers = db.query(CreditCustomer).filter(CreditCustomer.business_code == business_code).all()
    cust_phone_map = {}
    for cc in credit_customers:
        if cc.phone:
            cust_phone_map[_normalize_phone(cc.phone)] = cc

    result = []
    for inv in invoices:
        items = []
        est_cost = 0.0
        total_qty = 0.0
        try:
            items = json.loads(inv.items_json)
            for it in items:
                q = float(it.get("quantity") or 0.0)
                c = float(it.get("cost_price") or 0.0)
                est_cost += c * q
                total_qty += q
        except Exception:
            pass

        raw_staff = (inv.cashier_username or "").strip()
        if not raw_staff or raw_staff.lower() in ("undefined", "null", "none"):
            raw_staff = "Admin"
        display_staff = user_display_map.get(raw_staff.lower(), raw_staff)

        grand_tot = float(inv.grand_total or 0.0)
        sub_tot = float(inv.subtotal or grand_tot)
        disc_amt = float(inv.discount_amount or 0.0)
        tax_amt = float(inv.tax_amount or 0.0)
        cash_p = float(inv.cash_paid if inv.cash_paid is not None else grand_tot)
        est_profit = max(0.0, grand_tot - est_cost) if inv.status == "PAID" else 0.0

        is_cr = str(inv.payment_method or "").upper() == "CREDIT"
        cr_added = round(max(0.0, grand_tot - cash_p), 2) if is_cr else 0.0
        matched_cc = cust_phone_map.get(_normalize_phone(inv.customer_phone or "")) if inv.customer_phone else None

        result.append({
            "id": inv.id,
            "invoice_number": inv.invoice_number,
            "date_time": inv.date_time.isoformat() if inv.date_time else "",
            "cashier_username": raw_staff,
            "staff_username": raw_staff,
            "staff_name": display_staff,
            "cashier_name": display_staff,
            "user_name": raw_staff,
            "cashier": display_staff,
            "created_by": raw_staff,
            "customer_id": matched_cc.id if matched_cc else None,
            "customer_name": inv.customer_name or (matched_cc.name if matched_cc else "Walk-in Customer"),
            "customer_phone": inv.customer_phone or "",
            "customer_address": matched_cc.address if matched_cc else "",
            "credit_added": cr_added,
            "customer_credit_balance": round(float(matched_cc.credit_balance or 0.0), 2) if matched_cc else 0.0,
            "payment_method": inv.payment_method or "Cash",
            "subtotal": round(sub_tot, 2),
            "discount_amount": round(disc_amt, 2),
            "tax_amount": round(tax_amt, 2),
            "grand_total": round(grand_tot, 2),
            "cash_paid": round(cash_p, 2),
            "balance_change": round(float(inv.balance_change or 0.0), 2),
            "estimated_cost": round(est_cost, 2),
            "estimated_profit": round(est_profit, 2),
            "status": inv.status or "PAID",
            "items_count": len(items),
            "total_quantity": round(total_qty, 2),
            "items": items
        })
    return result

@app.post("/api/invoices/{invoice_id}/void")
async def void_invoice(invoice_id: int, business_code: str, staff_username: Optional[str] = "Admin", db: Session = Depends(get_db)):
    """Void invoice, restore item stock, and reverse credit balance if Credit sale"""
    inv = db.query(Invoice).filter(Invoice.id == invoice_id, Invoice.business_code == business_code).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found.")

    if inv.status == "VOIDED":
        raise HTTPException(status_code=400, detail="This invoice is already voided.")

    inv.status = "VOIDED"
    staff_ident = (staff_username or "Admin").strip() or "Admin"

    # Restore stocks
    try:
        items = json.loads(inv.items_json)
        for it in items:
            item_db = db.query(Item).filter(Item.id == it["item_id"], Item.business_code == business_code).first()
            if item_db:
                prev = item_db.stock_quantity
                item_db.stock_quantity = prev + it["quantity"]
                item_db.updated_at = datetime.now(timezone.utc)

                # Log restoration
                log = StockLog(
                    business_code=business_code,
                    item_id=item_db.id,
                    item_code=item_db.code,
                    item_name=item_db.name,
                    log_type="VOID_RETURN",
                    quantity_change=it["quantity"],
                    previous_stock=prev,
                    new_stock=item_db.stock_quantity,
                    staff_username=staff_ident,
                    note=f"Stock Restored from Voided Invoice #{inv.invoice_number}"
                )
                db.add(log)
    except Exception as e:
        logger.error(f"[VOID ERROR] {e}")

    # Reverse customer credit if this was a Credit invoice
    if str(inv.payment_method or "").upper() == "CREDIT" and inv.customer_phone:
        norm_p = _normalize_phone(inv.customer_phone)
        all_custs = db.query(CreditCustomer).filter(CreditCustomer.business_code == business_code).all()
        for cc in all_custs:
            if cc.phone.strip() == inv.customer_phone.strip() or (norm_p and _normalize_phone(cc.phone) == norm_p):
                cr_to_reverse = max(0.0, float(inv.grand_total or 0.0) - float(inv.cash_paid or 0.0))
                if cr_to_reverse > 0:
                    cc.credit_balance = round(max(0.0, float(cc.credit_balance or 0.0) - cr_to_reverse), 2)
                    cc.updated_at = datetime.now(timezone.utc)
                    db.add(CreditLedger(
                        business_code=business_code,
                        customer_id=cc.id,
                        customer_phone=cc.phone,
                        transaction_type="PAYMENT_RECEIVED",
                        amount=round(cr_to_reverse, 2),
                        balance_after=cc.credit_balance,
                        payment_method="Void Reversal",
                        reference_note=f"Voided Credit Bill #{inv.invoice_number}",
                        staff_user=staff_ident,
                        created_at=datetime.now(timezone.utc)
                    ))
                break

    db.commit()

    await ws_manager.broadcast(business_code, {
        "type": "INVOICE_VOIDED",
        "invoice_id": inv.id,
        "invoice_number": inv.invoice_number
    })
    await ws_manager.broadcast(business_code, {
        "type": "CREDIT_UPDATED",
        "action": "INVOICE_VOIDED"
    })

    log_activity(db, business_code, staff_ident, "BILL_VOIDED",
                 f"Voided Invoice #{inv.invoice_number} (Rs. {inv.grand_total:.2f}). Stock restored.")

    return {"success": True, "message": f"Invoice {inv.invoice_number} voided and stock restored."}

# ---------------------------------------------------------------------------
# Reports & KPIs
# ---------------------------------------------------------------------------
@app.get("/api/reports/summary")
def get_reports_summary(
    business_code: str,
    range: str = "today",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db)
):
    query = db.query(Invoice).filter(Invoice.business_code == business_code, Invoice.status == "PAID")

    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    if range == "today":
        query = query.filter(Invoice.date_time >= today_start)
    elif range == "yesterday":
        yesterday_start = today_start - timedelta(days=1)
        query = query.filter(Invoice.date_time >= yesterday_start, Invoice.date_time < today_start)
    elif range == "this_week":
        week_start = today_start - timedelta(days=today_start.weekday())
        query = query.filter(Invoice.date_time >= week_start)
    elif range == "this_month":
        month_start = today_start.replace(day=1)
        query = query.filter(Invoice.date_time >= month_start)
    elif range == "custom" and start_date and end_date:
        try:
            s_dt = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
            e_dt = datetime.fromisoformat(end_date).replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
            query = query.filter(Invoice.date_time >= s_dt, Invoice.date_time <= e_dt)
        except Exception:
            pass

    invoices = query.all()

    total_sales = 0.0
    total_cost = 0.0
    total_discounts = 0.0
    total_bills = len(invoices)

    for inv in invoices:
        total_sales += float(inv.grand_total or 0.0)
        total_discounts += float(inv.discount_amount or 0.0)
        try:
            items = json.loads(inv.items_json)
            for it in items:
                total_cost += float(it.get("cost_price") or 0.0) * float(it.get("quantity") or 1.0)
                total_discounts += float(it.get("discount") or 0.0)
        except Exception:
            pass

    net_profit = max(0.0, total_sales - total_cost)
    avg_bill_value = (total_sales / total_bills) if total_bills > 0 else 0.0

    # Low stock items count for this business
    low_stock_count = db.query(Item).filter(
        Item.business_code == business_code,
        Item.stock_quantity <= Item.low_stock_level
    ).count()

    return {
        "total_sales": round(total_sales, 2),
        "net_profit": round(net_profit, 2),
        "total_bills": total_bills,
        "avg_bill_value": round(avg_bill_value, 2),
        "total_discounts": round(total_discounts, 2),
        "low_stock_items": low_stock_count
    }

@app.get("/api/reports/export")
def export_reports_csv(
    business_code: str,
    range: str = "today",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Exports sales report as CSV"""
    invoices_data = get_invoices(business_code, range, start_date, end_date, db)

    csv_lines = [
        "\ufeffInvoice Number,Date Time,Staff Member,Payment Method,Subtotal (Rs.),Discount (Rs.),Grand Total (Rs.),Est. Profit (Rs.),Status,Items Count\n"
    ]
    for inv in invoices_data:
        staff_val = inv.get("staff_name") or inv.get("cashier_username") or "Admin"
        line = f'"{inv["invoice_number"]}","{inv["date_time"]}","{staff_val}","{inv["payment_method"]}",{inv["subtotal"]},{inv["discount_amount"]},{inv["grand_total"]},{inv.get("estimated_profit", 0.0)},"{inv["status"]}",{inv["items_count"]}\n'
        csv_lines.append(line)

    csv_data = "".join(csv_lines)
    return Response(
        content=csv_data,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=SupiriPOS_Report_{business_code}_{range}.csv"}
    )

# ---------------------------------------------------------------------------
# Staff Users & Granular Access Control
# ---------------------------------------------------------------------------
@app.get("/api/users")
def get_users(business_code: str, db: Session = Depends(get_db)):
    users = db.query(POSUser).filter(POSUser.business_code == business_code).all()
    result = []
    for u in users:
        result.append({
            "id": u.id,
            "username": u.username,
            "full_name": u.full_name,
            "role_title": u.role_title,
            "can_billing": u.can_billing,
            "can_items": u.can_items,
            "can_stock": u.can_stock,
            "can_users": u.can_users,
            "can_reports": u.can_reports,
            "created_at": u.created_at.isoformat()
        })
    return result

@app.post("/api/users")
async def create_user(req: UserCreateUpdateRequest, db: Session = Depends(get_db)):
    u_clean = req.username.strip().lower()
    existing = db.query(POSUser).filter(
        POSUser.business_code == req.business_code,
        POSUser.username == u_clean
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Username '{u_clean}' already exists in this business.")

    if not req.password:
        raise HTTPException(status_code=400, detail="Password is required.")

    new_user = POSUser(
        business_code=req.business_code,
        username=u_clean,
        password_hash=hash_password(req.password),
        full_name=req.full_name.strip(),
        role_title=req.role_title.strip(),
        can_billing=req.can_billing,
        can_items=req.can_items,
        can_stock=req.can_stock,
        can_users=req.can_users,
        can_reports=req.can_reports
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    await ws_manager.broadcast(req.business_code, {
        "type": "USERS_UPDATED",
        "action": "CREATE",
        "username": new_user.username
    })

    log_activity(db, req.business_code, "Admin", "USER_CREATED",
                 f"Created staff account '{new_user.username}' ({new_user.role_title})")

    return {"success": True, "id": new_user.id, "username": new_user.username}

@app.put("/api/users/{user_id}")
async def update_user(user_id: int, req: UserCreateUpdateRequest, db: Session = Depends(get_db)):
    user = db.query(POSUser).filter(POSUser.id == user_id, POSUser.business_code == req.business_code).first()
    if not user:
        raise HTTPException(status_code=404, detail="Staff user not found.")

    u_clean = req.username.strip().lower()
    # Check duplicate username
    dup = db.query(POSUser).filter(
        POSUser.business_code == req.business_code,
        POSUser.username == u_clean,
        POSUser.id != user_id
    ).first()
    if dup:
        raise HTTPException(status_code=400, detail=f"Username '{u_clean}' already taken.")

    user.username = u_clean
    user.full_name = req.full_name.strip()
    user.role_title = req.role_title.strip()
    user.can_billing = req.can_billing
    user.can_items = req.can_items
    user.can_stock = req.can_stock
    user.can_users = req.can_users
    user.can_reports = req.can_reports

    if req.password and req.password.strip():
        user.password_hash = hash_password(req.password.strip())

    db.commit()

    await ws_manager.broadcast(req.business_code, {
        "type": "USERS_UPDATED",
        "action": "UPDATE",
        "username": user.username
    })

    log_activity(db, req.business_code, "Admin", "USER_UPDATED",
                 f"Updated staff account '{user.username}' ({user.role_title})")

    return {"success": True, "id": user.id}

@app.delete("/api/users/{user_id}")
async def delete_user(user_id: int, business_code: str, db: Session = Depends(get_db)):
    user = db.query(POSUser).filter(POSUser.id == user_id, POSUser.business_code == business_code).first()
    if not user:
        raise HTTPException(status_code=404, detail="Staff user not found.")

    # Guard: Do not delete if only 1 user exists
    count = db.query(POSUser).filter(POSUser.business_code == business_code).count()
    if count <= 1:
        raise HTTPException(status_code=400, detail="Cannot delete the sole administrator account.")

    deleted_username = user.username
    db.delete(user)
    db.commit()

    await ws_manager.broadcast(business_code, {
        "type": "USERS_UPDATED",
        "action": "DELETE",
        "user_id": user_id
    })

    log_activity(db, business_code, "Admin", "USER_DELETED",
                 f"Deleted staff account '{deleted_username}'")

    return {"success": True, "message": "User deleted."}

# ---------------------------------------------------------------------------
# Dashboard Overview & Live Intelligence
# ---------------------------------------------------------------------------
@app.get("/api/dashboard/stats")
def get_dashboard_stats(business_code: str, db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    seven_days_ago = now - timedelta(days=7)
    thirty_days_ago = now - timedelta(days=30)

    # Today's invoices
    today_invoices = db.query(Invoice).filter(
        Invoice.business_code == business_code,
        Invoice.created_at >= today_start,
        Invoice.status == "PAID"
    ).all()
    today_sales = sum(inv.grand_total for inv in today_invoices)
    today_count = len(today_invoices)

    # 7 days sales
    week_invoices = db.query(Invoice).filter(
        Invoice.business_code == business_code,
        Invoice.created_at >= seven_days_ago,
        Invoice.status == "PAID"
    ).all()
    week_sales = sum(inv.grand_total for inv in week_invoices)

    # 30 days sales
    month_invoices = db.query(Invoice).filter(
        Invoice.business_code == business_code,
        Invoice.created_at >= thirty_days_ago,
        Invoice.status == "PAID"
    ).all()
    month_sales = sum(inv.grand_total for inv in month_invoices)

    # Total products & low stock items
    all_items = db.query(Item).filter(Item.business_code == business_code).all()
    total_products = len(all_items)

    low_stock_list = []
    for it in all_items:
        if it.stock_quantity <= it.low_stock_level:
            low_stock_list.append({
                "id": it.id,
                "code": it.code,
                "name": it.name,
                "category": it.category,
                "unit": it.unit,
                "stock_quantity": it.stock_quantity,
                "low_stock_level": it.low_stock_level,
                "selling_price": it.selling_price
            })

    # Active staff users count (always at least 1 for the active business)
    active_users = max(db.query(POSUser).filter(POSUser.business_code == business_code).count(), 1)

    # Recent 5 invoices live feed
    recent_invoices_raw = db.query(Invoice).filter(
        Invoice.business_code == business_code
    ).order_by(desc(Invoice.created_at)).limit(5).all()

    recent_invoices = [{
        "id": inv.id,
        "invoice_number": inv.invoice_number,
        "date_time": inv.date_time.isoformat() if inv.date_time else "",
        "cashier_username": inv.cashier_username,
        "grand_total": inv.grand_total,
        "payment_method": inv.payment_method,
        "status": inv.status
    } for inv in recent_invoices_raw]

    # Top 5 selling items
    top_items_counter = {}
    for inv in week_invoices:
        try:
            items_arr = json.loads(inv.items_json)
            for itm in items_arr:
                name = itm.get("name", "Unknown")
                qty = float(itm.get("quantity") or itm.get("qty") or 1.0)
                tot = float(itm.get("total") or 0.0)
                if name not in top_items_counter:
                    top_items_counter[name] = {"quantity": 0.0, "revenue": 0.0, "unit": itm.get("unit", "Pcs")}
                top_items_counter[name]["quantity"] += qty
                top_items_counter[name]["revenue"] += tot
        except Exception:
            pass

    sorted_top = sorted(
        [{
            "name": k,
            "quantity": v["quantity"],
            "qty_sold": v["quantity"],
            "qty": v["quantity"],
            "total_qty": v["quantity"],
            "sold": v["quantity"],
            "count": v["quantity"],
            "revenue": v["revenue"],
            "unit": v["unit"]
        } for k, v in top_items_counter.items()],
        key=lambda x: x["quantity"],
        reverse=True
    )[:5]

    return {
        "today_sales": today_sales,
        "today_count": today_count,
        "today_bills": today_count,
        "week_sales": week_sales,
        "month_sales": month_sales,
        "total_products": total_products,
        "active_users": active_users,
        "active_staff_count": active_users,
        "low_stock_count": len(low_stock_list),
        "low_stock_items": low_stock_list,
        "recent_invoices": recent_invoices,
        "top_selling_items": sorted_top
    }

# ---------------------------------------------------------------------------
# Item Bin Card & User Activity Audit Log
# ---------------------------------------------------------------------------
@app.get("/api/reports/bin-card")
def get_bin_card(
    business_code: str,
    item_id: Optional[int] = None,
    item_code: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Generates complete chronological stock ledger (Bin Card) for a specific product"""
    target_item = None
    if item_id:
        target_item = db.query(Item).filter(Item.id == item_id, Item.business_code == business_code).first()
    elif item_code:
        target_item = db.query(Item).filter(Item.code == item_code, Item.business_code == business_code).first()
    else:
        target_item = db.query(Item).filter(Item.business_code == business_code).order_by(Item.name.asc()).first()

    if not target_item:
        return {"item": None, "movements": []}

    query = db.query(StockLog).filter(
        StockLog.business_code == business_code,
        StockLog.item_id == target_item.id
    )

    if start_date:
        try:
            s_dt = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
            query = query.filter(StockLog.created_at >= s_dt)
        except Exception:
            pass
    if end_date:
        try:
            e_dt = datetime.fromisoformat(end_date).replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
            query = query.filter(StockLog.created_at <= e_dt)
        except Exception:
            pass

    logs = query.order_by(StockLog.created_at.asc()).all()

    movements = []
    for l in logs:
        change = float(l.quantity_change or 0.0)
        qty_in = change if change > 0 else 0.0
        qty_out = abs(change) if change < 0 else 0.0
        staff_val = (l.staff_username or "").strip()
        if not staff_val or staff_val.lower() in ("undefined", "null", "none"):
            staff_val = "System User"
        new_stk = float(l.new_stock or 0.0)
        movements.append({
            "id": l.id,
            "created_at": l.created_at.isoformat() if l.created_at else "",
            "log_type": l.log_type,
            "reference": l.note or "-",
            "qty_in": qty_in,
            "qty_out": qty_out,
            "previous_stock": float(l.previous_stock or 0.0),
            "new_stock": new_stk,
            "running_balance": new_stk,
            "staff_username": staff_val,
            "staff_name": staff_val,
            "username": staff_val
        })

    return {
        "item": {
            "id": target_item.id,
            "code": target_item.code,
            "name": target_item.name,
            "category": target_item.category,
            "unit": target_item.unit,
            "cost_price": target_item.cost_price,
            "selling_price": target_item.selling_price,
            "stock_quantity": target_item.stock_quantity,
            "low_stock_level": target_item.low_stock_level
        },
        "movements": movements
    }

@app.get("/api/reports/activity-logs")
def get_activity_logs(
    business_code: str,
    username: Optional[str] = None,
    staff_username: Optional[str] = None,
    action_type: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = 150,
    db: Session = Depends(get_db)
):
    """Fetches staff audit logs with granular user and action filters"""
    query = db.query(ActivityLog).filter(ActivityLog.business_code == business_code)

    target_user = staff_username or username
    if target_user and target_user.upper() != "ALL":
        query = query.filter(ActivityLog.username.ilike(target_user.strip()))

    if action_type and action_type.upper() != "ALL":
        query = query.filter(ActivityLog.action_type == action_type.strip().upper())

    if start_date:
        try:
            s_dt = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
            query = query.filter(ActivityLog.created_at >= s_dt)
        except Exception:
            pass
    if end_date:
        try:
            e_dt = datetime.fromisoformat(end_date).replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
            query = query.filter(ActivityLog.created_at <= e_dt)
        except Exception:
            pass

    logs = query.order_by(desc(ActivityLog.created_at)).limit(limit).all()

    result = []
    for l in logs:
        staff_val = (l.username or "").strip()
        if not staff_val or staff_val.lower() in ("undefined", "null", "none"):
            staff_val = "System User"
        result.append({
            "id": l.id,
            "username": staff_val,
            "staff_username": staff_val,
            "staff_name": staff_val,
            "user_name": staff_val,
            "created_by": staff_val,
            "action_type": l.action_type or "SYSTEM",
            "details": l.details or "-",
            "created_at": l.created_at.isoformat() if l.created_at else ""
        })
    return result

# ---------------------------------------------------------------------------
# Master Admin Control Panel Endpoints (Protected by Super Admin Token)
# ---------------------------------------------------------------------------
@app.get("/api/admin/overview-stats")
def admin_overview_stats(admin: SystemAdmin = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Summary metrics for Master Admin overview dashboard"""
    total_biz = db.query(Business).count()
    active_biz = db.query(Business).filter(Business.is_active != False).count()
    suspended_biz = db.query(Business).filter(Business.is_active == False).count()
    total_users = db.query(POSUser).count()
    total_products = db.query(Item).count()
    total_invoices = db.query(Invoice).count()
    total_revenue = db.query(func.sum(Invoice.grand_total)).filter(Invoice.status == "PAID").scalar() or 0.0
    open_tickets = db.query(SupportTicket).filter(SupportTicket.status == "open").count()
    total_tickets = db.query(SupportTicket).count()

    return {
        "success": True,
        "admin_email": admin.admin_email,
        "total_businesses": total_biz,
        "active_businesses": active_biz,
        "suspended_businesses": suspended_biz,
        "total_users": total_users,
        "total_products": total_products,
        "total_invoices": total_invoices,
        "total_revenue": round(float(total_revenue), 2),
        "open_support_tickets": open_tickets,
        "total_support_tickets": total_tickets,
        "stats": {
            "total_businesses": total_biz,
            "active_businesses": active_biz,
            "suspended_businesses": suspended_biz,
            "total_users": total_users,
            "total_products": total_products,
            "total_invoices": total_invoices,
            "total_revenue": round(float(total_revenue), 2),
            "open_support_tickets": open_tickets,
            "total_support_tickets": total_tickets
        }
    }

@app.get("/api/admin/businesses")
def admin_list_businesses(admin: SystemAdmin = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Fetch all registered businesses with full owner details and stats"""
    businesses = db.query(Business).order_by(desc(Business.created_at)).all()
    result = []
    for b in businesses:
        primary_user = db.query(POSUser).filter(POSUser.business_code == b.business_code).order_by(POSUser.id).first()
        users_cnt = db.query(POSUser).filter(POSUser.business_code == b.business_code).count()
        items_cnt = db.query(Item).filter(Item.business_code == b.business_code).count()
        invoices_cnt = db.query(Invoice).filter(Invoice.business_code == b.business_code).count()
        sales_sum = db.query(func.sum(Invoice.grand_total)).filter(
            Invoice.business_code == b.business_code,
            Invoice.status == "PAID"
        ).scalar() or 0.0

        is_act = getattr(b, "is_active", True)
        if is_act is None:
            is_act = True

        result.append({
            "id": b.id,
            "business_code": b.business_code,
            "name": b.name,
            "owner_name": b.owner_name,
            "email": b.email,
            "phone": b.phone,
            "nic": b.nic or "",
            "address": b.address,
            "is_active": is_act,
            "terminal_username": primary_user.username if primary_user else "user",
            "created_at": b.created_at.isoformat() if b.created_at else datetime.now(timezone.utc).isoformat(),
            "stats": {
                "users_count": users_cnt,
                "products_count": items_cnt,
                "invoices_count": invoices_cnt,
                "total_sales": round(float(sales_sum), 2)
            }
        })
    return {"success": True, "businesses": result, "total": len(result)}

@app.post("/api/admin/businesses")
def admin_create_business(req: AdminCreateBusinessRequest, admin: SystemAdmin = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Super Admin direct business account provisioning"""
    code = req.business_code.strip().upper() if req.business_code else ""
    if not code:
        code = generate_next_business_code(db)
    else:
        if db.query(Business).filter(Business.business_code == code).first():
            raise HTTPException(status_code=400, detail=f"Business code '{code}' is already registered.")

    email_clean = req.email.strip().lower()
    new_biz = Business(
        business_code=code,
        name=req.name.strip(),
        owner_name=req.owner_name.strip(),
        email=email_clean,
        phone=req.phone.strip(),
        nic=req.nic.strip() if req.nic else "",
        address=req.address.strip(),
        master_password_hash=hash_password(req.master_password.strip()),
        is_active=req.is_active if req.is_active is not None else True,
        receipt_footer="Thank You! Come Again! / ස්තූතියි! නැවත එන්න!"
    )
    db.add(new_biz)
    db.commit()
    db.refresh(new_biz)

    term_user = req.terminal_username.strip().lower() if req.terminal_username else "user"
    term_pass = req.terminal_password.strip() if req.terminal_password else "123"
    user = POSUser(
        business_code=code,
        username=term_user,
        password_hash=hash_password(term_pass),
        full_name=req.owner_name.strip(),
        role_title="Store Manager",
        can_billing=True,
        can_items=True,
        can_stock=True,
        can_users=True,
        can_reports=True,
        must_change_password=(term_user == "user" and term_pass == "123")
    )
    db.add(user)
    db.commit()

    log_activity(db, code, admin.admin_email, "ADMIN_CREATE_BIZ", f"Super Admin created business '{new_biz.name}' ({code})")

    return {
        "success": True,
        "message": f"Business '{new_biz.name}' ({code}) created successfully.",
        "business": {
            "id": new_biz.id,
            "business_code": new_biz.business_code,
            "name": new_biz.name,
            "owner_name": new_biz.owner_name,
            "email": new_biz.email,
            "phone": new_biz.phone,
            "terminal_username": term_user,
            "is_active": new_biz.is_active
        }
    }

@app.put("/api/admin/businesses/{business_id}")
def admin_update_business(business_id: int, req: AdminUpdateBusinessRequest, admin: SystemAdmin = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Update business details, suspend/activate, or reset master & terminal passwords"""
    biz = db.query(Business).filter(Business.id == business_id).first()
    if not biz:
        raise HTTPException(status_code=404, detail="Business not found")

    if req.name is not None and req.name.strip():
        biz.name = req.name.strip()
    if req.owner_name is not None and req.owner_name.strip():
        biz.owner_name = req.owner_name.strip()
    if req.email is not None and req.email.strip():
        biz.email = req.email.strip().lower()
    if req.phone is not None and req.phone.strip():
        biz.phone = req.phone.strip()
    if req.address is not None and req.address.strip():
        biz.address = req.address.strip()
    if req.nic is not None:
        biz.nic = req.nic.strip()
    if req.is_active is not None:
        biz.is_active = req.is_active
    if req.master_password is not None and req.master_password.strip():
        biz.master_password_hash = hash_password(req.master_password.strip())

    if req.terminal_password is not None and req.terminal_password.strip():
        primary_user = db.query(POSUser).filter(POSUser.business_code == biz.business_code).order_by(POSUser.id).first()
        if primary_user:
            primary_user.password_hash = hash_password(req.terminal_password.strip())
            primary_user.must_change_password = False

    db.commit()
    db.refresh(biz)

    log_activity(db, biz.business_code, admin.admin_email, "ADMIN_UPDATE_BIZ", f"Super Admin updated business '{biz.name}' details")

    return {
        "success": True,
        "message": f"Business '{biz.name}' updated successfully.",
        "business": {
            "id": biz.id,
            "business_code": biz.business_code,
            "name": biz.name,
            "owner_name": biz.owner_name,
            "email": biz.email,
            "phone": biz.phone,
            "address": biz.address,
            "is_active": biz.is_active
        }
    }

@app.delete("/api/admin/businesses/{business_id}")
def admin_delete_business(business_id: int, admin: SystemAdmin = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Cleanly delete a business and all its multi-tenant records"""
    biz = db.query(Business).filter(Business.id == business_id).first()
    if not biz:
        raise HTTPException(status_code=404, detail="Business not found")

    code = biz.business_code
    biz_name = biz.name

    # Cascade delete records
    db.query(Invoice).filter(Invoice.business_code == code).delete(synchronize_session=False)
    db.query(StockLog).filter(StockLog.business_code == code).delete(synchronize_session=False)
    db.query(Item).filter(Item.business_code == code).delete(synchronize_session=False)
    db.query(CreditLedger).filter(CreditLedger.business_code == code).delete(synchronize_session=False)
    db.query(CreditCustomer).filter(CreditCustomer.business_code == code).delete(synchronize_session=False)
    db.query(ActivityLog).filter(ActivityLog.business_code == code).delete(synchronize_session=False)
    db.query(POSUser).filter(POSUser.business_code == code).delete(synchronize_session=False)
    db.query(SupportTicket).filter(SupportTicket.business_code == code).delete(synchronize_session=False)
    db.delete(biz)
    db.commit()

    logger.info(f"[ADMIN DELETE] Business {biz_name} ({code}) deleted by {admin.admin_email}")

    return {
        "success": True,
        "message": f"Business '{biz_name}' ({code}) and all related records deleted cleanly."
    }

@app.put("/api/admin/profile")
def admin_update_profile(req: AdminProfileUpdateRequest, admin: SystemAdmin = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Update Super Admin's own email and password (persisted to system_admins in Supabase)"""
    if not verify_password(req.current_password, admin.password_hash):
        raise HTTPException(status_code=400, detail="Current password incorrect.")

    db_admin = db.query(SystemAdmin).filter(SystemAdmin.id == admin.id).first()
    if not db_admin:
        raise HTTPException(status_code=404, detail="Admin record not found.")

    if req.new_email and req.new_email.strip():
        clean_email = req.new_email.strip().lower()
        existing = db.query(SystemAdmin).filter(
            func.lower(SystemAdmin.admin_email) == clean_email,
            SystemAdmin.id != db_admin.id
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="This email is already registered as an admin.")
        db_admin.admin_email = clean_email

    if req.new_password and req.new_password.strip():
        if len(req.new_password.strip()) < 8:
            raise HTTPException(status_code=400, detail="New password must be at least 8 characters.")
        db_admin.password_hash = hash_password(req.new_password.strip())

    db_admin.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(db_admin)

    new_token = generate_admin_token(db_admin.admin_email)
    logger.info(f"[ADMIN PROFILE] Super Admin credentials updated in Supabase: {db_admin.admin_email}")

    return {
        "success": True,
        "message": "Super Admin credentials updated successfully in Supabase.",
        "admin_email": db_admin.admin_email,
        "token": new_token
    }

# ---------------------------------------------------------------------------
# Business Profile Management & Deletion with Resend OTP Verification
# ---------------------------------------------------------------------------
@app.post("/api/business/request-otp")
def business_request_otp(req: BusinessRequestOTPRequest, db: Session = Depends(get_db)):
    """
    Sends a 6-digit OTP verification code via Resend HTTPS API to the business owner's
    registered email address for Profile Update or Deletion.
    """
    code_clean = req.business_code.strip().upper()
    biz = db.query(Business).filter(Business.business_code == code_clean).first()
    if not biz:
        raise HTTPException(status_code=404, detail="Business not found.")

    if not biz.email:
        raise HTTPException(status_code=400, detail="This business has no registered email on file.")

    otp = f"{random.randint(100000, 999999)}"
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=10)

    otp_record = OTPVerification(
        email=biz.email.lower().strip(),
        otp_code=otp,
        expires_at=expires_at,
        is_verified=False
    )
    db.add(otp_record)
    db.commit()

    is_delete = (req.action.upper() == "DELETE_BUSINESS")
    action_label = "Permanent Store Account Deletion" if is_delete else "Store Profile & Settings Update"
    subject = f"⚠️ SECURITY CODE: {action_label} - {otp}" if is_delete else f"SupiriPOS PRO: Verification Code for {action_label} - {otp}"
    warning_text = (
        "<b>CRITICAL WARNING:</b> Entering this code will permanently delete your store and ALL associated data (sales, items, customers, invoices) with zero recovery!"
        if is_delete else
        "This code will authorize changes to your store profile and business settings."
    )

    html_content = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="margin: 0; padding: 25px 15px; background-color: #0b1120; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #f8fafc;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 540px; margin: 0 auto; background-color: #0f172a; border-radius: 14px; border: 1px solid #1e293b; padding: 28px;">
            <tr>
                <td>
                    <div style="margin-bottom: 4px;">
                        <span style="font-size: 22px; font-weight: 800; color: #10b981;">SupiriPOS <span style="color: #38bdf8;">PRO</span></span>
                    </div>
                    <p style="margin: 0 0 16px 0; font-size: 12px; color: #94a3b8;">Next-Gen Cloud Point of Sale System</p>
                    <div style="height: 1px; width: 100%; background: #1e293b; margin-bottom: 20px;"></div>

                    <h2 style="margin: 0 0 10px 0; color: {'#ef4444' if is_delete else '#10b981'}; font-size: 20px;">
                        {'⚠️ Store Deletion Authorization' if is_delete else '🔐 Store Settings Verification'}
                    </h2>
                    <p style="font-size: 14px; line-height: 1.5; color: #cbd5e1;">
                        Hello <strong>{biz.owner_name}</strong> ({biz.name} &bull; <code style="color: #38bdf8;">{biz.business_code}</code>),<br>
                        A security request was initiated for <strong>{action_label}</strong>.<br><br>
                        {warning_text}
                    </p>
                    <div style="background: #1e293b; border: 2px dashed {'#ef4444' if is_delete else '#10b981'}; border-radius: 10px; padding: 18px; text-align: center; margin: 20px 0;">
                        <span style="font-size: 11px; text-transform: uppercase; color: #94a3b8; font-weight: 700; display: block; margin-bottom: 4px;">Security Verification Code</span>
                        <div style="font-size: 38px; font-weight: 800; letter-spacing: 8px; color: #ffffff; font-family: monospace;">{otp}</div>
                        <p style="margin: 4px 0 0 0; font-size: 11px; color: #94a3b8;">Expires in 10 minutes. Never share this code.</p>
                    </div>
                    <p style="font-size: 12px; color: #64748b; line-height: 1.5;">
                        If you did not initiate this request, please change your Master Password immediately and contact PrasaTek Support.
                    </p>
                    <div style="border-top: 1px solid #1e293b; padding-top: 16px; margin-top: 20px; text-align: center;">
                        <p style="margin: 0; font-size: 12px; font-weight: 700; color: #f1f5f9;">PrasaTek System Solutions</p>
                        <p style="margin: 3px 0 0 0; font-size: 11px; color: #64748b;">Enterprise Software &amp; Smart Cloud Solutions &bull; Sri Lanka</p>
                    </div>
                </td>
            </tr>
        </table>
    </body>
    </html>
    """

    send_email_in_background(
        to_email=biz.email.lower().strip(),
        subject=subject,
        html_content=html_content,
        plain_text=f"SupiriPOS PRO Security Code: {otp}\nAction: {action_label}\nStore: {biz.name} ({biz.business_code})\nExpires in 10 minutes.",
        context_label="BIZ-OTP"
    )

    masked_email = biz.email
    if "@" in biz.email:
        parts = biz.email.split("@")
        u = parts[0]
        masked_email = (u[:2] + "***" + u[-1:] if len(u) > 3 else u[:1] + "***") + "@" + parts[1]

    return {
        "success": True,
        "message": f"Verification code sent to {masked_email}",
        "masked_email": masked_email
    }

@app.post("/api/business/update-settings")
def business_update_settings(req: BusinessUpdateSettingsRequest, db: Session = Depends(get_db)):
    """
    Applies store settings updates only upon valid 6-digit email OTP verification.
    """
    code_clean = req.business_code.strip().upper()
    biz = db.query(Business).filter(Business.business_code == code_clean).first()
    if not biz:
        raise HTTPException(status_code=404, detail="Business not found.")

    otp_clean = req.otp_code.strip()
    record = db.query(OTPVerification).filter(
        OTPVerification.email == biz.email.lower().strip(),
        OTPVerification.otp_code == otp_clean,
        OTPVerification.is_verified == False
    ).order_by(desc(OTPVerification.created_at)).first()

    if not record:
        raise HTTPException(status_code=400, detail="Invalid OTP verification code. Please check and try again.")

    now = datetime.now(timezone.utc)
    exp = record.expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if now > exp:
        raise HTTPException(status_code=400, detail="Verification code has expired. Please request a new code.")

    # Mark OTP as verified
    record.is_verified = True

    # Update business settings
    if req.name and req.name.strip():
        biz.name = req.name.strip()
    if req.owner_name and req.owner_name.strip():
        biz.owner_name = req.owner_name.strip()
    if req.phone and req.phone.strip():
        biz.phone = req.phone.strip()
    if req.address and req.address.strip():
        biz.address = req.address.strip()
    if req.receipt_footer is not None:
        biz.receipt_footer = req.receipt_footer.strip()
    if req.logo_base64 is not None:
        biz.logo_base64 = req.logo_base64.strip()

    db.commit()
    db.refresh(biz)

    log_activity(db, code_clean, biz.owner_name, "BUSINESS_PROFILE_UPDATED", f"Business profile updated via OTP verification.")

    return {
        "success": True,
        "message": "Business settings updated successfully!",
        "business": {
            "business_code": biz.business_code,
            "name": biz.name,
            "owner_name": biz.owner_name,
            "email": biz.email,
            "phone": biz.phone,
            "address": biz.address,
            "receipt_footer": biz.receipt_footer,
            "logo_base64": biz.logo_base64
        }
    }

@app.post("/api/business/delete")
def business_delete_with_otp(req: BusinessDeleteRequest, db: Session = Depends(get_db)):
    """
    Permanently deletes a business and all associated tenant records upon valid OTP verification.
    """
    code_clean = req.business_code.strip().upper()
    biz = db.query(Business).filter(Business.business_code == code_clean).first()
    if not biz:
        raise HTTPException(status_code=404, detail="Business not found.")

    otp_clean = req.otp_code.strip()
    record = db.query(OTPVerification).filter(
        OTPVerification.email == biz.email.lower().strip(),
        OTPVerification.otp_code == otp_clean,
        OTPVerification.is_verified == False
    ).order_by(desc(OTPVerification.created_at)).first()

    if not record:
        raise HTTPException(status_code=400, detail="Invalid OTP deletion code. Please check and try again.")

    now = datetime.now(timezone.utc)
    exp = record.expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if now > exp:
        raise HTTPException(status_code=400, detail="Deletion code has expired. Please request a new code.")

    record.is_verified = True
    biz_name = biz.name

    # Cascade delete tenant records
    db.query(Invoice).filter(Invoice.business_code == code_clean).delete(synchronize_session=False)
    db.query(StockLog).filter(StockLog.business_code == code_clean).delete(synchronize_session=False)
    db.query(Item).filter(Item.business_code == code_clean).delete(synchronize_session=False)
    db.query(CreditLedger).filter(CreditLedger.business_code == code_clean).delete(synchronize_session=False)
    db.query(CreditCustomer).filter(CreditCustomer.business_code == code_clean).delete(synchronize_session=False)
    db.query(ActivityLog).filter(ActivityLog.business_code == code_clean).delete(synchronize_session=False)
    db.query(POSUser).filter(POSUser.business_code == code_clean).delete(synchronize_session=False)
    db.query(SupportTicket).filter(SupportTicket.business_code == code_clean).delete(synchronize_session=False)
    db.delete(biz)
    db.commit()

    logger.info(f"[STORE DELETED BY OWNER] Business '{biz_name}' ({code_clean}) deleted via email OTP.")

    return {
        "success": True,
        "message": f"Business '{biz_name}' ({code_clean}) and all associated records have been permanently deleted."
    }

# ---------------------------------------------------------------------------
# Support Ticket System Endpoints
# ---------------------------------------------------------------------------
@app.post("/api/support/tickets")
def create_support_ticket(req: SupportTicketCreateRequest, db: Session = Depends(get_db)):
    """
    Submits an advanced support inquiry / ticket.
    Requires:
    - Registered Email (Mandatory)
    - Phone Number (Mandatory)
    - Subject (Mandatory)
    - Message (Mandatory)
    - Reason / Category & Priority (Dropdown selections)
    - Optional: Business Code & File/Image Attachment (Base64 data URL)
    """
    subject_clean = req.subject.strip()
    msg_clean = req.message.strip()

    if not subject_clean or not msg_clean:
        raise HTTPException(status_code=400, detail="Subject and message are required.")

    email_clean = req.email.strip().lower() if (req.email and req.email.strip()) else None
    if not email_clean or "@" not in email_clean or "." not in email_clean:
        raise HTTPException(status_code=400, detail="A valid registered email address is required.")

    phone_clean = req.phone.strip() if (req.phone and req.phone.strip()) else None
    if not phone_clean:
        raise HTTPException(status_code=400, detail="Phone number is required for support verification.")

    code_clean = req.business_code.strip().upper() if (req.business_code and req.business_code.strip()) else None
    category_val = (req.category or "Technical Issue").strip()
    priority_val = (req.priority or "Normal").strip()
    att_name = req.attachment_name.strip() if (req.attachment_name and req.attachment_name.strip()) else None
    att_data = req.attachment_data if (req.attachment_data and req.attachment_data.strip()) else None

    biz = None
    if code_clean:
        biz = db.query(Business).filter(Business.business_code == code_clean).first()

    if not biz and email_clean:
        biz = db.query(Business).filter(func.lower(Business.email) == email_clean).first()

    if biz:
        biz_code_val = biz.business_code
        biz_name_val = biz.name
        owner_email_val = email_clean or biz.email
        owner_name_val = req.name.strip() if (req.name and req.name.strip()) else (biz.owner_name or "Store Owner")
        biz_id_val = biz.id
    else:
        biz_code_val = code_clean or "PUBLIC"
        biz_name_val = "Public Inquirer"
        owner_email_val = email_clean
        owner_name_val = req.name.strip() if (req.name and req.name.strip()) else "Client / Merchant"
        biz_id_val = None

    ticket = SupportTicket(
        business_id=biz_id_val,
        business_code=biz_code_val,
        business_name=biz_name_val,
        owner_email=owner_email_val,
        owner_name=owner_name_val,
        phone=phone_clean,
        category=category_val,
        priority=priority_val,
        subject=subject_clean,
        message=msg_clean,
        attachment_name=att_name,
        attachment_data=att_data,
        status="open"
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)

    if biz_code_val and biz_code_val != "PUBLIC":
        log_activity(db, biz_code_val, owner_name_val, "SUPPORT_TICKET_CREATED", f"Support ticket #{ticket.id} [{priority_val}] created: '{subject_clean}'")

    # Send confirmation email to user via Resend API
    if owner_email_val:
        confirm_subj = f"[{priority_val.upper()}] Support Ticket Created: #{ticket.id} - {ticket.subject}"
        att_badge = f'<div style="margin-top: 8px; font-size: 12px; color: #38bdf8;">📎 Attachment included: {att_name}</div>' if att_name else ''
        confirm_html = f"""
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"></head>
        <body style="margin: 0; padding: 25px 15px; background-color: #0b1120; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #f8fafc;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 540px; margin: 0 auto; background-color: #0f172a; border-radius: 14px; border: 1px solid #1e293b; padding: 28px;">
                <tr><td>
                    <div style="font-size: 20px; font-weight: 800; color: #10b981; margin-bottom: 6px;">SupiriPOS <span style="color: #38bdf8;">PRO</span> Support</div>
                    <div style="font-size: 13px; color: #94a3b8; margin-bottom: 16px;">We received your support ticket <strong>#{ticket.id}</strong></div>
                    
                    <div style="display: flex; gap: 8px; margin-bottom: 14px;">
                        <span style="background: rgba(6, 182, 212, 0.15); border: 1px solid #06b6d4; color: #06b6d4; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 6px;">{category_val}</span>
                        <span style="background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; color: #ef4444; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 6px;">Priority: {priority_val}</span>
                    </div>

                    <div style="background: rgba(16, 185, 129, 0.08); border-left: 3px solid #10b981; padding: 14px; border-radius: 6px; margin-bottom: 20px;">
                        <div style="font-size: 12px; font-weight: 700; color: #10b981; margin-bottom: 4px;">Subject: {ticket.subject}</div>
                        <div style="font-size: 13px; color: #cbd5e1; white-space: pre-wrap;">{ticket.message}</div>
                        {att_badge}
                    </div>

                    <div style="font-size: 12px; color: #94a3b8; margin-bottom: 14px;">
                        Phone on file: <strong>{phone_clean}</strong><br>
                        Business: <strong>{biz_name_val} ({biz_code_val})</strong>
                    </div>

                    <p style="font-size: 13px; color: #94a3b8; line-height: 1.5;">Our engineering team has been notified. You will receive an official response right here in this email thread once an agent reviews your inquiry.</p>
                    <div style="border-top: 1px solid #1e293b; padding-top: 16px; margin-top: 24px; text-align: center; font-size: 11px; color: #64748b;">PrasaTek System Solutions &bull; Sri Lanka</div>
                </td></tr>
            </table>
        </body></html>
        """
        send_email_in_background(
            to_email=owner_email_val,
            subject=confirm_subj,
            html_content=confirm_html,
            plain_text=f"Your ticket #{ticket.id} [{priority_val}] ({ticket.subject}) has been received. Our team will review and reply shortly.",
            context_label="TICKET-CONFIRM"
        )

    return {
        "success": True,
        "message": f"Support ticket #{ticket.id} submitted successfully! A confirmation has been sent to {owner_email_val}.",
        "ticket": {
            "id": ticket.id,
            "business_code": ticket.business_code,
            "business_name": ticket.business_name,
            "owner_email": ticket.owner_email,
            "owner_name": ticket.owner_name,
            "phone": ticket.phone,
            "category": ticket.category,
            "priority": ticket.priority,
            "subject": ticket.subject,
            "message": ticket.message,
            "attachment_name": ticket.attachment_name,
            "has_attachment": bool(ticket.attachment_data),
            "status": ticket.status,
            "created_at": ticket.created_at.isoformat() if ticket.created_at else datetime.now(timezone.utc).isoformat()
        }
    }

@app.get("/api/support/tickets")
def list_merchant_support_tickets(
    business_code: Optional[str] = None,
    email: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Lists tickets submitted by a specific business_code or email"""
    query = db.query(SupportTicket)
    if business_code and business_code.strip():
        code_clean = business_code.strip().upper()
        query = query.filter(SupportTicket.business_code == code_clean)
    elif email and email.strip():
        email_clean = email.strip().lower()
        query = query.filter(func.lower(SupportTicket.owner_email) == email_clean)
    else:
        return {"success": True, "tickets": [], "total": 0}

    tickets = query.order_by(desc(SupportTicket.created_at)).all()

    result = []
    for t in tickets:
        result.append({
            "id": t.id,
            "business_code": t.business_code,
            "business_name": t.business_name,
            "owner_email": t.owner_email,
            "phone": t.phone,
            "category": t.category,
            "priority": t.priority,
            "subject": t.subject,
            "message": t.message,
            "attachment_name": t.attachment_name,
            "attachment_data": t.attachment_data,
            "status": t.status,
            "admin_reply": t.admin_reply,
            "replied_at": t.replied_at.isoformat() if t.replied_at else None,
            "created_at": t.created_at.isoformat() if t.created_at else None
        })

    return {"success": True, "tickets": result, "total": len(result)}

@app.get("/api/admin/support/tickets")
def admin_list_support_tickets(admin: SystemAdmin = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Master Admin endpoint: lists all tickets with metadata and attachments from all businesses"""
    tickets = db.query(SupportTicket).order_by(desc(SupportTicket.created_at)).all()
    result = []
    open_count = 0
    for t in tickets:
        if t.status == "open":
            open_count += 1
        result.append({
            "id": t.id,
            "business_id": t.business_id,
            "business_code": t.business_code,
            "business_name": t.business_name or t.business_code,
            "owner_email": t.owner_email,
            "owner_name": t.owner_name,
            "phone": t.phone,
            "category": t.category or "Technical Issue",
            "priority": t.priority or "Normal",
            "subject": t.subject,
            "message": t.message,
            "attachment_name": t.attachment_name,
            "attachment_data": t.attachment_data,
            "status": t.status,
            "admin_reply": t.admin_reply,
            "replied_at": t.replied_at.isoformat() if t.replied_at else None,
            "created_at": t.created_at.isoformat() if t.created_at else None
        })

    return {
        "success": True,
        "tickets": result,
        "total": len(result),
        "open_count": open_count
    }

@app.post("/api/admin/support/tickets/{ticket_id}/reply")
def admin_reply_support_ticket(ticket_id: int, req: AdminTicketReplyRequest, admin: SystemAdmin = Depends(get_current_admin), db: Session = Depends(get_db)):
    """
    Super Admin replies to a ticket.
    Updates database status and dispatches official email reply via Resend API to the merchant.
    """
    ticket = db.query(SupportTicket).filter(SupportTicket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=404, detail="Support ticket not found.")

    reply_clean = (req.reply_message or req.reply or "").strip()
    if not reply_clean:
        raise HTTPException(status_code=400, detail="Reply message cannot be empty.")

    ticket.admin_reply = reply_clean
    ticket.status = req.status if req.status in ["open", "resolved"] else "resolved"
    ticket.replied_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(ticket)

    # Dispatch email reply via Resend API
    if ticket.owner_email:
        reply_html = f"""
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"></head>
        <body style="margin: 0; padding: 25px 15px; background-color: #0b1120; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #f8fafc;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 580px; margin: 0 auto; background-color: #0f172a; border-radius: 14px; border: 1px solid #1e293b; padding: 28px;">
                <tr>
                    <td>
                        <div style="margin-bottom: 4px;">
                            <span style="font-size: 22px; font-weight: 800; color: #10b981;">SupiriPOS <span style="color: #38bdf8;">PRO</span></span>
                        </div>
                        <p style="margin: 0 0 16px 0; font-size: 12px; color: #94a3b8;">PrasaTek System Solutions Customer Support Desk</p>
                        <div style="height: 1px; width: 100%; background: #1e293b; margin-bottom: 20px;"></div>

                        <h3 style="margin: 0 0 12px 0; color: #ffffff; font-size: 18px;">
                            Response to Ticket #{ticket.id}: {ticket.subject}
                        </h3>
                        <p style="font-size: 13.5px; color: #cbd5e1; line-height: 1.5; margin: 0 0 14px 0;">
                            Hello <strong>{ticket.owner_name or 'Store Partner'}</strong> ({ticket.business_name}),<br>
                            Our technical support team has reviewed your ticket and provided the following response:
                        </p>

                        <!-- Admin Reply Card -->
                        <div style="background: rgba(16, 185, 129, 0.08); border-left: 4px solid #10b981; border-radius: 6px; padding: 16px; margin: 18px 0;">
                            <div style="font-size: 11px; text-transform: uppercase; color: #10b981; font-weight: 700; margin-bottom: 6px;">
                                💬 Official Support Response (Status: {ticket.status.upper()})
                            </div>
                            <div style="font-size: 14px; line-height: 1.6; color: #ffffff; white-space: pre-wrap;">{reply_clean}</div>
                        </div>

                        <!-- Original Inquiry -->
                        <div style="background: #1e293b; border-radius: 8px; padding: 14px; margin: 16px 0;">
                            <div style="font-size: 11px; color: #94a3b8; font-weight: 700; margin-bottom: 4px;">Your Original Inquiry:</div>
                            <div style="font-size: 13px; color: #94a3b8; font-style: italic; white-space: pre-wrap;">{ticket.message}</div>
                        </div>

                        <p style="font-size: 12.5px; color: #64748b; line-height: 1.5; margin-top: 20px;">
                            If you have further questions or if your issue is not completely resolved, you can submit an additional ticket directly from your POS dashboard or email us at <a href="mailto:info@prasatek.lk" style="color: #38bdf8;">info@prasatek.lk</a>.
                        </p>

                        <div style="border-top: 1px solid #1e293b; padding-top: 16px; margin-top: 20px; text-align: center;">
                            <p style="margin: 0; font-size: 12px; font-weight: 700; color: #f1f5f9;">PrasaTek System Solutions</p>
                            <p style="margin: 3px 0 0 0; font-size: 11px; color: #64748b;">Enterprise Software &amp; Smart Cloud Solutions &bull; Sri Lanka</p>
                        </div>
                    </td>
                </tr>
            </table>
        </body>
        </html>
        """

        send_email_in_background(
            to_email=ticket.owner_email,
            subject=f"Re: [Ticket #{ticket.id}] {ticket.subject}",
            html_content=reply_html,
            plain_text=f"SupiriPOS PRO Support Response (Ticket #{ticket.id})\n\nOfficial Reply:\n{reply_clean}\n\nOriginal Inquiry:\n{ticket.message}\n\nStatus: {ticket.status.upper()}\nPrasaTek System Solutions",
            context_label="SUPPORT-REPLY"
        )

    return {
        "success": True,
        "message": f"Reply dispatched to {ticket.owner_email} and ticket #{ticket.id} marked as {ticket.status}.",
        "ticket": {
            "id": ticket.id,
            "status": ticket.status,
            "admin_reply": ticket.admin_reply,
            "replied_at": ticket.replied_at.isoformat() if ticket.replied_at else None
        }
    }

# ---------------------------------------------------------------------------
# Static Assets & Single Page Application Serving
# ---------------------------------------------------------------------------
# Mount /assets directory safely
assets_dir = os.path.join(os.path.dirname(__file__), "assets")
if not os.path.exists(assets_dir):
    os.makedirs(assets_dir, exist_ok=True)
app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

@app.middleware("http")
async def disable_static_cache(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith(".html") or path.endswith(".js") or path.endswith(".css"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

@app.get("/")
def serve_index():
    index_file = os.path.join(os.path.dirname(__file__), "index.html")
    if os.path.exists(index_file):
        return FileResponse(
            index_file,
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0"
            }
        )
    return JSONResponse({"status": "SupiriPOS PRO Backend is running. Please add index.html."})

# Fallback for any client side routing
@app.get("/{full_path:path}")
def serve_spa_fallback(full_path: str):
    # If file exists in assets or local, don't fallback
    if full_path.startswith("api/") or full_path.startswith("ws/") or full_path.startswith("assets/"):
        raise HTTPException(status_code=404, detail="Not Found")
    index_file = os.path.join(os.path.dirname(__file__), "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    raise HTTPException(status_code=404, detail="Not Found")
