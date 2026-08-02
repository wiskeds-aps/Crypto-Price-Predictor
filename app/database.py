import os
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("CRYPTOSKRINER_DATA_DIR", PROJECT_ROOT / "data"))
if not DATA_DIR.is_absolute():
    DATA_DIR = PROJECT_ROOT / DATA_DIR

DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{(DATA_DIR / 'crypto.db').as_posix()}")
engine_kwargs = {}
if DATABASE_URL.startswith("sqlite"):
    sqlite_timeout = float(os.environ.get("CRYPTOSKRINER_SQLITE_TIMEOUT_SEC", "30"))
    engine_kwargs["connect_args"] = {"check_same_thread": False, "timeout": sqlite_timeout}

engine = create_engine(DATABASE_URL, **engine_kwargs)

if DATABASE_URL.startswith("sqlite"):
    _busy_timeout_ms = int(float(os.environ.get("CRYPTOSKRINER_SQLITE_TIMEOUT_SEC", "30")) * 1000)

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute(f"PRAGMA busy_timeout={_busy_timeout_ms}")
        cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
