"""Versioned prompts for the optional, grounded model-enhancement step."""

from __future__ import annotations

import json
from typing import Any, Mapping, Sequence

from .schemas import Attraction, DayItinerary


PLAN_NARRATIVE_PROMPT_VERSION = "travelops-v2.0.0"


def build_plan_narrative_messages(
    *,
    parsed_request: Mapping[str, Any],
    records: Sequence[Attraction],
    itinerary: Sequence[DayItinerary],
) -> list[dict[str, str]]:
    """Build a bounded prompt that excludes contact details and free-form notes.

    The model is asked only to explain a deterministic candidate plan. It is not
    permitted to add venues, prices, opening times, booking claims, or sources.
    """

    allowed_sources = [
        {
            "source_id": record.id,
            "name": record.name,
            "city": record.city,
            "category": record.category,
            "summary": record.summary,
            "tags": record.tags,
        }
        for record in records
    ]
    deterministic_days = [
        {
            "day": day.day,
            "theme": day.theme,
            "items": [
                {
                    "title": item.title,
                    "source_id": item.source_id,
                }
                for item in day.items
            ],
        }
        for day in itinerary
    ]
    safe_request = {
        "destination": parsed_request["destination"],
        "days": parsed_request["days"],
        "travelers": parsed_request["travelers"],
        "total_budget_cny": parsed_request["total_budget_cny"],
        "interests": parsed_request["interests"],
        "travel_style": parsed_request["travel_style"],
    }
    prompt_data = {
        "task": "Write a short, grounded Chinese explanation for a deterministic travel-plan draft.",
        "response_contract": {
            "overview": "string, no more than 500 characters",
            "day_notes": [
                {
                    "day": "integer for every requested day, exactly once",
                    "theme": "string, no more than 100 characters",
                    "rationale": "string grounded only in allowed_sources",
                    "source_ids": "non-empty array, every id must be in allowed_source_ids",
                }
            ],
            "caveats": "array of at most four short strings",
        },
        "response_example": {
            "overview": "这是基于受控示例资料的行程说明。",
            "day_notes": [
                {
                    "day": 1,
                    "theme": "自然漫步",
                    "rationale": "围绕候选点位安排低强度活动。",
                    "source_ids": ["syn-example-001"],
                }
            ],
            "caveats": ["示例资料不代表真实库存或营业信息。"],
        },
        "rules": [
            "Return one valid JSON object only; do not wrap it in Markdown.",
            "Use only the supplied allowed_sources and their source_id values.",
            "Do not invent venues, source IDs, prices, opening hours, routes, bookings, availability, or facts.",
            "Do not change the number of days or the deterministic candidate items.",
            "State that this is synthetic demo data in a caveat when appropriate.",
        ],
        "request": safe_request,
        "deterministic_candidate": deterministic_days,
        "allowed_source_ids": [record["source_id"] for record in allowed_sources],
        "allowed_sources": allowed_sources,
    }
    return [
        {
            "role": "system",
            "content": (
                "You are the TravelOps Copilot explanation component. "
                "Follow the provided response contract exactly. "
                "Your response must be valid JSON and must contain no markdown."
            ),
        },
        {
            "role": "user",
            "content": json.dumps(prompt_data, ensure_ascii=False, separators=(",", ":")),
        },
    ]
