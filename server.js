import 'dotenv/config';
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { httpSecurity, ALLOWED_ORIGINS } from "./middleware/httpSecurity.js";
import { registerSocketAuth, attachSessionTracking } from "./sockets/middleware.js";
import { ADMIN_PATH } from './config/adminPath.js';

import { initDB, Payment, PendingPayment, User, sequelize } from "./db/db.js";
import { initServerWasm } from "./services/engine.js";

import { userProfiles, activeUsers, rooms, MAX_ACTIVE_ROOMS, MAX_ACTIVE_BOT_ROOMS } from './state/appState.js';
import nodemailer from "nodemailer";
import passwordResetRoutes from "./routes/passwordReset.js";
import supportRoutes from "./routes/support.js";

import { getBotUser, cleanupBotRoom, sweepBotState } from "./game/bot.js";
import { stopRoomTimers } from "./game/gameUtils.js";
import { initMatchReconciliation } from "./services/matchReconciliation.js";

import { MERCHANT_LOGIN, createPaymentData, checkPaymentSignature } from "./services/robokassa.js";
import { getCoinPackageById } from "./services/coinPackages.js";
import { deliverPaymentAlert, syncCachedCoins } from "./services/paymentNotifier.js";
import { syncSocketProfile } from "./services/profileSync.js";
import { toPublicProfile } from "./services/publicProfile.js";

import { getNextPlusMemberExpiry, VOLT_PLUS_TERM_DAYS } from "./services/voltPlus.js";
import { resolveToken } from "./services/authTokens.js";
import { sendPaymentCheck } from './services/mailer.js';

import { registerAllSocketHandlers } from "./sockets/index.js";
import { initAnalysisQueueEvents } from "./sockets/analysisHandlers.js";
import { initMatchmakingQueueDrain } from "./sockets/matchmakingHandlers.js";
// ROUTES
import authRoutes from "./routes/auth.js";
import meRoutes from "./routes/me.js";
import matchRoutes from "./routes/matches.js";
import leaderboardRoutes from "./routes/leaderboard.js";
import shopRoutes from "./routes/shop.js";
import tournamentRoutes from "./tournaments/routes.js";
import { initializeTournamentRedis, startDueTournaments, purgeExpiredTournamentArchives } from "./tournaments/service.js";
import { processTournamentCheckInDeadlines } from "./tournaments/socketHandlers.js";
import adminRoutes from "./routes/admin.js";
import systemRoutes from "./routes/system.js";
import { catalogUploadDir, ensureCatalogUploadDir } from "./catalog/storage.js";
import { getSystemSettings, initializeSystemSettings } from "./services/systemSettings.js";
import { startAdminMailingWorker } from "./services/adminMailings.js";
import { startAdminMetricsSampler, invalidateRevenueCache } from "./services/adminMetrics.js";
import { maintenanceApiGate } from "./middleware/maintenance.js";
import { apiLimiter } from "./middleware/httpSecurity.js";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173,http://192.168.1.73:5173";

const app = express();
app.use(httpSecurity);

// Отключает страницу-предупреждение Microsoft Dev Tunnels для сторонних вебхуков
app.use((req, res, next) => {
  res.setHeader("X-Tunnel-Skip-Anti-Phishing-Page", "true");
  next();
});

app.use(express.json());
// Keep support available during maintenance; it has its own strict rate limiter.
app.use("/api/support", supportRoutes);
app.use("/api", maintenanceApiGate);
app.use("/uploads/catalog", express.static(catalogUploadDir, {
  index: false,
  maxAge: "7d",
  immutable: true,
}));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api/system", systemRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/auth/password-reset", passwordResetRoutes);
app.use("/api", apiLimiter);
app.use("/api/me", meRoutes);
app.use("/api/matches", matchRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/shop", shopRoutes);
app.use("/api/tournaments", tournamentRoutes);
app.use("/api", (req, res) => {
    res.status(404).json({ error: "not-found" });
});
app.use(ADMIN_PATH, adminRoutes);
app.use(express.urlencoded({ extended: true }));

await initDB();
await initializeSystemSettings();
await initializeTournamentRedis();
await ensureCatalogUploadDir();
startAdminMailingWorker();
await getBotUser(); // создаем BOT
await initServerWasm();

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
     origin: ALLOWED_ORIGINS,
     methods: ["GET", "POST"],
     credentials: true
  },
});

app.set("io", io);

// C2: Engine.IO по умолчанию держит ссылку на первый HTTP-запрос сессии.
// Она нужна только для express-session / чтения socket.request.headers позже;
// у нас авторизация через socket.handshake.auth.token -> resolveToken() -> socket.data.
// Освобождаем объект, чтобы он не висел в памяти всё время жизни соединения.
io.engine.on("connection", (rawSocket) => {
  rawSocket.request = null;
});

// === РОБОКАССА ===

// Регистронезависимое чтение параметра (Робокасса может вернуть Shp_ / shp_)
const pick = (obj, name) => {
  const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? obj[key] : undefined;
};

// 1. Инициализация платежа. packageId выбирает пакет, expectedPrice служит только проверкой актуальности;
// сервер сам определяет сумму и количество монет, пользователь определяется по токену сессии.
app.post("/api/robokassa/create-payment", async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const userId = token ? await resolveToken(token) : null;
  if (!userId) return res.status(401).json({ error: "Требуется авторизация" });

  const pkg = await getCoinPackageById(req.body?.packageId);
  if (!pkg) return res.status(400).json({ error: "Неизвестный пакет" });
  if (req.body?.expectedPrice !== undefined && Number(req.body.expectedPrice) !== Number(pkg.price)) {
    return res.status(409).json({ error: "package-price-changed", currentPrice: pkg.price });
  }

  try {
    const invId = await sequelize.transaction(async (transaction) => {
      // Lock the user row so account deletion and payment creation cannot race.
      const user = await User.findByPk(userId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!user || user.profileSettings?.accountDeleted) {
        const error = new Error("Authenticated account is no longer active.");
        error.code = "SESSION_EXPIRED";
        throw error;
      }

      const newInvId = Date.now(); // числовой уникальный номер счёта, генерируется на сервере
      await PendingPayment.create({
        invId: newInvId,
        userId,
        amountCoins: pkg.coins,
        priceRub: pkg.price,
      }, { transaction });
      return newInvId;
    });

    return res.json(createPaymentData(pkg.price, invId, userId));
  } catch (error) {
    if (error.code === "SESSION_EXPIRED") {
      return res.status(401).json({ error: "session-expired" });
    }
    console.error("Ошибка при создании отложенного платежа в БД:", error);
    return res.status(500).json({ error: "Ошибка сервера при инициализации платежа" });
  }
});

// Volt Plus: отдельный счёт фиксирует цену из системных настроек на момент создания.
app.post("/api/robokassa/create-plus-payment", async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const userId = token ? await resolveToken(token) : null;
  if (!userId) return res.status(401).json({ error: "Требуется авторизация" });

  try {
    const settings = await getSystemSettings({ forceRefresh: true });
    const price = Number(settings.plusPriceRub);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(503).json({ error: "volt-plus-not-configured" });
    }
    if (req.body?.expectedPrice !== undefined) {
      const expectedPrice = Number(req.body.expectedPrice);
      if (!Number.isFinite(expectedPrice) || Math.abs(expectedPrice - price) > 0.001) {
        return res.status(409).json({ error: "plus-price-changed", currentPrice: price });
      }
    }

    const invId = await sequelize.transaction(async (transaction) => {
      const user = await User.findByPk(userId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!user || user.profileSettings?.accountDeleted) {
        const error = new Error("Authenticated account is no longer active.");
        error.code = "SESSION_EXPIRED";
        throw error;
      }
      let newInvId = Date.now();
      while (
        await PendingPayment.findByPk(newInvId, { transaction }) ||
        await Payment.findByPk(newInvId, { transaction })
      ) newInvId += 1;

      await PendingPayment.create({
        invId: newInvId,
        userId,
        amountCoins: 0,
        priceRub: price,
        paymentType: "volt_plus",
      }, { transaction });
      return newInvId;
    });

    return res.json(createPaymentData(price, invId, userId, `Volt Plus ${VOLT_PLUS_TERM_DAYS} days`));
  } catch (error) {
    if (error.code === "SESSION_EXPIRED") return res.status(401).json({ error: "session-expired" });
    console.error("Ошибка при создании счёта Volt Plus:", error);
    return res.status(500).json({ error: "Не удалось создать платёж Volt Plus." });
  }
});

// 2. Result URL — серверное уведомление от Робокассы (POST или GET, зависит от настроек кабинета)
app.all("/api/robokassa/result", async (req, res) => {
  const params = { ...req.query, ...req.body };
  const OutSum = params.OutSum;
  const InvId = params.InvId;
  const SignatureValue = params.SignatureValue;
  const shpUserId = pick(params, "shp_userid");

  console.log(`[Robokassa] Уведомление: заказ №${InvId}, сумма ${OutSum}, пользователь ${shpUserId}`);

  if (!checkPaymentSignature(OutSum, InvId, SignatureValue, shpUserId)) {
    console.error("[Robokassa] ❌ Неверная подпись");
    return res.status(400).send("bad sign");
  }

  let credited = null;
  try {
    credited = await sequelize.transaction(async (t) => {
      if (await Payment.findByPk(InvId, { transaction: t })) return null; // уже обработан

      const pending = await PendingPayment.findByPk(InvId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!pending) return null;

      const lockedPrice = Number(pending.priceRub);
      const badUser = String(pending.userId) !== String(shpUserId);
      const badSum = !Number.isFinite(lockedPrice) || lockedPrice <= 0 || Math.abs(Number(OutSum) - lockedPrice) > 0.001;
      const paymentType = pending.paymentType || "coins";
      if (badUser || badSum || !["coins", "volt_plus"].includes(paymentType)) {
        const e = new Error(`Несоответствие платежа ${InvId}: user=${!badUser}, sum=${!badSum}, type=${paymentType}`);
        e.code = "BAD_PAYMENT";
        throw e;
      }

      const user = await User.findByPk(pending.userId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!user || user.profileSettings?.accountDeleted) {
        const e = new Error(`Платёж ${InvId} привязан к отсутствующему или удалённому аккаунту.`);
        e.code = "BAD_PAYMENT";
        throw e;
      }

      if (paymentType === "volt_plus") {
        await user.update({
          plusMember: true,
          plusMemberExpiresAt: getNextPlusMemberExpiry(user),
        }, { transaction: t });
      } else {
        const amountCoins = Number(pending.amountCoins);
        if (!Number.isSafeInteger(amountCoins) || amountCoins <= 0) {
          const e = new Error(`Некорректное количество монет в платеже ${InvId}.`);
          e.code = "BAD_PAYMENT";
          throw e;
        }
        await User.increment("coins", { by: amountCoins, where: { id: pending.userId }, transaction: t });
      }

      await Payment.create(
        { invId: InvId, merchantLogin: MERCHANT_LOGIN, outSum: parseFloat(OutSum), status: "paid" },
        { transaction: t }
      );

      await pending.destroy({ transaction: t });

      const updatedUser = await User.findByPk(pending.userId, { transaction: t });
      return {
        userId: pending.userId,
        paymentType,
        amountCoins: Number(pending.amountCoins) || 0,
        priceRub: lockedPrice,
        balance: updatedUser.coins,
        plusMemberExpiresAt: updatedUser.plusMemberExpiresAt,
        profile: toPublicProfile(updatedUser),
        orderId: InvId,
      };
    });
  } catch (err) {
    if (err.code === "BAD_PAYMENT") {
      console.error("[Robokassa]", err.message);
      return res.status(400).send("bad payment");
    }
    console.error("[DB Error] Ошибка транзакции:", err);
    // 500 → Робокасса повторит уведомление позже, платёж не потеряется
    return res.status(500).send("error");
  }

  // Транзакция закоммичена — теперь можно подтвердить Робокассе
  res.send(`OK${InvId}`);

  if (credited) {
    // Сбрасываем кэш поступлений сразу после успешного платежа
    invalidateRevenueCache();

    const { userId, paymentType, amountCoins, priceRub, balance, orderId, plusMemberExpiresAt, profile } = credited;
    if (paymentType === "volt_plus") {
      console.log(`[DB] ✅ Пользователь ${userId} активировал Volt Plus до ${plusMemberExpiresAt}. Платёж ${orderId} закрыт.`);
      syncSocketProfile(io, userId, profile);
      deliverPaymentAlert(io, userId, {
        paymentType,
        amountCoins: 0,
        orderId,
        balance,
        plusMember: true,
        plusMemberExpiresAt,
      }).catch((e) => console.error("[Payment] Ошибка доставки уведомления Volt Plus:", e));
    } else {
      console.log(`[DB] ✅ Пользователь ${userId} +${amountCoins} монет. Платёж ${orderId} закрыт.`);
      syncCachedCoins(userId, balance);
      deliverPaymentAlert(io, userId, { paymentType, amountCoins, orderId, balance }).catch((e) =>
        console.error("[Payment] Ошибка доставки уведомления:", e)
      );

    }

    // Email receipt for both coin packs and Volt Plus subscriptions.
    User.findByPk(userId).then((user) => sendPaymentCheck(
      user,
      orderId,
      amountCoins,
      balance,
      { paymentType, priceRub, plusMemberExpiresAt },
    )).catch((e) => console.error("[Payment] Не удалось отправить email-квитанцию:", e));
  } else {
    console.log(`[Robokassa] Платёж ${InvId} уже был обработан`);
  }
});

// 3. SuccessURL / FailURL — куда Робокасса возвращает браузер игрока.
// В кабинете укажите: http://<ваш-хост>/api/robokassa/success и /fail (метод любой).
// Здесь ничего не начисляем — только возвращаем игрока в приложение.
app.all("/api/robokassa/success", (req, res) => res.redirect(303, `${FRONTEND_URL}/?payment=success`));
app.all("/api/robokassa/fail", (req, res) => res.redirect(303, `${FRONTEND_URL}/?payment=fail`));

// === КОНЕЦ РОБОКАССЫ ===

initAnalysisQueueEvents(io);
initMatchmakingQueueDrain(io);

registerSocketAuth(io);

io.on("connection", (socket) => {
  attachSessionTracking(io, socket);
  registerAllSocketHandlers(io, socket);
});

startAdminMetricsSampler();

let tournamentSchedulerRunning = false;
const runTournamentScheduler = async () => {
  if (tournamentSchedulerRunning) return;
  tournamentSchedulerRunning = true;
  try {
    const startedTournamentIds = await startDueTournaments();
    for (const tournamentId of startedTournamentIds) {
      io.to(`tournament:${tournamentId}`).emit("tournament:updated", { tournamentId });
    }
    await processTournamentCheckInDeadlines(io);
  } catch (error) {
    console.error("Tournament scheduler error:", error);
  } finally {
    tournamentSchedulerRunning = false;
  }
};
setInterval(runTournamentScheduler, 5000).unref();
runTournamentScheduler();

const purgeTournamentArchiveRows = async () => {
  try {
    const deletedCount = await purgeExpiredTournamentArchives();
    if (deletedCount > 0) console.info(`[Tournament] Expired compact archive rows removed: ${deletedCount}`);
  } catch (error) {
    console.error("Tournament archive cleanup error:", error);
  }
};
purgeTournamentArchiveRows();
setInterval(purgeTournamentArchiveRows, 5 * 60 * 1000).unref();

// Раз в 10 минут вычищаем записи кэша, у которых уже нет живого сокета
// и которым больше часа. Защита на случай, если setTimeout из правки 2
// не сработал (рестарт процесса, исключение в хендлере).
setInterval(() => {
  for (const [socketId] of userProfiles.entries()) {
    if (!io.sockets.sockets.has(socketId)) {
      userProfiles.delete(socketId);
      activeUsers.delete(socketId);
    }
  }
}, 10 * 60 * 1000).unref();

// Раз в минуту вычищаем «залипшие» комнаты из rooms.
// Не трогаем живые матчи: удаляем только явно мёртвые состояния.
const ROOM_SWEEP_INTERVAL_MS = 60_000;
const ROOM_FINALIZATION_GRACE_MS = 5 * 60 * 1000;
const ROOM_ABANDONED_MS = 10 * 60 * 1000;
const roomFirstSeenAt = new Map();
const roomFinalizingSince = new Map();

function stopTimersOfRoom(room, roomId) {
  if (!room) return;
  stopRoomTimers(roomId); // реестр таймеров из gameUtils.js
  if (room.clocks) {
    clearInterval(room.clocks.interval);
    clearInterval(room.clocks.delayInterval);
    room.clocks.interval = null;
    room.clocks.delayInterval = null;
  }
  for (const key of ["roundTransitionTimer", "coinSettlementRetryTimer", "tournamentResultRetryTimer"]) {
    if (room[key]) {
      clearTimeout(room[key]);
      room[key] = null;
    }
  }
  for (const color of ["white", "black"]) {
    const timer = room.reconnectTimers?.[color]?.timer;
    if (timer) clearTimeout(timer);
  }
}

function sweepRooms() {
  const now = Date.now();

  for (const id of roomFirstSeenAt.keys()) if (!rooms.has(id)) roomFirstSeenAt.delete(id);
  for (const id of roomFinalizingSince.keys()) if (!rooms.has(id)) roomFinalizingSince.delete(id);

  // Редкие пути удаления комнаты, где cleanupBotRoom не вызвали (см. A2).
  sweepBotState(rooms);

  let removed = 0;
  for (const [roomId, room] of rooms.entries()) {
    if (!roomFirstSeenAt.has(roomId)) roomFirstSeenAt.set(roomId, now);
    const seenAt = roomFirstSeenAt.get(roomId);

    let reason = null;
    if (!room || room.status !== "active") {
      reason = "status";
    } else if (room.matchFinalizationStarted) {
      if (!roomFinalizingSince.has(roomId)) roomFinalizingSince.set(roomId, now);
      if (now - roomFinalizingSince.get(roomId) > ROOM_FINALIZATION_GRACE_MS) reason = "finalization-stuck";
    } else {
      roomFinalizingSince.delete(roomId);
      const hasLiveSocket = ["white", "black"].some((color) => {
        const sid = room.players?.[color]?.id;
        return Boolean(sid && io.sockets.sockets.has(sid));
      });
      const noReconnectTimers =
        !room.reconnectTimers?.white?.timer && !room.reconnectTimers?.black?.timer;
      if (!hasLiveSocket && noReconnectTimers && now - seenAt > ROOM_ABANDONED_MS) {
        reason = "abandoned";
      }
    }

    if (!reason) continue;

    stopTimersOfRoom(room, roomId);
    cleanupBotRoom(roomId);
    rooms.delete(roomId);
    roomFirstSeenAt.delete(roomId);
    roomFinalizingSince.delete(roomId);
    removed += 1;
    console.warn(`[Rooms sweep] Удалена комната ${roomId}: ${reason}`);
  }

  const maxExpectedRooms = MAX_ACTIVE_ROOMS + MAX_ACTIVE_BOT_ROOMS;
  if (rooms.size > maxExpectedRooms + 20) {
    console.warn(
      `[Rooms sweep] rooms.size=${rooms.size} > ${maxExpectedRooms + 20} ` +
      `(лимиты ${MAX_ACTIVE_ROOMS} + ${MAX_ACTIVE_BOT_ROOMS})`
    );
  }
  if (removed) console.info(`[Rooms sweep] Удалено комнат: ${removed}; осталось: ${rooms.size}`);
}
setInterval(sweepRooms, ROOM_SWEEP_INTERVAL_MS).unref();

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`Server listening on :${PORT}`));

// F1/F1c: reconciliation активных матчей ПОСЛЕ старта.
// По умолчанию report (read-only); запись в БД возможна только при
// MATCH_RECONCILIATION_MODE=enforce И MATCH_RECONCILIATION_APPLY=true.
// setImmediate — не задерживает listen; catch здесь + внутри модуля
// гарантируют, что проблема с БД/Redis не влияет на подключение игроков.
// Полностью отключается MATCH_RECONCILIATION_ENABLED=false.
if (process.env.MATCH_RECONCILIATION_ENABLED !== "false") {
  setImmediate(() => {
    initMatchReconciliation({ io }).catch((error) => {
      console.warn("[Reconciliation] skipped:", error?.message || error);
    });
  });
}