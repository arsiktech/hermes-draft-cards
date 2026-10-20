"""Draft Cards: reviewable email and message drafts, rendered as cards in the Hermes desktop chat."""

from __future__ import annotations

from pathlib import Path

from . import tools

TOOLSET = "draft_cards"


def register(ctx) -> None:
    draft_card, draft_card_read, draft_card_status = tools.make_handlers()
    ctx.register_tool(name="draft_card", toolset=TOOLSET, schema=tools.DRAFT_CARD, handler=draft_card,
                      description="Show a reviewable email or message draft card", emoji="✉️")
    ctx.register_tool(name="draft_card_read", toolset=TOOLSET, schema=tools.DRAFT_CARD_READ, handler=draft_card_read,
                      description="Read a draft card's latest version and approval", emoji="✉️")
    ctx.register_tool(name="draft_card_status", toolset=TOOLSET, schema=tools.DRAFT_CARD_STATUS,
                      handler=draft_card_status, description="Report a draft's outcome on its card", emoji="✉️")

    skill = Path(__file__).parent / "skills" / "draft-cards" / "SKILL.md"
    if skill.exists():
        ctx.register_skill("draft-cards", skill)
