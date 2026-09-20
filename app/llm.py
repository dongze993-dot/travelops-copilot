"""A small, testable adapter for DeepSeek's OpenAI-compatible chat endpoint.

The adapter owns only model-written explanations. Retrieval, source selection,
budget calculations, validation, and CRM handoff remain deterministic so an
unavailable or unsafe provider response cannot change those controls.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

import httpx
from pydantic import ValidationError

from .config import LLMSettings
from .prompts import PLAN_NARRATIVE_PROMPT_VERSION, build_plan_narrative_messages
from .schemas import (
    Attraction,
    DayItinerary,
    GenerationMetadata,
    LLMTravelNarrative,
    TokenUsage,
)


@dataclass(frozen=True)
class LLMGenerationResult:
    """A validated narrative or a safe reason to keep the deterministic result."""

    narrative: LLMTravelNarrative | None
    metadata: GenerationMetadata


class DeepSeekNarrativeGenerator:
    """Call DeepSeek without exposing credentials or raw provider error bodies."""

    _RETRYABLE_STATUS_CODES = frozenset({408, 429, 500, 502, 503, 504})

    def __init__(
        self,
        settings: LLMSettings,
        *,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.settings = settings
        self._transport = transport
        self._sleep = sleep

    def _metadata(
        self,
        *,
        mode: str,
        fallback_code: str | None,
        attempts: int,
        latency_ms: float | None,
        usage: TokenUsage | None = None,
        model: str | None = None,
    ) -> GenerationMetadata:
        safe_model = (model or self.settings.model).strip() or None
        return GenerationMetadata(
            mode=mode,  # type: ignore[arg-type]
            provider=(self.settings.provider or "unknown")[:40],
            model=safe_model[:120] if safe_model else None,
            prompt_version=PLAN_NARRATIVE_PROMPT_VERSION,
            fallback_code=fallback_code,
            attempts=attempts,
            llm_latency_ms=latency_ms,
            usage=usage,
        )

    def _fallback(
        self,
        code: str,
        *,
        attempts: int = 0,
        latency_ms: float | None = None,
    ) -> LLMGenerationResult:
        mode = "deterministic" if code == "llm_disabled" else "deterministic_fallback"
        return LLMGenerationResult(
            narrative=None,
            metadata=self._metadata(
                mode=mode,
                fallback_code=code,
                attempts=attempts,
                latency_ms=latency_ms,
            ),
        )

    def skip(self, code: str) -> LLMGenerationResult:
        """Record an intentional deterministic path without calling a provider."""

        return self._fallback(self.settings.disabled_reason() or code)

    @staticmethod
    def _status_code(status_code: int) -> str:
        if status_code in {401, 403}:
            return "provider_auth_failed"
        if status_code == 402:
            return "provider_payment_required"
        if status_code == 408:
            return "provider_timeout"
        if status_code == 429:
            return "provider_rate_limited"
        if status_code in {400, 404, 409, 413, 422}:
            return "provider_request_rejected"
        if status_code >= 500:
            return "provider_unavailable"
        return "provider_request_failed"

    @staticmethod
    def _usage_from_response(body: Mapping[str, Any]) -> TokenUsage | None:
        raw_usage = body.get("usage")
        if not isinstance(raw_usage, Mapping):
            return None

        def number(name: str) -> int | None:
            value = raw_usage.get(name)
            return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None

        usage = TokenUsage(
            prompt_tokens=number("prompt_tokens"),
            completion_tokens=number("completion_tokens"),
            total_tokens=number("total_tokens"),
        )
        return usage if any(value is not None for value in usage.model_dump().values()) else None

    @staticmethod
    def _parse_narrative(
        content: str,
        *,
        allowed_source_ids: set[str],
        expected_days: int,
    ) -> tuple[LLMTravelNarrative | None, str | None]:
        try:
            payload = json.loads(content)
        except json.JSONDecodeError:
            return None, "invalid_provider_json"
        if not isinstance(payload, dict):
            return None, "invalid_provider_json"
        try:
            narrative = LLMTravelNarrative.model_validate(payload)
        except (ValidationError, TypeError, ValueError):
            return None, "invalid_provider_json"

        returned_days = [note.day for note in narrative.day_notes]
        if sorted(returned_days) != list(range(1, expected_days + 1)):
            return None, "untrusted_provider_output"
        for note in narrative.day_notes:
            if len(note.source_ids) != len(set(note.source_ids)):
                return None, "untrusted_provider_output"
            if not set(note.source_ids).issubset(allowed_source_ids):
                return None, "untrusted_provider_output"
        return narrative, None

    def generate(
        self,
        *,
        parsed_request: Mapping[str, Any],
        records: Sequence[Attraction],
        itinerary: Sequence[DayItinerary],
    ) -> LLMGenerationResult:
        """Return only validated, source-grounded narrative output.

        Every failure, including missing configuration, timeouts, invalid JSON,
        or source hallucination, leaves the caller with deterministic content.
        """

        disabled_reason = self.settings.disabled_reason()
        if disabled_reason:
            return self._fallback(disabled_reason)
        if not records:
            return self._fallback("knowledge_empty")
        if not itinerary:
            return self._fallback("candidate_empty")

        payload = {
            "model": self.settings.model,
            "messages": build_plan_narrative_messages(
                parsed_request=parsed_request,
                records=records,
                itinerary=itinerary,
            ),
            "temperature": self.settings.temperature,
            "max_tokens": self.settings.max_tokens,
            "stream": False,
            "response_format": {"type": "json_object"},
        }
        endpoint = f"{self.settings.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.settings.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        attempts = 0
        started = time.perf_counter()

        for attempt_index in range(self.settings.max_retries + 1):
            attempts += 1
            try:
                with httpx.Client(
                    timeout=self.settings.timeout_seconds,
                    transport=self._transport,
                ) as client:
                    response = client.post(endpoint, headers=headers, json=payload)
            except httpx.TimeoutException:
                code = "provider_timeout"
            except httpx.RequestError:
                code = "provider_network_error"
            else:
                if response.status_code in self._RETRYABLE_STATUS_CODES:
                    code = self._status_code(response.status_code)
                elif not response.is_success:
                    elapsed = round((time.perf_counter() - started) * 1000, 2)
                    return self._fallback(
                        self._status_code(response.status_code), attempts=attempts, latency_ms=elapsed
                    )
                else:
                    try:
                        body = response.json()
                    except (json.JSONDecodeError, ValueError):
                        elapsed = round((time.perf_counter() - started) * 1000, 2)
                        return self._fallback(
                            "invalid_provider_json", attempts=attempts, latency_ms=elapsed
                        )
                    if not isinstance(body, Mapping):
                        elapsed = round((time.perf_counter() - started) * 1000, 2)
                        return self._fallback(
                            "invalid_provider_json", attempts=attempts, latency_ms=elapsed
                        )
                    choices = body.get("choices")
                    if not isinstance(choices, list) or not choices or not isinstance(choices[0], Mapping):
                        elapsed = round((time.perf_counter() - started) * 1000, 2)
                        return self._fallback(
                            "invalid_provider_json", attempts=attempts, latency_ms=elapsed
                        )
                    choice = choices[0]
                    if choice.get("finish_reason") == "length":
                        elapsed = round((time.perf_counter() - started) * 1000, 2)
                        return self._fallback(
                            "truncated_provider_response", attempts=attempts, latency_ms=elapsed
                        )
                    message = choice.get("message")
                    content = message.get("content") if isinstance(message, Mapping) else None
                    if not isinstance(content, str) or not content.strip():
                        elapsed = round((time.perf_counter() - started) * 1000, 2)
                        return self._fallback(
                            "provider_empty_response", attempts=attempts, latency_ms=elapsed
                        )
                    narrative, parse_error = self._parse_narrative(
                        content,
                        allowed_source_ids={record.id for record in records},
                        expected_days=len(itinerary),
                    )
                    elapsed = round((time.perf_counter() - started) * 1000, 2)
                    if parse_error:
                        return self._fallback(parse_error, attempts=attempts, latency_ms=elapsed)
                    response_model = body.get("model")
                    model = response_model if isinstance(response_model, str) else self.settings.model
                    return LLMGenerationResult(
                        narrative=narrative,
                        metadata=self._metadata(
                            mode="llm_augmented",
                            fallback_code=None,
                            attempts=attempts,
                            latency_ms=elapsed,
                            usage=self._usage_from_response(body),
                            model=model[:120],
                        ),
                    )

            if attempt_index < self.settings.max_retries and code in {
                "provider_timeout",
                "provider_network_error",
                "provider_rate_limited",
                "provider_unavailable",
            }:
                self._sleep(0.25 * (attempt_index + 1))
                continue
            elapsed = round((time.perf_counter() - started) * 1000, 2)
            return self._fallback(code, attempts=attempts, latency_ms=elapsed)

        elapsed = round((time.perf_counter() - started) * 1000, 2)
        return self._fallback("provider_unavailable", attempts=attempts, latency_ms=elapsed)
