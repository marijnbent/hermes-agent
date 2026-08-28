"""``hermes whatsapp`` subcommand parser.

Extracted verbatim from ``hermes_cli/main.py:main()`` (god-file Phase 2).
Handler injected to avoid importing ``main``.
"""

from __future__ import annotations

from typing import Callable


def build_whatsapp_parser(
    subparsers,
    *,
    cmd_whatsapp: Callable,
    cmd_whatsapp_inbox: Callable,
) -> None:
    """Attach the ``whatsapp`` subcommand to ``subparsers``."""
    # =========================================================================
    # whatsapp command
    # =========================================================================
    whatsapp_parser = subparsers.add_parser(
        "whatsapp",
        help="Set up WhatsApp integration",
        description="Configure WhatsApp and pair via QR code",
    )
    whatsapp_parser.set_defaults(func=cmd_whatsapp)
    whatsapp_subparsers = whatsapp_parser.add_subparsers(dest="whatsapp_command")
    inbox_parser = whatsapp_subparsers.add_parser(
        "inbox",
        help="Query the passive WhatsApp inbox archive",
        description="Search messages captured by the read-only WhatsApp inbox archive",
    )
    from plugins.platforms.whatsapp.inbox_cli import register_cli

    register_cli(inbox_parser)
    inbox_parser.set_defaults(func=cmd_whatsapp_inbox)
