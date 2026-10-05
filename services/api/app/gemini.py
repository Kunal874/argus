from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx


class GeminiAdapter:
    """Gemini moderator with an explicit, testable deterministic fallback."""

    def __init__(self) -> None:
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.model_id = os.getenv("GEMINI_MODEL_ID", "gemini-2.5-flash")
        self.base_url = os.getenv(
            "GEMINI_API_URL", "https://generativelanguage.googleapis.com/v1beta"
        ).rstrip("/")

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def explain(self, decision_package: dict[str, Any], fallback: str) -> tuple[str, str]:
        if not self.configured:
            return fallback, "deterministic-fallback"

        prompt = (
            "You are the Moderator for Argus, an Indian MSME working-capital decision system. "
            "Use only the verified JSON below. Do not calculate new quantities, change optimizer "
            "limits, or invent evidence. In at most 90 words, explain the trade-off, the recommended "
            "action, the human approval required, and any important assumption.\n\n"
            + json.dumps(decision_package, ensure_ascii=False)
        )
        try:
            response = httpx.post(
                f"{self.base_url}/models/{self.model_id}:generateContent",
                headers={"x-goog-api-key": self.api_key, "Content-Type": "application/json"},
                json={
                    "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "temperature": 0.1,
                        "maxOutputTokens": 600,
                    },
                },
                timeout=30,
            )
            response.raise_for_status()
            parts = response.json()["candidates"][0]["content"]["parts"]
            text = "".join(part.get("text", "") for part in parts).strip()
            if not text:
                raise KeyError("Gemini returned no explanation text")
            allowed_numbers = set(re.findall(r"(?<![A-Za-z])\d[\d,]*(?:\.\d+)?%?", json.dumps(decision_package)))
            output_numbers = set(re.findall(r"(?<![A-Za-z])\d[\d,]*(?:\.\d+)?%?", text))
            normalize = lambda value: value.replace(",", "").replace("%", "")
            normalized_allowed = {normalize(item) for item in allowed_numbers}
            if any(normalize(value) not in normalized_allowed for value in output_numbers):
                return fallback, "deterministic-fallback-unverified-output"
            return text, "gemini"
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError):
            return fallback, "deterministic-fallback-after-provider-error"
