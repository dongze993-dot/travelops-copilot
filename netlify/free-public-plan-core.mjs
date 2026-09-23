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

function foodItem(selection, request) {
  const source = selection.source;
  return {
    slot: "中午",
    title: "资料中的本地餐饮信息：" + titleForSource(source),
    description: "公开资料摘要：" + sourceExcerpt(source) + " " + sourceReason(selection, request) + " 本项目不指定餐厅、菜单或价格，请按当天位置和个人口味选择。",
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
  return {
    slot: "中午",
    title: foodRequested ? "安排当地餐饮探索" : "安排就近用餐",
    description: foodRequested
      ? "本次没有查到可直接引用的本地美食资料，因此不编造餐厅或招牌菜。可根据上午所在区域、自身忌口和现场营业信息自行选择。"
      : "按上午活动所在区域自行选择正餐。本项目不指定餐厅、菜单或价格，也不把未经公开资料支撑的店铺写入计划。",
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

function eveningItem() {
  return {
    slot: "晚上",
    title: "晚间自由安排",
    description: "可在当天活动区域或住宿附近散步、用餐、休息。营业状态、消费金额和具体店铺请以当天公开信息与现场情况为准。",
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
    eveningItem(),
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

function multiplierForEvidence(evidence, request) {
  if (evidence.pricing_scope === "per_person") return request.travelers;
  if (evidence.pricing_scope === "per_group") return 1;
  if (evidence.pricing_scope === "per_day_per_person") return request.travelers * request.days;
  if (evidence.pricing_scope === "per_day_per_group") return request.days;
  return null;
}

function priceLineItem(evidence, request) {
  const multiplier = evidence.aggregation_safe === false ? null : multiplierForEvidence(evidence, request);
  const included = multiplier != null;
  const minimum = included ? roundCny(evidence.minimum_cny * multiplier) : evidence.minimum_cny;
  const maximum = included ? roundCny(evidence.maximum_cny * multiplier) : evidence.maximum_cny;
  const sourceAmount = moneyLabel(evidence.minimum_cny, evidence.maximum_cny);
  const calculation = evidence.aggregation_safe === false
    ? "同一条原文中出现多个可选金额，可能是不同票种；均保留原文，但不相加"
    : included
    ? evidence.pricing_scope === "per_person"
      ? "资料金额 " + sourceAmount + " / 人 × " + request.travelers + " 人"
      : evidence.pricing_scope === "per_group"
        ? "资料金额 " + sourceAmount + " / 团（不按人数重复计算）"
        : evidence.pricing_scope === "per_day_per_person"
          ? "资料金额 " + sourceAmount + " / 人 / 天 × " + request.travelers + " 人 × " + request.days + " 天"
          : "资料金额 " + sourceAmount + " / 团 / 天 × " + request.days + " 天"
    : "资料金额 " + sourceAmount + " 的计价单位未结构化标明，按原金额展示，未计入同行总额";
  return {
    category: evidence.label,
    amount_cny: minimum === maximum ? minimum : null,
    minimum_cny: minimum,
    maximum_cny: maximum,
    source_amount_cny: evidence.minimum_cny === evidence.maximum_cny ? evidence.minimum_cny : null,
    source_minimum_cny: evidence.minimum_cny,
    source_maximum_cny: evidence.maximum_cny,
    pricing_scope: evidence.pricing_scope,
    quantity: multiplier,
    included_in_subtotal: included,
    source_id: evidence.source_id,
    source_title: evidence.source_title,
    evidence_url: evidence.evidence_url,
    evidence_text: evidence.evidence_text,
    assumption: calculation,
  };
}

function buildBudgetFramework(request, selections) {
  const evidence = dedupePriceEvidence(selections.flatMap((selection) => selection.price_evidence));
  const lineItems = evidence.map((item) => priceLineItem(item, request));
  const included = lineItems.filter((item) => item.included_in_subtotal);
  const unaggregated = lineItems.filter((item) => !item.included_in_subtotal);
  const minimum = included.length
    ? roundCny(included.reduce((total, item) => total + item.minimum_cny, 0))
    : null;
  const maximum = included.length
    ? roundCny(included.reduce((total, item) => total + item.maximum_cny, 0))
    : null;
  const midpoint = minimum == null || maximum == null ? null : roundCny((minimum + maximum) / 2);
  const uncoveredPlaceCount = selections.filter((selection) => !selection.price_evidence.length).length;
  const hasSubtotal = midpoint != null;
  const hasAlternativePrices = lineItems.some((item) => item.included_in_subtotal === false && item.pricing_scope === "per_person" && item.assumption.includes("多个可选金额"));
  const notice = !evidence.length
    ? "本次公开资料没有可引用的金额记录，因此不输出看似精确的游玩总价。下方地点仍可查看资料页，但餐饮、门票和市内出行需要自行确认。"
    : !hasSubtotal
      ? hasAlternativePrices
        ? "找到了 " + evidence.length + " 条含金额的公开资料，其中同一原文的多个票种可能互斥；金额按原文保留，不把它们错误相加为多人总价。"
        : "找到了 " + evidence.length + " 条含金额的公开资料，但资料没有结构化标明计价单位；金额按原文保留，不把它们错误相加为多人总价。"
      : "仅汇总了 " + included.length + " 条计价单位明确的公开资料，得到 " + moneyLabel(minimum, maximum) + " 的可确认部分；餐饮、市内出行和未标价地点不在这个小计中。";
  return {
    currency: "CNY",
    mode: hasSubtotal ? "sourced_partial_subtotal" : "source_evidence_pending",
    pricing_complete: false,
    budget_cap_cny: roundCny(request.total_budget_cny),
    line_items: lineItems,
    source_price_items: lineItems,
    estimated_total_cny: midpoint,
    recommended_range_cny: hasSubtotal ? { minimum, maximum } : null,
    remaining_cny: hasSubtotal ? roundCny(request.total_budget_cny - midpoint) : null,
    confirmed_subtotal_cny: midpoint,
    confirmed_subtotal_range_cny: hasSubtotal ? { minimum, maximum } : null,
    summary_label: hasSubtotal ? "可确认的公开价格小计" : "公开价格依据",
    total_label: hasSubtotal ? "可确认部分小计" : "暂无可汇总的公开价格",
    scope: "只使用资料中有明确金额与计价单位的条目；不把未标价的餐饮、市内出行、往返交通或住宿编入总价。",
    notice,
    price_evidence_count: evidence.length,
    included_price_evidence_count: included.length,
    unaggregated_price_evidence_count: unaggregated.length,
    unpriced_planned_place_count: uncoveredPlaceCount,
    total_is_source_backed: hasSubtotal,
    total_is_complete_trip_budget: false,
  };
}

function buildValidation(retrieval, budget) {
  const coverageOk = Number(retrieval?.source_count) > 0;
  const withinBudget = budget.confirmed_subtotal_cny == null
    ? null
    : budget.confirmed_subtotal_cny <= budget.budget_cap_cny;
  const issues = [];
  if (!coverageOk) {
    issues.push("未找到能对应本次目的地的公开资料，系统没有生成替代城市或虚构景点。");
  }
  if (!budget.total_is_source_backed) {
    issues.push("公开资料没有足够的结构化价格证据，不能诚实地汇总多人游玩总价。");
  } else if (withinBudget === false) {
    issues.push("已查到的可确认价格小计高于你填写的游玩预算上限；其他未标价消费尚未计入。 ");
  }
  issues.push("票价、营业时间、餐饮价格、交通和预约信息请在出行前通过资料页或官方渠道确认。");
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
