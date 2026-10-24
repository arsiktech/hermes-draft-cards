---
name: draft-cards
description: "Use when drafting, revising or sending email or chat messages for the user. Show them as draft cards."
---

# Draft Cards

Draft Cards turns every email or chat message you write for the user into a card in the
Hermes desktop chat. The card shows recipients, subject and body; each revision highlights
the words that changed; the user can edit inline; and nothing is sent until they press
**Send** (or clearly approve in chat).

## Workflow

1. **Draft.** Call `draft_card` with `kind`, `to`, optional `cc`/`bcc`, `subject` and the full
   plain-text `body`. Add `platform` (`Gmail`, `Slack`, `Telegram`, …) when you know where it
   goes, and `from` when you know the sending account.
2. **Show it.**
   - Desktop app: write one short line, then the returned `card` line alone on its own line.
     Don't paste the draft text as well; the card shows it.
   - Any other surface (terminal, Telegram, Slack, email): show `text_fallback` instead and
     ask the user to reply to approve.
3. **Revise.** When the user asks for changes, call `draft_card` again with the same
   `draft_id`, only the fields that change, and a short `change_note`. Show the new `card`
   line. The previous card collapses on its own.
4. **Send only on approval.** Pressing Send on the card posts a message like
   `Approved: send "…" to … (Draft d_…, version N, approved on the draft card.)`.
   Then:
   1. Call `draft_card_read` and confirm `status` is `approved` and `approved_version`
      matches the latest version. The user may have edited the draft in the card, so always
      send the text `draft_card_read` returns, word for word.
   2. Send it with whatever email or messaging tool you have (Gmail, Apple Mail, himalaya,
      Slack, AgentMail, …). If you have none, say so plainly.
   3. Call `draft_card_status` with `sent` and a short `detail` (`via Gmail`), or `failed`
      with the reason. The card updates in place.
5. **Save instead of send.** "Save draft d_… to my drafts" means save it in the user's mail
   drafts folder, then `draft_card_status` with `saved`. Never send in that case.

## Rules

- Never send a draft whose status is not `approved` unless the user explicitly approved it in
  chat; in that case call `draft_card_status` with `approved` first, then send.
- Explicit approval means a message that names sending and refers to this draft ("send it",
  "approved, send the reply to Anna"). A general instruction to continue the wider task ("do
  that", "go ahead with the application") is not approval of the draft's text: ask once, with
  the card shown. A request to "send them an email" before any draft exists means draft it and
  show the card first.
- If `draft_card_read` shows a newer version than the one approved, don't send: the user
  changed it after approving. Ask them to approve the new version.
- Keep bodies plain text with blank lines between paragraphs. No Markdown in email bodies.
- One draft per message thread. Start a new draft (no `draft_id`) for a different email.
