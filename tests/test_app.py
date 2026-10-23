from fastapi.testclient import TestClient

from straddloop.app.main import SECTIONS, app


def test_every_section_renders_and_unbuilt_ones_say_so(tmp_path, monkeypatch):
    monkeypatch.setenv("STRADDLOOP_HOME", str(tmp_path))
    client = TestClient(app)
    for slug, title, status, phase, _ in SECTIONS:
        r = client.get(f"/{slug}")
        assert r.status_code == 200, slug
        assert title in r.text
        if status == "planned":
            assert f"arrives in Phase {phase}" in r.text


def test_secrets_never_rendered(tmp_path, monkeypatch):
    monkeypatch.setenv("STRADDLOOP_HOME", str(tmp_path))
    monkeypatch.setenv("DHAN_ACCESS_TOKEN", "TOP-SECRET-VALUE")
    monkeypatch.setenv("DHAN_CLIENT_ID", "1000")
    client = TestClient(app)
    for path in ("/overview", "/settings", "/market-data"):
        assert "TOP-SECRET-VALUE" not in client.get(path).text


def test_unknown_section_404():
    assert TestClient(app).get("/nope").status_code == 404
