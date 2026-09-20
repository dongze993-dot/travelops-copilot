"""Local configuration for the optional DeepSeek adapter.

The project deliberately keeps provider credentials outside source control.  A
small `.env` loader makes the first local run approachable for a beginner,
while `os.environ` still takes precedence in Docker and hosted environments.
No value read here is logged or returned by an API endpoint.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_LOCAL_ENV_KEYS = frozenset(
    {
        "DEEPSEEK_API_KEY",
        "TRAVELOPS_LLM_ENABLED",
        "TRAVELOPS_LLM_PROVIDER",
        "TRAVELOPS_LLM_BASE_URL",
        "TRAVELOPS_LLM_MODEL",
        "TRAVELOPS_LLM_TIMEOUT_SECONDS",
        "TRAVELOPS_LLM_MAX_RETRIES",
        "TRAVELOPS_LLM_MAX_TOKENS",
        "TRAVELOPS_LLM_TEMPERATURE",
    }
)


def _load_local_env(path: Path | None = None) -> None:
    """Load only known TravelOps keys without overriding real environment values."""

    env_path = path or _PROJECT_ROOT / ".env"
    if not env_path.is_file():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, raw_value = line.partition("=")
        key = key.strip()
        if key not in _LOCAL_ENV_KEYS or key in os.environ:
            continue
        value = raw_value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


def _parse_bool(value: str | None, *, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _parse_float(value: str | None, *, default: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value) if value is not None else default
    except ValueError:
        return default
    return parsed if minimum <= parsed <= maximum else default


def _parse_int(value: str | None, *, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value) if value is not None else default
    except ValueError:
        return default
    return parsed if minimum <= parsed <= maximum else default


@dataclass(frozen=True)
class LLMSettings:
    """Non-logged settings for one OpenAI-compatible DeepSeek endpoint."""

    enabled: bool
    provider: str
    api_key: str | None
    base_url: str
    model: str
    timeout_seconds: float
    max_retries: int
    max_tokens: int
    temperature: float

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] | None = None) -> "LLMSettings":
        if environ is None:
            _load_local_env()
            environ = os.environ

        base_url = environ.get("TRAVELOPS_LLM_BASE_URL", "https://api.deepseek.com").strip()
        return cls(
            enabled=_parse_bool(environ.get("TRAVELOPS_LLM_ENABLED"), default=False),
            provider=environ.get("TRAVELOPS_LLM_PROVIDER", "deepseek").strip().lower(),
            api_key=environ.get("DEEPSEEK_API_KEY", "").strip() or None,
            base_url=base_url.rstrip("/"),
            model=environ.get("TRAVELOPS_LLM_MODEL", "deepseek-chat").strip(),
            timeout_seconds=_parse_float(
                environ.get("TRAVELOPS_LLM_TIMEOUT_SECONDS"),
                default=20.0,
                minimum=1.0,
                maximum=120.0,
            ),
            max_retries=_parse_int(
                environ.get("TRAVELOPS_LLM_MAX_RETRIES"),
                default=1,
                minimum=0,
                maximum=1,
            ),
            max_tokens=_parse_int(
                environ.get("TRAVELOPS_LLM_MAX_TOKENS"),
                default=800,
                minimum=128,
                maximum=4_000,
            ),
            temperature=_parse_float(
                environ.get("TRAVELOPS_LLM_TEMPERATURE"),
                default=0.0,
                minimum=0.0,
                maximum=1.0,
            ),
        )

    def disabled_reason(self) -> str | None:
        """Return a safe fallback code rather than an exception or a secret."""

        if not self.enabled:
            return "llm_disabled"
        if self.provider != "deepseek":
            return "unsupported_provider"
        if not self.api_key:
            return "missing_api_key"
        if not self.base_url.startswith("https://"):
            return "invalid_base_url"
        if not self.model:
            return "missing_model"
        return None
