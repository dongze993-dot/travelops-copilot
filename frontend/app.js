(() => {
  "use strict";

  const API = {
    plan: "/api/v1/plans",
    freePlan: "/api/v3/free-plans",
  };
  const isStaticBrowserDemo = window.TRAVELOPS_STATIC_DEMO === true;
  const isNetlifySite = /(^|\.)netlify\.app$/i.test(window.location.hostname);

  const planForm = document.querySelector("#plan-form");
  const planButton = document.querySelector("#plan-submit");
  const planStatus = document.querySelector("#plan-status");
  const planOutput = document.querySelector("#plan-output");
  const emptyState = document.querySelector("#empty-state");
  const resultState = document.querySelector("#result-state");
  const environmentLabel = document.querySelector("#environment-label");
  const publicDemoNotice = document.querySelector("#public-demo-notice");
  const sourcesSection = document.querySelector("#sources-section");
  const budgetSection = document.querySelector("#budget-section");
  const itinerarySection = document.querySelector("#itinerary-section");
  const travelTip = document.querySelector("#travel-tip");

  let useFreePublicSources = isNetlifySite;

  const today = new Date();
  today.setDate(today.getDate() + 7);
  document.querySelector("#start-date").value = today.toISOString().slice(0, 10);

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function shortText(value, maximum = 250) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > maximum ? `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…` : text;
  }

  function safeUrl(value) {
    try {
      const url = new URL(value, window.location.origin);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function cny(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 }).format(number)
      : "";
  }

  function cnyRange(range) {
    const minimum = cny(range?.minimum);
    const maximum = cny(range?.maximum);
    return minimum && maximum ? (minimum === maximum ? minimum : `${minimum}–${maximum}`) : "";
  }

  function amountRange(item, sourceAmount = false) {
    const direct = sourceAmount ? item?.source_amount_cny : item?.amount_cny;
    const minimum = sourceAmount ? item?.source_minimum_cny : item?.minimum_cny;
    const maximum = sourceAmount ? item?.source_maximum_cny : item?.maximum_cny;
    return cny(direct) || cnyRange({ minimum, maximum }) || "";
  }

  function styleLabel(value) {
    return {
      budget: "精打细算",
      balanced: "均衡体验",
      comfort: "舒适从容",
    }[value] || "旅行计划";
  }

  function setStatus(message = "", kind = "") {
    planStatus.textContent = message;
    planStatus.className = `form-status${kind ? ` ${kind}` : ""}`;
  }

  function setButtonLoading(isLoading, label = "正在生成") {
    if (!planButton.dataset.defaultLabel) planButton.dataset.defaultLabel = planButton.innerHTML;
    planButton.disabled = isLoading;
    planButton.innerHTML = isLoading
      ? `<span>${escapeHtml(label)}</span><span aria-hidden="true">⋯</span>`
      : planButton.dataset.defaultLabel;
  }

  async function parseResponse(response) {
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const detail = typeof body === "object" ? body.detail || body.message : body;
      const error = new Error(detail || `请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async function staticDemoAdapter() {
    if (!isStaticBrowserDemo) return null;
    if (window.TravelOpsStaticDemoReady && typeof window.TravelOpsStaticDemoReady.then === "function") {
      await window.TravelOpsStaticDemoReady;
    }
    if (!window.TravelOpsStaticDemo) throw new Error("本地预览资料尚未加载，请刷新后再试。");
    return window.TravelOpsStaticDemo;
  }

  async function postJson(url, payload) {
    const staticDemo = await staticDemoAdapter();
    if (staticDemo) return staticDemo.postJson(url, payload);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    return parseResponse(response);
  }

  async function getJson(url) {
    const staticDemo = await staticDemoAdapter();
    if (staticDemo) return staticDemo.getJson(url);
    return parseResponse(await fetch(url, { headers: { Accept: "application/json" } }));
  }

  function setPublicCopy() {
    useFreePublicSources = true;
    environmentLabel.textContent = "免费公开资料";
    publicDemoNotice.textContent = "不需要 API Key、账号或绑卡。地点和资料页金额会附来源链接；住宿、餐饮等会以普通消费区间估算并明确标注。资料价格和开放情况会变化，出发前请打开链接确认。";
  }

  async function configureDataSource() {
    if (isStaticBrowserDemo) {
      environmentLabel.textContent = "本地预览";
      publicDemoNotice.textContent = "本地预览使用项目自带资料；公开网站会查询可打开的中文公开资料。";
      return;
    }

    if (isNetlifySite) setPublicCopy();
    try {
      const health = await getJson("/health");
      if (health?.deployment === "netlify_functions" || health?.free_public_sources?.enabled === true) {
        setPublicCopy();
      } else if (!isNetlifySite) {
        environmentLabel.textContent = "本地计划模式";
      }
    } catch {
      if (!isNetlifySite) environmentLabel.textContent = "本地计划模式";
    }
  }

  function getPlanPayload() {
    const interests = [...document.querySelectorAll('input[name="interests"]:checked')].map((item) => item.value);
    return {
      destination: document.querySelector("#destination").value.trim(),
      start_date: document.querySelector("#start-date").value || undefined,
      days: Number(document.querySelector("#days").value),
      travelers: Number(document.querySelector("#travelers").value),
      total_budget_cny: Number(document.querySelector("#total-budget").value),
      interests,
      travel_style: document.querySelector('input[name="travel_style"]:checked').value,
    };
  }

  function renderMetrics(plan) {
    const summary = plan.request_summary || {};
    const basis = plan.planning_basis || {};
    const budget = plan.budget || {};
    const estimate = cnyRange(budget.recommended_range_cny) || cny(budget.estimated_total_cny);
    const metrics = [
      [`${Number(summary.days) || 0} 天`, "游玩天数"],
      [`${Number(basis.selected_source_count) || 0} 个`, "已安排资料地点"],
      [estimate || "待估算", "普通出行总区间"],
    ];
    document.querySelector("#metric-row").innerHTML = metrics
      .map(([value, label]) => `<div class="metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`)
      .join("");
  }

  function evidenceAmount(evidence) {
    return cny(evidence?.amount_cny)
      || cny(evidence?.source_amount_cny)
      || cnyRange({ minimum: evidence?.minimum_cny ?? evidence?.source_minimum_cny, maximum: evidence?.maximum_cny ?? evidence?.source_maximum_cny });
  }

  function priceEvidenceHtml(evidence = []) {
    const records = Array.isArray(evidence) ? evidence.slice(0, 3) : [];
    return records.map((record) => {
      const amount = evidenceAmount(record);
      const href = safeUrl(record.evidence_url || record.source_url);
      if (!amount) return "";
      const detail = shortText(record.evidence_text || record.detail || "资料页中出现的费用信息", 150);
      const link = href
        ? `<a class="evidence-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">查看费用原文 ↗</a>`
        : "";
      return `<div class="source-price"><strong>资料金额 ${escapeHtml(amount)}</strong><span>${escapeHtml(detail)}</span>${link}</div>`;
    }).join("");
  }

  function sourceReferenceHtml(item) {
    const href = safeUrl(item?.source_url);
    return href
      ? `<a class="source-reference" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">查看这条资料 ↗</a>`
      : "";
  }

  function renderItinerary(itinerary = []) {
    const validDays = Array.isArray(itinerary) ? itinerary : [];
    document.querySelector("#itinerary-count").textContent = validDays.length ? `${validDays.length} 天` : "";
    document.querySelector("#itinerary").innerHTML = validDays.map((day) => {
      const items = Array.isArray(day.items) ? day.items : [];
      const itemHtml = items.map((item) => {
        const sourceBacked = Boolean(item.source_id && item.source_url);
        const selectionReason = shortText(item.selection_reason, 135);
        const detail = shortText(item.description, sourceBacked ? 220 : 135);
        return `<div class="activity${sourceBacked ? " activity-sourced" : " activity-flexible"}">
          <span class="activity-slot">${escapeHtml(item.slot || "安排")}</span>
          <div class="activity-content">
            <strong>${escapeHtml(item.title || "当日安排")}</strong>
            ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
            ${selectionReason ? `<div class="activity-meta">${escapeHtml(selectionReason)}</div>` : ""}
            ${priceEvidenceHtml(item.price_evidence)}
            ${sourceReferenceHtml(item)}
          </div>
        </div>`;
      }).join("");
      return `<article class="itinerary-day">
        <div class="day-label">第 ${escapeHtml(day.day || "")} 天${day.date_label ? ` · ${escapeHtml(day.date_label)}` : ""}</div>
        <div class="day-content">
          <h4>${escapeHtml(day.theme || "当天安排")}</h4>
          ${itemHtml || '<p class="empty-inline">这一天没有可用的公开资料。</p>'}
        </div>
      </article>`;
    }).join("");
  }

  function renderBudget(budget = {}) {
    const items = Array.isArray(budget.line_items) ? budget.line_items : [];
    const estimate = cnyRange(budget.recommended_range_cny) || cny(budget.estimated_total_cny);
    document.querySelector("#budget-currency").textContent = budget.currency || "CNY";
    document.querySelector("#budget-scope").textContent = budget.scope || "按普通消费水平给出区间；来源页中的价格会单独展示。";

    if (!items.length) {
      document.querySelector("#budget").innerHTML = `<div class="no-result"><strong>暂时无法形成费用区间。</strong><p>请检查天数、人数和预算后再试。</p></div>`;
    } else {
      document.querySelector("#budget").innerHTML = `${items.map((item) => {
        const original = amountRange(item, true) || amountRange(item, false) || "资料金额待确认";
        const calculated = amountRange(item, false) || original;
        const href = safeUrl(item.evidence_url);
        const evidence = shortText(item.evidence_text, 180);
        const isSourceFact = item.estimate_type === "source_fact";
        return `<div class="budget-item">
          <div>
            <strong>${escapeHtml(item.category || "普通出行费用")}</strong>
            <small>${escapeHtml(evidence || item.assumption || "普通出行估算")}</small>
            ${item.assumption ? `<small>${escapeHtml(item.assumption)}</small>` : ""}
            ${href ? `<a class="evidence-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">查看费用原文 ↗</a>` : ""}
          </div>
          <span class="budget-amount">${escapeHtml(isSourceFact ? original : calculated)}</span>
        </div>`;
      }).join("")}
      <div class="budget-total"><span>${escapeHtml(budget.total_label || "普通出行总区间")}</span><span>${escapeHtml(estimate || "待估算")}</span></div>`;
    }

    const notice = `${budget.feasibility_label ? `${budget.feasibility_label} ` : ""}${budget.notice || "价格会变化，出发前请确认来源页。"}`;
    travelTip.hidden = false;
    travelTip.textContent = `说明：${notice}`;
  }

  function renderCitations(citations = []) {
    const sources = Array.isArray(citations) ? citations.filter((source) => source && (source.title || source.uri)) : [];
    sourcesSection.hidden = sources.length === 0;
    if (!sources.length) {
      document.querySelector("#citations").innerHTML = "";
      return;
    }
    document.querySelector("#citation-count").textContent = `${sources.length} 条`;
    document.querySelector("#citations").innerHTML = sources.map((source) => {
      const href = safeUrl(source.uri);
      const title = escapeHtml(source.title || "公开资料");
      const heading = href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${title} <span aria-hidden="true">↗</span></a>`
        : `<strong>${title}</strong>`;
      const tags = Array.isArray(source.matched_interests) && source.matched_interests.length
        ? `<span class="citation-relevance">匹配：${escapeHtml(source.matched_interests.join("、"))}</span>`
        : (href ? '<span class="citation-relevance">打开资料</span>' : "");
      return `<article class="citation"><div class="citation-top">${heading}${tags}</div>${source.excerpt ? `<p>${escapeHtml(shortText(source.excerpt, 220))}</p>` : ""}</article>`;
    }).join("");
  }

  function renderNoSourcePlan(summary = {}) {
    document.querySelector("#summary-label").textContent = summary.destination || "旅行计划";
    document.querySelector("#summary-title").textContent = "暂未找到可用的目的地资料";
    document.querySelector("#plan-badge").textContent = "换个名称试试";
    document.querySelector("#metric-row").innerHTML = "";
    document.querySelector("#plan-basis").textContent = "系统没有用其他城市的资料补空，也没有生成未查证的景点或价格。";
    document.querySelector("#itinerary-count").textContent = "";
    document.querySelector("#itinerary").innerHTML = `<div class="no-result"><strong>没有找到能对应这个目的地的公开资料。</strong><p>可尝试输入“上饶市”“婺源县”等完整名称，或输入更具体的景区名后再试。</p></div>`;
    itinerarySection.hidden = false;
    budgetSection.hidden = true;
    travelTip.hidden = true;
    sourcesSection.hidden = true;
  }

  function renderPlanBasis(summary = {}, plan = {}) {
    const interests = Array.isArray(summary.interests) && summary.interests.length ? summary.interests.join("、") : "未选择偏好";
    const sourceCount = Number(plan.retrieval?.source_count) || 0;
    const placeCount = Number(plan.planning_basis?.selected_source_count) || 0;
    document.querySelector("#plan-basis").textContent = `根据“${summary.destination || "目的地"}”、${interests}、${Number(summary.days) || 0} 天、${Number(summary.travelers) || 0} 人、${styleLabel(summary.travel_style)}和你填写的上限 ${cny(plan.budget?.budget_cap_cny) || "未填写"}，从 ${sourceCount} 条公开资料中安排了 ${placeCount} 个地点。`;
  }

  function renderPlan(plan) {
    const summary = plan.request_summary || {};
    const citations = Array.isArray(plan.citations) ? plan.citations : [];
    const sourceCount = Number(plan.retrieval?.source_count) || citations.length;

    emptyState.hidden = true;
    planOutput.hidden = false;
    if (!sourceCount) {
      renderNoSourcePlan(summary);
      resultState.textContent = "没有找到资料";
      resultState.className = "result-state";
      return false;
    }

    const interests = Array.isArray(summary.interests) && summary.interests.length ? summary.interests.join("、") : "公开资料";
    document.querySelector("#summary-label").textContent = `${summary.destination || "目的地"} · ${interests}`;
    document.querySelector("#summary-title").textContent = `${summary.destination || "目的地"}${summary.days ? ` ${summary.days} 天游玩计划` : "游玩计划"}`;
    document.querySelector("#plan-badge").textContent = `查到 ${sourceCount} 条资料`;
    itinerarySection.hidden = false;
    budgetSection.hidden = false;
    renderPlanBasis(summary, plan);
    renderMetrics(plan);
    renderItinerary(plan.itinerary);
    renderBudget(plan.budget);
    renderCitations(citations);
    resultState.textContent = "计划已生成";
    resultState.className = "result-state ready";

    if (window.matchMedia("(max-width: 900px)").matches) {
      planOutput.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return true;
  }

  function friendlyError(error) {
    if (error?.status === 429) return "查询次数较多，请等一分钟后再试。";
    if (error?.status === 504) return "公开资料查询超时，请稍后再试。";
    if (error?.status >= 500) return "公开资料服务暂时不可用，请稍后再试。";
    return "暂时无法生成计划，请检查目的地名称后重试。";
  }

  planForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!planForm.reportValidity()) return;
    const payload = getPlanPayload();
    if (!payload.destination) {
      setStatus("请填写目的地。", "error");
      document.querySelector("#destination").focus();
      return;
    }

    const useFreeRoute = useFreePublicSources;
    setStatus(useFreeRoute ? "正在查询公开资料并整理按天计划…" : "正在整理旅行计划…");
    setButtonLoading(true);
    resultState.textContent = "查询中";
    resultState.className = "result-state";
    try {
      const plan = await postJson(useFreeRoute ? API.freePlan : API.plan, payload);
      const hasSources = renderPlan(plan);
      setStatus(
        hasSources
          ? `已查到 ${Number(plan.retrieval?.source_count) || plan.citations?.length || 0} 条公开资料；每个地点和费用依据都可以打开查看。`
          : "没有找到对应公开资料，试试更完整的城市、县城或景区名称。",
        hasSources ? "success" : "error",
      );
    } catch (error) {
      setStatus(friendlyError(error), "error");
      resultState.textContent = "等待重试";
      resultState.className = "result-state";
    } finally {
      setButtonLoading(false);
    }
  });

  void configureDataSource();
})();
