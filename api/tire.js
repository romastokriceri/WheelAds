/**
 * /api/tire  — GET
 * Читає дані шини/диска з Google Sheets.
 *
 * Колонки аркуша Tires (заголовки в рядку 1, A — порожня службова колонка):
 *   A  (порожня)       B  Status        C  ID            D  Marke
 *   E  Modell          F  Größe         G  Zoll          H  Dot
 *   I  Saison          J  Set           K  Durchschnitt  L  Belastungsindex
 *   M  Geschwindigkeitsindex            N  Felgen        O  Coment
 *   P  Einkaufspreis   Q  Preis         R  Client         S  Verkaufsdatum
 *   T  Einkaufsdatum
 *
 * Колонки аркуша Диски (заголовки в рядку 2, A — порожня службова колонка):
 *   A  (порожня)       B  Status        C  ID            D  Reifen(Marke)
 *   E  Modell          F  Set           G  Einkaufspreis  H  Preis
 *   I  Größe           J  PCD           K  ET             L  Zoll
 *   M  DIA             N  Löcher        O  Einkaufsdatum
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
  STATUS:    2,   // B
  ID:        3,   // C
  MARKE:     4,   // D
  MODELL:    5,   // E
  GROSSE:    6,   // F — Größe (205/55R16)
  ZOLL:      7,   // G — окрема колонка з дюймами
  DOT:       8,   // H
  SAISON:    9,   // I
  SET:      10,   // J
  PROFIL:   11,   // K — Durchschnitt (залишковий профіль, мм)
  BELASTUNG: 12,  // L — Belastungsindex
  GESCHW:   13,   // M — Geschwindigkeitsindex
  FELGEN:   14,   // N — рядок з параметрами дисків (якщо комплект)
  COMMENT:  15,   // O — Coment
  EINKAUF:  16,   // P — Einkaufspreis (закупочна, не показуємо)
  PREIS:    17,   // Q — Preis (ціна продажу)
  CLIENT:   18,   // R
  VERKAUF:  19,   // S — Verkaufsdatum
  EINKAUF_DATE: 20, // T
};

// ── Колонки Диски (1-based) ───────────────────────────────────────────────────
const FCOL = {
  STATUS:  2,   // B
  ID:      3,   // C
  MARKE:   4,   // D — стовпець "Reifen" (бренд диска)
  MODELL:  5,   // E
  SET:     6,   // F
  EINKAUF: 7,   // G — Einkaufspreis
  PREIS:   8,   // H
  GROSSE:  9,   // I
  PCD:    10,   // J
  ET:     11,   // K
  ZOLL:   12,   // L
  DIA:    13,   // M
  LOECHER: 14,  // N — Löcher
  // PHOTO_FOLDER: невідомо — за дебаг-діапазоном A:O колонка O = "Einkaufsdatum",
  // не Photo_Folder. Якщо потрібне фото з цього аркуша — розширити діапазон
  // запиту (наприклад "A:S") і перевірити debug=1 ще раз.
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

// ── Фото з Cloudinary (через аркуш Photos) ────────────────────────────────────
// Не прив'язуємось до позиції колонки (вона з часом зсувалась в реальних
// даних) — натомість шукаємо в кожному рядку клітинку з Cloudinary URL і
// витягуємо ID товару та тип/індекс фото напряму з самого URL.
// URL завжди має вигляд:
//   https://res.cloudinary.com/{cloud}/image/upload/v{version}/tires/{id4}/{id4}_{quick|N}.{ext}
const CLOUDINARY_URL_RE = /\/tires\/(\d{4})\/\d+_(quick|\d+)\.\w+/i;

async function getCloudinaryPhotos(sheets, numericId) {
  const paddedId = numericId.padStart(4, "0");
  const found = new Map(); // "quick" | "gallery:N" → url (останній запис перемагає, як і Cloudinary overwrite)

  try {
    const rows = await getRows(sheets, PHOTOS_SHEET, "A:K");

    for (const row of rows) {
      const urlCell = row.find(
        c => typeof c === "string" && c.startsWith("https://res.cloudinary.com/")
      );
      if (!urlCell) continue;

      const m = urlCell.match(CLOUDINARY_URL_RE);
      if (!m) continue;

      const [, folderId, suffix] = m;
      if (folderId !== paddedId) continue;

      const key = suffix === "quick" ? "quick" : `gallery:${parseInt(suffix, 10)}`;
      found.set(key, urlCell);
    }
  } catch (e) {
    console.error("[photos]", e);
  }

  const quick   = found.get("quick") || null;
  const gallery = [...found.entries()]
    .filter(([k]) => k.startsWith("gallery:"))
    .sort((a, b) => parseInt(a[0].split(":")[1], 10) - parseInt(b[0].split(":")[1], 10))
    .map(([, url]) => url);

  return quick ? [quick, ...gallery] : gallery;
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

    // ── DEBUG РЕЖИМ: ?debug=1 — показує сирі рядки з усіх аркушів ──────────
    // Видали цей блок після того, як знайдеш правильні колонки.
    if (req.query.debug === "1") {
      const [tRows, fRows] = await Promise.all([
        getRows(sheets, TIRES_SHEET,  "A1:T5"),
        getRows(sheets, FELGEN_SHEET, "A1:O5"),
      ]);

      // Окремо й безпечно — щоб помилка доступу до Photos не зламала весь debug
      let photosInfo;
      try {
        const pRows = await getRows(sheets, PHOTOS_SHEET, "A1:K200");
        const matching = pRows.filter(row =>
          row.some(c => typeof c === "string" && c.includes(`/${numericId.padStart(4,"0")}/`))
        );
        photosInfo = {
          sheet_name: PHOTOS_SHEET,
          total_rows: pRows.length,
          first_3_rows: pRows.slice(0, 3),
          rows_matching_this_id: matching,
        };
      } catch (e) {
        photosInfo = { sheet_name: PHOTOS_SHEET, error: e.message };
      }

      return res.status(200).json({
        debug: true,
        searched_id: numericId,
        tires_sheet: {
          name: TIRES_SHEET,
          row1_header: tRows[0] || null,
          row2: tRows[1] || null,
          row3: tRows[2] || null,
        },
        felgen_sheet: {
          name: FELGEN_SHEET,
          row1: fRows[0] || null,
          row2_header: fRows[1] || null,
          row3: fRows[2] || null,
        },
        photos_sheet: photosInfo,
      });
    }

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
    const photos      = await getCloudinaryPhotos(sheets, resolvedId);

    return res.status(200).json({
      type: detectType(tire, felgen),
      id:   resolvedId,
      photo:  photos[0] || null,  // перше фото — для поточної верстки
      photos,                      // повний масив — для майбутньої галереї
      tire,
      felgen,
      isAdmin,
    });

  } catch (e) {
    console.error("[tire]", e);
    return res.status(500).json({ error: "Server error", detail: e.message });
  }
}
