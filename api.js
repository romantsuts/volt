// Centralized HTTP client for REST endpoints.

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD
  ? "https://api.yourgame.com"
  : "");
const ADMIN_API = import.meta.env.VITE_ADMIN_PATH || "/api/admin";


const expireSession = () => {
  localStorage.removeItem("auth_token");
  localStorage.removeItem("game_user");
  localStorage.removeItem("user_profile");
  window.dispatchEvent(new Event("auth:expired"));
};

async function parseResponse(response) {
  if (response.status === 401) {
    expireSession();
    throw Object.assign(new Error("Требуется войти в аккаунт."), { status: 401, data: {} });
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = {
      "admin-required": "Недостаточно прав для этой операции.",
      "already-owned": "Этот предмет уже куплен.",
      "plus-required": "Для этой позиции нужна активная подписка Volt Plus.",
      "plus-item-included": "Позиция включена в Volt Plus и не покупается отдельно.",
      "plus-price-changed": "Цена Volt Plus изменилась. Проверьте новую цену и повторите попытку.",
      "volt-plus-not-configured": "Подписка Volt Plus пока не настроена в админ-панели.",
      "catalog-defaults-unavailable": "Регистрация недоступна: в каталоге не настроены активные аватар volt и доска classic.",
      "package-price-changed": "Цена пакета обновилась. Список цен обновлён — проверьте сумму и нажмите «Купить» ещё раз.",
      "pending-payments": "Нельзя удалить аккаунт, пока есть незавершённый платёж. Дождитесь его обработки и повторите попытку.",
      "email-taken": "Этот email уже зарегистрирован.",
      "invalid-email": "Введите корректный адрес email.",
      "not-enough": "Недостаточно средств.",
      "vlt-required": "Недостаточно VLT для разблокировки.",
      "catalog-item-not-owned": "Этот предмет не числится в коллекции аккаунта.",
      "catalog-item-not-found": "Предмет каталога больше недоступен.",
      "invalid-catalog-item-id": "Не удалось определить ID предмета. Обнови каталог.",
      "unknown-currency": "Неизвестная валюта.",
      "maintenance-mode": "Сервис временно находится на техническом обслуживании.",
      cooldown: "Ежедневный бонус пока недоступен."
    };
    throw Object.assign(new Error(messages[data.error] || data.error || response.statusText), {
      status: response.status,
      data,
    });
  }
  return data;
}

async function req(path, { method = "GET", body } = {}) {
  const token = localStorage.getItem("auth_token");
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return parseResponse(response);
}

async function upload(path, file) {
  const token = localStorage.getItem("auth_token");
  const body = new FormData();
  body.append("image", file);
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  });
  return parseResponse(response);
}

const assetUrl = (imageUrl) => {
  if (typeof imageUrl !== "string" || !imageUrl) return "";
  const normalizedUrl = imageUrl.startsWith("/") ? imageUrl : `/${imageUrl}`;
  if (!/^\/uploads\/catalog\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}\.(?:jpe?g|png|webp)$/i.test(normalizedUrl)) {
    return "";
  }
  return API_URL ? new URL(normalizedUrl, API_URL).toString() : normalizedUrl;
};

export const api = {
  assetUrl,

  // Authentication
  register: (payload) => req("/api/auth/register", { method: "POST", body: payload }),
  checkEmail: (email) => req("/api/auth/check-email", { method: "POST", body: { email } }),
  login: (username, password) => req("/api/auth/login", { method: "POST", body: { username, password } }),
  me: () => req("/api/auth/me"),
  logout: () => req("/api/auth/logout", { method: "POST" }),
  deleteAccount: async () => {
    const result = await req("/api/auth/me", { method: "DELETE" });
    expireSession();
    return result;
  },
  requestPasswordReset: (email) => req("/api/auth/password-reset/request", { method: "POST", body: { email } }),
  submitSupportRequest: (payload) => req("/api/support", { method: "POST", body: payload }),
  completePasswordReset: async (token, password, passwordConfirm) => {
    const result = await req("/api/auth/password-reset/complete", {
      method: "POST",
      body: { token, password, passwordConfirm },
    });
    expireSession();
    return result;
  },

  // Profile
  updateProfile: (patch) => req("/api/me", { method: "PATCH", body: patch }),

  // Matches
  matchHistory: (page = 1) => req(`/api/matches?page=${page}`),
  matchStats: (roomId) => req(`/api/matches/${encodeURIComponent(roomId)}`),
  matchFull: (id) => req(`/api/matches/by-id/${id}/full`),

  // Leaderboard
  leaderboard: (sortBy = "rating") => req(`/api/leaderboard?sortBy=${encodeURIComponent(sortBy)}`),
  myRank: (sortBy = "rating") => req(`/api/leaderboard/me?sortBy=${encodeURIComponent(sortBy)}`),

  // Tournaments
  tournaments: () => req("/api/tournaments"),
  tournament: (id) => req(`/api/tournaments/${encodeURIComponent(id)}`),
  createTournament: (payload) => req("/api/tournaments", {
    method: "POST",
    body: typeof payload === "string" ? { title: payload } : payload,
  }),
  updateTournament: (id, payload) => req(`/api/tournaments/${encodeURIComponent(id)}`, { method: "PATCH", body: payload }),
  registerTournament: (id, expectedEntryFeeCoins) => req(`/api/tournaments/${encodeURIComponent(id)}/register`, { method: "POST", body: { expectedEntryFeeCoins } }),
  cancelTournamentRegistration: (id) => req(`/api/tournaments/${encodeURIComponent(id)}/register`, { method: "DELETE" }),
  tournamentMatchFull: (roomId) => req(`/api/tournaments/rooms/${encodeURIComponent(roomId)}/full`),
  startTournament: (id) => req(`/api/tournaments/${encodeURIComponent(id)}/start`, { method: "POST", body: {} }),

  // Public system mode and shop catalog
  systemStatus: () => req("/api/system/status"),
  coinPackages: () => req("/api/shop/coin-packages"),
  createRobokassaPayment: (packageId, expectedPrice) => req("/api/robokassa/create-payment", {
    method: "POST",
    body: { packageId, expectedPrice },
  }),
  createVoltPlusPayment: (expectedPrice) => req("/api/robokassa/create-plus-payment", {
    method: "POST",
    body: { expectedPrice },
  }),
  themeCatalog: () => req("/api/shop/catalog"),
  buyTheme: (itemId, currencyType) => req("/api/shop/themes", { method: "POST", body: { itemId, currencyType } }),
  avatarCatalog: () => req("/api/shop/avatars"),
  buyAvatar: (itemId, currencyType = "coins") => req("/api/shop/avatars", { method: "POST", body: { itemId, currencyType } }),
  collectDaily: () => req("/api/shop/daily", { method: "POST" }),

  // Admin panel
  adminMe: () => req(`${ADMIN_API}/me`),
  adminSystemSettings: () => req(`${ADMIN_API}/settings`),
  updateAdminSystemSettings: (payload) => req(`${ADMIN_API}/settings`, { method: "PATCH", body: payload }),
  adminMetrics: () => req(`${ADMIN_API}/metrics`),
  adminMailingPreview: () => req(`${ADMIN_API}/mailings/preview`),
  createAdminMailing: (payload) => req(`${ADMIN_API}/mailings`, { method: "POST", body: payload }),
  adminMailingCampaign: (id) => req(`${ADMIN_API}/mailings/${encodeURIComponent(id)}`),
  adminTournaments: () => req(`${ADMIN_API}/tournaments`),
  updateAdminTournament: (id, payload) => req(`${ADMIN_API}/tournaments/${encodeURIComponent(id)}`, { method: "PATCH", body: payload }),
  deleteAdminTournament: (id) => req(`${ADMIN_API}/tournaments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  adminCatalog: (category) => req(`${ADMIN_API}/catalog${category ? `?category=${encodeURIComponent(category)}` : ""}`),
  createCatalogItem: (payload) => req(`${ADMIN_API}/catalog/items`, { method: "POST", body: payload }),
  updateCatalogItem: (category, key, payload) => req(`${ADMIN_API}/catalog/items/${encodeURIComponent(category)}/${encodeURIComponent(key)}`, { method: "PATCH", body: payload }),
  archiveCatalogItem: (category, key) => req(`${ADMIN_API}/catalog/items/${encodeURIComponent(category)}/${encodeURIComponent(key)}`, { method: "DELETE" }),
  uploadCatalogImage: (file) => upload(`${ADMIN_API}/catalog/upload`, file),

};

export default api;
