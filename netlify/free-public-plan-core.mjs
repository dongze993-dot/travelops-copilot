/**
 * Planner for results retrieved from free public information pages.
 *
 * A source can recommend a place only when that place is in the returned
 * public material. Prices are even stricter: the planner sums them only when
 * the evidence explicitly says how the amount is charged. This keeps a
 * source-backed partial subtotal from being presented as a fabricated trip
 * total.
 */

const INTEREST_PROFILES = Object.freeze([
  {
    key: "nature",
    keywords: ["自然", "风景", "山", "湖", "江", "河", "瀑", "峡", "森林", "湿地", "公园", "海", "岛", "洞", "岩", "地质"],
  },
  {
    key: "culture",
    keywords: ["人文", "历史", "文化", "古", "博物馆", "寺", "祠", "塔", "遗址", "书院", "故居", "古城", "古镇", "古村", "街区"],
  },
  {
    key: "food",
    keywords: ["美食", "餐饮", "小吃", "菜", "食", "茶", "酒", "夜市", "市场"],
  },
  {
    key: "family",
    keywords: ["亲子", "儿童", "动物", "海洋", "科技", "乐园", "植物园", "互动"],
  },
]);

const STYLE_PROFILES = Object.freeze({
  budget: {
    label: "精打细算",
    places_per_day: 2,
    schedule_note: "同一天最多放入两条有资料支撑的地点，避免为了凑满行程而增加未经核实的消费。",
  },
  balanced: {
    label: "均衡体验",
    places_per_day: 2,
    schedule_note: "优先把不同资料地点分开安排到上午和下午，餐饮与晚间时段保留给用户自行确认。",
  },
  comfort: {
    label: "舒适从容",
    places_per_day: 1,
    schedule_note: "每天只安排一个有公开资料支撑的主要地点，其余时间留给休息与现场调整。",
  },
});

// These are ordinary, non-booking spending ranges rather than live quotes.
// They let a visitor decide whether a trip is feasible when a free source has
// no current restaurant or hotel price. Every range is shown as an estimate.
const ORDINARY_SPEND_RANGES = Object.freeze({
  budget: {
    room_per_night: [180, 260],
    breakfast_and_snacks_per_day: [15, 35],
    casual_lunch_per_day: [30, 55],
    local_dinner_per_day: [45, 85],
    city_transport_per_day: [20, 45],
    unpriced_place_per_visit: [0, 35],
    souvenir_per_trip: [20, 60],
  },
  balanced: {
    room_per_night: [240, 380],
    breakfast_and_snacks_per_day: [25, 50],
    casual_lunch_per_day: [45, 80],
    local_dinner_per_day: [75, 140],
    city_transport_per_day: [30, 70],
    unpriced_place_per_visit: [0, 65],
    souvenir_per_trip: [40, 120],
  },
  comfort: {
    room_per_night: [360, 550],
    breakfast_and_snacks_per_day: [45, 80],
    casual_lunch_per_day: [70, 130],
    local_dinner_per_day: [120, 220],
    city_transport_per_day: [50, 110],
    unpriced_place_per_visit: [0, 100],
    souvenir_per_trip: [80, 180],
  },
});

function roundCny(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function stableHash(text) {
  let hash = 2166136261;
  for (const character of String(text)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(6, "0");
}

function nonEmptyText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function titleForSource(source) {
  return nonEmptyText(source?.title) || nonEmptyText(source?.source_id) || "公开资料中的地点";
}

function sourceExcerpt(source) {
  return nonEmptyText(source?.excerpt) || "公开资料页没有可展示的摘要。";
}

function sourceUrl(source) {
  const value = nonEmptyText(source?.uri);
  return /^https:\/\//i.test(value) ? value : null;
}

function textValues(value) {
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (value && typeof value === "object") {
    return [value.name, value.label, value.title].flatMap(textValues);
  }
  return [];
}

function sourceCategoryLabels(source) {
  const fields = [
    source?.category,
    source?.categories,
    source?.tags,
    source?.matched_interests,
    source?.matched_interests,
    source?.interest_tags,
    source?.interestTags,
    source?.labels,
    source?.type,
    source?.type_labels,
  ];
  return [...new Set(fields.flatMap(textValues))].slice(0, 8);
}

function sourceSearchText(source) {
  return [titleForSource(source), sourceExcerpt(source), ...sourceCategoryLabels(source)]
    .join(" ")
    .toLocaleLowerCase("zh-CN");
}

function profileForInterest(interest) {
  const label = nonEmptyText(interest);
  const normalized = label.toLocaleLowerCase("zh-CN");
  return INTEREST_PROFILES.find((profile) => profile.keywords.some((keyword) => normalized.includes(keyword))) || null;
}

function interestMatchesForSource(source, interests) {
  const searchText = sourceSearchText(source);
  return interests
    .map((interest) => {
      const label = nonEmptyText(interest);
      const profile = profileForInterest(label);
      const directMatch = label && searchText.includes(label.toLocaleLowerCase("zh-CN"));
      const profileMatch = profile?.keywords.some((keyword) => searchText.includes(keyword.toLocaleLowerCase("zh-CN")));
      return directMatch || profileMatch ? { label, key: profile?.key || "custom" } : null;
    })
    .filter(Boolean);
}

function numberField(record, keys) {
  for (const key of keys) {
    const candidate = Number(record?.[key]);
    if (Number.isFinite(candidate) && candidate >= 0) return roundCny(candidate);
  }
  return null;
}

function priceScope(record) {
  if (record?.per_person === true) return "per_person";
  if (record?.per_group === true) return "per_group";
  if (record?.per_day_per_person === true) return "per_day_per_person";
  if (record?.per_day_per_group === true) return "per_day_per_group";

  const value = nonEmptyText(record?.pricing_scope || record?.price_scope || record?.billing_unit || record?.unit)
    .toLocaleLowerCase("en-US")
    .replace(/[\s-]+/g, "_");
  if (["per_person", "per_visitor", "per_ticket", "single_ticket", "individual"].includes(value)) return "per_person";
  if (["per_group", "per_booking", "per_order", "flat"].includes(value)) return "per_group";
  if (["per_day_per_person", "daily_per_person"].includes(value)) return "per_day_per_person";
  if (["per_day_per_group", "daily_per_group"].includes(value)) return "per_day_per_group";
  return "unknown";
}

function canonicalPriceEvidence(source) {
  const rawEvidence = source?.price_evidence ?? source?.priceEvidence;
  const values = Array.isArray(rawEvidence) ? rawEvidence : rawEvidence == null ? [] : [rawEvidence];
  return values
    .map((value) => typeof value === "number" ? { amount_cny: value } : value)
    .filter((value) => value && typeof value === "object")
    .map((value) => {
      const exact = numberField(value, ["amount_cny", "price_cny", "value_cny", "amount"]);
      let minimum = numberField(value, ["minimum_cny", "min_cny", "lower_cny"]);
      let maximum = numberField(value, ["maximum_cny", "max_cny", "upper_cny"]);
      minimum ??= exact;
      maximum ??= exact;
      if (minimum == null && maximum != null) minimum = maximum;
      if (maximum == null && minimum != null) maximum = minimum;
      if (minimum == null || maximum == null) return null;
      const low = Math.min(minimum, maximum);
      const high = Math.max(minimum, maximum);
      const explicitUrl = nonEmptyText(value.source_url || value.evidence_url || value.url);
      return {
        source_id: nonEmptyText(source?.source_id) || null,
        source_title: titleForSource(source),
        source_url: sourceUrl(source),
        evidence_url: /^https:\/\//i.test(explicitUrl) ? explicitUrl : sourceUrl(source),
        evidence_text: nonEmptyText(value.detail || value.evidence_text || value.text || value.description || value.label)
          || "公开资料中提及的金额。",
        label: nonEmptyText(value.label || value.category || value.type) || "公开资料价格",
        minimum_cny: low,
        maximum_cny: high,
        pricing_scope: priceScope(value),
        aggregation_safe: value.aggregation_safe !== false,
      };
    })
    .filter(Boolean);
}

function dedupePriceEvidence(evidence) {
  const known = new Set();
  return evidence.filter((item) => {
    const key = [
      item.source_id,
      item.minimum_cny,
      item.maximum_cny,
      item.pricing_scope,
      item.evidence_text,
      item.evidence_url,
    ].join("|");
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
}

function perTravelerPriceRange(evidence) {
  const amounts = evidence.filter((item) => item.pricing_scope === "per_person" && item.aggregation_safe !== false);
  if (!amounts.length) return null;
  return amounts.reduce((total, item) => ({
    minimum_cny: roundCny(total.minimum_cny + item.minimum_cny),
    maximum_cny: roundCny(total.maximum_cny + item.maximum_cny),
  }), { minimum_cny: 0, maximum_cny: 0 });
}

function sourceSelections(request, sources) {
  const perTravelerBudget = request.travelers > 0
    ? roundCny(request.total_budget_cny / request.travelers)
    : null;
  return sources.map((source, sourceIndex) => {
    const matchedInterests = interestMatchesForSource(source, request.interests);
    const priceEvidence = dedupePriceEvidence(canonicalPriceEvidence(source));
    const travelerPrice = perTravelerPriceRange(priceEvidence);
    const budgetFit = travelerPrice == null || perTravelerBudget == null
      ? "not_enough_pricing_data"
      : travelerPrice.maximum_cny <= perTravelerBudget
        ? "within_stated_budget"
        : "above_stated_budget";
    return {
      source,
      source_index: sourceIndex,
      matched_interests: matchedInterests,
      category_labels: sourceCategoryLabels(source),
      price_evidence: priceEvidence,
      per_traveler_price_range_cny: travelerPrice,
      budget_fit: budgetFit,
    };
  }).sort((left, right) => {
    const matchDelta = right.matched_interests.length - left.matched_interests.length;
    if (matchDelta) return matchDelta;
    const rank = { within_stated_budget: 0, not_enough_pricing_data: 1, above_stated_budget: 2 };
    const budgetDelta = rank[left.budget_fit] - rank[right.budget_fit];
    if (budgetDelta) return budgetDelta;
    if (request.travel_style === "budget") {
      const leftCost = left.per_traveler_price_range_cny?.minimum_cny;
      const rightCost = right.per_traveler_price_range_cny?.minimum_cny;
      if (leftCost != null && rightCost != null && leftCost !== rightCost) return leftCost - rightCost;
    }
    return left.source_index - right.source_index;
  });
}

function distributeSelections(selections, request) {
  const style = STYLE_PROFILES[request.travel_style] || STYLE_PROFILES.balanced;
  const maximum = request.days * style.places_per_day;
  const planned = selections.slice(0, maximum);
  const alternatives = selections.slice(maximum);
  const base = Math.floor(planned.length / request.days);
  let remainder = planned.length % request.days;
  let cursor = 0;
  const days = Array.from({ length: request.days }, () => {
    const count = Math.min(style.places_per_day, base + (remainder-- > 0 ? 1 : 0));
    const selected = planned.slice(cursor, cursor + count);
    cursor += count;
    return selected;
  });
  return { days, alternatives, style };
}

function moneyLabel(minimum, maximum) {
  return minimum === maximum ? "¥" + minimum : "¥" + minimum + "–¥" + maximum;
}

function sourceReason(selection, request = null) {
  const reasons = [];
  if (selection.matched_interests.length) {
    reasons.push("匹配你的偏好：" + selection.matched_interests.map((match) => match.label).join("、"));
  }
  if (selection.category_labels.length) {
    reasons.push("资料标签：" + selection.category_labels.join("、"));
  }
  if (selection.price_evidence.length) {
    reasons.push("该资料含 " + selection.price_evidence.length + " 条金额记录，已列入费用依据");
  }
  if (request && selection.per_traveler_price_range_cny) {
    const price = moneyLabel(
      selection.per_traveler_price_range_cny.minimum_cny,
      selection.per_traveler_price_range_cny.maximum_cny,
    );
    const perTravelerBudget = request.travelers > 0 ? roundCny(request.total_budget_cny / request.travelers) : null;
    if (selection.budget_fit === "within_stated_budget") {
      reasons.push("资料中按人计价的部分为 " + price + "，低于本次每人游玩预算 ¥" + perTravelerBudget);
    } else if (selection.budget_fit === "above_stated_budget") {
      reasons.push("资料中按人计价的部分为 " + price + "，高于本次每人游玩预算 ¥" + perTravelerBudget + "，已排在其他可选资料之后");
    }
  }
  return reasons.length ? reasons.join("；") + "。" : "按与目的地对应的公开资料列入本次计划。";
}

function attractionItem(slot, selection, request) {
  const source = selection.source;
  return {
    slot,
    title: "游览：" + titleForSource(source),
    description: "公开资料摘要：" + sourceExcerpt(source) + " " + sourceReason(selection, request) + " 出发前请打开资料页确认开放状态、预约要求和现场安排。",
    estimated_duration_minutes: null,
    estimated_cost_cny: null,
    source_id: source.source_id,
    source_url: sourceUrl(source),
    selection_reason: sourceReason(selection, request),
    matched_interests: selection.matched_interests.map((match) => match.label),
    category_labels: selection.category_labels,
    price_evidence: selection.price_evidence,
  };
}

function ordinarySpendProfile(request) {
  return ORDINARY_SPEND_RANGES[request.travel_style] || ORDINARY_SPEND_RANGES.balanced;
}

function ordinaryFoodGuidance(request) {
  const profile = ordinarySpendProfile(request);
  const lunch = moneyLabel(profile.casual_lunch_per_day[0], profile.casual_lunch_per_day[1]);
  const dinner = moneyLabel(profile.local_dinner_per_day[0], profile.local_dinner_per_day[1]);
  const snacks = moneyLabel(profile.breakfast_and_snacks_per_day[0], profile.breakfast_and_snacks_per_day[1]);
  return {
    lunch: "平价正餐约 " + lunch + " / 人，可选择当天景点附近的家常菜、粉面或简餐。",
    dinner: "晚餐约 " + dinner + " / 人；可优先找当地家常菜、小炒或地方特色正餐。",
    snacks: "小吃和早餐合计约 " + snacks + " / 人 / 天，可选粉面、饼类、卤味等平价品类。",
  };
}

function foodItem(selection, request) {
  const source = selection.source;
  const guidance = ordinaryFoodGuidance(request);
  return {
    slot: "中午",
    title: "午餐：参考资料中的本地餐饮信息",
    description: "公开资料摘要：" + sourceExcerpt(source) + " " + sourceReason(selection, request) + " " + guidance.lunch,
    estimated_duration_minutes: null,
    estimated_cost_cny: null,
    source_id: source.source_id,
    source_url: sourceUrl(source),
    selection_reason: sourceReason(selection, request),
    matched_interests: selection.matched_interests.map((match) => match.label),
    category_labels: selection.category_labels,
    price_evidence: selection.price_evidence,
  };
}

function lunchItem(request) {
  const foodRequested = request.interests.some((interest) => profileForInterest(interest)?.key === "food");
  const guidance = ordinaryFoodGuidance(request);
  return {
    slot: "中午",
    title: foodRequested ? "午餐：平价本地小吃或家常菜" : "午餐：景点周边平价正餐",
    description: foodRequested
      ? "本次没有查到可直接引用的本地美食资料，因此不写具体餐厅或招牌菜。" + guidance.lunch + " " + guidance.snacks
      : "按上午活动所在区域选择就近用餐。" + guidance.lunch,
    estimated_duration_minutes: null,
    estimated_cost_cny: null,
  };
}

function flexibleMorningItem() {
  return {
    slot: "上午",
    title: "当天暂未安排具体景点",
    description: "公开资料不足以支撑一个具体地点时，本计划不会借用其他城市的景点。可改用更具体的县市名称重新查询，或把这段时间留给抵达和休息。",
    estimated_duration_minutes: null,
    estimated_cost_cny: null,
  };
}

function flexibleAfternoonItem() {
  return {
    slot: "下午",
    title: "预留现场调整时间",
    description: "根据天气、体力和上午资料页的实际信息决定是否延长游览。没有第二个可核验地点时，本计划不会虚构景点或路线。",
    estimated_duration_minutes: null,
    estimated_cost_cny: null,
  };
}

function eveningItem(request, foodSelection) {
  const guidance = ordinaryFoodGuidance(request);
  return {
    slot: "晚上",
    title: "晚餐：当地家常菜或平价特色小吃",
    description: (foodSelection
      ? "可先打开本日的餐饮资料，结合当天所在区域选择。"
      : "建议在当天景点周边或住宿附近选择有明码标价的店铺。") + " " + guidance.dinner + " " + guidance.snacks + " 具体店铺、菜品和营业状态请以当天现场信息为准。",
    estimated_duration_minutes: null,
    estimated_cost_cny: null,
  };
}

function dateLabel(startDate, dayIndex) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ""))) return null;
  const [year, month, day] = startDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + dayIndex));
  if (Number.isNaN(date.getTime())) return null;
  return (date.getUTCMonth() + 1) + "月" + date.getUTCDate() + "日";
}

function dayTheme(request, dayIndex, selections, style) {
  const matches = [...new Set(selections.flatMap((selection) => selection.matched_interests.map((match) => match.label)))];
  if (matches.length) return "第 " + (dayIndex + 1) + " 天 · " + matches.join(" / ") + "安排";
  if (selections.length) return "第 " + (dayIndex + 1) + " 天 · " + style.label + "安排";
  return "第 " + (dayIndex + 1) + " 天 · 弹性安排";
}

function makeDayItems(request, selections) {
  const foodSelection = selections.find((selection) => selection.matched_interests.some((match) => match.key === "food")) || null;
  const placeSelections = selections.filter((selection) => selection !== foodSelection);
  const [morningSelection, afternoonSelection] = placeSelections;
  return [
    morningSelection ? attractionItem("上午", morningSelection, request) : flexibleMorningItem(),
    foodSelection ? foodItem(foodSelection, request) : lunchItem(request),
    afternoonSelection ? attractionItem("下午", afternoonSelection, request) : flexibleAfternoonItem(),
    eveningItem(request, foodSelection),
  ];
}

function makeItinerary(request, selections) {
  const distribution = distributeSelections(selections, request);
  return {
    itinerary: distribution.days.map((daySelections, dayIndex) => ({
      day: dayIndex + 1,
      date_label: dateLabel(request.start_date, dayIndex),
      theme: dayTheme(request, dayIndex, daySelections, distribution.style),
      items: makeDayItems(request, daySelections),
      data_backed_place_count: daySelections.length,
      plan_note: daySelections.length
        ? "地点按公开资料与本次偏好筛选后列出，不代表最佳交通路线或实时营业安排。"
        : "该日没有足够的公开资料支撑具体地点，本计划保留时间框架而不填入其他城市的景点。",
    })),
    alternatives: distribution.alternatives,
    style: distribution.style,
  };
}

function multiplyRange(range, multiplier) {
  return {
    minimum: roundCny(range[0] * multiplier),
    maximum: roundCny(range[1] * multiplier),
  };
}

function estimatedLine(category, range, assumption, extras = {}) {
  return {
    category,
    minimum_cny: range.minimum,
    maximum_cny: range.maximum,
    amount_cny: range.minimum === range.maximum ? range.minimum : null,
    estimate_type: "ordinary_range",
    included_in_total: true,
    assumption,
    ...extras,
  };
}

function sourceFactLine(evidence) {
  const sourceAmount = moneyLabel(evidence.minimum_cny, evidence.maximum_cny);
  return {
    category: "资料原文：" + evidence.source_title,
    source_amount_cny: evidence.minimum_cny === evidence.maximum_cny ? evidence.minimum_cny : null,
    source_minimum_cny: evidence.minimum_cny,
    source_maximum_cny: evidence.maximum_cny,
    minimum_cny: evidence.minimum_cny,
    maximum_cny: evidence.maximum_cny,
    estimate_type: "source_fact",
    included_in_total: false,
    source_id: evidence.source_id,
    source_title: evidence.source_title,
    evidence_url: evidence.evidence_url,
    evidence_text: evidence.evidence_text,
    assumption: evidence.aggregation_safe === false
      ? "资料原文包含多个可能互斥的票种（" + sourceAmount + "），仅展示，不直接相加"
      : "资料原文金额 " + sourceAmount + "，已作为普通出行估算的参考之一",
  };
}

function uniqueSelections(selections) {
  const found = new Map();
  for (const selection of selections) {
    const id = nonEmptyText(selection?.source?.source_id);
    if (id && !found.has(id)) found.set(id, selection);
  }
  return [...found.values()];
}

function sourceTicketEstimate(selections, travelers) {
  const pricedSources = [];
  for (const selection of uniqueSelections(selections)) {
    const evidence = selection.price_evidence || [];
    if (!evidence.length) continue;
    pricedSources.push({
      title: titleForSource(selection.source),
      minimum: Math.min(...evidence.map((item) => item.minimum_cny)),
      maximum: Math.max(...evidence.map((item) => item.maximum_cny)),
    });
  }
  if (!pricedSources.length) return null;
  return {
    range: {
      minimum: roundCny(pricedSources.reduce((total, source) => total + source.minimum, 0) * travelers),
      maximum: roundCny(pricedSources.reduce((total, source) => total + source.maximum, 0) * travelers),
    },
    sourceTitles: pricedSources.map((source) => source.title),
  };
}

function buildBudgetFramework(request, selections) {
  const profile = ordinarySpendProfile(request);
  const unique = uniqueSelections(selections);
  const evidence = dedupePriceEvidence(unique.flatMap((selection) => selection.price_evidence));
  const sourceFacts = evidence.map(sourceFactLine);
  const rooms = Math.ceil(request.travelers / 2);
  const nights = request.days > 1 ? request.days - 1 : 0;
  const unpricedPlaceCount = unique.filter((selection) => !selection.price_evidence.length).length;
  const ticketEstimate = sourceTicketEstimate(unique, request.travelers);
  const estimates = [];

  if (nights) {
    estimates.push(estimatedLine(
      "普通双人酒店",
      multiplyRange(profile.room_per_night, rooms * nights),
      rooms + " 间 × " + nights + " 晚；按普通双人酒店的非预订参考区间。",
    ));
  }
  estimates.push(estimatedLine(
    "早餐与平价小吃",
    multiplyRange(profile.breakfast_and_snacks_per_day, request.travelers * request.days),
    request.travelers + " 人 × " + request.days + " 天；粉面、饼类、卤味等日常小吃和早餐。",
  ));
  estimates.push(estimatedLine(
    "午餐：家常菜或简餐",
    multiplyRange(profile.casual_lunch_per_day, request.travelers * request.days),
    request.travelers + " 人 × " + request.days + " 天；景点周边平价正餐。",
  ));
  estimates.push(estimatedLine(
    "晚餐：当地家常菜 / 特色正餐",
    multiplyRange(profile.local_dinner_per_day, request.travelers * request.days),
    request.travelers + " 人 × " + request.days + " 天；不指定餐厅，按普通消费水平估算。",
  ));
  estimates.push(estimatedLine(
    "市内交通",
    multiplyRange(profile.city_transport_per_day, request.travelers * request.days),
    request.travelers + " 人 × " + request.days + " 天；公交、打车接驳等，不含往返目的地的大交通。",
  ));
  if (ticketEstimate) {
    estimates.push(estimatedLine(
      "资料地点的游玩费用",
      ticketEstimate.range,
      "按已安排资料地点中可见金额的最低至最高选择估算（" + ticketEstimate.sourceTitles.join("、") + "）；同页多个票种不相加。",
      { source_titles: ticketEstimate.sourceTitles },
    ));
  }
  if (unpricedPlaceCount) {
    estimates.push(estimatedLine(
      "未标价景点预留",
      multiplyRange(profile.unpriced_place_per_visit, request.travelers * unpricedPlaceCount),
      unpricedPlaceCount + " 个资料地点没有价格原文，为可能的门票或体验留出普通区间。",
    ));
  }
  estimates.push(estimatedLine(
    "少量伴手礼",
    multiplyRange(profile.souvenir_per_trip, request.travelers),
    request.travelers + " 人；按少量购买、非特产大额消费估算。",
  ));

  const minimum = roundCny(estimates.reduce((total, item) => total + item.minimum_cny, 0));
  const maximum = roundCny(estimates.reduce((total, item) => total + item.maximum_cny, 0));
  const midpoint = roundCny((minimum + maximum) / 2);
  const cap = roundCny(request.total_budget_cny);
  const feasibility = cap < minimum
    ? "budget_too_low"
    : cap < maximum
      ? "budget_needs_choices"
      : "budget_covers_range";
  const feasibilityLabel = feasibility === "budget_too_low"
    ? "预算低于普通出行区间，建议缩短天数、选择更便宜住宿或减少收费景点。"
    : feasibility === "budget_needs_choices"
      ? "预算可以成行，但需要优先选择平价住宿、小吃和较低价景点。"
      : "预算可以覆盖这份普通出行区间，仍建议为临时消费留一点余量。";
  return {
    currency: "CNY",
    mode: "ordinary_travel_range",
    pricing_complete: false,
    budget_cap_cny: cap,
    line_items: [...sourceFacts, ...estimates],
    source_price_items: sourceFacts,
    estimated_total_cny: midpoint,
    recommended_range_cny: { minimum, maximum },
    remaining_cny: roundCny(cap - midpoint),
    confirmed_subtotal_cny: null,
    confirmed_subtotal_range_cny: null,
    summary_label: "普通出行估算区间",
    total_label: "住宿、吃、游、市内交通总区间",
    scope: "包含普通酒店、饮食、市内交通、游玩费用和少量伴手礼；不含往返目的地的大交通、购物大额消费与预订手续费。",
    notice: "这是按普通消费水平做的合理区间，不是实时价格。资料页中的金额会单独展示；酒店、餐饮和未标价景点使用的是非预订估算。",
    feasibility,
    feasibility_label: feasibilityLabel,
    price_evidence_count: evidence.length,
    unpriced_planned_place_count: unpricedPlaceCount,
    total_is_source_backed: false,
    total_is_complete_trip_budget: false,
  };
}

function buildValidation(retrieval, budget) {
  const coverageOk = Number(retrieval?.source_count) > 0;
  const withinBudget = budget.feasibility === "budget_too_low" ? false : budget.feasibility === "budget_covers_range";
  const issues = [];
  if (!coverageOk) {
    issues.push("未找到能对应本次目的地的公开资料，系统没有生成替代城市或虚构景点。");
  }
  if (budget.feasibility === "budget_too_low") {
    issues.push("你填写的预算低于普通出行区间，计划已保留但需要缩短天数或压缩住宿、餐饮和收费景点。 ");
  } else if (budget.feasibility === "budget_needs_choices") {
    issues.push("预算处于普通出行区间内，建议按照页面的平价住宿、小吃和低价景点方向执行。 ");
  }
  issues.push("票价、酒店、餐饮、交通和预约信息会变化，请在出行前通过资料页或商家页面确认。");
  return {
    passed: coverageOk,
    within_budget: withinBudget,
    coverage_ok: coverageOk,
    pricing_complete: false,
    issues,
    revision_count: 0,
  };
}

export function buildFreePublicSourcePlan(payload, retrieval) {
  const request = {
    destination: String(payload.destination || "").trim(),
    start_date: payload.start_date || null,
    days: Number(payload.days),
    travelers: Number(payload.travelers),
    total_budget_cny: Number(payload.total_budget_cny),
    interests: Array.isArray(payload.interests) ? payload.interests.map(nonEmptyText).filter(Boolean) : [],
    travel_style: Object.hasOwn(STYLE_PROFILES, payload.travel_style) ? payload.travel_style : "balanced",
  };
  const sources = Array.isArray(retrieval?.sources) ? retrieval.sources : [];
  const selections = sourceSelections(request, sources);
  const planned = makeItinerary(request, selections);
  const plannedSelections = planned.itinerary.flatMap((day) => day.items)
    .filter((item) => item.source_id)
    .map((item) => selections.find((selection) => selection.source.source_id === item.source_id))
    .filter(Boolean);
  const budget = buildBudgetFramework(request, plannedSelections);
  const validation = buildValidation(retrieval || { source_count: 0 }, budget);
  const identity = JSON.stringify({
    request,
    sourceIds: sources.map((source) => source.source_id),
    priceEvidence: selections.flatMap((selection) => selection.price_evidence),
    mode: retrieval?.mode,
  });
  const sourceCount = Number(retrieval?.source_count) || 0;
  const selectedSourceIds = new Set(plannedSelections.map((selection) => selection.source.source_id).filter(Boolean));

  return {
    plan_id: "FREE-SOURCES-" + stableHash(identity),
    request_summary: {
      destination: request.destination,
      start_date: request.start_date,
      days: request.days,
      travelers: request.travelers,
      interests: request.interests,
      travel_style: request.travel_style,
      mock_mode: false,
      data_mode: "free_public_sources",
    },
    itinerary: planned.itinerary,
    alternatives: planned.alternatives.map((selection) => ({
      source_id: selection.source.source_id,
      title: titleForSource(selection.source),
      uri: sourceUrl(selection.source),
      selection_reason: sourceReason(selection),
    })),
    planning_basis: {
      source_count: sourceCount,
      selected_source_count: selectedSourceIds.size,
      alternative_source_count: planned.alternatives.length,
      matched_interest_count: selections.reduce((total, selection) => total + selection.matched_interests.length, 0),
      travel_style_note: planned.style.schedule_note,
      source_order_note: "地点按本次偏好、公开资料标签和可确认价格信息排序；它不是实时导航路线。",
    },
    budget,
    citations: sources,
    retrieval: {
      mode: "free_public_sources",
      provider: retrieval?.provider || "中文维基导游 / 中文维基百科",
      status: retrieval?.status || "unavailable",
      retrieved_at: retrieval?.retrieved_at || null,
      cache_age_seconds: Number(retrieval?.cache_age_seconds) || 0,
      source_count: sourceCount,
      notices: Array.isArray(retrieval?.notices) ? retrieval.notices : [],
    },
    validation,
    ticket: null,
  };
}
