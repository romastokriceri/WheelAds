/**
 * GET /api/config
 * Віддає username бота зі змінних Vercel (без @).
 * Додай BOT_USERNAME у Project Settings → Environment Variables.
 */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const botUsername = String(process.env.BOT_USERNAME || "").replace(/^@/, "").trim();
  return res.status(200).json({ botUsername });
};
