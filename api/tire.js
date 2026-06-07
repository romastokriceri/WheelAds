import { google } from "googleapis";

const SHEET_ID     = process.env.GOOGLE_SHEETS_ID;
const TIRES_SHEET  = "Tires";
const PHOTOS_SHEET = "Photos";
const FELGEN_SHEET = "Диски";

// Колонки Tires (1-based, відповідає config.py)
const COL = {
  STATUS: 2, ID: 3, MARKE: 4, MODELL: 5, GROSSE: 6,
  DOT: 7, SAISON: 8, SET: 9, PROFIL: 10,
  BELASTUNG: 11, GESCHW: 12, FELGEN: 13, COMMENT: 14, PREIS: 15,
};

// Колонки Диски (1-based, відповідає реальній структурі аркуша)
const FCOL = {
  STATUS: 2, ID: 3, MARKE: 4, MODELL: 5, SET: 6,
  // col G (Standort) = 7 — пропускаємо
  PREIS: 8, GROSSE: 9, PCD: 10, ET: 11, ZOLL: 12, DIA: 13, LOECHER: 14,
  PHOTO_FOLDER: 15,
};

function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

// Зчитати всі рядки аркуша
async function getSheetRows(sheets, sheetName, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!${range}`,
  });
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
