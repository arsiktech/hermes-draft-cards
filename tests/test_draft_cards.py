"""Behaviour tests for the store, the agent tools and the backend routes.

Run from the repo root with Hermes's Python:  python -m pytest tests -q
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _load_package():
    """Import the plugin as a package named ``draft_cards`` (the way Hermes namespaces it)."""
    spec = importlib.util.spec_from_file_location("draft_cards", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
    module = importlib.util.module_from_spec(spec)
    sys.modules["draft_cards"] = module
    spec.loader.exec_module(module)
    return module


pkg = _load_package()
store_mod = sys.modules["draft_cards.store"]
tools_mod = sys.modules["draft_cards.tools"]


@pytest.fixture(autouse=True)
def _no_event_bridge(monkeypatch):
    """The live desktop event bridge is Hermes's; tests only check that a notify happens."""
    calls = []
    monkeypatch.setattr(tools_mod, "_notify", calls.append)
    return calls


@pytest.fixture()
def store(tmp_path):
    db = tmp_path / "drafts.db"
    clock = iter(range(1_000, 10_000))
    return store_mod.DraftStore(connect=lambda: sqlite3.connect(db), clock=lambda: float(next(clock)))


def _email(**over):
    base = {"to": "Sarah Chen <sarah@example.com>", "subject": "Moving Friday's review", "body": "Hi Sarah,\n\nCan we move it?\n\nThanks, Matt"}
    base.update(over)
    return base


def test_create_assigns_card_one_and_normalises(store):
    rec = store.create(kind="email", fields=_email(cc="a@x.com; b@x.com, a@x.com"), session_id="s1")
    assert store_mod.DraftStore.valid_id(rec["id"])
    assert rec["status"] == "draft" and rec["latest_version"] == 1 and rec["latest_card"] == 1
    fields = rec["versions"][0]["fields"]
    assert fields["to"] == ["Sarah Chen <sarah@example.com>"]
    assert fields["cc"] == ["a@x.com", "b@x.com"]  # split + deduped


def test_quoted_display_names_are_not_split():
    assert store_mod.split_recipients('"Chen, Sarah" <sarah@x.com>, bob@x.com') == ['"Chen, Sarah" <sarah@x.com>', "bob@x.com"]


def test_message_kind_drops_email_only_fields(store):
    rec = store.create(kind="message", fields={"to": "#design", "subject": "ignored", "cc": "x@y.z", "body": "Ship it"})
    f = rec["versions"][0]["fields"]
    assert f["subject"] == "" and f["cc"] == [] and f["to"] == ["#design"]


def test_agent_revision_opens_new_card_and_carries_fields(store):
    rec = store.create(kind="email", fields=_email())
    rec = store.revise(rec["id"], fields={"body": "Hi Sarah, can we push it to 2 PM? Thanks, Matt"}, note="shorter")
    latest = rec["versions"][-1]
    assert latest["v"] == 2 and latest["card"] == 2 and latest["author"] == "agent"
    assert latest["fields"]["subject"] == "Moving Friday's review"  # carried over


def test_identical_agent_revision_is_rejected(store):
    rec = store.create(kind="email", fields=_email())
    with pytest.raises(store_mod.DraftError):
        store.revise(rec["id"], fields={})


def test_user_edit_stays_on_its_card_and_needs_fresh_base(store):
    rec = store.create(kind="email", fields=_email())
    rec = store.revise(rec["id"], fields={"subject": "New subject"}, author="user", card=1, base_version=1)
    assert rec["versions"][-1]["card"] == 1 and rec["versions"][-1]["author"] == "user"
    with pytest.raises(store_mod.DraftError) as stale:
        store.revise(rec["id"], fields={"subject": "Stale"}, author="user", card=1, base_version=1)
    assert stale.value.code == 409


def test_no_op_user_edit_is_quietly_accepted(store):
    rec = store.create(kind="email", fields=_email())
    again = store.revise(rec["id"], fields={"subject": "Moving Friday's review"}, author="user", card=1, base_version=1)
    assert again["latest_version"] == 1


def test_approval_pins_latest_and_any_edit_clears_it(store):
    rec = store.create(kind="email", fields=_email())
    with pytest.raises(store_mod.DraftError):
        store.approve(rec["id"], 2)
    rec = store.approve(rec["id"], 1)
    assert rec["status"] == "approved" and rec["approved_version"] == 1
    rec = store.revise(rec["id"], fields={"body": "Changed"})
    assert rec["status"] == "draft" and rec["approved_version"] is None


def test_sent_drafts_are_frozen_for_users(store):
    rec = store.create(kind="email", fields=_email())
    store.approve(rec["id"], 1)
    store.set_status(rec["id"], "sent", "via Gmail")
    with pytest.raises(store_mod.DraftError):
        store.revise(rec["id"], fields={"body": "late edit"}, author="user", card=1, base_version=1)
    with pytest.raises(store_mod.DraftError):
        store.set_status(rec["id"], "discarded", by="user")
    with pytest.raises(store_mod.DraftError):
        store.set_status(rec["id"], "sent", by="user")  # users can never claim a send


def test_invalid_ids_never_touch_the_database(store):
    for bad in ("../etc/passwd", "d_XYZ", "", None, "d_123"):
        with pytest.raises(store_mod.DraftError):
            store.get(bad)


def test_limits_are_enforced(store):
    rec = store.create(kind="email", fields=_email(body="x" * 50_000, subject="s" * 999, to=[f"u{i}@x.com" for i in range(80)]))
    f = rec["versions"][0]["fields"]
    assert len(f["body"]) == 20_000 and len(f["subject"]) == 300 and len(f["to"]) == 50


def test_prune_keeps_most_recent(store):
    ids = [store.create(kind="email", fields=_email(body=f"b{i}"))["id"] for i in range(5)]
    assert store.prune(keep=2) == 3
    assert [r["id"] for r in store.recent()] == ids[-1:-3:-1]


# ---------------------------------------------------------------- tools
@pytest.fixture()
def handlers(store):
    return tools_mod.make_handlers(lambda: store)


def test_tool_roundtrip_create_revise_read_status(handlers, _no_event_bridge):
    draft, read, status = handlers
    out = json.loads(draft({**_email(), "platform": "Gmail"}, session_id="sess-1"))
    assert out["card"] == f'::draft-card{{id="{out["draft_id"]}" v="1"}}'
    assert "Subject: Moving Friday's review" in out["text_fallback"]
    out2 = json.loads(draft({"draft_id": out["draft_id"], "body": "Shorter.", "change_note": "shorter"}))
    assert out2["card"].endswith('v="2"}') and out2["version"] == 2
    got = json.loads(read({"draft_id": out["draft_id"]}))
    assert got["status"] == "draft" and got["fields"]["body"] == "Shorter." and len(got["history"]) == 2
    done = json.loads(status({"draft_id": out["draft_id"], "status": "sent", "detail": "via Gmail"}))
    assert done == {"draft_id": out["draft_id"], "status": "sent", "detail": "via Gmail"}
    assert _no_event_bridge == [out["draft_id"]] * 3  # create, revise, status each tell the desktop


def test_tool_errors_are_json_not_exceptions(handlers):
    draft, read, status = handlers
    assert "error" in json.loads(draft({"subject": "no body"}))
    assert "error" in json.loads(read({"draft_id": "nope"}))
    assert "error" in json.loads(status({"draft_id": "d_00000000", "status": "sent"}))


def test_schemas_are_wellformed():
    for schema in (tools_mod.DRAFT_CARD, tools_mod.DRAFT_CARD_READ, tools_mod.DRAFT_CARD_STATUS):
        assert schema["name"].startswith("draft_card") and schema["parameters"]["type"] == "object"
        json.dumps(schema)


# ---------------------------------------------------------------- routes
def test_routes_with_fastapi(store, monkeypatch):
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    spec = importlib.util.spec_from_file_location("draft_cards_api_test", ROOT / "dashboard" / "plugin_api.py")
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    # The router loads its own copy of store.py (as Hermes does), so build the store from that copy:
    # its DraftError is the class the router maps to HTTP status codes.
    api_store = api._store.DraftStore(connect=store._connect, clock=store._clock)
    monkeypatch.setattr(api._store, "DraftStore", lambda: api_store)
    monkeypatch.setattr(api, "_notify", lambda _id: None)
    app = fastapi.FastAPI()
    app.include_router(api.router, prefix="/api/plugins/draft-cards")
    client = TestClient(app)

    rec = store.create(kind="email", fields=_email())
    base = f"/api/plugins/draft-cards/drafts/{rec['id']}"
    assert client.get(base).json()["latest_version"] == 1
    assert client.get("/api/plugins/draft-cards/drafts/..%2F..%2Fx").status_code in (400, 404)
    edited = client.post(f"{base}/edit", json={"base_version": 1, "card": 1, "fields": {"subject": "Edited", "evil": "x"}}).json()
    assert edited["versions"][-1]["fields"]["subject"] == "Edited" and "evil" not in edited["versions"][-1]["fields"]
    assert client.post(f"{base}/edit", json={"base_version": 1, "card": 1, "fields": {"subject": "x"}}).status_code == 409
    assert client.post(f"{base}/approve", json={"version": 2}).json()["status"] == "approved"
    assert client.post(f"{base}/state", json={"status": "sent"}).status_code == 400
    assert client.post(f"{base}/state", json={"status": "draft"}).json()["approved_version"] is None
