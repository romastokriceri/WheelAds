import { google } from "googleapis";
import crypto from "crypto";

const SHEET_ID     = process.env.GOOGLE_SHEETS_ID;
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TIRES_SHEET  = "Tires";
const PHOTOS_SHEET = "Photos";
const FELGEN_SHEET = "Диски";

// Дозволені user.id через кому: ALLOWED_USER_IDS=123456,789012
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

const COL = {
  STATUS: 2, ID: 3, MARKE: 4, MODELL: 5, GROSSE: 6,
  DOT: 7, SAISON: 8, SET: 9, PROFIL: 10,
  BELASTUNG: 11, GESCHW: 12, FELGEN: 13, COMMENT: 14, PREIS: 15,
};

const FCOL = {
  STATUS: 2, ID: 3, MARKE: 4, MODELL: 5, SET: 6,
  PREIS: 8, GROSSE: 9, PCD: 10, ET: 11, ZOLL: 12, DIA: 13, LOECHER: 14,
  PHOTO_FOLDER: 15,
};

// ── Верифікація Telegram initData (HMAC-SHA256) ──────────────────────────────
function verifyInitData(initDataRaw) {
  try {
    const params = new URLSearchParams(initDataRaw);
    const hash   = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN).digest();
    const expected  = crypto.createHmac("sha256", secretKey)
      .update(dataCheckString).digest("hex");

    if (hash !== expected) return null;

    // Перевіряємо свіжість (не старіше 10 хв)
    const authDate = parseInt(params.get("auth_date") || "0");
    if (Date.now() / 1000 - authDate > 600) return null;

    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

async function getRows(sheets, sheet, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!${range}`,
  });
  return res.data.values || [];
}

async function findRow(sheets, sheet, range, colIdx, numericId) {
  const rows = await getRows(sheets, sheet, range);
  const start = sheet === FELGEN_SHEET ? 2 : 1; // Диски: заголовки в рядку 2
  for (const row of rows.slice(start)) {
    const val = (row[colIdx] || "").trim().replace(/^0+/, "") || "0";
    if (val === numericId) return row;
  }
  return null;
}

async function getQuickPhoto(sheets, numericId) {
  try {
    const rows = await getRows(sheets, PHOTOS_SHEET, "A:F");
    for (const row of rows.slice(1)) {
      const rowId = (row[0] || "").trim().replace(/^0+/, "") || "0";
      const type  = (row[1] || "").trim().toLowerCase();
      const url   = (row[2] || "").trim();
      if (rowId === numericId && type === "quick" && url) return url;
    }
  } catch { /* no photo */ }
  return null;
}

function detectType(tire, felgen) {
  const hasTire   = !!(tire?.marke || tire?.profil_mm || tire?.dot);
  const hasFelgen = !!(felgen || tire?.felgen_raw);
  if (hasTire && hasFelgen) return "komplettraeder";
  if (!hasTire && hasFelgen) return "felgen";
  return "reifen";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { id, initData } = req.query;
  if (!id) return res.status(400).json({ error: "Missing id" });

  // ── Визначаємо чи адмін ──────────────────────────────────────────────────
  let isAdmin = false;
  if (initData) {
    const user = verifyInitData(initData);
    if (user && ALLOWED_USER_IDS.includes(user.id)) {
      isAdmin = true;
    }
  }

  const numericId = String(parseInt(id, 10));

  try {
    const auth   = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const [tireRow, felgenRow] = await Promise.all([
      findRow(sheets, TIRES_SHEET,  "A:U", COL.ID  - 1, numericId),
      findRow(sheets, FELGEN_SHEET, "A:P", FCOL.ID - 1, numericId),
    ]);

    if (!tireRow && !felgenRow) {
      return res.status(404).json({ error: "Not found" });
    }

    const gt = (col) => tireRow   ? (tireRow  [col - 1] || "").trim() : "";
    const gf = (col) => felgenRow ? (felgenRow[col - 1] || "").trim() : "";

    const tire = tireRow ? {
      id:         gt(COL.ID),
      status:     gt(COL.STATUS),
      marke:      gt(COL.MARKE),
      modell:     gt(COL.MODELL),
      grosse:     gt(COL.GROSSE),
      dot:        gt(COL.DOT),
      saison:     gt(COL.SAISON),
      set:        gt(COL.SET),
      profil_mm:  gt(COL.PROFIL),
      belastung:  gt(COL.BELASTUNG),
      geschw:     gt(COL.GESCHW),
      felgen_raw: gt(COL.FELGEN),
      comment:    gt(COL.COMMENT),
      preis:      gt(COL.PREIS),
    } : null;

    const felgen = felgenRow ? {
      id:      gf(FCOL.ID),
      status:  gf(FCOL.STATUS),
      marke:   gf(FCOL.MARKE),
      modell:  gf(FCOL.MODELL),
      set:     gf(FCOL.SET),
      preis:   gf(FCOL.PREIS),
      grosse:  gf(FCOL.GROSSE),
      pcd:     gf(FCOL.PCD),
      et:      gf(FCOL.ET),
      zoll:    gf(FCOL.ZOLL),
      dia:     gf(FCOL.DIA),
      loecher: gf(FCOL.LOECHER),
    } : null;

    const resolvedId = (tire?.id || felgen?.id || numericId)
      .replace(/^0+/, "") || numericId;

    const photo = await getQuickPhoto(sheets, resolvedId);

    return res.status(200).json({
      type: detectType(tire, felgen),
      id:   resolvedId,
      photo,
      tire,
      felgen,
      isAdmin,   // ← ключове: сайт знає чи показувати редагування
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", detail: e.message });
  }
}
  return res.data.values || [];
}

// Знайти рядок в Tires по ID
async function getTireRow(sheets, numericId) {
  const rows = await getSheetRows(sheets, TIRES_SHEET, "A:U");
  for (const row of rows.slice(1)) {
    const rowId = (row[COL.ID - 1] || "").trim().replace(/^0+/, "") || "0";
    if (rowId === numericId) return row;
  }
  return null;
}

// Знайти рядок в Диски по ID
async function getFelgenRow(sheets, numericId) {
  const rows = await getSheetRows(sheets, FELGEN_SHEET, "A:P");
  // Заголовки в рядку 2 (рядок 0 = порожній, рядок 1 = заголовки)
  for (const row of rows.slice(2)) {
    const rowId = (row[FCOL.ID - 1] || "").trim().replace(/^0+/, "") || "0";
    if (rowId === numericId) return row;
  }
  return null;
}

// Quick photo з аркуша Photos
async function getQuickPhoto(sheets, tireId) {
  try {
    const rows = await getSheetRows(sheets, PHOTOS_SHEET, "A:F");
    for (const row of rows.slice(1)) {
      const rowId = (row[0] || "").trim().replace(/^0+/, "") || "0";
      const type  = (row[1] || "").trim().toLowerCase();
      const url   = (row[2] || "").trim();
      if (rowId === tireId && type === "quick" && url) return url;
    }
  } catch (_) {}
  return null;
}

// Визначити тип товару
function detectType(tire, felgen) {
  const hasTire   = !!(tire?.marke || tire?.profil_mm || tire?.dot);
  const hasFelgen = !!(felgen || tire?.felgen_raw);
  if (hasTire && hasFelgen) return "komplettraeder";
  if (hasFelgen)            return "felgen";
  return "reifen";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing id" });

  const numericId = String(parseInt(id, 10));

  try {
    const auth   = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    // Паралельно читаємо Tires і Диски
    const [tireRow, felgenRow] = await Promise.all([
      getTireRow(sheets, numericId),
      getFelgenRow(sheets, numericId),
    ]);

    if (!tireRow && !felgenRow) {
      return res.status(404).json({ error: "Not found" });
    }

    const gt = (col) => tireRow  ? (tireRow [col - 1] || "").trim() : "";
    const gf = (col) => felgenRow ? (felgenRow[col - 1] || "").trim() : "";

    // Дані шини (може бути порожнім якщо це чистий диск)
    const tire = tireRow ? {
      id:         gt(COL.ID),
      status:     gt(COL.STATUS),
      marke:      gt(COL.MARKE),
      modell:     gt(COL.MODELL),
      grosse:     gt(COL.GROSSE),
      dot:        gt(COL.DOT),
      saison:     gt(COL.SAISON),
      set:        gt(COL.SET),
      profil_mm:  gt(COL.PROFIL),
      belastung:  gt(COL.BELASTUNG),
      geschw:     gt(COL.GESCHW),
      felgen_raw: gt(COL.FELGEN),   // рядок типу "5x112 ET35 17Zoll" якщо є
      comment:    gt(COL.COMMENT),
      preis:      gt(COL.PREIS),
    } : null;

    // Дані диска (з окремого аркуша Диски)
    const felgen = felgenRow ? {
      id:      gf(FCOL.ID),
      status:  gf(FCOL.STATUS),
      marke:   gf(FCOL.MARKE),     // "Autec", "Com4Wheels" тощо
      modell:  gf(FCOL.MODELL),    // KBA номер
      set:     gf(FCOL.SET),
      preis:   gf(FCOL.PREIS),
      grosse:  gf(FCOL.GROSSE),    // "7,5J x 17"
      pcd:     gf(FCOL.PCD),       // "5x112"
      et:      gf(FCOL.ET),        // "35"
      zoll:    gf(FCOL.ZOLL),      // "17"
      dia:     gf(FCOL.DIA),       // "57.1"
      loecher: gf(FCOL.LOECHER),   // "5"
      photo_folder: gf(FCOL.PHOTO_FOLDER),
    } : null;

    const type = detectType(tire, felgen);

    // ID і фото — беремо звідки є
    const resolvedId = (tire?.id || felgen?.id || numericId).replace(/^0+/, "") || numericId;

    const photo = await getQuickPhoto(sheets, resolvedId);

    return res.status(200).json({
      type,           // "reifen" | "felgen" | "komplettraeder"
      id:     resolvedId,
      photo,
      tire,           // null якщо чистий диск
      felgen,         // null якщо чиста шина
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", detail: e.message });
  }
}}

async function getQuickPhoto(sheets, tireId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${PHOTOS_SHEET}!A:F`,
    });
    const rows = res.data.values || [];
    for (const row of rows.slice(1)) {
      const rowId = (row[0] || "").trim();
      const type  = (row[1] || "").trim().toLowerCase();
      const url   = (row[2] || "").trim();
      if ((rowId === tireId || rowId === String(parseInt(tireId))) && type === "quick" && url) {
        return url;
      }
    }
  } catch (_) {}
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing id" });

  const numericId = String(parseInt(id, 10));

  try {
    const auth   = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const row = await getTireRow(sheets, numericId);
    if (!row) return res.status(404).json({ error: "Not found" });

    const g = (col) => (row[col - 1] || "").trim();

    const tire = {
      id:        g(COL.ID),
      status:    g(COL.STATUS),
      marke:     g(COL.MARKE),
      modell:    g(COL.MODELL),
      grosse:    g(COL.GROSSE),
      dot:       g(COL.DOT),
      saison:    g(COL.SAISON),
      set:       g(COL.SET),
      profil_mm: g(COL.PROFIL),
      belastung: g(COL.BELASTUNG),
      geschw:    g(COL.GESCHW),
      comment:   g(COL.COMMENT),
      preis:     g(COL.PREIS),
    };

    tire.photo = await getQuickPhoto(sheets, numericId);

    return res.status(200).json(tire);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", detail: e.message });
  }
}
