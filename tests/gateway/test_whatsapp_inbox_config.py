from plugins.platforms.whatsapp.adapter import _apply_yaml_config


def test_inbox_capture_yaml_enables_passive_archive_and_history_start(monkeypatch):
    monkeypatch.delenv("WHATSAPP_INBOX_CAPTURE_ENABLED", raising=False)
    monkeypatch.delenv("WHATSAPP_INBOX_CAPTURE_SINCE", raising=False)

    _apply_yaml_config({}, {
        "inbox_capture": {
            "enabled": True,
            "since": "2026-01-01T00:00:00Z",
        }
    })

    assert __import__("os").environ["WHATSAPP_INBOX_CAPTURE_ENABLED"] == "true"
    assert __import__("os").environ["WHATSAPP_INBOX_CAPTURE_SINCE"] == "2026-01-01T00:00:00Z"
