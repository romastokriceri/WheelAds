const { google } = require("googleapis");

const TTL_MS = 2 * 60 * 1000;
let memoryCache = { expiresAt: 0, payload: null };
let inFlight = null;
const PAGE_SIZE_MAX = 48;

function text(value) {
  return value == null ? "" : String(value).trim();
}

function normId(value) {
  return text(value).padStart(4, "0");
}

// Статус рядка (дзеркало canonStatus з Apps Script Helper.gs).
// Порожній статус вважаємо «Доступно».
function statusKind(value) {
  const status = text(value).toLowerCase().replace(/\s+/g, " ");
  if (!status) return "lager";
  if (["verkauft", "продано", "sold", "продан"].includes(status) || status.startsWith("прода")) return "sold";
  if (
    ["grau", "сірий", "сіре", "сірі", "серый", "серое", "серые", "gray", "grey", "резерв", "в резерві"].includes(status) ||
    /с[іі]р|сер[ыи]|grau|gr[ae]y|резерв/.test(status)
  ) return "grau";
  if (
    ["pending", "в очікуванні", "в очiкуваннi", "warten"].includes(status) ||
    /очіку|очiку|ожида|pending|warten/.test(status)
  ) return "pending";
  return "other";
}

// На сайт іде все, крім «Продано» та «В очікуванні».
function isShown(kind) {
  return kind !== "sold" && kind !== "pending";
}

function priceNumber(value) {
  const raw = text(value);
  if (!raw) return 0;
  let normalized = raw.replace(/[^\d,.-]/g, "");
  normalized = normalized.includes(",")
    ? normalized.replace(/\./g, "").replace(",", ".")
    : normalized.replace(/,/g, "");
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function formatPrice(value) {
  const numeric = priceNumber(value);
  return numeric > 0 ? `${numeric.toFixed(2).replace(".", ",")} €` : text(value);
}

function mapTire(row) {
  const id = text(row[2]);
  if (!id) return null;
  const size = text(row[5]);
  const rim = text(row[6]);
  return {
    id: id.padStart(4, "0"), type: "reifen", status: text(row[1]),
    brand: text(row[3]), model: text(row[4]),
    size: size && rim && !size.toLowerCase().includes(rim.toLowerCase()) ? `${size} ${rim}` : (size || rim),
    season: text(row[8]), quantity: text(row[9]), tread: text(row[10]),
    price: formatPrice(row[16]), dot: text(row[7]),
  };
}

function mapRim(row) {
  const id = text(row[2]);
  if (!id) return null;
  return {
    id: id.padStart(4, "0"), type: "felge", status: text(row[1]),
    brand: text(row[3]), model: text(row[4]), size: text(row[8]),
    season: "", quantity: text(row[5]), price: formatPrice(row[7]),
    pcd: text(row[9]), et: text(row[10]), zoll: text(row[11]), dia: text(row[12]),
  };
}

// У сірого лота в Coment (стовпець O) вказано ID аналога, до якого він «сірий».
// Беремо перше число-ID з коментаря, яке реально існує в Tires (і не власний ID).
// Числа перед «шт/stk/pcs/x» (кількість) ігноруємо; довші числа мають пріоритет.
function findAnalogId(comment, ownId, byId) {
  const tokens = text(comment).split(/[\s,;:|()[\]{}№#]+/).filter(Boolean);
  const found = [];
  tokens.forEach((token, i) => {
    const digits = token.replace(/^id/i, "");
    if (!/^\d{1,4}$/.test(digits)) return;
    if (/^(шт|stk|st|pcs|x)\.?$/i.test(tokens[i + 1] || "")) return;
    const id = normId(digits);
    if (id !== ownId && byId.has(id)) found.push({ id, len: digits.length });
  });
  found.sort((a, b) => b.len - a.len);
  return found.length ? found[0].id : null;
}

// Tires!A3:Q: B=Status, C=ID, O=Coment, Q=Preis.
// Показуємо всі статуси, крім «Продано» і «В очікуванні». Сірий лот і його аналог
// (за ID з Coment) — це дублі: з групи лишаємо лише найдорожчий.
function pickTires(rows) {
  const entries = [];
  for (const row of rows) {
    const id = text(row[2]);
    if (id) entries.push({ row, id: normId(id), kind: statusKind(row[1]), ref: null });
  }
  const byId = new Map();
  for (const entry of entries) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  for (const entry of entries) {
    if (entry.kind === "grau") entry.ref = findAnalogId(entry.row[14], entry.id, byId);
  }

  // Ланцюжок сірий → сірий → ... → аналог. Корінь групи — ID кінцевого аналога.
  const rootOf = (entry) => {
    const seen = new Set([entry.id]);
    let current = entry;
    while (current.kind === "grau" && current.ref && !seen.has(current.ref)) {
      seen.add(current.ref);
      const next = byId.get(current.ref);
      if (!next) return current.ref;
      current = next;
    }
    return current.id;
  };

  const shown = entries.filter((entry) => isShown(entry.kind));
  const groups = new Map();
  for (const entry of shown) {
    const key = entry.ref ? rootOf(entry) : entry.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  // Дорожчий перемагає; при рівній ціні перевага у не-сірого лота.
  const beats = (a, b) => {
    const pa = priceNumber(a.row[16]);
    const pb = priceNumber(b.row[16]);
    if (pa !== pb) return pa > pb;
    return a.kind !== "grau" && b.kind === "grau";
  };
  const hidden = new Set();
  for (const members of groups.values()) {
    if (members.length < 2 || !members.some((member) => member.ref)) continue;
    const winner = members.reduce((best, member) => (beats(member, best) ? member : best));
    members.forEach((member) => { if (member !== winner) hidden.add(member); });
  }
  return shown.filter((entry) => !hidden.has(entry)).map((entry) => entry.row);
}

async function loadInventory() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const [tires, rims] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: "Tires!A3:Q" }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: "'Диски'!A3:R" }),
  ]);
  const rimRows = (rims.data.values || []).filter((row) => text(row[2]) && isShown(statusKind(row[1])));
  return [
    ...pickTires(tires.data.values || []).map(mapTire).filter(Boolean),
    ...rimRows.map(mapRim).filter(Boolean),
  ];
}

function seasonKind(value) {
  const season = text(value).toLowerCase();
  if (/winter|зим/.test(season)) return "winter";
  if (/sommer|summer|лет/.test(season)) return "summer";
  if (/ganzjahr|all.?season|всесез/.test(season)) return "allseason";
  return "unknown";
}

function itemRadius(item) {
  if (item.type === "felge") {
    const n = Number(String(item.zoll || "").match(/\d{2}/)?.[0]);
    return Number.isFinite(n) ? n : null;
  }
  const match = String(item.size || "").match(/R\s*(1[3-9]|2[0-4])\b/i);
  return match ? Number(match[1]) : null;
}

function parsePriorities(raw) {
  return String(raw || "")
    .split(",")
    .map((key) => key.trim().match(/^(winter|summer|allseason)-(1[3-9]|2[0-4])$/i))
    .filter(Boolean)
    .map((match) => `${match[1].toLowerCase()}-${match[2]}`)
    .slice(0, 8);
}

function buildPage(allItems, query) {
  const season = ["all", "winter", "summer"].includes(query.season) ? query.season : "all";
  const radius = /^(1[3-9]|2[0-4])$/.test(String(query.r || "")) ? Number(query.r) : null;
  const search = String(query.q || "").trim().toLocaleLowerCase("ru").replaceAll("ё", "е").slice(0, 100);
  const offset = Math.max(0, Math.min(100000, Number.parseInt(query.offset, 10) || 0));
  const limit = Math.max(1, Math.min(PAGE_SIZE_MAX, Number.parseInt(query.limit, 10) || 24));
  const priorities = parsePriorities(query.p);

  const seasonOk = (item) => {
    const kind = seasonKind(item.season);
    return !(season !== "all" && item.type === "reifen" && kind !== season && kind !== "allseason");
  };
  // Діаметри, які реально є в наявності для обраного сезону (для кнопок R на сайті).
  const radii = [...new Set(allItems.filter(seasonOk).map(itemRadius).filter((r) => r !== null))]
    .sort((a, b) => a - b);

  const filtered = allItems.filter((item) => {
    if (!seasonOk(item)) return false;
    if (radius !== null && itemRadius(item) !== radius) return false;
    if (!search) return true;
    const haystack = [item.id, item.brand, item.model, item.size, item.season,
      item.pcd, item.et, item.zoll, item.dia].join(" ").toLocaleLowerCase("ru").replaceAll("ё", "е");
    return haystack.includes(search);
  });

  const priorityRank = (item) => {
    if (item.type !== "reifen") return priorities.length + 1;
    const kind = seasonKind(item.season);
    const radius = itemRadius(item);
    if (!radius) return priorities.length;
    const indexes = [
      priorities.indexOf(`${kind}-${radius}`),
      kind === "allseason" ? priorities.indexOf(`winter-${radius}`) : -1,
      kind === "allseason" ? priorities.indexOf(`summer-${radius}`) : -1,
    ].filter((index) => index >= 0);
    return indexes.length ? Math.min(...indexes) : priorities.length;
  };
  const compare = (a, b) => priorityRank(a) - priorityRank(b) ||
    String(a.id).localeCompare(String(b.id), "ru", { numeric: true });
  filtered.sort(compare);

  // Reserve room for both first-choice sizes so a large R16 stock cannot push
  // every R18 result off the initial page.
  const firstPage = [];
  const selected = new Set();
  if (priorities.length > 1) {
    const perPriority = Math.ceil(limit / 2);
    [0, 1].forEach((rank) => {
      let added = 0;
      for (const item of filtered) {
        if (priorityRank(item) !== rank || added >= perPriority) continue;
        firstPage.push(item);
        selected.add(item);
        added++;
      }
    });
  }
  const ordered = firstPage.concat(filtered.filter((item) => !selected.has(item)));
  const items = ordered.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    total: filtered.length,
    radii,
    offset,
    nextOffset: nextOffset < filtered.length ? nextOffset : null,
    hasMore: nextOffset < filtered.length,
    updatedAt: memoryCache.payload.updatedAt,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  try {
    if (!memoryCache.payload || memoryCache.expiresAt <= Date.now()) {
      if (!inFlight) {
        inFlight = loadInventory().then((items) => {
          memoryCache = {
            payload: { items, updatedAt: new Date().toISOString() },
            expiresAt: Date.now() + TTL_MS,
          };
          return memoryCache.payload;
        }).finally(() => { inFlight = null; });
      }
      await inFlight;
    }
    return res.status(200).json(buildPage(memoryCache.payload.items, req.query || {}));
  } catch (error) {
    console.error("[inventory] load failed:", error);
    if (memoryCache.payload) return res.status(200).json(buildPage(memoryCache.payload.items, req.query || {}));
    return res.status(500).json({ error: "Не удалось загрузить товары" });
  }
};