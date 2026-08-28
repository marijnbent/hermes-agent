"""Read-only CLI access to the passive WhatsApp inbox archive."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from hermes_constants import get_hermes_home


def inbox_root() -> Path:
    return get_hermes_home() / "whatsapp" / "inbox"


def _timestamp(value: str | None) -> float | None:
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def load_inbox_records(
    *,
    chat: str | None = None,
    query: str | None = None,
    since: str | None = None,
    before: str | None = None,
    limit: int = 100,
    root: Path | None = None,
) -> list[dict[str, Any]]:
    """Return newest matching archived messages without mutating the archive."""
    index_path = (root or inbox_root()) / "messages.jsonl"
    if not index_path.exists():
        return []

    chat_needle = (chat or "").casefold()
    query_needle = (query or "").casefold()
    since_ts = _timestamp(since)
    before_ts = _timestamp(before)
    records: list[dict[str, Any]] = []
    with index_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except (json.JSONDecodeError, TypeError):
                continue
            timestamp = float(record.get("timestamp") or 0)
            if since_ts is not None and timestamp < since_ts:
                continue
            if before_ts is not None and timestamp >= before_ts:
                continue
            chat_text = " ".join(
                str(record.get(key) or "")
                for key in ("chatName", "chatId", "senderName", "senderId")
            ).casefold()
            if chat_needle and chat_needle not in chat_text:
                continue
            searchable = " ".join(
                [chat_text, str(record.get("body") or "")]
                + [str(link) for link in record.get("links") or []]
            ).casefold()
            if query_needle and query_needle not in searchable:
                continue
            records.append(record)

    records.sort(key=lambda item: float(item.get("timestamp") or 0), reverse=True)
    return records[: max(0, int(limit))]


def register_cli(parser) -> None:
    parser.add_argument("--chat", help="Contact/group name or WhatsApp ID")
    parser.add_argument("--query", help="Search message text and links")
    parser.add_argument("--since", help="Inclusive ISO date/time lower bound")
    parser.add_argument("--before", help="Exclusive ISO date/time upper bound")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")


def whatsapp_inbox_command(args) -> int:
    records = load_inbox_records(
        chat=args.chat,
        query=args.query,
        since=args.since,
        before=args.before,
        limit=args.limit,
    )
    if args.json:
        print(json.dumps(records, ensure_ascii=False, indent=2))
        return 0
    if not records:
        print("No archived WhatsApp messages matched.")
        return 0
    for record in records:
        direction = "→" if record.get("direction") == "outgoing" else "←"
        name = record.get("chatName") or record.get("chatId") or "unknown"
        body = record.get("body") or f"[{record.get('mediaType') or 'message'}]"
        print(f"{record.get('timestampIso', '')} {direction} {name}: {body}")
        for media_path in record.get("mediaPaths") or []:
            print(f"  media: {media_path}")
    return 0
