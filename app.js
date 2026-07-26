(() => {
  "use strict";

  const DAY = 24 * 60 * 60 * 1000;
  const ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;
  const ATTRS = {
    source: "custom-syg-source",
    title: "custom-syg-title",
    start: "custom-syg-start",
    end: "custom-syg-end",
    progress: "custom-syg-progress",
    urgency: "custom-syg-urgency",
    scale: "custom-syg-scale",
    labelWidth: "custom-syg-label-width",
  };

  const state = {
    widgetID: "",
    avID: "",
    av: null,
    renderedItemIDs: null,
    scale: "week",
    labelWidth: 260,
    viewDate: new Date().setHours(0, 0, 0, 0),
    timeline: null,
    statusTimer: null,
    frameHeightTimer: null,
    frameChrome: null,
    resizeObserver: null,
  };

  const $ = (selector) => document.querySelector(selector);
  const ui = {
    name: $('[data-role="name"]'),
    count: $('[data-role="count"]'),
    range: $('[data-role="range"]'),
    connection: $('[data-role="connection"]'),
    settings: $('[data-role="settings"]'),
    source: $('[data-role="source"]'),
    title: $('[data-role="title"]'),
    start: $('[data-role="start"]'),
    end: $('[data-role="end"]'),
    progress: $('[data-role="progress"]'),
    urgency: $('[data-role="urgency"]'),
    status: $('[data-role="status"]'),
    chart: $('[data-role="chart"]'),
    save: $('[data-action="save"]'),
  };

  function inheritTheme() {
    try {
      const parentStyle = window.parent.getComputedStyle(window.parent.document.documentElement);
      [
        "--b3-theme-background",
        "--b3-theme-surface",
        "--b3-theme-on-background",
        "--b3-theme-on-surface",
        "--b3-theme-on-surface-light",
        "--b3-theme-primary",
        "--b3-theme-on-primary",
        "--b3-theme-error",
        "--b3-border-color",
        "--b3-list-icon-hover",
        "--b3-border-radius",
      ].forEach((name) => {
        const value = parentStyle.getPropertyValue(name);
        if (value) document.documentElement.style.setProperty(name, value);
      });
    } catch (error) {
      // Fall back to local colors when parent theme access is unavailable.
    }
  }

  function syncFrameHeight() {
    const frame = window.frameElement;
    if (!frame) return;
    clearTimeout(state.frameHeightTimer);
    state.frameHeightTimer = setTimeout(() => {
      const app = document.querySelector(".app");
      const height = Math.max(1, Math.ceil(app?.getBoundingClientRect().height || document.body.scrollHeight));
      frame.style.border = "0";
      const block = frame.closest('[data-type="NodeWidget"]');
      const frameHeight = frame.getBoundingClientRect().height;
      if (block) {
        const measuredChrome = block.getBoundingClientRect().height - frameHeight;
        if (Number.isFinite(measuredChrome) && measuredChrome >= 0 && measuredChrome <= 32) {
          state.frameChrome = measuredChrome;
        }
        const chrome = state.frameChrome ?? 6;
        const blockHeight = height + chrome;
        if (Math.abs(block.getBoundingClientRect().height - blockHeight) > 1) {
          block.style.height = `${blockHeight}px`;
        }
      }
      frame.style.minHeight = "0";
      frame.style.maxHeight = "none";
      if (Math.abs(frameHeight - height) > 1 || frame.style.height !== `${height}px`) {
        frame.style.height = `${height}px`;
      }
    }, 48);
  }

  function findWidgetID() {
    try {
      return window.frameElement?.closest("[data-node-id]")?.getAttribute("data-node-id") || "";
    } catch (error) {
      return "";
    }
  }

  async function post(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      throw new Error(result.msg || `请求失败：${path}`);
    }
    return result.data;
  }

  function setStatus(message, error = false) {
    clearTimeout(state.statusTimer);
    ui.status.textContent = message;
    ui.status.dataset.error = error ? "true" : "false";
    ui.status.hidden = !message;
    if (message && !error && !message.includes("正在")) {
      state.statusTimer = setTimeout(() => {
        ui.status.hidden = true;
      }, 2600);
    }
  }

  function startOfDay(value) {
    const date = new Date(value);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  function valueByBlock(keyValue, blockID) {
    return (keyValue?.values || []).find((value) => value.blockID === blockID);
  }

  function textFromValue(value) {
    if (!value) return "";
    if (value.block) return value.block.content || "";
    if (value.text) return value.text.content || "";
    if (value.number) return String(value.number.content ?? "");
    return "";
  }

  function completionFromValue(value) {
    return Boolean(value?.checkbox?.checked);
  }

  function urgencyFromValue(value) {
    const urgency = String(value?.mSelect?.[0]?.content || "").trim();
    return ["一般", "重要", "紧急"].includes(urgency) ? urgency : "";
  }

  function addOption(select, value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }

  async function resolveAttributeView(source) {
    if (!ID_PATTERN.test(source)) {
      throw new Error("数据库 ID 格式不正确，应类似 20260724080906-52fqzfk");
    }

    try {
      const direct = await post("/api/av/getAttributeView", { id: source });
      if (direct?.av) return { avID: source, av: direct.av };
    } catch (error) {
      // Usually source is a database block ID; resolve the AV ID below.
    }

    const rows = await post("/api/query/sql", {
      stmt: `SELECT markdown FROM blocks WHERE id = '${source}' AND type = 'av' LIMIT 1`,
    });
    if (!rows?.length) {
      throw new Error("没有找到该数据库。请填写 AV ID；也可以填写数据库块 ID 自动解析。");
    }
    const match = String(rows[0].markdown || "").match(/data-av-id="([^"]+)"/);
    if (!match) throw new Error("数据库块中没有找到 AV ID。");
    const data = await post("/api/av/getAttributeView", { id: match[1] });
    return { avID: match[1], av: data.av };
  }

  function itemIDsFromRenderedView(view) {
    const itemIDs = [];
    const seen = new Set();
    const add = (id) => {
      if (!ID_PATTERN.test(String(id || "")) || seen.has(id)) return;
      seen.add(id);
      itemIDs.push(id);
    };
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if ((Array.isArray(value.cells) || Array.isArray(value.values)) && value.id) add(value.id);
      Object.entries(value).forEach(([key, child]) => {
        if (key !== "cells" && key !== "values") visit(child);
      });
    };
    visit(view);
    return itemIDs;
  }

  async function loadRenderedItemIDs() {
    const activeView = (state.av?.views || []).find((view) => view.id === state.av.viewID)
      || (state.av?.views || [])[0];
    if (!activeView?.id) return null;
    try {
      const rendered = await post("/api/av/renderAttributeView", {
        id: state.avID,
        viewID: activeView.id,
        page: 1,
        pageSize: -1,
        createIfNotExist: false,
      });
      return itemIDsFromRenderedView(rendered?.view);
    } catch (error) {
      console.warn("无法读取数据库渲染顺序，回退到基础顺序。", error);
      return null;
    }
  }

  function populateFields(mapping = {}) {
    const columns = state.av?.keyValues || [];
    const titleColumns = columns.filter((item) => ["block", "text"].includes(item.key.type));
    const dateColumns = columns.filter((item) => item.key.type === "date");
    const completionColumns = columns.filter((item) => item.key.type === "checkbox");
    const urgencyColumns = columns.filter((item) => ["select", "mSelect"].includes(item.key.type));

    [ui.title, ui.start, ui.end, ui.progress, ui.urgency].forEach((select) => {
      select.replaceChildren();
      select.disabled = false;
    });

    titleColumns.forEach((item) => addOption(ui.title, item.key.id, item.key.name));
    dateColumns.forEach((item) => {
      addOption(ui.start, item.key.id, item.key.name);
      addOption(ui.end, item.key.id, item.key.name);
    });
    ui.end.prepend(new Option("使用开始字段的日期范围", "__range__"));
    addOption(ui.progress, "", "不显示");
    completionColumns.forEach((item) => addOption(ui.progress, item.key.id, item.key.name));
    addOption(ui.urgency, "", "不显示");
    urgencyColumns.forEach((item) => addOption(ui.urgency, item.key.id, item.key.name));

    if (!titleColumns.length || !dateColumns.length) {
      throw new Error("数据库至少需要一个标题字段和一个日期字段。");
    }

    [
      [ui.title, mapping.title],
      [ui.start, mapping.start],
      [ui.end, mapping.end],
      [ui.progress, mapping.progress],
      [ui.urgency, mapping.urgency],
    ].forEach(([select, value]) => {
      if ([...select.options].some((option) => option.value === value)) select.value = value;
    });
    if (!mapping.start) {
      const populatedDate = dateColumns.find((item) =>
        (item.values || []).some((value) => value.date?.isNotEmpty),
      );
      if (populatedDate) ui.start.value = populatedDate.key.id;
    }
    if (!mapping.urgency) {
      const namedUrgency = urgencyColumns.find((item) => ["紧急程度", "优先级"].includes(item.key.name));
      if (namedUrgency) ui.urgency.value = namedUrgency.key.id;
    }
    ui.save.disabled = false;
  }

  async function loadDatabase(mapping = {}) {
    const source = ui.source.value.trim();
    setStatus("正在读取数据库……");
    const resolved = await resolveAttributeView(source);
    state.avID = resolved.avID;
    state.av = resolved.av;
    state.renderedItemIDs = await loadRenderedItemIDs();
    ui.source.value = resolved.avID;
    ui.name.textContent = state.av.name || "未命名数据库";
    populateFields(mapping);
    ui.connection.textContent = "已连接";
    ui.connection.classList.add("is-connected");
    setStatus(`字段读取成功 · ${state.av.name || "未命名数据库"}`);
  }

  async function getSavedConfig() {
    if (!state.widgetID) return null;
    const attrs = await post("/api/attr/getBlockAttrs", { id: state.widgetID });
    if (!attrs?.[ATTRS.source]) return null;
    return {
      source: attrs[ATTRS.source] || "",
      title: attrs[ATTRS.title] || "",
      start: attrs[ATTRS.start] || "",
      end: attrs[ATTRS.end] || "__range__",
      progress: attrs[ATTRS.progress] || "",
      urgency: attrs[ATTRS.urgency] || "",
      scale: attrs[ATTRS.scale] === "month" ? "month" : "week",
      labelWidth: Number(attrs[ATTRS.labelWidth]) || 260,
    };
  }

  async function saveConfig() {
    const config = {
      source: ui.source.value.trim(),
      title: ui.title.value,
      start: ui.start.value,
      end: ui.end.value,
      progress: ui.progress.value,
      urgency: ui.urgency.value,
      scale: state.scale,
      labelWidth: state.labelWidth,
    };
    if (state.widgetID) {
      await post("/api/attr/setBlockAttrs", {
        id: state.widgetID,
        attrs: {
          [ATTRS.source]: config.source,
          [ATTRS.title]: config.title,
          [ATTRS.start]: config.start,
          [ATTRS.end]: config.end,
          [ATTRS.progress]: config.progress,
          [ATTRS.urgency]: config.urgency,
          [ATTRS.scale]: config.scale,
          [ATTRS.labelWidth]: String(config.labelWidth),
        },
      });
    } else {
      localStorage.setItem("siyuan-gantt-widget-config", JSON.stringify(config));
    }
    return config;
  }

  function getTasks() {
    const columns = state.av.keyValues || [];
    const byID = new Map(columns.map((item) => [item.key.id, item]));
    const titleColumn = byID.get(ui.title.value);
    const startColumn = byID.get(ui.start.value);
    const endColumn = byID.get(ui.end.value);
    const completionColumn = byID.get(ui.progress.value);
    const urgencyColumn = byID.get(ui.urgency.value);
    const activeView = (state.av.views || []).find((view) => view.id === state.av.viewID)
      || (state.av.views || [])[0];
    const itemIDs = Array.isArray(state.renderedItemIDs)
      ? state.renderedItemIDs
      : activeView?.itemIds?.length
        ? activeView.itemIds
        : [...new Set(columns.flatMap((item) => (item.values || []).map((value) => value.blockID)))];

    return itemIDs.map((blockID) => {
      const startValue = valueByBlock(startColumn, blockID);
      const date = startValue?.date;
      if (!date?.isNotEmpty) return null;
      const start = startOfDay(date.content);
      let end = start;
      if (ui.end.value === "__range__") {
        if (date.hasEndDate && date.isNotEmpty2) end = startOfDay(date.content2);
      } else {
        const endDate = valueByBlock(endColumn, blockID)?.date;
        if (endDate?.isNotEmpty) end = startOfDay(endDate.content);
      }
      if (end < start) end = start;
      return {
        blockID,
        title: textFromValue(valueByBlock(titleColumn, blockID)) || "未命名任务",
        start,
        end,
        completed: completionFromValue(valueByBlock(completionColumn, blockID)),
        urgency: urgencyFromValue(valueByBlock(urgencyColumn, blockID)),
      };
    }).filter(Boolean);
  }

  function formatDate(value) {
    const date = new Date(value);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function startOfNaturalWeek(value) {
    const date = new Date(startOfDay(value));
    const offset = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - offset);
    return date.getTime();
  }

  function startOfNaturalMonth(value) {
    const date = new Date(value);
    return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  }

  function addNaturalMonths(value, amount) {
    const date = new Date(value);
    return new Date(date.getFullYear(), date.getMonth() + amount, 1).getTime();
  }

  function daysInMonth(value) {
    const date = new Date(value);
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  }

  function addAnchorMonths(value, amount) {
    const date = new Date(value);
    const target = new Date(date.getFullYear(), date.getMonth() + amount, 1);
    target.setDate(Math.min(date.getDate(), daysInMonth(target)));
    return startOfDay(target);
  }

  function buildTimelinePeriod(tasks) {
    const focusMin = startOfDay(state.viewDate) - DAY * 2;
    const focusMax = state.scale === "month"
      ? focusMin + DAY * daysInMonth(state.viewDate)
      : focusMin + DAY * 7;
    const taskMin = tasks.length ? Math.min(...tasks.map((task) => task.start)) : focusMin;
    const taskMax = tasks.length ? Math.max(...tasks.map((task) => task.end + DAY)) : focusMax;
    let min;
    let max;

    if (state.scale === "month") {
      min = addNaturalMonths(startOfNaturalMonth(Math.min(taskMin, focusMin)), -1);
      max = addNaturalMonths(startOfNaturalMonth(Math.max(taskMax - DAY, focusMax - DAY)), 2);
    } else {
      min = startOfNaturalWeek(Math.min(taskMin, focusMin)) - DAY * 14;
      max = startOfNaturalWeek(Math.max(taskMax - DAY, focusMax - DAY)) + DAY * 21;
    }

    const units = [];
    for (let cursor = min; cursor < max; cursor += DAY) {
      units.push({ start: cursor, end: cursor + DAY });
    }
    return { units, min, max, focusMin, focusMax };
  }

  function positionPercent(value, units) {
    const first = units[0].start;
    const last = units[units.length - 1].end;
    const clamped = Math.max(first, Math.min(last, value));
    let index = units.findIndex((unit) => clamped >= unit.start && clamped < unit.end);
    if (index < 0) index = units.length - 1;
    const unit = units[index];
    const fraction = Math.max(0, Math.min(1, (clamped - unit.start) / (unit.end - unit.start)));
    return ((index + fraction) / units.length) * 100;
  }

  function appendHeaderBands(timeline, units) {
    const unitWidth = 100 / units.length;
    let groupStart = 0;
    while (groupStart < units.length) {
      const first = new Date(units[groupStart].start);
      let groupEnd = groupStart + 1;
      while (groupEnd < units.length) {
        const next = new Date(units[groupEnd].start);
        if (next.getFullYear() !== first.getFullYear() || next.getMonth() !== first.getMonth()) break;
        groupEnd += 1;
      }
      const band = document.createElement("div");
      band.className = "period-band";
      band.style.left = `${groupStart * unitWidth}%`;
      band.style.width = `${(groupEnd - groupStart) * unitWidth}%`;
      band.textContent = `${first.getFullYear()}年${first.getMonth() + 1}月`;
      timeline.appendChild(band);
      groupStart = groupEnd;
    }

    units.forEach((unit, index) => {
      const date = new Date(unit.start);
      const tick = document.createElement("div");
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      const isToday = unit.start === startOfDay(Date.now());
      tick.className = "tick";
      if (state.scale === "month" && isWeekend) tick.classList.add("tick--weekend");
      if (isToday) tick.classList.add("tick--today");
      tick.style.left = `${index * unitWidth}%`;
      tick.style.width = `${unitWidth}%`;
      if (state.scale === "week") {
        const weekday = document.createElement("span");
        weekday.className = "tick__weekday";
        weekday.textContent = `周${"日一二三四五六"[date.getDay()]}`;
        tick.appendChild(weekday);
      }
      const day = document.createElement("span");
      day.className = "tick__date";
      day.textContent = String(date.getDate());
      tick.appendChild(day);
      tick.title = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
      timeline.appendChild(tick);
    });
  }

  function appendWeekendCells(timeline, units) {
    if (state.scale !== "month") return;
    const unitWidth = 100 / units.length;
    units.forEach((unit, index) => {
      const date = new Date(unit.start);
      if (date.getDay() !== 0 && date.getDay() !== 6) return;
      const cell = document.createElement("span");
      cell.className = "weekend-cell";
      cell.style.left = `${index * unitWidth}%`;
      cell.style.width = `${unitWidth}%`;
      timeline.appendChild(cell);
    });
  }

  function appendToday(timeline, units) {
    const today = startOfDay(Date.now());
    if (today < units[0].start || today >= units[units.length - 1].end) return;
    const marker = document.createElement("span");
    marker.className = "today";
    marker.style.left = `${positionPercent(today + DAY, units)}%`;
    timeline.appendChild(marker);
  }

  function navigatePeriod(direction) {
    if (state.scale === "month") {
      state.viewDate = addAnchorMonths(state.viewDate, direction);
    } else {
      state.viewDate += direction * DAY * 7;
    }
    render();
  }

  function setActiveScale() {
    document.querySelectorAll("[data-scale]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.scale === state.scale);
    });
  }

  function enableColumnResize(resizer, grid) {
    resizer.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = state.labelWidth;
      const maxWidth = Math.min(520, ui.chart.clientWidth * 0.6);
      resizer.classList.add("is-dragging");
      resizer.setPointerCapture(event.pointerId);

      const onMove = (moveEvent) => {
        state.labelWidth = Math.round(Math.max(80, Math.min(maxWidth, startWidth + moveEvent.clientX - startX)));
        grid.style.setProperty("--label-width", `${state.labelWidth}px`);
      };
      const onUp = async () => {
        resizer.classList.remove("is-dragging");
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onUp);
        resizer.removeEventListener("pointercancel", onUp);
        if (state.av) await saveConfig();
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
      resizer.addEventListener("pointercancel", onUp);
    });
  }

  function render() {
    if (!state.av) return;
    const tasks = getTasks();
    const { units, min, max, focusMin, focusMax } = buildTimelinePeriod(tasks);
    state.timeline = { units, min, max, focusMin, focusMax };
    ui.count.textContent = `${tasks.length} 项任务`;
    ui.range.textContent = `${new Date(min).getFullYear()}年${formatDate(min)} – ${new Date(max - DAY).getFullYear()}年${formatDate(max - DAY)}`;
    document.querySelector('[data-action="period-prev"]').title = state.scale === "month" ? "上一个月" : "上一周";
    document.querySelector('[data-action="period-next"]').title = state.scale === "month" ? "下一个月" : "下一周";
    setActiveScale();
    const grid = document.createElement("div");
    grid.className = "grid";
    grid.dataset.scale = state.scale;
    const timelineAvailable = Math.max(320, ui.chart.clientWidth - state.labelWidth);
    const focusDays = Math.max(1, Math.round((focusMax - focusMin) / DAY));
    const dayWidth = state.scale === "month"
      ? Math.max(32, timelineAvailable / focusDays)
      : Math.max(64, timelineAvailable / 7);
    const timelineWidth = units.length * dayWidth;
    grid.style.setProperty("--label-width", `${state.labelWidth}px`);
    grid.style.setProperty("--timeline-width", `${timelineWidth}px`);
    grid.style.setProperty("--unit-count", String(units.length));

    const header = document.createElement("div");
    header.className = "row row--header";
    const headerLabel = document.createElement("div");
    headerLabel.className = "label";
    headerLabel.textContent = "任务";
    const resizer = document.createElement("span");
    resizer.className = "column-resizer";
    resizer.title = "拖动调整任务栏宽度";
    headerLabel.appendChild(resizer);
    enableColumnResize(resizer, grid);
    const headerTimeline = document.createElement("div");
    headerTimeline.className = "timeline timeline--header";
    headerTimeline.dataset.scale = state.scale;
    appendHeaderBands(headerTimeline, units);
    appendToday(headerTimeline, units);
    header.append(headerLabel, headerTimeline);
    grid.appendChild(header);

    tasks.forEach((task) => {
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("div");
      label.className = "label";
      const dot = document.createElement("span");
      dot.className = ui.progress.value
        ? task.completed
          ? "task-dot task-dot--done"
          : "task-dot task-dot--pending"
        : "task-dot";
      const labelContent = document.createElement("div");
      labelContent.className = "label__content";
      const labelText = document.createElement("div");
      labelText.className = "label__text";
      labelText.textContent = task.title;
      labelText.title = task.title;
      labelContent.appendChild(labelText);
      label.append(dot, labelContent);
      if (ui.progress.value) {
        const completion = document.createElement("span");
        completion.className = task.completed
          ? "label__status label__status--done"
          : "label__status label__status--pending";
        completion.textContent = task.completed ? "已完成" : "未完成";
        label.appendChild(completion);
      }

      const timeline = document.createElement("div");
      timeline.className = "timeline";
      appendWeekendCells(timeline, units);
      const bar = document.createElement("div");
      const urgencyClass = {
        一般: "bar--urgency-normal",
        重要: "bar--urgency-important",
        紧急: "bar--urgency-urgent",
      }[task.urgency];
      bar.className = urgencyClass ? `bar ${urgencyClass}` : "bar";
      const clippedStart = task.start < min;
      const clippedEnd = task.end + DAY > max;
      if (clippedStart) bar.classList.add("bar--clipped-start");
      if (clippedEnd) bar.classList.add("bar--clipped-end");
      const left = positionPercent(Math.max(task.start, min), units);
      const right = positionPercent(Math.min(task.end + DAY, max), units);
      bar.style.left = `${left}%`;
      bar.style.width = `${Math.max(0.8, right - left)}%`;
      bar.title = `${task.title}\n${new Date(task.start).toLocaleDateString()} – ${new Date(task.end).toLocaleDateString()}`;
      bar.addEventListener("click", () => {
        window.parent.location.href = `siyuan://blocks/${task.blockID}`;
      });
      const barText = document.createElement("span");
      barText.className = "bar__text";
      barText.textContent = task.title;
      bar.appendChild(barText);
      timeline.appendChild(bar);
      appendToday(timeline, units);
      row.append(label, timeline);
      grid.appendChild(row);
    });

    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "period-empty";
      empty.textContent = "暂无排期任务";
      grid.appendChild(empty);
    }

    ui.chart.replaceChildren(grid);
    const focusOffset = Math.max(0, Math.round((focusMin - min) / DAY));
    ui.chart.scrollLeft = focusOffset * dayWidth;
    syncFrameHeight();
    setStatus(`已更新 ${tasks.length} 项任务`);
  }

  async function handle(action) {
    try {
      if (action === "load") {
        await loadDatabase();
      } else if (action === "save") {
        await saveConfig();
        render();
        ui.settings.hidden = true;
      } else if (action === "refresh") {
        if (!ui.source.value.trim()) throw new Error("请先配置数据库 ID（AV ID）。");
        const mapping = {
          title: ui.title.value,
          start: ui.start.value,
          end: ui.end.value,
          progress: ui.progress.value,
          urgency: ui.urgency.value,
        };
        await loadDatabase(mapping);
        render();
      } else if (action === "period-prev") {
        navigatePeriod(-1);
      } else if (action === "period-next") {
        navigatePeriod(1);
      } else if (action === "today") {
        state.viewDate = startOfDay(Date.now());
        render();
      } else if (action === "settings") {
        ui.settings.hidden = !ui.settings.hidden;
        syncFrameHeight();
      }
    } catch (error) {
      ui.connection.textContent = "连接失败";
      ui.connection.classList.remove("is-connected");
      setStatus(error.message || String(error), true);
    }
  }

  async function init() {
    inheritTheme();
    state.widgetID = findWidgetID();
    if (window.frameElement) window.frameElement.style.removeProperty("min-height");
    state.resizeObserver = new ResizeObserver(syncFrameHeight);
    state.resizeObserver.observe(document.querySelector(".app"));
    setActiveScale();

    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => handle(button.dataset.action));
    });
    document.querySelectorAll("[data-scale]").forEach((button) => {
      button.addEventListener("click", async () => {
        state.scale = button.dataset.scale;
        if (state.av) {
          render();
          await saveConfig();
        }
      });
    });

    let config = await getSavedConfig();
    if (!config) {
      try {
        config = JSON.parse(localStorage.getItem("siyuan-gantt-widget-config") || "null");
      } catch (error) {
        config = null;
      }
    }
    if (!config?.source) {
      syncFrameHeight();
      return;
    }

    ui.source.value = config.source;
    state.scale = config.scale === "month" ? "month" : "week";
    state.labelWidth = Number(config.labelWidth) || 260;
    try {
      await loadDatabase(config);
      render();
      ui.settings.hidden = true;
    } catch (error) {
      setStatus(error.message || String(error), true);
      ui.settings.hidden = false;
    }
    syncFrameHeight();
  }

  init().catch((error) => setStatus(error.message || String(error), true));
})();
