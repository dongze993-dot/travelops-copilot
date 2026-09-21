"""Local, source-aware attraction retrieval for deterministic demonstrations."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable

from .schemas import Attraction, Citation


# These are intentionally labelled example records.  A checked-in
# data/attractions.json file takes precedence and lets the demo use a larger,
# reviewable catalogue without changing application code.
_FALLBACK_ATTRACTIONS: list[dict[str, Any]] = [
    {
        "id": "demo-hz-01",
        "name": "湖畔慢行示例区",
        "city": "杭州",
        "category": "自然",
        "summary": "虚构的步行示例点位，适合演示低成本自然主题行程。",
        "price_cny": 0,
        "hours": "09:00-18:00（示例）",
        "tags": ["自然", "徒步", "拍照"],
        "source_title": "TravelOps 合成示例资料：杭州点位",
        "source_url": "data/attractions.json#demo-hz-01",
    },
    {
        "id": "demo-hz-02",
        "name": "宋韵体验示例馆",
        "city": "杭州",
        "category": "人文",
        "summary": "虚构的室内文化体验点位，含可预测的示例票价。",
        "price_cny": 65,
        "hours": "10:00-17:00（示例）",
        "tags": ["人文", "历史", "室内"],
        "source_title": "TravelOps 合成示例资料：杭州点位",
        "source_url": "data/attractions.json#demo-hz-02",
    },
    {
        "id": "demo-hz-03",
        "name": "茶事工坊示例课",
        "city": "杭州",
        "category": "体验",
        "summary": "虚构的预约式体验活动，用于演示带预算约束的工具调用。",
        "price_cny": 120,
        "hours": "13:00-16:00（示例）",
        "tags": ["体验", "美食", "茶"],
        "source_title": "TravelOps 合成示例资料：杭州点位",
        "source_url": "data/attractions.json#demo-hz-03",
    },
    {
        "id": "demo-sh-01",
        "name": "滨江城市漫游示例线",
        "city": "上海",
        "category": "城市漫游",
        "summary": "虚构的滨江步行线路，用于演示城市目的地检索。",
        "price_cny": 0,
        "hours": "全天（示例）",
        "tags": ["城市", "拍照", "自然"],
        "source_title": "TravelOps 合成示例资料：上海点位",
        "source_url": "data/attractions.json#demo-sh-01",
    },
    {
        "id": "demo-sh-02",
        "name": "近代建筑叙事示例馆",
        "city": "上海",
        "category": "人文",
        "summary": "虚构的人文场馆，用于演示引用、时长和门票字段。",
        "price_cny": 50,
        "hours": "09:30-17:30（示例）",
        "tags": ["人文", "建筑", "室内"],
        "source_title": "TravelOps 合成示例资料：上海点位",
        "source_url": "data/attractions.json#demo-sh-02",
    },
    {
        "id": "demo-su-01",
        "name": "园林生活示例园",
        "city": "苏州",
        "category": "园林",
        "summary": "虚构的园林参观示例，用于验证跨城市数据检索。",
        "price_cny": 70,
        "hours": "08:30-17:00（示例）",
        "tags": ["人文", "园林", "拍照"],
        "source_title": "TravelOps 合成示例资料：苏州点位",
        "source_url": "data/attractions.json#demo-su-01",
    },
]


def _normalise(value: str) -> str:
    return "".join(value.lower().split())


class LocalKnowledgeBase:
    """Load a small JSON catalogue and retrieve records with transparent scoring.

    This is deliberately not a claim of real-time travel information.  It gives
    a reviewer a reproducible controlled retrieval layer before a vector database
    is justified.
    """

    def __init__(self, data_path: str | Path | None = None) -> None:
        self.data_path = self._resolve_data_path(data_path)
        self.records = self._load_records()

    @staticmethod
    def _resolve_data_path(data_path: str | Path | None) -> Path | None:
        if data_path:
            return Path(data_path)

        environment_path = os.getenv("TRAVELOPS_KNOWLEDGE_PATH")
        if environment_path:
            return Path(environment_path)

        project_root = Path(__file__).resolve().parents[1]
        candidates = (
            project_root / "data" / "attractions.json",
            project_root / "data" / "travel_knowledge.json",
            Path.cwd() / "data" / "attractions.json",
            Path.cwd() / "data" / "travel_knowledge.json",
        )
        return next((candidate for candidate in candidates if candidate.exists()), None)

    def _load_records(self) -> list[Attraction]:
        raw_records: Iterable[Any] = _FALLBACK_ATTRACTIONS
        if self.data_path and self.data_path.exists():
            try:
                loaded = json.loads(self.data_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    loaded = loaded.get("attractions", loaded.get("items", []))
                if isinstance(loaded, list) and loaded:
                    raw_records = loaded
            except (OSError, json.JSONDecodeError):
                # A bad optional demo-data file should not stop a controlled demo
                # from starting; the health endpoint still exposes record count.
                raw_records = _FALLBACK_ATTRACTIONS

        validated: list[Attraction] = []
        for raw in raw_records:
            try:
                record = dict(raw)
                record.setdefault("source_title", "TravelOps 本地示例资料")
                record.setdefault(
                    "source_url",
                    f"data/attractions.json#{record.get('id', 'unknown')}",
                )
                validated.append(Attraction.model_validate(record))
            except (TypeError, ValueError):
                # Ignore a malformed item rather than returning an unverifiable
                # partial object to the planner.
                continue
        return validated or [Attraction.model_validate(item) for item in _FALLBACK_ATTRACTIONS]

    @property
    def record_count(self) -> int:
        return len(self.records)

    def search(
        self,
        destination: str,
        interests: Iterable[str] = (),
        *,
        limit: int = 8,
    ) -> list[Attraction]:
        """Return deterministic, explainable matches ordered by a simple score."""

        city_query = _normalise(destination)
        interest_terms = [_normalise(item) for item in interests if _normalise(item)]
        scored: list[tuple[int, str, Attraction]] = []
        for attraction in self.records:
            city = _normalise(attraction.city)
            haystack = _normalise(
                " ".join(
                    [
                        attraction.name,
                        attraction.city,
                        attraction.category,
                        attraction.summary,
                        *attraction.tags,
                    ]
                )
            )
            city_score = 10 if city_query and (city_query in city or city in city_query) else 0
            interest_score = sum(3 for term in interest_terms if term in haystack)
            # Prefer lower-cost records for deterministic tie-breaking, then id.
            scored.append((city_score + interest_score, attraction.id, attraction))

        # A controlled demo must not silently turn a city mismatch into a plan
        # for another city.  Callers get an explicit empty result and can route
        # that case to manual data collection instead.
        candidates = [entry for entry in scored if entry[0] >= 10]
        candidates.sort(key=lambda entry: (-entry[0], entry[2].price_cny, entry[1]))
        return [entry[2] for entry in candidates[: max(1, min(limit, 20))]]

    @staticmethod
    def citations_for(records: Iterable[Attraction], interests: Iterable[str] = ()) -> list[Citation]:
        interest_label = "、".join(interests) or "目的地匹配"
        citations: list[Citation] = []
        seen: set[str] = set()
        for record in records:
            if record.id in seen:
                continue
            seen.add(record.id)
            citations.append(
                Citation(
                    source_id=record.id,
                    title=record.source_title,
                    uri=record.source_url,
                    excerpt=record.summary,
                    relevance=f"用于 {interest_label} 的本地资料检索",
                )
            )
        return citations
