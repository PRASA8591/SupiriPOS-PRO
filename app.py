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
import smtplib
import hashlib
import ssl
import urllib.parse
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import List, Dict, Optional, Any

from fastapi import (
    FastAPI, WebSocket, WebSocketDisconnect, HTTPException,
    Depends, Request, Response, status, Query
)
from fastapi.middleware.cors import CORSMiddleware
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

# Load environment variables
load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
SECRET_KEY = os.getenv("SECRET_KEY", "supiripos-prasatek-secret-key-2026")
SMTP_HOST = os.getenv("SMTP_HOST", "smtp-relay.brevo.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_LOGIN = os.getenv("SMTP_LOGIN", os.getenv("SMTP_EMAIL", ""))
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM_EMAIL = os.getenv("SMTP_FROM_EMAIL", "info@prasatek.lk")
SMTP_FROM_NAME = os.getenv("SMTP_FROM_NAME", "PrasaTek System Solutions")
SMTP_EMAIL = SMTP_FROM_EMAIL

def send_smtp_email(to_email: str, subject: str, html_content: str) -> bool:
    """
    Sends an HTML email via Brevo SMTP relay from PrasaTek System Solutions <info@prasatek.lk>.
    """
    if not SMTP_LOGIN or not SMTP_PASSWORD:
        return False
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{SMTP_FROM_NAME} <{SMTP_FROM_EMAIL}>"
        msg["To"] = to_email
        msg.attach(MIMEText(html_content, "html", "utf-8"))

        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=8) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(SMTP_LOGIN, SMTP_PASSWORD)
            server.sendmail(SMTP_FROM_EMAIL, [to_email], msg.as_string())
        logger.info(f"[SMTP] Email sent to {to_email} via {SMTP_HOST}:{SMTP_PORT}")
        return True
    except Exception as e:
        logger.warning(f"[SMTP WARNING] Could not send email to {to_email}: {e}")
        return False

# ---------------------------------------------------------------------------
# Dual-Database Connection & Resilience Fallback
# ---------------------------------------------------------------------------
Base = declarative_base()
ACTIVE_DB_TYPE = "Unknown"
DB_STATUS_NOTE = ""

def format_database_url(raw_url: str, driver: str = "psycopg2") -> str:
    """
    Format PostgreSQL URL with specified driver and safely URL-encode any special
    characters in the user/password (such as @, #, $, %, etc.).
    """
    if not raw_url or "://" not in raw_url:
        return raw_url

    scheme_part, rest = raw_url.split("://", 1)
    target_scheme = f"postgresql+{driver}" if driver else "postgresql"

    # Separate query parameters if present
    query_str = ""
    if "?" in rest:
        rest, query_str = rest.split("?", 1)

    if "@" in rest:
        auth_part, host_part = rest.rsplit("@", 1)
        if ":" in auth_part:
            user, pwd = auth_part.split(":", 1)
            safe_user = urllib.parse.quote(urllib.parse.unquote(user), safe="")
            safe_pwd = urllib.parse.quote(urllib.parse.unquote(pwd), safe="")
            auth_str = f"{safe_user}:{safe_pwd}"
        else:
            safe_user = urllib.parse.quote(urllib.parse.unquote(auth_part), safe="")
            auth_str = safe_user
        formatted = f"{target_scheme}://{auth_str}@{host_part}"
    else:
        formatted = f"{target_scheme}://{rest}"

    if query_str:
        q_params = urllib.parse.parse_qs(query_str)
        if driver == "pg8000":
            q_params.pop("sslmode", None)
        if q_params:
            formatted += f"?{urllib.parse.urlencode(q_params, doseq=True)}"

    return formatted

def init_database_engine():
    """
    Attempts to connect to Supabase Cloud PostgreSQL with multi-driver cascade:
    1. If psycopg2 is installed/working, uses postgresql+psycopg2://...
    2. If psycopg2 fails (e.g. Windows Python 3.12+), automatically tries
       postgresql+psycopg://... or postgresql+pg8000://... (with SSL enabled for Supabase).
    3. Safely URL-encodes special characters in the password.
    4. Only falls back to local SQLite if all cloud PostgreSQL drivers fail.
    """
    global ACTIVE_DB_TYPE, DB_STATUS_NOTE
    
    use_sqlite_fallback = False
    
    # Check if URL contains placeholder or is missing
    if not DATABASE_URL or "[YOUR-PASSWORD]" in DATABASE_URL or "postgres:[YOUR-PASSWORD]" in DATABASE_URL:
        logger.warning(
            "[DB WARNING] DATABASE_URL contains placeholder '[YOUR-PASSWORD]' or is unconfigured. "
            "Activating offline resilience fallback to local SQLite."
        )
        use_sqlite_fallback = True
        DB_STATUS_NOTE = "Offline Fallback: Replace [YOUR-PASSWORD] in .env for Supabase Cloud sync"
    else:
        # Multi-driver waterfall: psycopg2 -> psycopg (v3) -> pg8000 (pure-python)
        driver_cascade = ["psycopg2", "psycopg", "pg8000"]
        last_error = None

        for driver in driver_cascade:
            try:
                # Check if driver is importable
                if driver == "psycopg2":
                    import psycopg2
                elif driver == "psycopg":
                    import psycopg
                elif driver == "pg8000":
                    import pg8000
            except ImportError as ie:
                logger.info(f"[DB] PostgreSQL driver '{driver}' is not installed ({ie}). Skipping.")
                continue

            try:
                formatted_url = format_database_url(DATABASE_URL, driver=driver)
                host_display = formatted_url.split("@")[-1].split("?")[0]
                logger.info(f"[DB] Attempting connection to Supabase PostgreSQL using driver '{driver}' on {host_display}")

                connect_args = {"connect_timeout": 5}
                if driver in ("psycopg2", "psycopg"):
                    connect_args["sslmode"] = "require"
                elif driver == "pg8000":
                    # pg8000 uses ssl_context and timeout argument
                    ctx = ssl.create_default_context()
                    ctx.check_hostname = False
                    ctx.verify_mode = ssl.CERT_NONE
                    connect_args = {"ssl_context": ctx, "timeout": 5}

                pg_engine = create_engine(
                    formatted_url,
                    pool_pre_ping=True,
                    pool_recycle=300,
                    connect_args=connect_args
                )

                # Test connection
                with pg_engine.connect() as conn:
                    conn.execute(text("SELECT 1"))

                logger.info(f"[DB SUCCESS] Connected to Supabase Cloud PostgreSQL via {driver}!")
                ACTIVE_DB_TYPE = f"Supabase PostgreSQL ({driver})"
                DB_STATUS_NOTE = f"Connected to Supabase Cloud Database via {driver}"
                return pg_engine

            except Exception as e:
                last_error = e
                logger.warning(f"[DB WARNING] Supabase connection failed with driver '{driver}': {e}")

        # If all cloud drivers fail, activate SQLite offline fallback
        logger.warning(
            f"[DB WARNING] All PostgreSQL drivers failed. Last error: {last_error}. "
            "Falling back to local SQLite (sqlite:///./supiripos_cloud.db) so system never crashes."
        )
        use_sqlite_fallback = True
        DB_STATUS_NOTE = f"Offline SQLite Fallback (Cloud error: {str(last_error)[:60]}...)"

    if use_sqlite_fallback:
        sqlite_url = "sqlite:///./supiripos_cloud.db"
        ACTIVE_DB_TYPE = "Local SQLite (Offline Resilience)"
        sqlite_engine = create_engine(
            sqlite_url,
            connect_args={"check_same_thread": False}
        )
        logger.info("[DB] SQLite database engine initialized successfully.")
        return sqlite_engine

engine = init_database_engine()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

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
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

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

# Create tables & perform safe migrations
try:
    Base.metadata.create_all(bind=engine)
    logger.info("[DB] All database tables verified / created successfully.")
    
    # Safe column migration check for pos_users.must_change_password
    with engine.connect() as conn:
        try:
            if engine.dialect.name == "sqlite":
                res = conn.execute(text("PRAGMA table_info(pos_users)")).fetchall()
                cols = [r[1] for r in res]
                if "must_change_password" not in cols:
                    conn.execute(text("ALTER TABLE pos_users ADD COLUMN must_change_password BOOLEAN DEFAULT 0"))
                    conn.commit()
            else:
                conn.execute(text("ALTER TABLE pos_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE"))
                conn.commit()
        except Exception as mig_err:
            logger.info(f"[DB] Migration check pos_users: {mig_err}")
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

# Initialize Demo Shop in DB
with SessionLocal() as db_session:
    seed_demo_supermarket(db_session)

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
    customer_name: Optional[str] = ""
    customer_phone: Optional[str] = ""
    items: List[CartItemModel]

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
    current_username: str
    current_password: str
    new_username: str
    new_password: str
    new_full_name: Optional[str] = None

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

@app.get("/api/sync/state")
def get_sync_state(business_code: str, db: Session = Depends(get_db)):
    """Fast polling fallback with delta state tracking"""
    items_count = db.query(Item).filter(Item.business_code == business_code).count()
    invoices_count = db.query(Invoice).filter(Invoice.business_code == business_code).count()
    version_num = ws_manager.business_version.get(business_code, 1)
    state_ver = f"v{version_num}_i{items_count}_inv{invoices_count}"
    return {
        "business_code": business_code,
        "version": version_num,
        "state_version": state_ver,
        "items_count": items_count,
        "invoices_count": invoices_count,
        "server_time": datetime.now(timezone.utc).isoformat()
    }

# ---------------------------------------------------------------------------
# Auth Gateways: OTP, Registration, Unlock & POS Login
# ---------------------------------------------------------------------------
@app.post("/api/auth/send-otp")
def send_otp(req: SendOTPRequest, db: Session = Depends(get_db)):
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

    # Try sending real email via Brevo SMTP
    html_content = f"""
    <div style="font-family: Arial, sans-serif; background-color: #0b1120; color: #f8fafc; padding: 30px; border-radius: 12px; max-width: 520px; margin: auto;">
        <h2 style="color: #10b981; margin-bottom: 5px;">SupiriPOS PRO</h2>
        <p style="color: #94a3b8; font-size: 14px; margin-top: 0;">Powered by {SMTP_FROM_NAME}</p>
        <div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 8px; border: 1px solid rgba(16, 185, 129, 0.3); text-align: center; margin: 20px 0;">
            <p style="margin: 0; font-size: 14px; color: #94a3b8;">Your 6-Digit Business Verification Code:</p>
            <h1 style="font-size: 38px; letter-spacing: 6px; color: #10b981; margin: 10px 0;">{otp}</h1>
            <p style="margin: 0; font-size: 12px; color: #64748b;">This OTP code expires in 10 minutes.</p>
        </div>
        <p style="font-size: 13px; color: #64748b; line-height: 1.5;">If you didn't request this verification code, please ignore this email.</p>
    </div>
    """
    email_sent = send_smtp_email(
        to_email=email_clean,
        subject=f"Your SupiriPOS PRO Verification Code: {otp}",
        html_content=html_content
    )

    return {
        "success": True,
        "otp_code": otp,  # Included so developer/tester sees OTP in toast notification immediately
        "email_sent": email_sent,
        "message": f"Verification code sent to {email_clean}. (Code: {otp})"
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

    # Send official Welcome Email via Brevo SMTP
    welcome_html = f"""
    <div style="font-family: Arial, sans-serif; background-color: #0b1120; color: #f8fafc; padding: 30px; border-radius: 12px; max-width: 560px; margin: auto;">
        <h2 style="color: #10b981; margin-bottom: 5px;">Welcome to SupiriPOS PRO!</h2>
        <p style="color: #94a3b8; font-size: 14px; margin-top: 0;">Powered by {SMTP_FROM_NAME} (pos.prasatek.lk)</p>
        <p style="font-size: 14px; color: #e2e8f0;">Hello <strong>{new_biz.owner_name}</strong>,</p>
        <p style="font-size: 14px; color: #cbd5e1; line-height: 1.5;">
            Your cloud POS terminal for <strong>{new_biz.name}</strong> has been successfully activated! Keep your credentials below safe:
        </p>
        <div style="background: rgba(255,255,255,0.05); padding: 18px; border-radius: 8px; border: 1px solid rgba(16, 185, 129, 0.3); margin: 20px 0;">
            <p style="margin: 6px 0; font-size: 14px;"><strong>Business Code:</strong> <span style="color: #06b6d4; font-family: monospace; font-size: 16px;">{business_code}</span></p>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Master Password:</strong> <span style="color: #10b981; font-family: monospace; font-size: 16px;">{req.master_password}</span></p>
            <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 12px 0;" />
            <p style="margin: 6px 0; font-size: 13px; color: #f59e0b;"><strong>First-Time Admin POS Login:</strong> Username: <code>user</code> | Password: <code>123</code> (You will be prompted to set your personal Admin credentials on first login).</p>
        </div>
        <p style="font-size: 12px; color: #64748b;">Support: {SMTP_FROM_EMAIL} | {SMTP_FROM_NAME}</p>
    </div>
    """
    send_smtp_email(
        to_email=email_clean,
        subject=f"Welcome to SupiriPOS PRO - Your Business Code: {business_code}",
        html_content=welcome_html
    )

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
    """Stage 1: Business Terminal Unlock"""
    code_clean = req.business_code.strip().upper()
    biz = db.query(Business).filter(Business.business_code == code_clean).first()

    if not biz:
        raise HTTPException(status_code=404, detail="Business code not found. Please verify and try again.")

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
    """Stage 2: POS Staff Login"""
    code_clean = req.business_code.strip().upper()
    username_clean = req.username.strip().lower()

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

@app.post("/api/auth/pos-logout")
def pos_logout(req: LogoutRequest, db: Session = Depends(get_db)):
    """Records staff logout event in activity logs"""
    log_activity(db, req.business_code, req.username, "LOGOUT", f"Staff {req.username} logged out from terminal")
    return {"success": True}

@app.post("/api/auth/change-initial-credentials")
def change_initial_credentials(req: ChangeInitialCredentialsRequest, db: Session = Depends(get_db)):
    """Forces first-time password & username change for default user/123 admin account"""
    code_clean = req.business_code.strip().upper()
    curr_user_clean = req.current_username.strip().lower()
    new_user_clean = req.new_username.strip().lower()

    user = db.query(POSUser).filter(
        POSUser.business_code == code_clean,
        POSUser.username == curr_user_clean
    ).first()

    if not user or not verify_password(req.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="Current credentials could not be verified.")

    if not new_user_clean or len(new_user_clean) < 3:
        raise HTTPException(status_code=400, detail="New username must be at least 3 characters.")

    if not req.new_password or len(req.new_password) < 4:
        raise HTTPException(status_code=400, detail="New password must be at least 4 characters.")

    if new_user_clean != curr_user_clean:
        existing = db.query(POSUser).filter(
            POSUser.business_code == code_clean,
            POSUser.username == new_user_clean
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail=f"Username '{new_user_clean}' is already in use by another staff user.")

    user.username = new_user_clean
    user.password_hash = hash_password(req.new_password)
    if req.new_full_name and req.new_full_name.strip():
        user.full_name = req.new_full_name.strip()
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
# Invoices & Billing (Real-Time Stock Deduction & Reprinting)
# ---------------------------------------------------------------------------
@app.post("/api/invoices")
async def create_invoice(req: CreateInvoiceRequest, db: Session = Depends(get_db)):
    if not req.items:
        raise HTTPException(status_code=400, detail="Invoice must contain at least one item.")

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
                staff_username=req.cashier_username,
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

    invoice = Invoice(
        business_code=req.business_code,
        invoice_number=inv_number,
        date_time=datetime.now(timezone.utc),
        cashier_username=req.cashier_username,
        payment_method=req.payment_method,
        subtotal=req.subtotal,
        discount_amount=req.discount_amount,
        discount_percent=req.discount_percent,
        tax_amount=req.tax_amount,
        grand_total=req.grand_total,
        cash_paid=req.cash_paid,
        balance_change=req.balance_change,
        customer_name=req.customer_name or "",
        customer_phone=req.customer_phone or "",
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
        "grand_total": invoice.grand_total
    })

    log_activity(db, req.business_code, req.cashier_username, "BILL_CREATED",
                 f"Created Invoice #{inv_number} ({req.payment_method}) - Total: Rs. {req.grand_total:.2f}")

    return {
        "success": True,
        "invoice_id": invoice.id,
        "invoice_number": invoice.invoice_number,
        "date_time": invoice.date_time.isoformat(),
        "cashier_username": invoice.cashier_username,
        "payment_method": invoice.payment_method,
        "subtotal": invoice.subtotal,
        "discount_amount": invoice.discount_amount,
        "grand_total": invoice.grand_total,
        "cash_paid": invoice.cash_paid,
        "balance_change": invoice.balance_change,
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

    invoices = query.order_by(desc(Invoice.date_time)).limit(200).all()

    result = []
    for inv in invoices:
        items = []
        try:
            items = json.loads(inv.items_json)
        except Exception:
            pass
        result.append({
            "id": inv.id,
            "invoice_number": inv.invoice_number,
            "date_time": inv.date_time.isoformat(),
            "cashier_username": inv.cashier_username,
            "payment_method": inv.payment_method,
            "subtotal": inv.subtotal,
            "discount_amount": inv.discount_amount,
            "grand_total": inv.grand_total,
            "cash_paid": inv.cash_paid,
            "balance_change": inv.balance_change,
            "status": inv.status,
            "items_count": len(items),
            "items": items
        })
    return result

@app.post("/api/invoices/{invoice_id}/void")
async def void_invoice(invoice_id: int, business_code: str, db: Session = Depends(get_db)):
    """Void invoice and restore item stock automatically"""
    inv = db.query(Invoice).filter(Invoice.id == invoice_id, Invoice.business_code == business_code).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found.")

    if inv.status == "VOIDED":
        raise HTTPException(status_code=400, detail="This invoice is already voided.")

    inv.status = "VOIDED"

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
                    staff_username="Admin",
                    note=f"Stock Restored from Voided Invoice #{inv.invoice_number}"
                )
                db.add(log)
    except Exception as e:
        logger.error(f"[VOID ERROR] {e}")

    db.commit()

    await ws_manager.broadcast(business_code, {
        "type": "INVOICE_VOIDED",
        "invoice_id": inv.id,
        "invoice_number": inv.invoice_number
    })

    log_activity(db, business_code, "Staff", "BILL_VOIDED",
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
    total_bills = len(invoices)

    for inv in invoices:
        total_sales += inv.grand_total
        try:
            items = json.loads(inv.items_json)
            for it in items:
                total_cost += float(it.get("cost_price", 0.0)) * float(it.get("quantity", 1.0))
        except Exception:
            pass

    net_profit = max(0.0, total_sales - total_cost)

    # Low stock items count for this business
    low_stock_count = db.query(Item).filter(
        Item.business_code == business_code,
        Item.stock_quantity <= Item.low_stock_level
    ).count()

    return {
        "total_sales": round(total_sales, 2),
        "net_profit": round(net_profit, 2),
        "total_bills": total_bills,
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
        "Invoice Number,Date Time,Cashier,Payment Method,Subtotal (Rs.),Discount (Rs.),Grand Total (Rs.),Status,Items Count\n"
    ]
    for inv in invoices_data:
        line = f'"{inv["invoice_number"]}","{inv["date_time"]}","{inv["cashier_username"]}","{inv["payment_method"]}",{inv["subtotal"]},{inv["discount_amount"]},{inv["grand_total"]},"{inv["status"]}",{inv["items_count"]}\n'
        csv_lines.append(line)

    csv_data = "".join(csv_lines)
    return Response(
        content=csv_data,
        media_type="text/csv",
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
        change = l.quantity_change
        qty_in = change if change > 0 else 0.0
        qty_out = abs(change) if change < 0 else 0.0
        movements.append({
            "id": l.id,
            "created_at": l.created_at.isoformat() if l.created_at else "",
            "log_type": l.log_type,
            "reference": l.note or "-",
            "qty_in": qty_in,
            "qty_out": qty_out,
            "previous_stock": l.previous_stock,
            "new_stock": l.new_stock,
            "staff_username": l.staff_username or "System"
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
    action_type: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = 150,
    db: Session = Depends(get_db)
):
    """Fetches staff audit logs with granular user and action filters"""
    query = db.query(ActivityLog).filter(ActivityLog.business_code == business_code)

    if username and username.upper() != "ALL":
        query = query.filter(ActivityLog.username == username.strip().lower())

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

    return [{
        "id": l.id,
        "username": l.username,
        "action_type": l.action_type,
        "details": l.details,
        "created_at": l.created_at.isoformat() if l.created_at else ""
    } for l in logs]

# ---------------------------------------------------------------------------
# Static Assets & Single Page Application Serving
# ---------------------------------------------------------------------------
# Mount /assets directory safely
assets_dir = os.path.join(os.path.dirname(__file__), "assets")
if not os.path.exists(assets_dir):
    os.makedirs(assets_dir, exist_ok=True)
app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

@app.get("/")
def serve_index():
    index_file = os.path.join(os.path.dirname(__file__), "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
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
