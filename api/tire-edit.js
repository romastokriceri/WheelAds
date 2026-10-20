/**
 * POST /api/tire-edit
 * Верифікує Telegram initData, перевіряє права, оновлює рядок у Google Sheets.
 *
 * Поклади цей файл у WheelAds/api/tire-edit.js (зараз на проді 404,
 * бо скрипт лежав у корені репо і ще був ESM при "type": "commonjs").
 */
const { google } = require("googleapis");
const crypto = require("crypto");

const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TIRES_SHEET = "Tires";
const FELGEN_SHEET = "Диски";

const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter(Boolean);

// Tires: B=Status, C=ID, O=Comment, Q=Preis (як у api/tire.js)
const TIRES_COLS = { ID: 3, STATUS: 2, COMMENT: 15, PREIS: 17 };
const FELGEN_COLS = { ID: 3, STATUS: 2, PREIS: 8 };

const VALID_STATUSES = new Set([
  "Доступно",
  "Зарезервовано",
  "Продано",
  "Сірий",
  "lager",
  "grau",
  "verkauft",
  "pending",
]);

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function verifyInitData(initDataRaw) {
  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expected = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (hash !== expected) return null;

    const authDate = parseInt(params.get("auth_date") || "0", 10);
    if (Date.now() / 1000 - authDate > 86400) return null;

    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

async function findRowNumber(sheets, sheetName, idColIdx, numericId, headerRows = 1) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:C`,
  });
  const rows = res.data.values || [];

  for (let i = headerRows; i < rows.length; i++) {
    const cellId = (rows[i][idColIdx - 1] || "").trim().replace(/^0+/, "") || "0";
    if (cellId === numericId) return i + 1;
  }
  return null;
}

async function batchWrite(sheets, updates) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: updates.map(({ range, value }) => ({
        range,
        values: [[value]],
      })),
    },
  });
}

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id, type, status, preis, comment, initData } = req.body || {};

  if (!id || !initData) {
    return res.status(400).json({ error: "Missing id or initData" });
  }
  if (status && !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: "Invalid status value" });
  }

  const user = verifyInitData(initData);
  if (!user) {
    return res.status(401).json({ error: "Invalid or expired initData" });
  }
  if (!ALLOWED_USER_IDS.includes(user.id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const numericId = String(parseInt(id, 10));
  const updateTires = type !== "felgen";
  const updateFelgen = type === "felgen" || type === "komplettraeder";

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const writes = [];

    if (updateTires) {
      const rowNum = await findRowNumber(sheets, TIRES_SHEET, TIRES_COLS.ID, numericId, 1);
      if (!rowNum) {
        return res.status(404).json({ error: `ID ${numericId} not found in Tires` });
      }
      if (status !== undefined) {
        writes.push({
          range: `${TIRES_SHEET}!${colLetter(TIRES_COLS.STATUS)}${rowNum}`,
          value: status,
        });
      }
      if (preis !== undefined) {
        writes.push({
          range: `${TIRES_SHEET}!${colLetter(TIRES_COLS.PREIS)}${rowNum}`,
          value: preis,
        });
      }
      if (comment !== undefined) {
        writes.push({
          range: `${TIRES_SHEET}!${colLetter(TIRES_COLS.COMMENT)}${rowNum}`,
          value: comment,
        });
      }
    }

    if (updateFelgen) {
      const rowNum = await findRowNumber(sheets, FELGEN_SHEET, FELGEN_COLS.ID, numericId, 2);
      if (rowNum) {
        if (status !== undefined) {
          writes.push({
            range: `${FELGEN_SHEET}!${colLetter(FELGEN_COLS.STATUS)}${rowNum}`,
            value: status,
          });
        }
        if (preis !== undefined) {
          writes.push({
            range: `${FELGEN_SHEET}!${colLetter(FELGEN_COLS.PREIS)}${rowNum}`,
            value: preis,
          });
        }
      }
    }

    if (writes.length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    await batchWrite(sheets, writes);
    return res.status(200).json({
      ok: true,
      id: numericId,
      fields: writes.map((w) => w.range),
    });
  } catch (e) {
    console.error("[tire-edit] error:", e);
    return res.status(500).json({ error: "Server error", detail: e.message });
  }
};
