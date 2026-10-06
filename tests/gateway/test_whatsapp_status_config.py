"""Focused contracts for WhatsApp status config handoff and bridge reuse."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from plugins.platforms.whatsapp import adapter


@pytest.fixture
def reuse_adapter(tmp_path):
    obj = object.__new__(adapter.WhatsAppAdapter)
    obj.platform = adapter.Platform.WHATSAPP
    obj._bridge_port = 3000
    obj._send_read_receipts = False
    obj._inbox_capture_enabled = False
    obj._inbox_capture_since = "1970-01-01T00:00:00Z"
    obj._status_publishing_enabled = False
    obj._session_path = tmp_path / "session"
    obj._session_path.parent.mkdir(exist_ok=True)
    obj._reply_prefix = None
    obj._dm_policy = "pairing"
    obj._group_policy = "pairing"
    obj._allow_from = set()
    obj._group_allow_from = set()
    obj._bridge_process = None
    obj._attach_to_bridge = lambda process: None
    obj._wire_plugin_handlers = lambda process: None
    obj._mark_connected = lambda: None
    return obj


def _health_payload(bridge_file, **extra):
    return {
        "status": "connected",
        "scriptHash": adapter._file_content_hash(bridge_file),
        "sendReadReceipts": False,
        "inboxCaptureEnabled": False,
        "inboxCaptureSince": "1970-01-01T00:00:00Z",
        "inboxCaptureDir": str(bridge_file.parent / "inbox"),
        **extra,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_field", "expected"),
    [(None, True), (False, True), (True, False)],
)
async def test_reuse_compares_status_flag_when_bridge_reports_it(reuse_adapter, tmp_path, monkeypatch, status_field, expected):
    bridge_file = tmp_path / "bridge.js"
    bridge_file.write_text("bridge", encoding="utf-8")
    payload = _health_payload(bridge_file)
    if status_field is not None:
        payload["statusPublishingEnabled"] = status_field
    monkeypatch.setattr(reuse_adapter, "_probe_bridge_health", lambda: _ready(payload))
    assert await reuse_adapter._reuse_running_bridge(bridge_file) is expected


async def _ready(payload):
    return True, payload


def test_bridge_env_always_hands_effective_status_value(monkeypatch, tmp_path):
    obj = object.__new__(adapter.WhatsAppAdapter)
    obj._send_read_receipts = False
    obj._inbox_capture_enabled = False
    obj._status_publishing_enabled = True
    obj._inbox_capture_since = "1970-01-01T00:00:00Z"
    obj._reply_prefix = None
    obj._bridge_process = None
    obj._session_path = tmp_path / "session"
    obj._dm_policy = "pairing"
    obj._group_policy = "pairing"
    obj._allow_from = set()
    obj._group_allow_from = set()
    monkeypatch.setattr(adapter, "with_hermes_node_path", lambda: {})
    monkeypatch.setattr(adapter, "_wenv", lambda name, default="": default)
    monkeypatch.setattr(adapter, "_cache_dirs", lambda: (tmp_path, tmp_path, tmp_path, tmp_path))
    env = obj._bridge_env()
    assert env["WHATSAPP_STATUS_PUBLISHING_ENABLED"] == "true"
    obj._status_publishing_enabled = False
    assert obj._bridge_env()["WHATSAPP_STATUS_PUBLISHING_ENABLED"] == "false"
