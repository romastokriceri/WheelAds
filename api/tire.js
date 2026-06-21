/**
 * /api/tire  — GET
 * Читає дані шини/диска з Google Sheets.
 *
 * Колонки аркуша Tires (A=1):
 *   A  Status          B  ID            C  Marke         D  Modell
 *   E  Größe           F  Zoll          G  Dot           H  Saison
 *   I  Set             J  Durchschnitt  K  Belastung     L  Geschw
 *   M  Felgen          N  Comment       O  Einkaufspreis P  Preis
 *   Q  Client          R  Verkaufsdatum S  Einkaufsdatum T  Photo_Folder
 *
 * Колонки аркуша Диски (заголовки в рядку 2):
 *   A  Status  B  ID  C  Marke  D  Modell  E  Set  F  ?  G  ?  H  Preis
 *   I  Größe   J  PCD K  ET     L  Zoll    M  DIA  N  Locher  O  Photo_Folder
 */

const { google } = require("googleapis");
const crypto      = require("crypto");

const SHEET_ID     = process.env.GOOGLE_SHEETS_ID;
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TIRES_SHEET  = "Tires";
const PHOTOS_SHEET = "Photos";
const FELGEN_SHEET = "Диски";

const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

// ── Колонки Tires (1-based, A=1) ─────────────────────────────────────────────
const COL = {
  STATUS:    1,   // A
  ID:        2,   // B
  MARKE:     3,   // C
  MODELL:    4,   // D
  GROSSE:    5,   // E — Größe (205/55R16)
  ZOLL:      6,   // F — окрема колонка з дюймами
  DOT:       7,   // G
  SAISON:    8,   // H
  SET:       9,   // I
  PROFIL:   10,   // J — Durchschnitt (залишковий профіль, мм)
  BELASTUNG: 11,  // K — Belastungsindex
  GESCHW:   12,   // L — Geschwindigkeitsindex
  FELGEN:   13,   // M — рядок з параметрами дисків (якщо комплект)
  COMMENT:  14,   // N
  EINKAUF:  15,   // O — Einkaufspreis (закупочна, не показуємо)
  PREIS:    16,   // P — Preis (ціна продажу)
  CLIENT:   17,   // Q
  VERKAUF:  18,   // R — Verkaufsdatum
  EINKAUF_DATE: 19, // S
  PHOTO_FOLDER: 20, // T
};

// ── Колонки Диски (1-based) ───────────────────────────────────────────────────
const FCOL = {
  STATUS:  1,   // A
  ID:      2,   // B
  MARKE:   3,   // C
  MODELL:  4,   // D
  SET:     5,   // E
  PREIS:   8,   // H
  GROSSE:  9,   // I
  PCD:    10,   // J
  ET:     11,   // K
  ZOLL:   12,   // L
  DIA:    13,   // M
  LOECHER: 14,  // N
  PHOTO_FOLDER: 15, // O
};

// ── Верифікація Telegram initData ────────────────────────────────────────────
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

async function findRow(sheets, sheet, range, colIdx, numericId, headerRows = 1) {
  const rows = await getRows(sheets, sheet, range);
  for (const row of rows.slice(headerRows)) {
    const val = (row[colIdx] || "").toString().trim().replace(/^0+/, "") || "0";
    if (val === numericId) return row;
  }
  return null;
}

// Photos — тип "quick" (перше фото швидкого скану)
async function getQuickPhoto(sheets, numericId) {
  try {
    const rows = await getRows(sheets, PHOTOS_SHEET, "A:F");
    for (const row of rows.slice(1)) {
      const rowId = (row[0] || "").toString().trim().replace(/^0+/, "") || "0";
      const type  = (row[1] || "").toString().trim().toLowerCase();
      const url   = (row[2] || "").toString().trim();
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

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { id, initData } = req.query;
  if (!id) return res.status(400).json({ error: "Missing id" });

  // Визначаємо чи адмін
  let isAdmin = false;
  if (initData) {
    const user = verifyInitData(initData);
    if (user && ALLOWED_USER_IDS.includes(user.id)) isAdmin = true;
  }

  const numericId = String(parseInt(id, 10));

  try {
    const auth   = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const [tireRow, felgenRow] = await Promise.all([
      findRow(sheets, TIRES_SHEET,  "A:T", COL.ID  - 1, numericId, 1),
      findRow(sheets, FELGEN_SHEET, "A:O", FCOL.ID - 1, numericId, 2),
    ]);

    if (!tireRow && !felgenRow) {
      return res.status(404).json({ error: "Not found" });
    }

    const gt = col => tireRow   ? (tireRow  [col - 1] || "").toString().trim() : "";
    const gf = col => felgenRow ? (felgenRow[col - 1] || "").toString().trim() : "";

    const tire = tireRow ? {
      id:          gt(COL.ID),
      status:      gt(COL.STATUS),
      marke:       gt(COL.MARKE),
      modell:      gt(COL.MODELL),
      grosse:      gt(COL.GROSSE),
      zoll:        gt(COL.ZOLL),       // ← нова колонка F
      dot:         gt(COL.DOT),
      saison:      gt(COL.SAISON),
      set:         gt(COL.SET),
      profil_mm:   gt(COL.PROFIL),
      belastung:   gt(COL.BELASTUNG),
      geschw:      gt(COL.GESCHW),
      felgen_raw:  gt(COL.FELGEN),
      comment:     gt(COL.COMMENT),
      preis:       gt(COL.PREIS),      // ← P, не O
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

    const resolvedId = (tire?.id || felgen?.id || numericId).replace(/^0+/, "") || numericId;
    const photo      = await getQuickPhoto(sheets, resolvedId);

    return res.status(200).json({
      type: detectType(tire, felgen),
      id:   resolvedId,
      photo,
      tire,
      felgen,
      isAdmin,
    });

  } catch (e) {
    console.error("[tire]", e);
    return res.status(500).json({ error: "Server error", detail: e.message });
  }
}