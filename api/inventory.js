const { google } = require("googleapis");

const TTL_MS = 2 * 60 * 1000;
let memoryCache = { expiresAt: 0, payload: null };
let inFlight = null;
const PAGE_SIZE_MAX = 48;

function text(value) {
  return value == null ? "" : String(value).trim();
}

function isAvailable(value) {
  const status = text(value).toLowerCase().replace(/\s+/g, " ");
  return ["lager", "доступно", "available", "verfügbar", "verfuegbar"].includes(status);
}

function formatPrice(value) {
  const raw = text(value);
  if (!raw) return "";
  let normalized = raw.replace(/[^\d,.-]/g, "");
  normalized = normalized.includes(",")
    ? normalized.replace(/\./g, "").replace(",", ".")
    : normalized.replace(/,/g, "");
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? `${numeric.toFixed(2).replace(".", ",")} €` : raw;
}

function mapTire(row) {
  const id = text(row[2]);
  if (!id || !isAvailable(row[1])) return null;
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
  if (!id || !isAvailable(row[1])) return null;
  return {
    id: id.padStart(4, "0"), type: "felge", status: text(row[1]),
    brand: text(row[3]), model: text(row[4]), size: text(row[8]),
    season: "", quantity: text(row[5]), price: formatPrice(row[7]),
    pcd: text(row[9]), et: text(row[10]), zoll: text(row[11]), dia: text(row[12]),
  };
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
  return [
    ...(tires.data.values || []).map(mapTire).filter(Boolean),
    ...(rims.data.values || []).map(mapRim).filter(Boolean),
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
