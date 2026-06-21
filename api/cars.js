/**
 * /api/cars  — GET
 * Перевіряє сумісність диска або шини з автомобілями.
 * Дані беруться з wheel_db.json (генерується export_db.py з wheel_database.py).
 *
 * Query params:
 *   pcd   : string  — "5x112"  (для felgen / komplettraeder)
 *   et    : string  — "40"
 *   zoll  : string  — "18"
 *   dia   : string  — "57.1"   (необов'язково)
 *   grosse: string  — "205/55R16"  (для reifen / komplettraeder)
 *   type  : string  — "reifen" | "felgen" | "komplettraeder"
 *
 * Відповідь:
 *   {
 *     fitment: [ { status, model, notes, reasons } ],   // для дисків
 *     bySize:  [ "VW Golf VII", "Audi A3", ... ]        // для шин
 *   }
 */

// Статичний require() — на відміну від fs.readFileSync(), Vercel бачить
// цю залежність під час збірки і гарантовано пакує wheel_db.json у функцію.
const wheelDb = require("../wheel_db.json");

function getDb() {
  return wheelDb;
}

// Нормалізація PCD: "5X112" / "5 x 112" → "5x112"
function normPcd(s) {
  if (!s) return "";
  return s.toString().trim().toLowerCase().replace(/\s+/g, "");
}

// Перевірка диска по базі (аналог check_fitment з Python)
function checkFitment(pcd, et, zoll, dia) {
  const db      = getDb();
  const normPCD = normPcd(pcd);
  const etNum   = parseInt(et,   10);
  const zollNum = parseInt(zoll, 10);
  const diaNum  = dia ? parseFloat(dia) : null;

  const ok = [], warn = [], bad = [];

  for (const spec of db) {
    if (normPcd(spec.pcd) !== normPCD) continue;  // PCD не збігається — пропускаємо

    const issues   = [];
    const warnings = [];

    // ET
    if (!isNaN(etNum)) {
      if (etNum < spec.et_min || etNum > spec.et_max) {
        const far = etNum < spec.et_min - 10 || etNum > spec.et_max + 10;
        const msg = `ET${etNum} поза ET${spec.et_min}–${spec.et_max}`;
        far
          ? issues.push(msg + " (занадто далеко)")
          : warnings.push(msg + " (можливо з проставками)");
      }
    }

    // Zoll
    if (!isNaN(zollNum) && !spec.zoll.includes(zollNum)) {
      warnings.push(`R${zollNum} не в стандартному списку ${spec.zoll.join("/")}`);
    }

    // DIA
    if (diaNum) {
      if (diaNum > spec.dia + 0.5) {
        issues.push(`DIA ${diaNum} > ${spec.dia} — не сяде без переточки`);
      } else if (Math.abs(diaNum - spec.dia) > 0.5) {
        warnings.push(`DIA ${diaNum} ≠ ${spec.dia} — потрібні центрувальні кільця`);
      }
    }

    const entry = { model: spec.model, notes: spec.notes || "", reasons: [] };

    if (issues.length) {
      entry.status  = "❌";
      entry.reasons = [...issues, ...warnings];
      bad.push(entry);
    } else if (warnings.length) {
      entry.status  = "⚠️";
      entry.reasons = warnings;
      warn.push(entry);
    } else {
      entry.status = "✅";
      ok.push(entry);
    }
  }

  return [...ok, ...warn, ...bad];  // ✅ → ⚠️ → ❌
}

// Пошук авто за розміром шини (аналог check_fitment_by_tyre_size)
function checkFitmentByTyreSize(grosse) {
  const db = getDb();
  const m  = grosse.match(/R\s*(\d{2})/i);
  if (!m) return [];

  const zoll = parseInt(m[1], 10);
  const seen = new Set();
  const out  = [];

  for (const spec of db) {
    if (spec.zoll.includes(zoll)) {
      const short = spec.model.replace(/\s*\([^)]*\)\s*\d{4}.*/g, "").trim();
      if (!seen.has(short)) { seen.add(short); out.push(short); }
    }
  }
  return out.slice(0, 15);
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=3600");

  try {
    const { pcd, et, zoll, dia, grosse, type = "reifen" } = req.query;

    const result = {};

    if (type !== "reifen" && pcd) {
      const fitment = checkFitment(pcd, et, zoll, dia);
      if (fitment.length) result.fitment = fitment;
    }

    if (type !== "felgen" && grosse) {
      const models = checkFitmentByTyreSize(grosse);
      if (models.length) result.bySize = models;
    }

    if (!result.fitment && !result.bySize) {
      return res.status(200).json({ fitment: [], bySize: [] });
    }

    return res.status(200).json(result);

  } catch (e) {
    console.error("[cars]", e);
    return res.status(500).json({ error: "Server error", detail: e.message });
  }
}
