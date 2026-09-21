(() => {
  "use strict";

  // The browser only calls same-origin APIs. Any provider credential stays on
  // the server; the optional v2 route never receives a key from this UI.
  const API = {
    plan: "/api/v1/plans",
    modelPlan: "/api/v2/plans",
    tickets: "/api/v1/tickets",
  };
  const isStaticBrowserDemo = window.TRAVELOPS_STATIC_DEMO === true;

  const planForm = document.querySelector("#plan-form");
  const ticketForm = document.querySelector("#ticket-form");
  const planStatus = document.querySelector("#plan-status");
  const ticketStatus = document.querySelector("#ticket-status");
  const planButton = document.querySelector("#plan-submit");
  const ticketButton = document.querySelector("#ticket-submit");
  const planOutput = document.querySelector("#plan-output");
  const emptyState = document.querySelector("#empty-state");
  const resultState = document.querySelector("#result-state");
  const useModelEnhancement = document.querySelector("#use-model-enhancement");
  const createFollowUpTicket = document.querySelector("#create-follow-up-ticket");
  const followUpTicketOption = document.querySelector("#follow-up-ticket-option");
  const handoffCard = document.querySelector("#handoff-card");
  const handoffCapability = document.querySelector("#handoff-capability");
  const publicDemoNotice = document.querySelector("#public-demo-notice");
  const environmentLabel = document.querySelector("#environment-label");

  let lastPlanId = null;
  let isPublicDemo = false;

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

  function setStatus(element, message = "", kind = "") {
    element.textContent = message;
    element.className = `form-status${kind ? ` ${kind}` : ""}`;
  }

  function setButtonLoading(button, isLoading, loadingLabel) {
    if (!button.dataset.defaultLabel) {
      button.dataset.defaultLabel = button.innerHTML;
    }
    button.disabled = isLoading;
    button.innerHTML = isLoading ? `<span>${escapeHtml(loadingLabel)}</span><span aria-hidden="true">⋯</span>` : button.dataset.defaultLabel;
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
    const readiness = window.TravelOpsStaticDemoReady;
    if (readiness && typeof readiness.then === "function") await readiness;
    if (!window.TravelOpsStaticDemo) {
      throw new Error("静态浏览器演示未能加载本地资料适配器，请刷新页面后重试。");
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

  function enablePublicDemoMode() {
    isPublicDemo = true;
    createFollowUpTicket.checked = false;
    createFollowUpTicket.disabled = true;
    followUpTicketOption.hidden = true;
    handoffCard.hidden = true;
    handoffCapability.hidden = true;
    publicDemoNotice.hidden = false;
    if (isStaticBrowserDemo) {
      useModelEnhancement.checked = false;
      useModelEnhancement.disabled = true;
      useModelEnhancement.closest(".model-option").hidden = true;
      document.querySelector("#notes").closest(".notes-field").hidden = true;
      document.querySelector("#trace-heading").textContent = "浏览器计算步骤";
      publicDemoNotice.innerHTML = "<strong>静态浏览器演示：</strong>结果仅由本页加载的合成资料与确定性规则生成，不运行 FastAPI、LangGraph、模型或 CRM；请勿输入个人信息。";
      environmentLabel.textContent = "静态浏览器演示";
      return;
    }
    environmentLabel.textContent = "公开演示环境";
  }

  async function detectPublicDemoMode() {
    if (isStaticBrowserDemo) {
      enablePublicDemoMode();
      return;
    }
    try {
      const health = await getJson("/health");
      if (health.public_demo_mode === true) enablePublicDemoMode();
    } catch {
      // A failed status probe must not pretend the current host is public.
    }
  }

  function cny(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 }).format(number)
      : "—";
  }

  function plural(value, label) {
    return `${Number(value) || 0} ${label}`;
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
      notes: isStaticBrowserDemo ? undefined : document.querySelector("#notes").value.trim() || undefined,
      create_follow_up_ticket: !isPublicDemo && createFollowUpTicket.checked,
    };
  }

  function renderMetrics(plan) {
    const summary = plan.request_summary || {};
    const budget = plan.budget || {};
    document.querySelector("#metric-row").innerHTML = [
      [plural(summary.days, "天"), "行程周期"],
      [plural(summary.travelers, "人"), "出行人数"],
      [cny(budget.estimated_total_cny), "预计花费"],
    ].map(([value, label]) => `<div class="metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
  }

  function renderItinerary(itinerary = []) {
    document.querySelector("#itinerary-count").textContent = `${itinerary.length} DAYS`;
    document.querySelector("#itinerary").innerHTML = itinerary.map((day) => {
      const items = Array.isArray(day.items) ? day.items : [];
      return `<article class="itinerary-day">
        <div class="day-label">DAY ${escapeHtml(day.day)}</div>
        <div class="day-content">
          <h4>${escapeHtml(day.theme || "当日安排")}</h4>
          ${items.map((item) => `<div class="activity">
            <span class="activity-slot">${escapeHtml(item.slot || "安排")}</span>
            <div class="activity-content">
              <strong>${escapeHtml(item.title || "待确认活动")}</strong>
              ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
              <div class="activity-meta">${item.estimated_duration_minutes ? `${escapeHtml(item.estimated_duration_minutes)} 分钟` : ""}${item.estimated_duration_minutes && item.estimated_cost_cny != null ? " · " : ""}${item.estimated_cost_cny != null ? cny(item.estimated_cost_cny) : ""}</div>
            </div>
          </div>`).join("") || '<p class="empty-inline">该日暂无细化安排。</p>'}
        </div>
      </article>`;
    }).join("") || '<p class="empty-inline">没有返回行程数据。</p>';
  }

  function renderBudget(budget = {}) {
    const items = Array.isArray(budget.line_items) ? budget.line_items : [];
    document.querySelector("#budget-currency").textContent = budget.currency || "CNY";
    document.querySelector("#budget").innerHTML = `${items.map((item) => `<div class="budget-item">
      <div><strong>${escapeHtml(item.category || "其他")}</strong>${item.assumption ? `<small>${escapeHtml(item.assumption)}</small>` : ""}</div>
      <span class="budget-amount">${cny(item.amount_cny)}</span>
    </div>`).join("")}
    <div class="budget-total"><span>预计总计</span><span>${cny(budget.estimated_total_cny)}</span></div>`;
  }

  function renderTrace(trace = []) {
    document.querySelector("#workflow-trace").innerHTML = trace.map((entry) => `<li>
      <strong>${escapeHtml(entry.step || "处理步骤")}</strong>
      <span>${escapeHtml(entry.detail || entry.status || "已完成")}</span>
    </li>`).join("") || '<li><strong>暂无轨迹</strong><span>服务未返回工作流明细。</span></li>';
  }

  function renderCitations(citations = []) {
    document.querySelector("#citation-count").textContent = `${citations.length} SOURCES`;
    document.querySelector("#citations").innerHTML = citations.map((source) => {
      const href = safeUrl(source.uri);
      const title = escapeHtml(source.title || source.source_id || "参考资料");
      const heading = href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${title} ↗</a>` : `<strong>${title}</strong>`;
      return `<article class="citation"><div class="citation-top">${heading}<span class="citation-relevance">${escapeHtml(source.relevance || "参考")}</span></div>${source.excerpt ? `<p>${escapeHtml(source.excerpt)}</p>` : ""}</article>`;
    }).join("") || '<p class="empty-inline">本次方案未返回可展示的来源。</p>';
  }

  function modelFallbackMessage(code) {
    const messages = {
      llm_disabled: "模型增强未启用，已返回确定性方案。",
      missing_api_key: "服务端未配置模型密钥，已返回确定性方案。",
      missing_model: "服务端未配置模型标识，已返回确定性方案。",
      invalid_base_url: "模型服务配置无效，已返回确定性方案。",
      knowledge_empty: "未找到同城受控资料，未调用模型。",
      validation_not_passed: "预算或日程校验未通过，未调用模型。",
      provider_auth_failed: "模型服务鉴权失败，已保留确定性方案。",
      provider_payment_required: "模型服务额度不可用，已保留确定性方案。",
      provider_rate_limited: "模型服务暂时限流，已保留确定性方案。",
      provider_timeout: "模型服务超时，已保留确定性方案。",
      provider_network_error: "模型服务网络不可用，已保留确定性方案。",
      provider_unavailable: "模型服务暂不可用，已保留确定性方案。",
      invalid_provider_json: "模型输出格式未通过校验，已保留确定性方案。",
      truncated_provider_response: "模型输出不完整，已保留确定性方案。",
      untrusted_provider_output: "模型输出未通过来源校验，已保留确定性方案。",
      static_demo_no_model: "静态公开演示不调用模型，已返回浏览器内确定性预览。",
    };
    return messages[code] || "未采用模型说明，已保留确定性方案。";
  }

  function renderModelNarrative(plan) {
    const section = document.querySelector("#model-narrative-section");
    const generation = plan.generation;
    if (!generation || typeof generation !== "object") {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    const badge = document.querySelector("#model-generation-badge");
    const metadata = document.querySelector("#model-generation");
    const content = document.querySelector("#model-narrative");
    const enhanced = generation.mode === "llm_augmented";
    badge.textContent = enhanced ? "已通过来源校验" : "确定性降级";
    badge.className = `count-pill ${enhanced ? "model-ready" : "model-fallback"}`;

    const metadataItems = [
      ["模式", enhanced ? "模型增强" : "确定性结果"],
      ["模型", generation.model || "未调用"],
      ["提示词", generation.prompt_version || "—"],
      ["调用", `${Number(generation.attempts) || 0} 次`],
    ];
    if (Number.isFinite(Number(generation.llm_latency_ms))) {
      metadataItems.push(["模型耗时", `${Math.round(Number(generation.llm_latency_ms))} ms`]);
    }
    if (generation.usage?.total_tokens != null) {
      metadataItems.push(["Token", String(generation.usage.total_tokens)]);
    }
    metadata.innerHTML = metadataItems.map(([label, value]) => `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`).join("");

    const narrative = plan.narrative;
    if (!enhanced || !narrative || typeof narrative !== "object") {
      content.innerHTML = `<p class="model-fallback-copy">${escapeHtml(modelFallbackMessage(generation.fallback_code))}</p>`;
      return;
    }

    const notes = Array.isArray(narrative.day_notes) ? narrative.day_notes : [];
    const caveats = Array.isArray(narrative.caveats) ? narrative.caveats : [];
    content.innerHTML = `
      <p class="model-overview">${escapeHtml(narrative.overview || "已生成受控模型说明。")}</p>
      <div class="model-notes">${notes.map((note) => `<article class="model-note">
        <strong>DAY ${escapeHtml(note.day)}</strong>
        <div><b>${escapeHtml(note.theme || "当日说明")}</b><p>${escapeHtml(note.rationale || "")}</p><small>来源：${escapeHtml((note.source_ids || []).join(", "))}</small></div>
      </article>`).join("")}</div>
      ${caveats.length ? `<ul class="model-caveats">${caveats.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
    `;
  }

  function renderPlan(plan) {
    const summary = plan.request_summary || {};
    const validation = plan.validation || {};
    lastPlanId = plan.plan_id || null;
    document.querySelector("#summary-label").textContent = `${summary.destination || "目的地"} · ${summary.travel_style || "行程"}`;
    document.querySelector("#summary-title").textContent = `${summary.destination || "旅行"}${summary.days ? ` ${summary.days} 日运营方案` : "运营方案"}`;
    const badge = document.querySelector("#validation-badge");
    const validationText = validation.passed ? "预算与覆盖已校验" : validation.issues?.length ? "需要人工复核" : "已生成";
    badge.textContent = validationText;
    badge.className = `validation-badge ${validation.passed ? "passed" : validation.issues?.length ? "issue" : ""}`;
    renderMetrics(plan);
    renderItinerary(plan.itinerary);
    renderBudget(plan.budget);
    renderTrace(plan.workflow_trace);
    renderModelNarrative(plan);
    renderCitations(plan.citations);

    const ticket = plan.ticket;
    const ticketBanner = document.querySelector("#plan-ticket");
    if (ticket?.ticket_id) {
      ticketBanner.hidden = false;
      ticketBanner.innerHTML = `已创建跟进工单：<code>${escapeHtml(ticket.ticket_id)}</code>。该请求已交给模拟服务队列。`;
    } else {
      ticketBanner.hidden = true;
      ticketBanner.textContent = "";
    }

    emptyState.hidden = true;
    planOutput.hidden = false;
    resultState.textContent = validation.passed ? "校验通过" : "已生成 · 待复核";
    resultState.className = `result-state ${validation.passed ? "ready" : "review"}`;

    // On narrow screens the result sits below the intake form. Move the reader
    // directly to the newly generated evidence without changing desktop flow.
    if (window.matchMedia("(max-width: 900px)").matches) {
      planOutput.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  planForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!planForm.reportValidity()) return;
    const payload = getPlanPayload();
    if (!payload.destination) {
      setStatus(planStatus, "请填写目的地。", "error");
      document.querySelector("#destination").focus();
      return;
    }

    const requestingModel = useModelEnhancement.checked;
    setStatus(
      planStatus,
      requestingModel ? "正在生成并校验受控模型说明…" : "正在从受控知识库检索并生成结构化方案…"
    );
    setButtonLoading(planButton, true, "正在生成");
    resultState.textContent = "生成中";
    resultState.className = "result-state";
    try {
      const plan = await postJson(requestingModel ? API.modelPlan : API.plan, payload);
      renderPlan(plan);
      const extra = plan.validation?.issues?.length ? " 已标注需要人工复核的事项。" : "";
      const modelExtra = requestingModel
        ? plan.generation?.mode === "llm_augmented"
          ? " 模型说明已通过来源校验。"
          : " 模型未被采用，已保留确定性结果。"
        : "";
      setStatus(planStatus, `方案 ${plan.plan_id || ""} 已生成。${extra}${modelExtra}`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "暂时无法生成方案，请检查服务是否已启动。";
      setStatus(planStatus, `生成失败：${message}`, "error");
      resultState.textContent = "等待重试";
      resultState.className = "result-state review";
    } finally {
      setButtonLoading(planButton, false);
    }
  });

  ticketForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isPublicDemo) {
      setStatus(ticketStatus, "公开演示已关闭工单读写，请勿提交个人信息。", "error");
      return;
    }
    if (!ticketForm.reportValidity()) return;
    const title = document.querySelector("#ticket-title").value.trim();
    const description = document.querySelector("#ticket-description").value.trim();
    if (!title || !description) {
      setStatus(ticketStatus, "请补齐工单标题和问题说明。", "error");
      return;
    }

    const payload = {
      title,
      description,
      priority: document.querySelector("#ticket-priority").value,
      source_plan_id: lastPlanId || undefined,
      metadata: { channel: "travelops-controlled-demo-ui" },
    };
    setStatus(ticketStatus, "正在创建工单…");
    setButtonLoading(ticketButton, true, "正在创建");
    try {
      const ticket = await postJson(API.tickets, payload);
      setStatus(ticketStatus, `工单已创建：${ticket.ticket_id || "已受理"}`, "success");
      ticketForm.reset();
    } catch (error) {
      const message = error instanceof Error ? error.message : "请确认服务是否已启动。";
      setStatus(ticketStatus, `创建失败：${message}`, "error");
    } finally {
      setButtonLoading(ticketButton, false);
    }
  });

  void detectPublicDemoMode();
})();
