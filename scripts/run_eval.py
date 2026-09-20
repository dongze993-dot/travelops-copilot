#!/usr/bin/env python3
"""Run versioned TravelOps Copilot evaluations through the public HTTP API.

The runner deliberately does not import application modules. It exercises the
same routes a browser, a front end, or an integration client would use and
writes a timestamped JSON evidence report. The suite contains synthetic data
only; do not add credentials or real personal data to it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


JSON = dict[str, Any] | list[Any] | str | int | float | bool | None
_MISSING = object()
_TEMPLATE_PATTERN = re.compile(r"\{\{([a-zA-Z0-9_.-]+)\}\}")


class EvaluationError(Exception):
    """A suite or assertion error that should be reported per case."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run TravelOps Copilot JSONL evaluations through HTTP."
    )
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:8000",
        help="Base URL of a running TravelOps service (default: %(default)s).",
    )
    parser.add_argument(
        "--suite",
        default="evals/v1.jsonl",
        help="JSONL evaluation suite path (default: %(default)s).",
    )
    parser.add_argument(
        "--out",
        help="Optional report destination. Defaults to reports/eval-<UTC timestamp>.json.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=10.0,
        help="Per-request timeout in seconds (default: %(default)s).",
    )
    parser.add_argument(
        "--case",
        action="append",
        dest="case_ids",
        help="Run only this case ID. May be repeated; fixture-dependent cases need predecessors.",
    )
    parser.add_argument(
        "--include-manual",
        action="store_true",
        help="Also run suite records marked automatable=false.",
    )
    parser.add_argument(
        "--no-write",
        action="store_true",
        help="Print the report without creating a file.",
    )
    return parser.parse_args()


def load_suite(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise EvaluationError(f"Suite file does not exist: {path}")

    cases: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for line_no, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            case = json.loads(line)
        except json.JSONDecodeError as exc:
            raise EvaluationError(f"Invalid JSON on {path}:{line_no}: {exc.msg}") from exc
        if not isinstance(case, dict):
            raise EvaluationError(f"Suite item at {path}:{line_no} must be a JSON object")
        case_id = case.get("case_id")
        if not isinstance(case_id, str) or not case_id:
            raise EvaluationError(f"Suite item at {path}:{line_no} has no non-empty case_id")
        if case_id in seen_ids:
            raise EvaluationError(f"Duplicate case_id in suite: {case_id}")
        if not isinstance(case.get("request"), dict):
            raise EvaluationError(f"Suite case {case_id} has no request object")
        if not isinstance(case.get("assertions"), list):
            raise EvaluationError(f"Suite case {case_id} has no assertions array")
        seen_ids.add(case_id)
        cases.append(case)
    if not cases:
        raise EvaluationError(f"No cases found in suite: {path}")
    return cases


def get_path(document: Any, path: str) -> Any:
    """Resolve a dot-separated JSON path; an empty path means the root value."""

    if path == "":
        return document
    current = document
    for segment in path.split("."):
        if isinstance(current, dict):
            if segment not in current:
                raise EvaluationError(f"JSON path not found: {path}")
            current = current[segment]
        elif isinstance(current, list):
            try:
                index = int(segment)
            except ValueError as exc:
                raise EvaluationError(f"Expected numeric array index in JSON path: {path}") from exc
            if index < 0 or index >= len(current):
                raise EvaluationError(f"JSON array index out of range: {path}")
            current = current[index]
        else:
            raise EvaluationError(f"Cannot descend into scalar at JSON path: {path}")
    return current


def resolve_reference(reference: str, context: dict[str, Any], response: Any) -> Any:
    if reference.startswith("response."):
        return get_path(response, reference.removeprefix("response."))
    if reference not in context:
        raise EvaluationError(f"No fixture value for template: {{{{{reference}}}}}")
    return context[reference]


def render_templates(value: Any, context: dict[str, Any], response: Any = _MISSING) -> Any:
    """Render fixture placeholders, preserving a non-string full-value reference."""

    if isinstance(value, dict):
        return {key: render_templates(item, context, response) for key, item in value.items()}
    if isinstance(value, list):
        return [render_templates(item, context, response) for item in value]
    if not isinstance(value, str):
        return value

    full = _TEMPLATE_PATTERN.fullmatch(value)
    if full:
        return resolve_reference(full.group(1), context, response)

    def replace(match: re.Match[str]) -> str:
        resolved = resolve_reference(match.group(1), context, response)
        return str(resolved)

    return _TEMPLATE_PATTERN.sub(replace, value)


def json_kind(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def require_path(response: Any, path: str) -> Any:
    if response is _MISSING:
        raise EvaluationError("No JSON response body was available for this assertion")
    return get_path(response, path)


def evaluate_assertion(
    assertion: dict[str, Any],
    *,
    status_code: int | None,
    response: Any,
    context: dict[str, Any],
) -> dict[str, Any]:
    """Evaluate one documented assertion operation and return a report entry."""

    op = assertion.get("op")
    if not isinstance(op, str):
        return {"passed": False, "op": op, "message": "Assertion has no string op"}

    try:
        rendered = render_templates(assertion, context, response)
        path = rendered.get("path", "")
        if not isinstance(path, str):
            raise EvaluationError("Assertion path must be a string")
        expected = rendered.get("value", _MISSING)

        if op == "status_code":
            passed = status_code == expected
            message = f"expected HTTP {expected}, got {status_code}"
        elif op == "path_exists":
            require_path(response, path)
            passed = True
            message = f"path exists: {path or '<root>'}"
        elif op == "path_is_null":
            actual = require_path(response, path)
            passed = actual is None
            message = f"expected null at {path}, got {actual!r}"
        elif op == "path_not_null":
            actual = require_path(response, path)
            passed = actual is not None
            message = f"expected non-null at {path}, got {actual!r}"
        elif op == "path_equals":
            actual = require_path(response, path)
            passed = actual == expected
            message = f"expected {path} == {expected!r}, got {actual!r}"
        elif op == "path_type":
            actual = require_path(response, path)
            actual_kind = json_kind(actual)
            passed = actual_kind == expected
            message = f"expected {path} type {expected!r}, got {actual_kind!r}"
        elif op in {"path_length_eq", "path_length_gte"}:
            actual = require_path(response, path)
            if not hasattr(actual, "__len__"):
                raise EvaluationError(f"Path has no length: {path}")
            length = len(actual)
            passed = length == expected if op == "path_length_eq" else length >= expected
            comparator = "==" if op == "path_length_eq" else ">="
            message = f"expected len({path or '<root>'}) {comparator} {expected}, got {length}"
        elif op in {"path_gte", "path_lte"}:
            actual = require_path(response, path)
            if not isinstance(actual, (int, float)) or isinstance(actual, bool):
                raise EvaluationError(f"Path is not numeric: {path}")
            passed = actual >= expected if op == "path_gte" else actual <= expected
            comparator = ">=" if op == "path_gte" else "<="
            message = f"expected {path} {comparator} {expected}, got {actual}"
        elif op == "path_starts_with":
            actual = require_path(response, path)
            passed = isinstance(actual, str) and actual.startswith(expected)
            message = f"expected {path} to start with {expected!r}, got {actual!r}"
        elif op == "path_contains":
            actual = require_path(response, path)
            if not isinstance(actual, (str, list, dict)):
                raise EvaluationError(f"Path does not support containment: {path}")
            passed = expected in actual
            message = f"expected {path} to contain {expected!r}, got {actual!r}"
        elif op == "array_contains_path":
            items = require_path(response, path)
            item_path = rendered.get("item_path")
            if not isinstance(items, list) or not isinstance(item_path, str):
                raise EvaluationError("array_contains_path requires list path and string item_path")
            values = []
            for item in items:
                try:
                    values.append(get_path(item, item_path))
                except EvaluationError:
                    values.append(_MISSING)
            passed = expected in values
            message = f"expected one {path or '<root>'}.{item_path} == {expected!r}, got {values!r}"
        elif op == "array_all_path_starts_with":
            items = require_path(response, path)
            item_path = rendered.get("item_path")
            if not isinstance(items, list) or not isinstance(item_path, str):
                raise EvaluationError(
                    "array_all_path_starts_with requires list path and string item_path"
                )
            values = [get_path(item, item_path) for item in items]
            passed = bool(values) and all(
                isinstance(item, str) and item.startswith(expected) for item in values
            )
            message = (
                f"expected every {path or '<root>'}.{item_path} to start with {expected!r}, "
                f"got {values!r}"
            )
        else:
            raise EvaluationError(f"Unknown assertion op: {op}")
    except EvaluationError as exc:
        return {"passed": False, "op": op, "message": str(exc)}
    except (TypeError, ValueError) as exc:
        return {"passed": False, "op": op, "message": f"Invalid assertion: {exc}"}

    return {"passed": bool(passed), "op": op, "message": message}


def execute_request(
    request_spec: dict[str, Any], *, base_url: str, timeout_seconds: float
) -> tuple[int | None, Any, str | None, float]:
    method = request_spec.get("method", "GET")
    path = request_spec.get("path")
    query = request_spec.get("query", {})
    body = request_spec.get("json", _MISSING)
    if not isinstance(method, str) or not isinstance(path, str) or not path.startswith("/"):
        raise EvaluationError("Request needs a method and an absolute API path beginning with '/'")
    if not isinstance(query, dict):
        raise EvaluationError("Request query must be an object")

    url = f"{base_url.rstrip('/')}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query, doseq=True)

    headers = {"Accept": "application/json"}
    data: bytes | None = None
    if body is not _MISSING:
        headers["Content-Type"] = "application/json; charset=utf-8"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url=url, data=data, headers=headers, method=method.upper())

    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as opened:
            status = opened.status
            raw_body = opened.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw_body = exc.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        return None, _MISSING, f"Request failed: {exc}", elapsed_ms

    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    try:
        response = json.loads(raw_body) if raw_body else None
    except json.JSONDecodeError:
        response = _MISSING
    return status, response, None, elapsed_ms


def run_case(
    case: dict[str, Any], *, base_url: str, timeout_seconds: float, context: dict[str, Any]
) -> dict[str, Any]:
    case_id = str(case["case_id"])
    title = str(case.get("title", ""))
    started = time.perf_counter()
    response: Any = _MISSING
    status_code: int | None = None
    request_error: str | None = None
    assertion_results: list[dict[str, Any]] = []

    try:
        request_spec = render_templates(case["request"], context)
        status_code, response, request_error, request_ms = execute_request(
            request_spec, base_url=base_url, timeout_seconds=timeout_seconds
        )
    except EvaluationError as exc:
        request_ms = round((time.perf_counter() - started) * 1000, 2)
        request_error = str(exc)

    if request_error:
        assertion_results.append({"passed": False, "op": "request", "message": request_error})
    else:
        for assertion in case["assertions"]:
            if not isinstance(assertion, dict):
                assertion_results.append(
                    {"passed": False, "op": None, "message": "Assertion item must be an object"}
                )
                continue
            assertion_results.append(
                evaluate_assertion(
                    assertion,
                    status_code=status_code,
                    response=response,
                    context=context,
                )
            )

    passed = bool(assertion_results) and all(item["passed"] for item in assertion_results)
    captures = case.get("captures", {})
    capture_error: str | None = None
    if passed and captures:
        if not isinstance(captures, dict):
            capture_error = "captures must be an object"
        else:
            try:
                for fixture_name, response_path in captures.items():
                    if not isinstance(fixture_name, str) or not isinstance(response_path, str):
                        raise EvaluationError("Capture keys and JSON paths must be strings")
                    context[fixture_name] = get_path(response, response_path)
            except EvaluationError as exc:
                capture_error = str(exc)
        if capture_error:
            passed = False
            assertion_results.append({"passed": False, "op": "capture", "message": capture_error})

    return {
        "case_id": case_id,
        "title": title,
        "tags": case.get("tags", []),
        "source_scope": case.get("source_scope", "unspecified"),
        "passed": passed,
        "http_status": status_code,
        "request_duration_ms": request_ms,
        "assertions": assertion_results,
    }


def choose_cases(
    cases: list[dict[str, Any]], args: argparse.Namespace
) -> tuple[list[dict[str, Any]], int]:
    selected: list[dict[str, Any]] = []
    skipped = 0
    requested_ids = set(args.case_ids or [])
    available_ids = {str(case["case_id"]) for case in cases}
    unknown_ids = requested_ids - available_ids
    if unknown_ids:
        raise EvaluationError(f"Unknown case ID(s): {', '.join(sorted(unknown_ids))}")

    for case in cases:
        case_id = str(case["case_id"])
        if requested_ids and case_id not in requested_ids:
            skipped += 1
            continue
        if not case.get("automatable", False) and not args.include_manual:
            skipped += 1
            continue
        selected.append(case)
    if not selected:
        raise EvaluationError("No selected cases to run")
    return selected, skipped


def default_report_path() -> Path:
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return Path("reports") / f"eval-{timestamp}.json"


def main() -> int:
    args = parse_args()
    suite_path = Path(args.suite)
    try:
        cases = load_suite(suite_path)
        selected_cases, skipped_cases = choose_cases(cases, args)
    except EvaluationError as exc:
        print(f"Evaluation setup failed: {exc}", file=sys.stderr)
        return 2

    suite_sha256 = hashlib.sha256(suite_path.read_bytes()).hexdigest()
    started_at = datetime.now(UTC)
    started_perf = time.perf_counter()
    context: dict[str, Any] = {"long_notes_501": "x" * 501}
    results = [
        run_case(
            case,
            base_url=args.base_url,
            timeout_seconds=args.timeout_seconds,
            context=context,
        )
        for case in selected_cases
    ]
    elapsed_ms = round((time.perf_counter() - started_perf) * 1000, 2)
    passed_cases = sum(1 for result in results if result["passed"])
    failed_cases = len(results) - passed_cases
    latency_samples = sorted(
        result["request_duration_ms"]
        for result in results
        if result["http_status"] is not None and result["passed"]
    )

    def percentile(samples: list[float], percentile_value: float) -> float | None:
        if not samples:
            return None
        index = max(0, min(len(samples) - 1, round((len(samples) - 1) * percentile_value)))
        return samples[index]

    report = {
        "report_schema_version": "1",
        "project": "TravelOps Copilot",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "base_url": args.base_url,
        "suite": str(suite_path),
        "suite_sha256": suite_sha256,
        "runner": {
            "path": "scripts/run_eval.py",
            "python": platform.python_version(),
            "platform": platform.platform(),
            "http_black_box_only": True,
        },
        "summary": {
            "selected_cases": len(results),
            "passed_cases": passed_cases,
            "failed_cases": failed_cases,
            "skipped_cases": skipped_cases,
            "contract_pass_rate_percent": round(passed_cases / len(results) * 100, 2),
            "elapsed_ms": elapsed_ms,
            "successful_case_latency_p50_ms": percentile(latency_samples, 0.50),
            "successful_case_latency_p95_ms": percentile(latency_samples, 0.95),
        },
        "scope_note": (
            "These results test HTTP/API contract behavior against synthetic demo data. "
            "They do not measure live travel accuracy, bookings, real CRM delivery, or user outcomes."
        ),
        "results": results,
    }

    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.no_write:
        print(rendered)
    else:
        report_path = Path(args.out) if args.out else default_report_path()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(rendered, encoding="utf-8")
        print(
            f"Evaluation finished: {passed_cases}/{len(results)} cases passed; report: {report_path}",
            file=sys.stdout,
        )

    return 0 if failed_cases == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
