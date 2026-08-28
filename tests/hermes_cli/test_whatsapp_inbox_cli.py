import argparse
import json

from plugins.platforms.whatsapp.inbox_cli import load_inbox_records, register_cli
from hermes_cli.subcommands.whatsapp import build_whatsapp_parser


def _write_records(root, records):
    inbox = root / "whatsapp" / "inbox"
    inbox.mkdir(parents=True)
    (inbox / "messages.jsonl").write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )


def test_load_inbox_records_is_profile_scoped_and_filters_by_chat_query_and_time(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _write_records(tmp_path, [
        {
            "messageId": "1", "chatName": "Dinant", "senderName": "Dinant",
            "body": "January note", "timestamp": 1767225600, "links": [], "mediaPaths": [],
        },
        {
            "messageId": "2", "chatName": "Dinant", "senderName": "Me",
            "body": "See https://example.com", "timestamp": 1787832000,
            "links": ["https://example.com"], "mediaPaths": ["/archive/image.jpg"],
        },
        {
            "messageId": "3", "chatName": "Other", "senderName": "Other",
            "body": "unrelated", "timestamp": 1787832001, "links": [], "mediaPaths": [],
        },
    ])

    records = load_inbox_records(chat="dinant", query="example", since="2026-08-01", limit=10)

    assert [record["messageId"] for record in records] == ["2"]
    assert records[0]["mediaPaths"] == ["/archive/image.jpg"]


def test_register_cli_exposes_machine_readable_filters():
    parser = argparse.ArgumentParser()
    register_cli(parser)

    args = parser.parse_args(["--chat", "Dinant", "--since", "2026-01-01", "--limit", "25", "--json"])

    assert args.chat == "Dinant"
    assert args.since == "2026-01-01"
    assert args.limit == 25
    assert args.json is True


def test_loader_preserves_unicode_line_separators_inside_messages(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    inbox = tmp_path / "whatsapp" / "inbox"
    inbox.mkdir(parents=True)
    record = {
        "timestamp": 1767225600,
        "chatName": "Dinant",
        "body": "before\u2028after",
    }
    (inbox / "messages.jsonl").write_text(
        json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    rows = load_inbox_records()

    assert rows == [record]


def test_whatsapp_inbox_is_available_under_existing_whatsapp_command():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command")
    setup_handler = object()
    inbox_handler = object()
    build_whatsapp_parser(
        subparsers,
        cmd_whatsapp=setup_handler,
        cmd_whatsapp_inbox=inbox_handler,
    )

    setup_args = parser.parse_args(["whatsapp"])
    inbox_args = parser.parse_args(["whatsapp", "inbox", "--json"])

    assert setup_args.func is setup_handler
    assert inbox_args.func is inbox_handler
    assert inbox_args.json is True
