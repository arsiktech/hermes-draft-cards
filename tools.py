"""Tool schemas and handlers. Handlers take ``(args, **kwargs)`` and always return a JSON string."""

from __future__ import annotations

import json
import logging
from typing import Any

from .store import DraftError, DraftStore, directive, plain_text

logger = logging.getLogger(__name__)

_RECIPIENTS = {
    "anyOf": [{"type": "array", "items": {"type": "string"}}, {"type": "string"}],
    "description": "Recipients: a list, or one comma-separated string. Use 'Name <address>' when you know the name.",
}

DRAFT_CARD = {
    "name": "draft_card",
    "description": (
        "Show an email or chat message you drafted for the user as a reviewable draft card, and keep "
        "every revision. Use it whenever the user asks you to write, draft, reply to or revise an email "
        "or message, BEFORE anything is sent.\n"
        "- New draft: omit draft_id. Revision: pass the same draft_id plus only the fields that change, "
        "and a short change_note. Each revision opens a new card in which the changed words are highlighted.\n"
        "- Then show it. On the Hermes desktop app, put the returned `card` line alone on its own line in "
        "your reply and do NOT repeat the draft text. On every other surface (terminal, Telegram, Slack, …) "
        "show `text_fallback` instead.\n"
        "- This tool never sends anything. When the user clicks Send on the card (or clearly approves in "
        "chat), call draft_card_read, send exactly that approved version with whatever email or messaging "
        "tool you have, then report the outcome with draft_card_status."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "draft_id": {"type": "string", "description": "Omit for a new draft. Pass it to revise an existing draft."},
            "kind": {"type": "string", "enum": ["email", "message"], "description": "email (default) or a chat message (Slack, Telegram, iMessage, X DM…)."},
            "platform": {"type": "string", "description": "Optional label shown on the card, e.g. 'Gmail', 'Apple Mail', 'Slack', 'Telegram'."},
            "from": {"type": "string", "description": "Sender address or account, if known."},
            "to": _RECIPIENTS,
            "cc": _RECIPIENTS,
            "bcc": _RECIPIENTS,
            "subject": {"type": "string", "description": "Email subject. Ignored for messages."},
            "body": {"type": "string", "description": "The full message text in plain text, with blank lines between paragraphs. Required for a new draft."},
            "change_note": {"type": "string", "description": "Revision only: a few words on what changed, e.g. 'shorter, warmer close'."},
        },
        "required": [],
    },
}

DRAFT_CARD_READ = {
    "name": "draft_card_read",
    "description": (
        "Read a draft card's current state: the latest version (the user may have edited it in the card), "
        "its status, and approved_version. Call it right before sending or saving a draft. Send only when "
        "status is 'approved' (the user clicked Send) or the user clearly approved it in chat, and send the "
        "approved version word for word."
    ),
    "parameters": {
        "type": "object",
        "properties": {"draft_id": {"type": "string", "description": "The draft id, e.g. d_1a2b3c4d."}},
        "required": ["draft_id"],
    },
}

DRAFT_CARD_STATUS = {
    "name": "draft_card_status",
    "description": (
        "Report what happened to a draft so its card updates: 'sent' after you sent it, 'saved' after you "
        "saved it to the user's drafts folder, 'failed' if sending failed (put the reason in detail), "
        "'approved' when the user approved it in chat rather than on the card, 'discarded' if the user "
        "dropped it. detail is a short human line such as 'via Gmail' or 'No email account connected'."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "draft_id": {"type": "string"},
            "status": {"type": "string", "enum": ["sent", "saved", "failed", "approved", "discarded"]},
            "detail": {"type": "string", "description": "Short outcome line shown on the card."},
        },
        "required": ["draft_id", "status"],
    },
}


def _ok(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _err(message: str, **extra: Any) -> str:
    return json.dumps({"error": message, **extra}, ensure_ascii=False)


def _notify(draft_id: str) -> None:
    """Tell connected desktop windows that a draft changed (fire-and-forget; polling covers misses)."""
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event

        broadcast_plugin_event("draft-cards", "draft.updated", {"id": draft_id})
    except Exception as exc:  # noqa: BLE001 - an event miss must never fail the tool
        logger.debug("draft-cards: event broadcast skipped: %s", exc)


def _summary(record: dict) -> dict:
    latest = record["versions"][-1]
    return {
        "draft_id": record["id"],
        "version": latest["v"],
        "status": record["status"],
        "approved_version": record["approved_version"],
        "kind": record["kind"],
        "platform": record["platform"],
        "fields": latest["fields"],
        "edited_by_user": latest["author"] == "user",
    }


def make_handlers(store_factory=DraftStore):
    def draft_card(args: dict, session_id: str = "", **_: Any) -> str:
        try:
            store = store_factory()
            fields = {k: args.get(k) for k in ("from", "to", "cc", "bcc", "subject", "body")}
            draft_id = (args.get("draft_id") or "").strip()
            if draft_id:
                record = store.revise(
                    draft_id,
                    fields=fields,
                    note=args.get("change_note") or "",
                    platform=args.get("platform"),
                )
            else:
                record = store.create(
                    kind=args.get("kind") or "email",
                    fields=fields,
                    platform=args.get("platform") or "",
                    session_id=str(session_id or ""),
                    note=args.get("change_note") or "",
                )
                store.prune()
            latest = record["versions"][-1]
            _notify(record["id"])
            return _ok({
                **_summary(record),
                "card": directive(record["id"], latest["card"]),
                "text_fallback": plain_text(record, latest),
                "next": (
                    "Desktop app: reply with a one-line intro, then the `card` line alone on its own line. "
                    "Don't paste the draft text, the card shows it. Other surfaces: show text_fallback. "
                    "Wait for the user's approval before sending."
                ),
            })
        except DraftError as exc:
            return _err(str(exc))
        except Exception as exc:  # noqa: BLE001
            logger.exception("draft_card failed")
            return _err(f"draft_card failed: {exc}")

    def draft_card_read(args: dict, **_: Any) -> str:
        try:
            record = store_factory().get((args.get("draft_id") or "").strip())
            summary = _summary(record)
            summary["text"] = plain_text(record)
            summary["history"] = [
                {"v": v["v"], "author": v["author"], "note": v["note"]} for v in record["versions"]
            ]
            return _ok(summary)
        except DraftError as exc:
            return _err(str(exc))
        except Exception as exc:  # noqa: BLE001
            logger.exception("draft_card_read failed")
            return _err(f"draft_card_read failed: {exc}")

    def draft_card_status(args: dict, **_: Any) -> str:
        try:
            draft_id = (args.get("draft_id") or "").strip()
            record = store_factory().set_status(draft_id, (args.get("status") or "").strip(), args.get("detail") or "")
            _notify(draft_id)
            return _ok({"draft_id": draft_id, "status": record["status"], "detail": record["status_detail"]})
        except DraftError as exc:
            return _err(str(exc))
        except Exception as exc:  # noqa: BLE001
            logger.exception("draft_card_status failed")
            return _err(f"draft_card_status failed: {exc}")

    return draft_card, draft_card_read, draft_card_status
