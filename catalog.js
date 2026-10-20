(() => {
  const CACHE_PREFIX = "wheel-catalog-page-v3:";
  const CACHE_INDEX = "wheel-catalog-cache-index-v3";
  const INTEREST_KEY = "wheel-catalog-interest-v1";
  const PAGE_SIZE = 24;
  const MAX_CACHED_PAGES = 60;

  const itemsNode = document.getElementById("items");
  const searchNode = document.getElementById("search");
  const countNode = document.getElementById("count");
  const updatedNode = document.getElementById("updated");
  const refreshNode = document.getElementById("refresh");

  let seasonFilter = "all";
  let radiusFilter = null;
  let searchQuery = "";
  let priorities = [];
  let pages = new Map();
  let total = 0;
  let nextOffset = null;
  let busy = false;
  let autoPaused = false;
  let generation = 0;
  let debounceTimer;
  let activeRequest;

  const norm = (s) => String(s || "").toLocaleLowerCase("ru").replaceAll("ё", "е").trim();
  const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]));

  function seasonKind(value) {
    const v = norm(value);
    if (/winter|зим/.test(v)) return "winter";
    if (/sommer|summer|лет/.test(v)) return "summer";
    if (/ganzjahr|all.?season|всесез/.test(v)) return "allseason";
    return "unknown";
  }

  function radiusFromQuery(value) {
    const q = String(value || "");
    const marked = q.match(/(?:^|\b)(?:R|X|ZOLL)\s*(1[3-9]|2[0-4])\b/i);
    if (marked) return Number(marked[1]);
    const onlyRadius = q.trim().match(/^(1[3-9]|2[0-4])$/);
    return onlyRadius ? Number(onlyRadius[1]) : null;
  }

  function readInterest() {
    try { return JSON.parse(localStorage.getItem(INTEREST_KEY) || "{}"); }
    catch (_) { return {}; }
  }

  function rememberSearch(query, season, selectedRadius = null) {
    const radius = selectedRadius || radiusFromQuery(query);
    if (!radius) return;
    let kind = season;
    if (kind === "all") {
      const q = norm(query);
      kind = /winter|зим/.test(q) ? "winter" : /sommer|summer|лет/.test(q) ? "summer" : "";
    }
    if (kind && !["winter", "summer"].includes(kind)) return;
    const interest = readInterest();
    const key = `${kind || "all"}-${radius}`;
    interest[key] = Math.min(999, (Number(interest[key]) || 0) + 1);
    try { localStorage.setItem(INTEREST_KEY, JSON.stringify(interest)); } catch (_) {}
  }

  function makePriorities() {
    const defaults = seasonFilter === "winter"
      ? ["winter-16", "winter-18", "allseason-16", "allseason-18"]
      : seasonFilter === "summer"
        ? ["summer-16", "summer-18", "allseason-16", "allseason-18"]
        : ["winter-16", "winter-18", "summer-16", "summer-18", "allseason-16", "allseason-18"];
    const entries = Object.entries(readInterest())
      .filter(([key, count]) => /^(winter|summer|allseason|all)-(1[3-9]|2[0-4])$/.test(key) && Number(count) > 0)
      .filter(([key]) => seasonFilter === "all" || key.startsWith(`${seasonFilter}-`) || key.startsWith("allseason-") || key.startsWith("all-"))
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    const learnedSpecific = entries.filter(([key]) => !key.startsWith("all-")).map(([key]) => key);
    const genericPrimary = entries.filter(([key]) => key.startsWith("all-")).map(([key]) => {
        const radius = key.split("-")[1];
        if (seasonFilter === "summer") return `summer-${radius}`;
        return `winter-${radius}`;
      });
    const genericSecondary = entries.filter(([key]) => key.startsWith("all-")).flatMap(([key]) => {
      const radius = key.split("-")[1];
      return seasonFilter === "winter" ? [`allseason-${radius}`]
        : seasonFilter === "summer" ? [`allseason-${radius}`]
          : [`summer-${radius}`, `allseason-${radius}`];
    });
    const selectedRadius = radiusFilter === null ? [] : seasonFilter === "all"
      ? [`winter-${radiusFilter}`, `summer-${radiusFilter}`, `allseason-${radiusFilter}`]
      : [`${seasonFilter}-${radiusFilter}`, `allseason-${radiusFilter}`];
    return [...new Set([...selectedRadius, ...learnedSpecific, ...genericPrimary, ...defaults, ...genericSecondary])].slice(0, 8);
  }

  function cacheKey(offset, prefs) {
    return CACHE_PREFIX + [seasonFilter, radiusFilter || "all", norm(searchQuery), prefs.join(","), offset].map(encodeURIComponent).join("|");
  }

  function readCachedPage(key) {
    try {
      const payload = JSON.parse(localStorage.getItem(key) || "null");
      if (payload) {
        const keys = JSON.parse(localStorage.getItem(CACHE_INDEX) || "[]").filter((entry) => entry.key !== key);
        keys.push({ key, savedAt: Date.now() });
        localStorage.setItem(CACHE_INDEX, JSON.stringify(keys));
      }
      return payload;
    }
    catch (_) { try { localStorage.removeItem(key); } catch (_) {} return null; }
  }

  function saveCachedPage(key, payload) {
    try {
      let keys = JSON.parse(localStorage.getItem(CACHE_INDEX) || "[]");
      keys = keys.filter((entry) => entry.key !== key);
      keys.push({ key, savedAt: Date.now() });
      while (keys.length > MAX_CACHED_PAGES) {
        const old = keys.shift();
        localStorage.removeItem(old.key);
      }
      localStorage.setItem(key, JSON.stringify(payload));
      localStorage.setItem(CACHE_INDEX, JSON.stringify(keys));
    } catch (_) { /* Storage quota: the catalog still works without client cache. */ }
  }

  function allLoadedItems() {
    const seen = new Set();
    const result = [];
    [...pages.keys()].sort((a, b) => a - b).forEach((offset) => {
      (pages.get(offset).items || []).forEach((item) => {
        const key = `${item.type}:${item.id}`;
        if (!seen.has(key)) { seen.add(key); result.push(item); }
      });
    });
    return result;
  }

  function itemCard(item) {
    const kind = seasonKind(item.season);
    const label = item.type === "felge" ? "Диски" : kind === "winter" ? "Зимние шины"
      : kind === "summer" ? "Летние шины" : kind === "allseason" ? "Всесезонные шины" : "Шины";
    const tagClass = kind === "winter" ? "winter" : kind === "summer" ? "summer" : "";
    const title = [item.brand, item.model].filter(Boolean).join(" ") || (item.type === "felge" ? "Колесные диски" : "Шины");
    const details = [item.season, item.dot ? `DOT ${item.dot}` : "", item.tread ? `Остаток ${item.tread} мм` : "",
      item.quantity ? `${item.quantity} шт.` : "", item.type === "felge" && item.pcd ? `PCD ${item.pcd}` : "",
      item.type === "felge" && item.et ? `ET ${item.et}` : ""].filter(Boolean);
    return `<article class="card"><div class="top"><span class="tag ${tagClass}">${label}</span><span class="id">№ ${esc(item.id)}</span></div><h2 class="title">${esc(title)}</h2><div class="size">${esc(item.size || "")}</div><div class="details">${details.map((x) => `<span class="detail">${esc(x)}</span>`).join("")}</div><div class="bottom"><span class="price">${esc(item.price || "Цена по запросу")}</span><a class="open" href="/tire?id=${encodeURIComponent(item.id)}">Подробнее →</a></div></article>`;
  }

  function render() {
    const loaded = allLoadedItems();
    itemsNode.setAttribute("aria-busy", String(busy));
    countNode.textContent = total > loaded.length ? `Показано ${loaded.length} из ${total}`
      : `${total} ${total === 1 ? "товар" : "товаров"}`;
    if (!loaded.length && !busy) {
      itemsNode.innerHTML = '<div class="empty">Ничего не найдено. Измените запрос или выберите другой сезон.</div>';
      return;
    }
    itemsNode.innerHTML = loaded.map(itemCard).join("") +
      (busy ? '<div class="loading" id="page-loading">Загружаем следующие товары…</div>' : "") +
      (nextOffset !== null ? (autoPaused
        ? '<button class="filter" id="retry-next" style="grid-column:1/-1;margin:8px auto">Повторить загрузку</button>'
        : '<div id="load-sentinel" aria-hidden="true"></div>') : "");
    if (nextOffset !== null) observeSentinel();
  }

  function showUpdated(payload) {
    if (!payload.updatedAt) return;
    updatedNode.textContent = `Обновлено ${new Date(payload.updatedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}`;
  }

  function applyPage(offset, payload) {
    pages.set(offset, payload);
    total = Number(payload.total) || 0;
    if (offset === 0 || nextOffset === offset || nextOffset === null) nextOffset = payload.nextOffset;
    showUpdated(payload);
    refreshNode.textContent = "";
    render();
  }

  function pageUrl(offset, prefs) {
    const params = new URLSearchParams({ season: seasonFilter, offset: String(offset), limit: String(PAGE_SIZE), p: prefs.join(",") });
    if (radiusFilter !== null) params.set("r", String(radiusFilter));
    if (searchQuery) params.set("q", searchQuery);
    return `/api/inventory?${params}`;
  }

  async function fetchPage(offset, prefs, token) {
    const key = cacheKey(offset, prefs);
    const controller = new AbortController();
    activeRequest = controller;
    const response = await fetch(pageUrl(offset, prefs), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (token !== generation) return;
    saveCachedPage(key, payload);
    applyPage(offset, payload);
  }

  async function resetAndLoad({ learnRadius = null, learnQuery = false } = {}) {
    if (activeRequest) activeRequest.abort();
    generation++;
    const token = generation;
    if (learnRadius !== null) rememberSearch(searchQuery, seasonFilter, learnRadius);
    else if (learnQuery) rememberSearch(searchQuery, seasonFilter);
    priorities = makePriorities();
    pages = new Map();
    total = 0;
    nextOffset = null;
    autoPaused = false;
    busy = true;
    itemsNode.setAttribute("aria-busy", "true");
    const cached = readCachedPage(cacheKey(0, priorities));
    if (cached) applyPage(0, cached);
    else {
      itemsNode.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      countNode.textContent = "Загрузка товаров…";
    }
    try {
      await fetchPage(0, priorities, token);
    } catch (error) {
      if (error.name === "AbortError") return;
      if (token !== generation) return;
      refreshNode.textContent = cached ? "Нет связи — показан сохранённый список" : "Проверьте подключение";
      if (!cached) itemsNode.innerHTML = '<div class="error">Не удалось загрузить товары. Попробуйте обновить страницу.</div>';
      console.error("Inventory load failed", error);
    } finally {
      if (token === generation) {
        busy = false;
        render();
      }
    }
  }

  function applyFilters(options = {}) {
    clearTimeout(debounceTimer);
    searchQuery = searchNode.value.trim();
    resetAndLoad({ ...options, learnQuery: Boolean(searchQuery) && Boolean(options.learnQuery) });
  }

  async function loadNext() {
    if (busy || nextOffset === null) return;
    const offset = nextOffset;
    const token = generation;
    const prefs = priorities;
    busy = true;
    autoPaused = false;
    render();
    const cached = readCachedPage(cacheKey(offset, prefs));
    if (cached) applyPage(offset, cached);
    try {
      await fetchPage(offset, prefs, token);
    } catch (error) {
      if (error.name === "AbortError") return;
      if (token === generation) autoPaused = true;
      if (token === generation) refreshNode.textContent = cached ? "Показаны сохранённые товары" : "Не удалось загрузить продолжение — прокрутите ещё раз";
      console.error("Next inventory page failed", error);
    } finally {
      if (token === generation) { busy = false; render(); }
    }
  }

  let observer;
  function observeSentinel() {
    if (!("IntersectionObserver" in window)) {
      const sentinel = document.getElementById("load-sentinel");
      if (sentinel) sentinel.outerHTML = '<button class="filter" id="load-more" style="grid-column:1/-1;margin:8px auto">Показать ещё</button>';
      return;
    }
    if (!observer) observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadNext();
    }, { rootMargin: "500px 0px" });
    observer.disconnect();
    const sentinel = document.getElementById("load-sentinel");
    if (sentinel) observer.observe(sentinel);
  }

  document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.season) {
      seasonFilter = button.dataset.season;
      document.querySelectorAll("[data-season]").forEach((entry) => entry.setAttribute("aria-pressed", String(entry === button)));
      return applyFilters();
    }
    if (button.dataset.radius) {
      radiusFilter = button.dataset.radius === "all" ? null : Number(button.dataset.radius);
      document.querySelectorAll("[data-radius]").forEach((entry) => entry.setAttribute("aria-pressed", String(entry === button)));
      return applyFilters({ learnRadius: radiusFilter });
    }
  }));

  searchNode.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchQuery = searchNode.value.trim();
      resetAndLoad({ learnQuery: Boolean(searchQuery) });
    }, 320);
  });

  itemsNode.addEventListener("click", (event) => {
    if (event.target.closest("#load-more, #retry-next")) loadNext();
  });

  resetAndLoad();
})();
