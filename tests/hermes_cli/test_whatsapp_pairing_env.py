from pathlib import Path

from hermes_cli.whatsapp_pairing import build_pairing_bridge_env


def test_pairing_bridge_inherits_inbox_capture_config(tmp_path):
    env = build_pairing_bridge_env(
        {"PATH": "/bin"},
        {"inbox_capture": {"enabled": True, "since": "2026-01-01T00:00:00Z"}},
        tmp_path / "whatsapp" / "inbox",
    )

    assert env["PATH"] == "/bin"
    assert env["WHATSAPP_INBOX_CAPTURE_ENABLED"] == "true"
    assert env["WHATSAPP_INBOX_CAPTURE_SINCE"] == "2026-01-01T00:00:00Z"
    assert env["WHATSAPP_INBOX_CAPTURE_DIR"] == str(tmp_path / "whatsapp" / "inbox")
