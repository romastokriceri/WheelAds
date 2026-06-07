/**
 * /api/tire-edit  — POST
 * Верифікує Telegram initData, перевіряє права, оновлює рядок у Google Sheets.
 *
 * Body (JSON):
 *   id       : string   — числовий ID товару ("21")
 *   type     : string   — "reifen" | "felgen" | "komplettraeder"
 *   status   : string   — "Доступно" | "Зарезервовано" | "Продано"
 *   preis    : string   — "140,00€"
 *   comment  : string   — довільний текст
 *   initData : string   — Telegram WebApp initData (для верифікації)
 */

import { google } from "googleapis";
import crypto from "crypto";

const SHEET_ID     = process.env.GOOGLE_SHEETS_ID;
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TIRES_SHEET  = "Tires";
const FELGEN_SHEET = "Диски";

const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",").map(s => parseInt(s.trim())).filter(Boolean);

// ── Колонки (1-based) ────────────────────────────────────────────────────────

// Tires: B=Status, C=ID, N=Comment, O=Preis
const TIRES_COLS = { ID: 3, STATUS: 2, COMMENT: 14, PREIS: 15 };

// Диски: B=Status, C=ID, H=Preis  (немає поля Comment)
const FELGEN_COLS = { ID: 3, STATUS: 2, PREIS: 8 };

// ── Дозволені значення (захист від сміттєвих запитів) ───────────────────────
const VALID_STATUSES = new Set(["Доступно", "Зарезервовано", "Продано"]);

// ── Auth ─────────────────────────────────────────────────────────────────────
function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    // ВАЖЛИВО: тут потрібен повний доступ, не readonly
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

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

    // Не старіше 10 хвилин
    const authDate = parseInt(params.get("auth_date") || "0");
    if (Date.now() / 1000 - authDate > 600) return null;

    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

// ── Знайти номер рядка у Sheet по ID ─────────────────────────────────────────
// Повертає 1-based row number або null
async function findRowNumber(sheets, sheetName, idColIdx, numericId, headerRows = 1) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:C`,   // достатньо перших колонок щоб знайти ID
  });
  const rows = res.data.values || [];

  for (let i = headerRows; i < rows.length; i++) {
    const cellId = (rows[i][idColIdx - 1] || "").trim().replace(/^0+/, "") || "0";
    if (cellId === numericId) {
      return i + 1; // Sheets API рядки 1-based
    }
  }
  return null;
}

// ── Записати кілька комірок одним запитом ─────────────────────────────────────
// updates: [{ range: "Tires!B5", value: "Продано" }, ...]
async function batchWrite(sheets, updates) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",  // щоб "140,00€" сприймалось як текст
      data: updates.map(({ range, value }) => ({
        range,
        values: [[value]],
      })),
    },
  });
}

// ── Перетворити номер колонки в літеру (1→A, 14→N, 15→O) ────────────────────
function colLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Тільки POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id, type, status, preis, comment, initData } = req.body || {};

  // ── 1. Базова валідація вхідних даних ────────────────────────────────────
  if (!id || !initData) {
    return res.status(400).json({ error: "Missing id or initData" });
  }
  if (status && !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: "Invalid status value" });
  }

  // ── 2. Верифікація Telegram + перевірка прав ─────────────────────────────
  const user = verifyInitData(initData);
  if (!user) {
    return res.status(401).json({ error: "Invalid or expired initData" });
  }
  if (!ALLOWED_USER_IDS.includes(user.id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const numericId = String(parseInt(id, 10));

  // ── 3. Визначаємо який аркуш оновлювати ──────────────────────────────────
  // komplettraeder = оновлюємо обидва; reifen = тільки Tires; felgen = тільки Диски
  const updateTires  = type !== "felgen";
  const updateFelgen = type === "felgen" || type === "komplettraeder";

  try {
    const auth   = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const writes = [];

    // ── 4а. Оновлення Tires ───────────────────────────────────────────────
    if (updateTires) {
      const rowNum = await findRowNumber(
        sheets, TIRES_SHEET, TIRES_COLS.ID, numericId, 1
      );
      if (!rowNum) {
        return res.status(404).json({ error: `ID ${numericId} not found in Tires` });
      }

      if (status !== undefined)  writes.push({ range: `${TIRES_SHEET}!${colLetter(TIRES_COLS.STATUS)}${rowNum}`,  value: status  });
      if (preis   !== undefined)  writes.push({ range: `${TIRES_SHEET}!${colLetter(TIRES_COLS.PREIS)}${rowNum}`,   value: preis   });
      if (comment !== undefined)  writes.push({ range: `${TIRES_SHEET}!${colLetter(TIRES_COLS.COMMENT)}${rowNum}`, value: comment });
    }

    // ── 4б. Оновлення Диски ───────────────────────────────────────────────
    if (updateFelgen) {
      const rowNum = await findRowNumber(
        sheets, FELGEN_SHEET, FELGEN_COLS.ID, numericId, 2  // заголовки в рядку 2
      );
      if (rowNum) {  // не падаємо якщо немає — може бути тільки шина
        if (status !== undefined) writes.push({ range: `${FELGEN_SHEET}!${colLetter(FELGEN_COLS.STATUS)}${rowNum}`, value: status });
        if (preis  !== undefined) writes.push({ range: `${FELGEN_SHEET}!${colLetter(FELGEN_COLS.PREIS)}${rowNum}`,  value: preis  });
      }
    }

    // ── 5. Записуємо все одним запитом ───────────────────────────────────
    if (writes.length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    await batchWrite(sheets, writes);

    // ── 6. Логуємо хто і що змінив ───────────────────────────────────────
    console.log(`[tire-edit] user=${user.id} (@${user.username||"?"}) id=${numericId} type=${type}`, {
      status, preis, comment: comment ? `"${comment.slice(0,30)}…"` : undefined,
      writes: writes.map(w => w.range),
    });

    return res.status(200).json({
      ok:     true,
      id:     numericId,
      fields: writes.map(w => w.range),
    });

  } catch (e) {
    console.error("[tire-edit] error:", e);
    return res.status(500).json({ error: "Server error", detail: e.message });
  }
}
