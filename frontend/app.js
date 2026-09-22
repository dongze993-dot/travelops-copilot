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
    return minimum && maximum ? `${minimum}–${maximum}` : "";
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
    if (!planButton.dataset.defaultLabel) {
      planButton.dataset.defaultLabel = planButton.innerHTML;
    }
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
    if (!window.TravelOpsStaticDemo) {
      throw new Error("本地预览资料尚未加载，请刷新后再试。");
    }
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
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    return parseResponse(response);
  }

  function setPublicCopy() {
    useFreePublicSources = true;
    environmentLabel.textContent = "免费公开资料";
    publicDemoNotice.textContent = "不需要 API Key、账号或绑卡。只用目的地查询公开资料；票价、营业时间和预约要求会变化，出发前请打开资料来源确认。";
  }

  async function configureDataSource() {
    if (isStaticBrowserDemo) {
      environmentLabel.textContent = "本地预览";
      publicDemoNotice.textContent = "这是本地预览，使用项目内置的示例资料；公开网站会自动查询可打开的免费资料来源。";
      return;
    }

    // A public Netlify deployment must never fall back to the old synthetic
    // route. If free lookup is unavailable, show a clear error instead.
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
    const budget = plan.budget || {};
    const total = cnyRange(budget.recommended_range_cny) || cny(budget.estimated_total_cny) || "待查询";
    const metrics = [
      [`${Number(summary.days) || 0} 天`, "游玩天数"],
      [`${Number(summary.travelers) || 0} 人`, "出行人数"],
      [total, "全程游玩参考"],
    ];
    document.querySelector("#metric-row").innerHTML = metrics
      .map(([value, label]) => `<div class="metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`)
      .join("");
  }

  function renderItinerary(itinerary = []) {
    const validDays = Array.isArray(itinerary) ? itinerary : [];
    document.querySelector("#itinerary-count").textContent = validDays.length ? `${validDays.length} 天` : "";
    document.querySelector("#itinerary").innerHTML = validDays.map((day) => {
      const items = Array.isArray(day.items) ? day.items : [];
      const itemHtml = items.map((item) => {
        const meta = [];
        if (Number.isFinite(Number(item.estimated_duration_minutes)) && Number(item.estimated_duration_minutes) > 0) {
          meta.push(`约 ${Math.round(Number(item.estimated_duration_minutes))} 分钟`);
        }
        if (Number.isFinite(Number(item.estimated_cost_cny))) {
          meta.push(`参考 ${cny(item.estimated_cost_cny)}`);
        }
        return `<div class="activity">
          <span class="activity-slot">${escapeHtml(item.slot || "安排")}</span>
          <div class="activity-content">
            <strong>${escapeHtml(item.title || "当日游玩安排")}</strong>
            ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
            ${meta.length ? `<div class="activity-meta">${escapeHtml(meta.join(" · "))}</div>` : ""}
          </div>
        </div>`;
      }).join("");
      return `<article class="itinerary-day">
        <div class="day-label">第 ${escapeHtml(day.day || "")} 天${day.date_label ? ` · ${escapeHtml(day.date_label)}` : ""}</div>
        <div class="day-content">
          <h4>${escapeHtml(day.theme || "当日游玩安排")}</h4>
          ${itemHtml || '<p class="empty-inline">这一天暂时没有可安排的公开资料。</p>'}
        </div>
      </article>`;
    }).join("");
  }

  function renderBudget(budget = {}) {
    const items = Array.isArray(budget.line_items) ? budget.line_items : [];
    const range = cnyRange(budget.recommended_range_cny);
    document.querySelector("#budget-currency").textContent = budget.currency || "CNY";
    document.querySelector("#budget-scope").textContent = budget.scope || "景区、餐饮、市内短途出行和小额伴手礼；不含往返交通与住宿。";
    document.querySelector("#budget").innerHTML = `${items.map((item) => `<div class="budget-item">
      <div><strong>${escapeHtml(item.category || "游玩支出")}</strong>${item.assumption ? `<small>${escapeHtml(item.assumption)}</small>` : ""}</div>
      ${cny(item.amount_cny) ? `<span class="budget-amount">${cny(item.amount_cny)}</span>` : ""}
    </div>`).join("")}
    <div class="budget-total"><span>${escapeHtml(budget.total_label || "全程游玩参考")}</span><span>${escapeHtml(range || cny(budget.estimated_total_cny) || "")}</span></div>`;

    const notice = budget.notice || "费用会随季节、购票方式和实际消费变化。";
    travelTip.hidden = false;
    travelTip.textContent = `提示：${notice}`;
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
      return `<article class="citation">
        <div class="citation-top">${heading}${href ? '<span class="citation-relevance">打开资料</span>' : ""}</div>
        ${source.excerpt ? `<p>${escapeHtml(source.excerpt)}</p>` : ""}
      </article>`;
    }).join("");
  }

  function renderNoSourcePlan(summary = {}) {
    document.querySelector("#summary-label").textContent = summary.destination || "旅行计划";
    document.querySelector("#summary-title").textContent = "暂未查到可用资料";
    document.querySelector("#plan-badge").textContent = "换个名称再试";
    document.querySelector("#metric-row").innerHTML = "";
    document.querySelector("#itinerary-count").textContent = "";
    document.querySelector("#itinerary").innerHTML = `<div class="no-result">
      <strong>暂时没有找到能直接用于行程的公开资料。</strong>
      <p>可以试试输入“上饶市”而不是简称，或输入更具体的县城、景区名称；稍后再试也可以。</p>
    </div>`;
    itinerarySection.hidden = false;
    budgetSection.hidden = true;
    travelTip.hidden = true;
    sourcesSection.hidden = true;
  }

  function renderPlan(plan) {
    const summary = plan.request_summary || {};
    const citations = Array.isArray(plan.citations) ? plan.citations : [];
    const sourceCount = Number(plan.retrieval?.source_count) || citations.length;

    emptyState.hidden = true;
    planOutput.hidden = false;
    if (!sourceCount) {
      renderNoSourcePlan(summary);
      resultState.textContent = "暂未查到资料";
      resultState.className = "result-state";
      return false;
    }

    document.querySelector("#summary-label").textContent = `${summary.destination || "目的地"} · ${styleLabel(summary.travel_style)}`;
    document.querySelector("#summary-title").textContent = `${summary.destination || "目的地"}${summary.days ? ` ${summary.days} 日旅行计划` : "旅行计划"}`;
    document.querySelector("#plan-badge").textContent = "旅行建议";
    itinerarySection.hidden = false;
    budgetSection.hidden = false;
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
    setStatus(useFreeRoute ? "正在查询免费公开资料，整理旅行计划…" : "正在整理旅行计划…");
    setButtonLoading(true);
    resultState.textContent = "生成中";
    resultState.className = "result-state";
    try {
      const plan = await postJson(useFreeRoute ? API.freePlan : API.plan, payload);
      const hasSources = renderPlan(plan);
      setStatus(
        hasSources
          ? `已整理 ${Number(plan.retrieval?.source_count) || plan.citations?.length || 0} 条公开资料，点击下方资料可查看原文。`
          : "暂未查到公开资料，请试试更具体的城市、县城或景区名称。",
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
