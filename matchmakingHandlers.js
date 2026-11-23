import { Op } from "sequelize";
import { User, Match } from "../db/db.js";
import redis from "../services/redisService.js";
import { getBotUser, createBotSocket, BOT_LEVELS } from "../game/bot.js";
import { createInitialBoard } from "../game/gameLogic.js";
import { rollStartDice, initProvablyFairSeeds } from "../game/diceService.js";
import { startTurnDelay, syncRedis } from "../game/gameUtils.js";
import {
  CoinMatchEconomyError,
  reserveCoinMatch,
  releaseCoinMatchReservation,
} from "../game/coinEconomy.js";
import { toPublicProfile } from "../services/publicProfile.js";
import { syncSocketProfile } from "../services/profileSync.js";
import {
  activeUsers,
  userProfiles,
  rooms,
  friendRooms,
  queues,
  removeFromQueue,
  createRoom,
  normalizeSettings,
  hasFreeRoomSlot,
  hasFreeBotRoomSlot,
  pendingMatches,
  MAX_ACTIVE_BOT_ROOMS,
  MAX_ACTIVE_ROOMS,
} from "../state/appState.js";
import { freshCube } from "../game/cube.js";
import { getSystemSettings } from "../services/systemSettings.js";
import { isTournamentAdmin } from "../tournaments/admin.js";

const QUEUE_DRAIN_INTERVAL_MS = 2000;
const SEARCH_TTL_MS = 2 * 60 * 1000; // 2 минут
const FRIEND_ROOM_TTL_MS = 5 * 60 * 1000; //5 минут
const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Снимает с поиска тех, кто ждёт дольше TTL, и сообщает им об этом.
 * queues — обычный объект с массивами (rating/coin), как в appState.js.
 */
export function expireStaleSearches(io) {
  const now = Date.now();

  Object.keys(queues).forEach((gameType) => {
    const queue = queues[gameType];
    if (!queue.length) return;

    const fresh = [];
    const expired = [];

    queue.forEach((entry) => {
      // записи без searchedAt (деплойнутые до этой правки) считаем протухшими — безопаснее
      if (now - (entry.searchedAt || 0) >= SEARCH_TTL_MS) expired.push(entry);
      else fresh.push(entry);
    });

    if (expired.length === 0) return;

    queues[gameType] = fresh; // переприсваиваем массив — так же делает removeFromQueue

    expired.forEach((p) => {
      io.sockets.sockets.get(p.socketId)?.emit("search-timeout", { waitedMs: SEARCH_TTL_MS });
    });

    console.log(`[Matchmaking] TTL: снял с поиска ${expired.length} игроков (${gameType})`);
  });
}

/**
 * Удаляет friend-коды, которые так и не были использованы за TTL.
 * friendRooms — Map<roomCode, { socketId, settings, createdAt }>
 */
export function expireStaleFriendRooms() {
  const now = Date.now();
  let removed = 0;

  friendRooms.forEach((data, roomCode) => {
    if (now - (data.createdAt || 0) >= FRIEND_ROOM_TTL_MS) {
      friendRooms.delete(roomCode);
      removed++;
    }
  });

  if (removed) console.log(`[FriendMode] TTL: удалил ${removed} неиспользованных кодов`);
}

async function publishCoinPlayerProfile(io, userId) {
  const user = await User.findByPk(userId);
  if (!user) return;
  syncSocketProfile(io, userId, toPublicProfile(user));
}

async function deleteActiveGameIfOwned(userId, roomId) {
  const key = `user:${userId}:active_game`;
  if (await redis.get(key) === roomId) await redis.del(key);
}

async function isBlockedByMaintenance(socket) {
  try {
    const settings = await getSystemSettings();
    if (!settings.maintenanceEnabled) return false;

    const userId = socket.data?.userId;
    const user = userId
      ? await User.findByPk(userId, { attributes: ["id", "role", "profileSettings"] })
      : null;
    if (isTournamentAdmin(user)) return false;

    socket.emit("error-msg", "Сервис временно находится на техническом обслуживании.");
    return true;
  } catch (error) {
    console.error("Unable to check maintenance before matchmaking:", error);
    socket.emit("error-msg", "Не удалось проверить доступность сервиса. Повторите попытку позже.");
    return true;
  }
}

/**
 * Создаёт комнату для двух игроков и стартует матч.
 * Раньше жила как вложенная функция внутри io.on("connection") в server.js —
 * здесь вынесена на верхний уровень модуля и принимает `io` первым параметром,
 * т.к. больше не имеет доступа к нему через замыкание.
 *
 * ВАЖНО: сюда попадают только пары, для которых уже подтверждено, что есть
 * свободный слот (см. tryStartOrQueue) — сама функция капасити не проверяет,
 * чтобы не дублировать проверку в двух местах (сразу и в drain-цикле).
 *
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket1 — тот, кто инициировал старт (нашёл соперника/зашёл по коду)
 * @param {{ socketId: string, username?: string, settings: object }} opponentData
 * @param {object} rawSettings
 */

/**
 * =============================
 * BOT MAKER
 * =============================
 */
async function startBotMatch(io, socket, raw = {}) {
  const human = userProfiles.get(socket.id);
  if (!human) return socket.emit("error-msg", "Сначала войдите в аккаунт");

  if (!hasFreeBotRoomSlot()) {
    return socket.emit(
      "error-msg",
      `Сейчас слишком много игр с ботом (лимит ${MAX_ACTIVE_BOT_ROOMS}). Попробуйте позже.`
    );
  }

  const alreadyPlaying = [...rooms.values()].some(
    (r) => r.status === "active" && [r.players.white.userId, r.players.black.userId].includes(human.userId)
  );
  if (alreadyPlaying) return socket.emit("error-msg", "У вас уже есть активная игра");

  const botLevel = BOT_LEVELS[raw.level] ? raw.level : "expert";
  const bot = await getBotUser(botLevel);
  // префикс "room_" обязателен: по нему disconnecting-хендлер находит игровые комнаты
  const roomId = `room_bot_${socket.id}_${Date.now()}`;
  const humanIsWhite = raw.color === "random" ? Math.random() < 0.5 : raw.color !== "black";
  const botSocket = createBotSocket(roomId);

  const settings = normalizeSettings({
    matchLength: raw.matchLength ?? 3,
    clockTime: raw.clockTime ?? 3,
    delaySeconds: raw.delaySeconds,
    gameType: "rating", // правила матча (Crawford, игра до N); ставки и ELO отключены флагом isBotGame
    bet: 0,
    isCubeGame: raw.isCubeGame ?? true
  });
  const pfState = initProvablyFairSeeds();

  const startRoll = rollStartDice(pfState);
  const board = createInitialBoard();

  const room = createRoom({
    roomId,
    mode: settings.gameType,
    socketWhite: humanIsWhite ? socket : botSocket,
    socketBlack: humanIsWhite ? botSocket : socket,
    isDouble: { value: 1, active: false, cubeOwner: null },
    gamePoints: { white: 0, black: 0 },
    settings,
    board,
    turn: startRoll.turn,
    dice: startRoll.dice,
    diceIsRolled: startRoll.diceIsRolled,
    profileWhite: humanIsWhite ? human : bot,
    profileBlack: humanIsWhite ? bot : human,
    whiteUserId: humanIsWhite ? human.userId : bot.userId,
    blackUserId: humanIsWhite ? bot.userId : human.userId,
    pfState, 
  });
  room.isBotGame = true;
  room.botColor = humanIsWhite ? "black" : "white";
  room.botLevel = botLevel;
  room.players[room.botColor].isBot = true;

  try {
    await redis.set(`user:${human.userId}:active_game`, roomId, "EX", 7200);
    await Match.create({
      roomId,
      whiteId: room.players.white.userId,
      blackId: room.players.black.userId,
      mode: "bot", // не "rating" — иначе analysisHandlers начислит ELO
      bet: 0,
      status: "playing",
      matchLength: settings.matchLength,
    });

    socket.join(roomId);
    rooms.set(roomId, room);
    const stateSaved = await syncRedis(roomId, room);
    if (!stateSaved) throw new Error("Не удалось сохранить начальное состояние игры с ботом в Redis.");
  } catch (err) {
    console.error("Ошибка создания матча с ботом:", err);
    rooms.delete(roomId);
    socket.leave(roomId);
    await Promise.allSettled([
      deleteActiveGameIfOwned(human.userId, roomId),
      redis.del(`match:${roomId}:state`),
      Match.update({ status: "abandoned" }, { where: { roomId, status: "playing" } }),
    ]);
    return socket.emit("error-msg", "Не удалось безопасно запустить игру. Попробуйте позже.");
  }

  const pub = (color) => {
    const p = room.players[color];
    return { userId: p.userId, name: p.name, color, avatar: p.avatar, avatarImageUrl: p.avatarImageUrl || null, avatarColor: p.avatarColor || "#22d3ee", rating: p.rating, plusMember: p.plusMember === true, isBot: !!p.isBot };
  };

  io.to(roomId).emit("game-started", {
    roomId,
    settings,
    board,
    turn: room.turn,
    dice: room.dice,
    diceIsRolled: room.diceIsRolled,
    gameClocks: room.clocks,
    isDouble: freshCube(),
    gamePoints: room.gamePoints,
    crawfordState: room.crawfordState,
    crawfordPlayer: room.crawfordPlayer,
    isCrawfordGame: room.isCrawfordGame,
    players: { white: pub("white"), black: pub("black") },
  });

  // Внутри startTurnDelay сработает хук бота (п. 2), если он ходит первым
  startTurnDelay(room, io, rooms, userProfiles);
}
// END OF BOT MAKER

async function startMatch(io, socket1, opponentData, rawSettings) {
  const roomId = `room_${opponentData.socketId}_${socket1.id}_${Date.now()}`;
  const socket2 = io.sockets.sockets.get(opponentData.socketId);
  const profile1 = userProfiles.get(socket1.id);
  const profile2 = userProfiles.get(opponentData.socketId);

  if (!profile1 || !profile2 || !socket2) {
    console.error("Ошибка: Один из игроков не имеет активного сокета или загруженного профиля.");
    socket1.emit("error-msg", "Ошибка инициализации профиля. Перезайдите в игру.");
    socket2?.emit("error-msg", "Ошибка инициализации профиля. Перезайдите в игру.");
    return;
  }

  socket1.join(roomId);
  socket2.join(roomId);

  const settings = normalizeSettings(rawSettings);
  const isCoinMatch = settings.gameType === "coin";
  let reservation = null;
  let coinReservationReleased = true;
  let room = null;
  let nonCoinMatchCreated = false;

  try {
    if (isCoinMatch) {
      reservation = await reserveCoinMatch({
        roomId,
        whiteId: profile1.userId,
        blackId: profile2.userId,
        bet: settings.bet,
        matchLength: settings.matchLength,
      });
      coinReservationReleased = false;
      settings.bet = reservation.bet;
      settings.tableLimitCoins = reservation.tableLimitCoins;
    }

    // 1. Генерируем сиды для новой комнаты
    const pfState = initProvablyFairSeeds();

    const startRoll = rollStartDice(pfState);
    const initialBoard = createInitialBoard();
    room = createRoom({
      roomId,
      mode: settings.gameType,
      socketWhite: socket1,
      socketBlack: socket2,
      isDouble: { value: 1, active: false, cubeOwner: null },
      gamePoints: { white: 0, black: 0 },
      settings,
      board: initialBoard,
      turn: startRoll.turn,
      dice: startRoll.dice,
      diceIsRolled: startRoll.diceIsRolled,
      profileWhite: profile1,
      profileBlack: profile2,
      whiteUserId: profile1.userId,
      blackUserId: profile2.userId,
      pfState, 
    });
    if (isCoinMatch) room.coinReservationStatus = "reserved";

    if (!isCoinMatch) {
      const activeCoinReservation = await Match.findOne({
        where: {
          mode: "coin",
          status: { [Op.in]: ["starting", "playing"] },
          coinReservationStatus: "reserved",
          [Op.or]: [
            { whiteId: { [Op.in]: [profile1.userId, profile2.userId] } },
            { blackId: { [Op.in]: [profile1.userId, profile2.userId] } },
          ],
        },
      });
      if (activeCoinReservation) {
        throw new CoinMatchEconomyError("Завершите текущий coin-матч до начала другой партии.");
      }
      await Match.create({
        roomId,
        whiteId: profile1.userId,
        blackId: profile2.userId,
        mode: settings.gameType,
        bet: settings.bet,
        status: "playing",
        matchLength: settings.matchLength,
      });
      nonCoinMatchCreated = true;
    }

    rooms.set(roomId, room);
    const stateSaved = await syncRedis(roomId, room);
    if (!stateSaved) throw new Error("Не удалось сохранить начальное состояние матча в Redis.");

    if (isCoinMatch) {
      await Promise.all([
        redis.set(`user:${profile1.userId}:active_game`, roomId),
        redis.set(`user:${profile2.userId}:active_game`, roomId),
      ]);
      const [activatedRows] = await Match.update(
        { status: "playing" },
        { where: { roomId, coinReservationStatus: "reserved", status: "starting" } }
      );
      if (Number(activatedRows) !== 1) throw new Error("Coin-матч не перешёл в активный статус.");
      await Promise.all([
        publishCoinPlayerProfile(io, profile1.userId),
        publishCoinPlayerProfile(io, profile2.userId),
      ]);
    } else {
      await Promise.all([
        redis.set(`user:${profile1.userId}:active_game`, roomId, "EX", 7200),
        redis.set(`user:${profile2.userId}:active_game`, roomId, "EX", 7200),
      ]);
    }

    console.log(`Матч ${roomId} успешно создан в PostgreSQL`);
  } catch (err) {
    console.error("Ошибка создания матча:", err);
    rooms.delete(roomId);
    await Promise.allSettled([
      deleteActiveGameIfOwned(profile1.userId, roomId),
      deleteActiveGameIfOwned(profile2.userId, roomId),
      redis.del(`match:${roomId}:state`),
    ]);

    if (isCoinMatch && reservation) {
      for (let attempt = 0; attempt < 3 && !coinReservationReleased; attempt += 1) {
        try {
          const releaseResult = await releaseCoinMatchReservation({ roomId, markAbandoned: true });
          coinReservationReleased = releaseResult.released || releaseResult.reason === "already-released";
          if (!coinReservationReleased) throw new Error(`Reservation release returned ${releaseResult.reason || "unknown status"}`);
        } catch (releaseError) {
          console.error("Не удалось вернуть резерв coin-матча после ошибки запуска:", releaseError);
          if (attempt < 2) await waitMs(500 * (attempt + 1));
        }
      }
      if (coinReservationReleased) {
        await Promise.allSettled([
          publishCoinPlayerProfile(io, profile1.userId),
          publishCoinPlayerProfile(io, profile2.userId),
        ]);
      }
    } else if (nonCoinMatchCreated) {
      await Match.update({ status: "abandoned" }, { where: { roomId } }).catch(() => {});
    }

    socket1.leave(roomId);
    socket2.leave(roomId);
    const message = err instanceof CoinMatchEconomyError
      ? err.message
      : isCoinMatch && reservation && !coinReservationReleased
        ? "Матч не запущен. Возврат резерва ещё выполняется; не начинайте новую игру, пока профиль не обновится."
        : isCoinMatch
          ? "Не удалось безопасно запустить coin-матч. Зарезервированные монеты возвращены."
          : "Ошибка сервера. Не удалось создать матч.";
    socket1.emit("error-msg", message);
    socket2.emit("error-msg", message);
    return;
  }

  io.to(roomId).emit("game-started", {
    roomId,
    settings,
    board: room.board,
    turn: room.turn,
    dice: room.dice,
    diceIsRolled: room.diceIsRolled,
    gameClocks: room.clocks,
    isDouble: freshCube(),
    gamePoints: room.gamePoints,
    crawfordState: room.crawfordState,
    crawfordPlayer: room.crawfordPlayer,
    isCrawfordGame: room.isCrawfordGame,
    players: {
      white: {
        userId: profile1.userId,
        name: profile1.username,
        color: "white",
        avatar: profile1.avatar,
        avatarImageUrl: profile1.avatarImageUrl || null,
        avatarColor: profile1.avatarColor || "#22d3ee",
        rating: profile1.rating,
        coins: profile1.coins,
        plusMember: profile1.plusMember === true
      },
      black: {
        userId: profile2.userId,
        name: profile2.username,
        color: "black",
        avatar: profile2.avatar,
        avatarImageUrl: profile2.avatarImageUrl || null,
        avatarColor: profile2.avatarColor || "#22d3ee",
        rating: profile2.rating,
        coins: profile2.coins,
        plusMember: profile2.plusMember === true
      },
    },
  });

  startTurnDelay(room, io, rooms, userProfiles);
  console.log(`Комната создана: ${roomId}`, room.settings);
}

function tryStartOrQueue(io, socket1, opponentData, settings) {
  if (hasFreeRoomSlot()) {
    startMatch(io, socket1, opponentData, settings);
    return;
  }

  pendingMatches.push({ socket1Id: socket1.id, opponentData, settings });
  const position = pendingMatches.length;

  const payload = {
    position,
    activeGames: rooms.size,
    maxGames: MAX_ACTIVE_ROOMS,
  };
  socket1.emit("waiting-for-slot", payload);

  const socket2 = io.sockets.sockets.get(opponentData.socketId);
  if (socket2) socket2.emit("waiting-for-slot", payload);

  console.log(
    `[Capacity] Соперник найден, но столов нет (${rooms.size}/${MAX_ACTIVE_ROOMS}). ` +
      `Пара встала в очередь ожидания, позиция ${position}.`
  );
}

/**
 * Разбирает pendingMatches по мере освобождения мест в rooms.
 * Вызывается периодически — см. initMatchmakingQueueDrain.
 * @param {import('socket.io').Server} io
 */
function drainPendingMatches(io) {
  while (pendingMatches.length && hasFreeRoomSlot()) {
    const item = pendingMatches.shift();
    const socket1 = io.sockets.sockets.get(item.socket1Id);
    const socket2 = io.sockets.sockets.get(item.opponentData.socketId);

    if (!socket1 && !socket2) {
      // Оба уже отключились, пока ждали — просто пропускаем пару
      continue;
    }
    if (!socket1) {
      socket2?.emit("error-msg", "Соперник отключился, пока вы ждали свободный стол. Попробуйте поиск заново.");
      continue;
    }
    if (!socket2) {
      socket1.emit("error-msg", "Соперник отключился, пока вы ждали свободный стол. Попробуйте поиск заново.");
      continue;
    }

    startMatch(io, socket1, item.opponentData, item.settings);
  }

  // Обновляем позицию в очереди для тех, кто остался ждать
  if (pendingMatches.length) {
    pendingMatches.forEach((item, idx) => {
      const payload = { position: idx + 1, activeGames: rooms.size, maxGames: MAX_ACTIVE_ROOMS };
      io.sockets.sockets.get(item.socket1Id)?.emit("waiting-for-slot", payload);
      io.sockets.sockets.get(item.opponentData.socketId)?.emit("waiting-for-slot", payload);
    });
  }
}

/**
 * Запускает периодическую проверку очереди ожидания свободного стола.
 * Вызвать ОДИН РАЗ при старте сервера (как initAnalysisQueueEvents) —
 * не на каждое соединение.
 * @param {import('socket.io').Server} io
 */
export function initMatchmakingQueueDrain(io) {
  const timer = setInterval(() => {
    drainPendingMatches(io);
    expireStaleSearches(io);    // объект с массивами — io нужен для search-timeout
    expireStaleFriendRooms();   // Map — io не нужен
  }, QUEUE_DRAIN_INTERVAL_MS);
  timer.unref?.();
}

/**
 * Если игрок ушёл из pendingMatches (отменил поиск или отключился), пока пара
 * ждала свободный стол — сообщает второму участнику пары, что ждать больше
 * нечего. Без этого он молча висит на экране ожидания навсегда: событие
 * "waiting-for-slot" больше не придёт (пары в очереди больше нет), а сам он
 * никакого сигнала о разрыве не получает.
 *
 * @param {import('socket.io').Server} io
 * @param {Array} removedPending — то, что вернул removeFromQueue()
 * @param {string} leavingSocketId — кто ушёл (чтобы понять, кто "выживший")
 * @param {'cancelled' | 'disconnected'} reason
 */
export function notifyPendingPartnersOfRemoval(io, removedPending, leavingSocketId, reason = "disconnected") {
  const message =
    reason === "cancelled"
      ? "Соперник отменил поиск, пока вы ждали свободный стол. Попробуйте поиск заново."
      : "Соперник отключился, пока вы ждали свободный стол. Попробуйте поиск заново.";

  removedPending.forEach((pair) => {
    const survivorId = pair.socket1Id === leavingSocketId ? pair.opponentData.socketId : pair.socket1Id;
    io.sockets.sockets.get(survivorId)?.emit("error-msg", message);
  });
}

/**
 * Регистрирует socket-события матчмейкинга: поиск по рейтингу/монетам,
 * приватные комнаты по коду, старт матча.
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
export function registerMatchmakingHandlers(io, socket) {
  socket.on("cancel-search", () => {
    const removedPending = removeFromQueue(socket.id);
    notifyPendingPartnersOfRemoval(io, removedPending, socket.id, "cancelled");
  });

  // --- ЧАСТЬ А: СОЗДАЁМ ПРИВАТНУЮ КОМНАТУ (Friend Game) ---
  socket.on("create-friend-room", async (settings) => {
    if (await isBlockedByMaintenance(socket)) return;
    const username = activeUsers.get(socket.id) || "Guest";
    const code = String(settings.roomCode); // тот самый 4-значный код
    friendRooms.set(code, {
      socketId: socket.id,
      username,
      settings, // длина матча, время и т.д.
      createdAt: Date.now()
    });
    console.log(`[FriendMode] Код ${code} зарезервирован за ${username}`);
  });

  // --- ЧАСТЬ Б: ВХОД В ПРИВАТНУЮ КОМНАТУ (по коду) ---
  socket.on("join-friend-room", async ({ roomCode }) => {
    if (await isBlockedByMaintenance(socket)) return;
    const hostData = friendRooms.get(String(roomCode));
    console.log(hostData);
    
    if (hostData) {
      // Если код верный — удаляем его (использован единожды) и пробуем стартовать
      friendRooms.delete(roomCode);
      tryStartOrQueue(io, socket, hostData, hostData.settings);
    } else {
      socket.emit("error", "Код не найден или устарел.");
    }
  });

  // --- FIND GAME ---
  socket.on("find-game", async (settings) => {
    if (await isBlockedByMaintenance(socket)) return;
    const username = activeUsers.get(socket.id) || "Guest";
    const { gameType, bet, percent, playerCoins } = settings;

    // Базовая проверка: существует ли такой тип очереди
    if (!queues[gameType]) {
      return socket.emit("error", "Неверный тип игры");
    }

    // 1. Предварительная очистка: удаляем игрока из ВСЕХ очередей перед поиском —
    // это гарантирует отсутствие "двойников" и старых заявок
    removeFromQueue(socket.id);

    let opponentIndex = -1;

    // 2. Логика поиска
    if (gameType === "coin") {
      const baseBet = Number(bet);
      const profile = userProfiles.get(socket.id);
      if (!Number.isSafeInteger(baseBet) || baseBet <= 0 || !profile?.userId) {
        return socket.emit("error-msg", "Укажите корректную базовую ставку в монетах.");
      }
      let user;
      try {
        user = await User.findByPk(profile.userId, { attributes: ["id", "coins"] });
      } catch (error) {
        console.error("Не удалось проверить баланс перед поиском coin-матча:", error);
        return socket.emit("error-msg", "Не удалось проверить баланс. Повторите поиск позже.");
      }
      const actualBalance = Number(user?.coins);
      if (!user || !Number.isSafeInteger(actualBalance) || actualBalance < baseBet) {
        return socket.emit("error-msg", "Вашего баланса недостаточно для выбранной базовой ставки.");
      }
      settings.matchLength = 1;
      settings.clockTime = 90; // ИЗМЕНИТЬ
      settings.bet = baseBet;
      opponentIndex = queues.coin.findIndex((p) => Number(p.settings.bet) === baseBet && p.socketId !== socket.id);
    } else if (gameType === "rating") {
      opponentIndex = queues.rating.findIndex((p) => {
        const isSameParams = p.settings.matchLength === settings.matchLength && p.settings.clockTime === settings.clockTime;
        const isSamePercent = p.settings.percent === percent;
        return isSameParams && isSamePercent && p.socketId !== socket.id;
      });
    }

    // 3. Обработка результата
    if (opponentIndex !== -1) {
      // Вычеркиваем оппонента (используем прямой доступ к массиву)
      const opponentData = queues[gameType].splice(opponentIndex, 1)[0];

      if (gameType === "rating") {
        // COIN-РЕЖИМ НА ОБОИХ. СТАВКА:
        // Берем минимальный баланс среди двух игроков
        const minBalance = Math.min(playerCoins, opponentData.settings.playerCoins);
        // Итоговая ставка — N% от баланса самого "бедного" игрока
        const finalBet = Math.floor(minBalance * percent);
        console.log(`Матч! У игрока А: ${playerCoins}, у игрока Б: ${opponentData.settings.playerCoins}.`);
        console.log(`На риске ${settings.percent * 100}%. Итоговая ставка: ${finalBet}`);
        settings.bet = finalBet;
        opponentData.settings.bet = finalBet;
      }
      // Соперник найден — но старт матча теперь идёт через капасити-проверку
      tryStartOrQueue(io, socket, opponentData, settings);
    } else {
      // Добавляем в нужную очередь
      queues[gameType].push({ socketId: socket.id, username, settings, searchedAt: Date.now() });
      console.log(`[${gameType}] Игрок ${username} ждёт матч (Ставка: ${bet})`);
      socket.emit("waiting", { message: `Поиск оппонента в режиме ${gameType}...`, ttlMs: SEARCH_TTL_MS });
    }
  });

  // +++ BOT GAME +++
  socket.on("start-bot-game", async (settings) => {
    if (await isBlockedByMaintenance(socket)) return;
    startBotMatch(io, socket, settings).catch((err) => {
      console.error("start-bot-game error:", err);
      socket.emit("error-msg", "Не удалось начать игру с ботом");
    });
  });
}