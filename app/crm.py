"""Small SQLite-backed mock CRM store used by the structured tool-adapter demo."""

from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import sqlite3
import threading
from uuid import uuid4

from .schemas import TicketCreateRequest, TicketRecord, TicketStatus


class TicketNotFoundError(KeyError):
    """Raised when a ticket id is not found in the mock CRM."""


class SQLiteTicketStore:
    """A minimal, parameterized SQLite repository for demonstrable CRM actions."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._initialise()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialise(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS tickets (
                    ticket_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    contact_name TEXT,
                    priority TEXT NOT NULL,
                    source_plan_id TEXT,
                    metadata_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)"
            )

    @staticmethod
    def _now() -> datetime:
        return datetime.now(UTC).replace(microsecond=0)

    @staticmethod
    def _from_row(row: sqlite3.Row) -> TicketRecord:
        return TicketRecord(
            ticket_id=row["ticket_id"],
            title=row["title"],
            description=row["description"],
            contact_name=row["contact_name"],
            priority=row["priority"],
            source_plan_id=row["source_plan_id"],
            metadata=json.loads(row["metadata_json"]),
            status=row["status"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    def create_ticket(self, ticket: TicketCreateRequest) -> TicketRecord:
        """Create one mock CRM ticket and return its persisted representation."""

        now = self._now()
        ticket_id = f"TCK-{uuid4().hex[:10].upper()}"
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO tickets (
                    ticket_id, title, description, contact_name, priority,
                    source_plan_id, metadata_json, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ticket_id,
                    ticket.title,
                    ticket.description,
                    ticket.contact_name,
                    ticket.priority,
                    ticket.source_plan_id,
                    json.dumps(ticket.metadata, ensure_ascii=False, sort_keys=True),
                    "open",
                    now.isoformat(),
                    now.isoformat(),
                ),
            )
        return TicketRecord(
            ticket_id=ticket_id,
            title=ticket.title,
            description=ticket.description,
            contact_name=ticket.contact_name,
            priority=ticket.priority,
            source_plan_id=ticket.source_plan_id,
            metadata=ticket.metadata,
            status="open",
            created_at=now,
            updated_at=now,
        )

    def get_ticket(self, ticket_id: str) -> TicketRecord:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM tickets WHERE ticket_id = ?", (ticket_id,)
            ).fetchone()
        if row is None:
            raise TicketNotFoundError(ticket_id)
        return self._from_row(row)

    def query_tickets(
        self,
        *,
        status: TicketStatus | None = None,
        contact_name: str | None = None,
        limit: int = 20,
    ) -> list[TicketRecord]:
        """Query tickets with a deliberately small allow-listed filter surface."""

        clauses: list[str] = []
        values: list[object] = []
        if status:
            clauses.append("status = ?")
            values.append(status)
        if contact_name:
            clauses.append("contact_name = ?")
            values.append(contact_name.strip())
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        values.append(max(1, min(limit, 100)))
        with self._connect() as connection:
            rows = connection.execute(
                f"SELECT * FROM tickets{where} ORDER BY created_at DESC LIMIT ?", values
            ).fetchall()
        return [self._from_row(row) for row in rows]
