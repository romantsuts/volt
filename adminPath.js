const raw = process.env.ADMIN_PATH || "/api/admin";
const normalized = raw.startsWith("/") ? raw : `/${raw}`;

export const ADMIN_PATH = normalized !== "/" ? normalized.replace(/\/+$/, "") : "/";

export const isAdminPath = (path) =>
  path === ADMIN_PATH || path.startsWith(`${ADMIN_PATH}/`);
