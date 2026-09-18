"""WhatsApp inbox capture config stays profile-scoped through YAML and bridge startup."""

import os
from pathlib import Path

import pytest

from agent import secret_scope as ss
from plugins.platforms.whatsapp import adapter
from plugins.platforms.whatsapp.adapter import _apply_yaml_config


def test_inbox_capture_yaml_supports_false_and_string_date(monkeypatch):
    monkeypatch.delenv("WHATSAPP_INBOX_CAPTURE_ENABLED", raising=False)
    monkeypatch.delenv("WHATSAPP_INBOX_CAPTURE_SINCE", raising=False)

    extra = _apply_yaml_config({}, {"inbox_capture": {"enabled": False, "since": "2026-02-03T04:05:06Z"}})

    assert extra == {"inbox_capture_enabled": False, "inbox_capture_since": "2026-02-03T04:05:06Z"}
    assert os.environ["WHATSAPP_INBOX_CAPTURE_ENABLED"] == "false"
    assert os.environ["WHATSAPP_INBOX_CAPTURE_SINCE"] == "2026-02-03T04:05:06Z"


def test_inbox_capture_yaml_does_not_leak_between_profiles(monkeypatch):
    monkeypatch.delenv("WHATSAPP_INBOX_CAPTURE_ENABLED", raising=False)
    monkeypatch.delenv("WHATSAPP_INBOX_CAPTURE_SINCE", raising=False)
    ss.set_multiplex_active(True)
    token = ss.set_secret_scope({})
    try:
        assert _apply_yaml_config({}, {"inbox_capture": {"enabled": True, "since": "2026-03-01"}}) == {
            "inbox_capture_enabled": True,
            "inbox_capture_since": "2026-03-01",
        }
        assert "WHATSAPP_INBOX_CAPTURE_ENABLED" not in os.environ
        assert "WHATSAPP_INBOX_CAPTURE_SINCE" not in os.environ
    finally:
        ss.reset_secret_scope(token)
        ss.set_multiplex_active(False)


def test_bridge_child_env_contains_effective_capture_settings(monkeypatch, tmp_path):
    child_env = {"LAUNCH_ONLY": "default", "WHATSAPP_INBOX_CAPTURE_ENABLED": "stale"}
    monkeypatch.setattr(adapter, "with_hermes_node_path", lambda: dict(child_env))
    monkeypatch.setattr(adapter, "_cache_dirs", lambda: (tmp_path / "i", tmp_path / "a", tmp_path / "v", tmp_path / "d"))
    monkeypatch.setattr(adapter, "_wenv", lambda key, default=None: default)

    instance = object.__new__(adapter.WhatsAppAdapter)
    instance._reply_prefix = None
    instance._send_read_receipts = False
    instance._inbox_capture_enabled = True
    instance._inbox_capture_since = "2026-04-05T06:07:08Z"
    instance._session_path = tmp_path / "platforms" / "whatsapp" / "session"
    instance._dm_policy = "pairing"
    instance._allow_from = set()

    result = instance._bridge_env()

    assert result["WHATSAPP_INBOX_CAPTURE_ENABLED"] == "true"
    assert result["WHATSAPP_INBOX_CAPTURE_SINCE"] == "2026-04-05T06:07:08Z"
    assert result["WHATSAPP_INBOX_CAPTURE_DIR"] == str(instance._session_path.parent / "inbox")
    assert result["LAUNCH_ONLY"] == "default"
