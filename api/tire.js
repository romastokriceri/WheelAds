import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const PHOTOS_SHEET = "Photos";
const TIRES_SHEET = "Tires";

// Column indices (1-based, matching config.py)
const COL = {
  STATUS: 2, ID: 3, MARKE: 4, MODELL: 5, GROSSE: 6,
  DOT: 7, SAISON: 8, SET: 9, PROFIL: 10,
  BELASTUNG: 11, GESCHW: 12, COMMENT: 14, PREIS: 15,
};

function getAuth() {
  const raw = process.env.GOOGLE_CREDENTIALS;
  const creds = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

async function getTireRow(sheets, numericId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TIRES_SHEET}!A:U`,
  });
  const rows = res.data.values || [];
  // Skip header row, find by ID column (index COL.ID-1 = 2)
  for (const row of rows.slice(1)) {
    const rowId = (row[COL.ID - 1] || "").trim();
    if (rowId === numericId || rowId === numericId.padStart(4, "0")) {
      return row;
    }
  }
  return null;
}

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