from app.gemini import GeminiAdapter


def test_gemini_adapter_has_safe_offline_fallback(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    adapter = GeminiAdapter()
    text, mode = adapter.explain({"verified": True}, "Verified fallback explanation")
    assert text == "Verified fallback explanation"
    assert mode == "deterministic-fallback"


def test_gemini_adapter_reads_generated_text(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": "Verified Gemini explanation"}]}}]}

    monkeypatch.setattr("app.gemini.httpx.post", lambda *args, **kwargs: Response())
    text, mode = GeminiAdapter().explain({"verified": True}, "fallback")
    assert text == "Verified Gemini explanation"
    assert mode == "gemini"


def test_gemini_adapter_rejects_unsupported_numbers(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": "Order 999 units immediately"}]}}]}

    monkeypatch.setattr("app.gemini.httpx.post", lambda *args, **kwargs: Response())
    text, mode = GeminiAdapter().explain({"verified_units": 10}, "verified fallback")
    assert text == "verified fallback"
    assert mode == "deterministic-fallback-unverified-output"
