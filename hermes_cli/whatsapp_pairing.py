"""Environment bridge for WhatsApp QR pairing."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def build_pairing_bridge_env(
    base_env: dict[str, str], whatsapp_config: dict[str, Any], inbox_dir: Path
) -> dict[str, str]:
    """Copy passive inbox settings into the Node pairing subprocess."""
    env = dict(base_env)
    capture = whatsapp_config.get("inbox_capture")
    if not isinstance(capture, dict):
        return env

    enabled = capture.get("enabled", False)
    env["WHATSAPP_INBOX_CAPTURE_ENABLED"] = (
        "true" if enabled is True or str(enabled).lower() in {"1", "true", "yes", "on"} else "false"
    )
    env["WHATSAPP_INBOX_CAPTURE_SINCE"] = str(
        capture.get("since") or "1970-01-01T00:00:00Z"
    )
    env["WHATSAPP_INBOX_CAPTURE_DIR"] = str(inbox_dir)
    return env


def pairing_bridge_env() -> dict[str, str]:
    """Resolve the active profile's config for an interactive QR pairing."""
    from hermes_cli.config import load_config
    from hermes_constants import get_hermes_home, with_hermes_node_path

    config = load_config()
    whatsapp_config = config.get("whatsapp")
    if not isinstance(whatsapp_config, dict):
        whatsapp_config = {}
    return build_pairing_bridge_env(
        with_hermes_node_path(),
        whatsapp_config,
        get_hermes_home() / "whatsapp" / "inbox",
    )
