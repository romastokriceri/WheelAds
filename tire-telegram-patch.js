/**
 * Встав ці заміни в WheelAds/tire.html (блок <script> внизу).
 *
 * 1) BOT_USERNAME — лиши як запасний, але кнопка більше не має вести на
 *    t.me/YourCarWheelBot (зараз саме так на проді).
 * 2) load() читає ID з Telegram start_param (меню Mini App).
 * 3) Кнопка «керування» → t.me/РЕАЛЬНИЙ_БОТ?start=edit_0080
 *    Бот тоді шле кнопку WebApp. ?startapp= без Mini App у BotFather
 *    відкриває чат і зупиняється — це і був обрив у тестах.
 */

async function load() {
  const params = new URLSearchParams(location.search);
  await loadTelegramSDK();
  tgApp = window.Telegram?.WebApp || null;
  if (tgApp) tgApp.ready();

  const startParam = (tgApp && tgApp.initDataUnsafe && tgApp.initDataUnsafe.start_param) || "";
  const rawId =
    location.hash.replace("#", "").trim() ||
    params.get("id") ||
    params.get("tire_id") ||
    startParam ||
    "";
  if (!rawId) {
    show("state-error");
    $("error-msg").textContent = "ID не вказано.";
    return;
  }

  const initData = tgApp?.initData || "";
  const cacheKey = `wheel-ad:tire:${String(rawId).replace(/\D/g, "")}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const entry = JSON.parse(cached);
      if (entry.expiresAt > Date.now()) {
        currentData = entry.data;
        render(entry.data);
        return;
      }
    } catch (_) {
      localStorage.removeItem(cacheKey);
    }
  }
  const apiUrl =
    `/api/tire?id=${encodeURIComponent(rawId)}` +
    (initData ? `&initData=${encodeURIComponent(initData)}` : "");

  try {
    const res = await fetch(apiUrl);
    if (!res.ok) {
      show("state-error");
      return;
    }
    const data = await res.json();
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ data, expiresAt: Date.now() + 60_000 }));
    } catch (_) {}
    currentData = data;
    render(data);
  } catch (e) {
    console.error(e);
    show("state-error");
  }
}

async function showTelegramButton(id) {
  const padded = String(id).padStart(4, "0");
  let bot = typeof BOT_USERNAME === "string" ? BOT_USERNAME.replace(/^@/, "") : "";
  if (!bot || bot === "YourCarWheelBot") {
    try {
      const r = await fetch("/api/config");
      const j = await r.json();
      if (j.botUsername) bot = String(j.botUsername).replace(/^@/, "");
    } catch (e) {
      console.error(e);
    }
  }
  if (!bot || bot === "YourCarWheelBot") {
    console.error("BOT_USERNAME не заданий — кнопка керування відкриє чужий/порожній бот");
    return;
  }
  const btn = $("tg-open-btn");
  btn.href = `https://t.me/${bot}?start=edit_${padded}`;
  showEl("tg-open-btn");
}
