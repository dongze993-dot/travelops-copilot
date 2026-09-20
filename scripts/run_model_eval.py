#!/usr/bin/env python3
"""Evaluate TravelOps v2 through its public HTTP API.

This runner intentionally keeps deterministic API regression (`run_eval.py`) and
real-model evidence separate. It never reads an API key, provider request body,
or raw provider error response. The service owns those secrets; this script
records only safe response metadata and synthetic evaluation inputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class EvaluationError(Exception):
    """A malformed suite or response assertion."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run TravelOps v2 model-evaluation cases over HTTP.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--suite", default="evals/v2-llm.jsonl")
    parser.add_argument("--out", help="Report path; defaults to reports/model-eval-<UTC timestamp>.json")
    parser.add_argument("--timeout-seconds", type=float, default=45.0)
    parser.add_argument(
        "--require-llm",
        action="store_true",
        help="Fail any eligible case that does not return validated llm_augmented output.",
    )
    parser.add_argument("--no-write", action="store_true")
    return parser.parse_args()


def load_suite(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise EvaluationError(f"Suite file does not exist: {path}")
    cases: list[dict[str, Any]] = []
    seen: set[str] = set()
    for line_no, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        try:
            case = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise EvaluationError(f"Invalid JSON on {path}:{line_no}: {exc.msg}") from exc
        if not isinstance(case, dict):
            raise EvaluationError(f"Suite item at {path}:{line_no} must be an object")
        case_id = case.get("case_id")
        if not isinstance(case_id, str) or not case_id or case_id in seen:
            raise EvaluationError(f"Invalid or duplicate case_id at {path}:{line_no}")
        if not isinstance(case.get("request"), dict) or not isinstance(case.get("expect"), dict):
            raise EvaluationError(f"Case {case_id} needs request and expect objects")
        if "requires_model" not in case["expect"] or "validation_passed" not in case["expect"]:
            raise EvaluationError(f"Case {case_id} needs requires_model and validation_passed expectations")
        seen.add(case_id)
        cases.append(case)
    if not cases:
        raise EvaluationError("Suite has no cases")
    return cases


def post_json(url: str, payload: dict[str, Any], timeout_seconds: float) -> tuple[int | None, Any, str | None, float]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Accept": "application/json", "Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as opened:
            status = opened.status
            body = opened.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        status = exc.code
        body = exc.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        elapsed = round((time.perf_counter() - started) * 1000, 2)
        return None, None, f"request_failed:{type(exc).__name__}", elapsed
    elapsed = round((time.perf_counter() - started) * 1000, 2)
    try:
        parsed = json.loads(body) if body else None
    except json.JSONDecodeError:
        parsed = None
    return status, parsed, None, elapsed


def percentile(samples: list[float], fraction: float) -> float | None:
    if not samples:
        return None
    ordered = sorted(samples)
    index = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * fraction)))
    return ordered[index]


def check_model_output(body: dict[str, Any], request: dict[str, Any]) -> list[str]:
    """Check only observable grounded-output invariants, never semantic travel truth."""

    failures: list[str] = []
    narrative = body.get("narrative")
    citations = body.get("citations")
    if not isinstance(narrative, dict) or not isinstance(citations, list):
        return ["missing_narrative_or_citations"]
    allowed = {
        item.get("source_id")
        for item in citations
        if isinstance(item, dict) and isinstance(item.get("source_id"), str)
    }
    day_notes = narrative.get("day_notes")
    if not isinstance(day_notes, list):
        return ["missing_day_notes"]
    expected_days = list(range(1, int(request["days"]) + 1))
    returned_days: list[int] = []
    for note in day_notes:
        if not isinstance(note, dict):
            failures.append("invalid_day_note")
            continue
        day = note.get("day")
        if not isinstance(day, int):
            failures.append("invalid_day")
            continue
        returned_days.append(day)
        source_ids = note.get("source_ids")
        if not isinstance(source_ids, list) or not source_ids:
            failures.append("missing_note_sources")
            continue
        if any(not isinstance(source_id, str) or source_id not in allowed for source_id in source_ids):
            failures.append("source_not_in_citations")
    if sorted(returned_days) != expected_days:
        failures.append("day_coverage_mismatch")
    return sorted(set(failures))


def run_case(
    case: dict[str, Any], *, base_url: str, timeout_seconds: float, require_llm: bool
) -> dict[str, Any]:
    request = case["request"]
    expectation = case["expect"]
    status, body, request_error, request_ms = post_json(
        f"{base_url.rstrip('/')}/api/v2/plans", request, timeout_seconds
    )
    failures: list[str] = []
    if request_error:
        failures.append(request_error)
    elif status != 200:
        failures.append(f"expected_http_200_got_{status}")
    elif not isinstance(body, dict):
        failures.append("response_not_json_object")
    else:
        validation = body.get("validation")
        generation = body.get("generation")
        if not isinstance(validation, dict) or not isinstance(generation, dict):
            failures.append("missing_validation_or_generation")
        else:
            if validation.get("passed") is not expectation["validation_passed"]:
                failures.append("validation_expectation_mismatch")
            expected_citations = expectation.get("citations")
            citations = body.get("citations")
            if expected_citations == "empty" and citations != []:
                failures.append("citation_expectation_mismatch")
            if expected_citations == "nonempty" and (not isinstance(citations, list) or not citations):
                failures.append("citation_expectation_mismatch")
            requires_model = expectation["requires_model"] is True
            mode = generation.get("mode")
            if requires_model and require_llm and mode != "llm_augmented":
                failures.append("required_model_not_augmented")
            if not requires_model:
                if body.get("narrative") is not None:
                    failures.append("ineligible_case_returned_narrative")
                expected_code = expectation.get("fallback_code")
                if require_llm and isinstance(expected_code, str) and generation.get("fallback_code") != expected_code:
                    failures.append("fallback_code_mismatch")
            if mode == "llm_augmented":
                failures.extend(check_model_output(body, request))

    observed: dict[str, Any] = {}
    if isinstance(body, dict):
        generation = body.get("generation")
        validation = body.get("validation")
        citations = body.get("citations")
        narrative = body.get("narrative")
        citation_items = citations if isinstance(citations, list) else []
        narrative_notes = narrative.get("day_notes", []) if isinstance(narrative, dict) else []
        observed = {
            "generation": generation if isinstance(generation, dict) else None,
            "validation": validation if isinstance(validation, dict) else None,
            "citation_source_ids": [
                item.get("source_id")
                for item in citation_items
                if isinstance(item, dict)
            ],
            "narrative_day_source_ids": [
                note.get("source_ids")
                for note in narrative_notes
                if isinstance(note, dict)
            ],
        }
    return {
        "case_id": case["case_id"],
        "title": case.get("title", ""),
        "tags": case.get("tags", []),
        "requires_model": expectation["requires_model"] is True,
        "passed": not failures,
        "http_status": status,
        "request_duration_ms": request_ms,
        "failures": sorted(set(failures)),
        "observed": observed,
    }


def observed_generation(result: dict[str, Any]) -> dict[str, Any] | None:
    observed = result.get("observed")
    if not isinstance(observed, dict):
        return None
    generation = observed.get("generation")
    return generation if isinstance(generation, dict) else None


def default_report_path() -> Path:
    return Path("reports") / f"model-eval-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.json"


def main() -> int:
    args = parse_args()
    try:
        cases = load_suite(Path(args.suite))
    except EvaluationError as exc:
        print(f"Evaluation setup failed: {exc}", file=sys.stderr)
        return 2

    started = time.perf_counter()
    results = [
        run_case(
            case,
            base_url=args.base_url,
            timeout_seconds=args.timeout_seconds,
            require_llm=args.require_llm,
        )
        for case in cases
    ]
    passed = sum(result["passed"] for result in results)
    model_cases = [result for result in results if result["requires_model"]]
    augmented = [
        result
        for result in model_cases
        if (generation := observed_generation(result)) and generation.get("mode") == "llm_augmented"
    ]
    valid_grounding = [
        result
        for result in augmented
        if not any(
            failure in {"source_not_in_citations", "day_coverage_mismatch"}
            for failure in result["failures"]
        )
    ]
    successful_latencies = [
        result["request_duration_ms"] for result in results if result["passed"] and result["http_status"] == 200
    ]
    llm_latencies = [
        generation["llm_latency_ms"]
        for result in augmented
        if isinstance((generation := observed_generation(result)), dict)
        and isinstance(generation.get("llm_latency_ms"), (int, float))
    ]
    fallback_codes = Counter(
        generation.get("fallback_code")
        for result in results
        if isinstance((generation := observed_generation(result)), dict)
        and isinstance(generation.get("fallback_code"), str)
    )
    models = Counter(
        generation.get("model")
        for result in augmented
        if isinstance((generation := observed_generation(result)), dict)
        and isinstance(generation.get("model"), str)
    )
    prompt_versions = Counter(
        generation.get("prompt_version")
        for result in results
        if isinstance((generation := observed_generation(result)), dict)
        and isinstance(generation.get("prompt_version"), str)
    )
    usage_rows = [
        generation.get("usage")
        for result in augmented
        if isinstance((generation := observed_generation(result)), dict)
        and isinstance(generation.get("usage"), dict)
    ]

    report = {
        "report_schema_version": "1",
        "project": "TravelOps Copilot",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "base_url": args.base_url,
        "suite": args.suite,
        "suite_sha256": hashlib.sha256(Path(args.suite).read_bytes()).hexdigest(),
        "runner": {
            "path": "scripts/run_model_eval.py",
            "python": platform.python_version(),
            "platform": platform.platform(),
            "http_black_box_only": True,
            "require_llm": args.require_llm,
        },
        "summary": {
            "selected_cases": len(results),
            "passed_cases": passed,
            "failed_cases": len(results) - passed,
            "contract_and_grounding_pass_rate_percent": round(passed / len(results) * 100, 2),
            "eligible_model_cases": len(model_cases),
            "llm_augmented_cases": len(augmented),
            "eligible_model_augmentation_rate_percent": (
                round(len(augmented) / len(model_cases) * 100, 2) if model_cases else None
            ),
            "source_allowlist_and_day_coverage_valid_cases": len(valid_grounding),
            "source_allowlist_and_day_coverage_rate_percent": (
                round(len(valid_grounding) / len(augmented) * 100, 2) if augmented else None
            ),
            "successful_request_latency_p50_ms": percentile(successful_latencies, 0.50),
            "successful_request_latency_p95_ms": percentile(successful_latencies, 0.95),
            "provider_latency_p50_ms": percentile(llm_latencies, 0.50),
            "provider_latency_p95_ms": percentile(llm_latencies, 0.95),
            "provider_usage_reported_cases": len(usage_rows),
            "provider_usage_prompt_tokens_total": sum(
                row.get("prompt_tokens", 0)
                for row in usage_rows
                if isinstance(row.get("prompt_tokens"), int)
            ),
            "provider_usage_completion_tokens_total": sum(
                row.get("completion_tokens", 0)
                for row in usage_rows
                if isinstance(row.get("completion_tokens"), int)
            ),
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
        },
        "models": dict(models),
        "prompt_versions": dict(prompt_versions),
        "fallback_codes": dict(fallback_codes),
        "scope_note": (
            "This evaluates structured model output, source allowlisting, and API behavior against "
            "repository-authored synthetic travel data. It does not measure real travel accuracy, "
            "provider quality beyond this prompt/suite, bookings, real CRM delivery, user outcomes, or cost."
        ),
        "results": results,
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.no_write:
        print(rendered)
    else:
        destination = Path(args.out) if args.out else default_report_path()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(rendered, encoding="utf-8")
        print(f"Model evaluation finished: {passed}/{len(results)} cases passed; report: {destination}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
