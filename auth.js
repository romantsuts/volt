// server/routes/auth.js
// REST-замена событий register / login / logout из authHandlers.js.
// Пароль и никнейм валидируются сервером до создания пользователя.

import { Router } from "express";
import bcrypt from "bcrypt";
import { randomBytes, randomUUID } from "node:crypto";
import { sequelize, User, PendingPayment } from "../db/db.js";
import { PasswordResetToken } from "../db/passwordResetToken.js";
import { issueToken, revokeToken, revokeUserTokens } from "../services/authTokens.js";
import { authLimiter } from "../middleware/httpSecurity.js";
import { requireAuth, profilePayload } from "../middleware/auth.js";
import { toPublicProfile } from "../services/publicProfile.js";
import { CatalogItem } from "../catalog/models.js";
import { getPasswordPolicyErrors } from "../services/passwordPolicy.js";
import { validateUsername } from "../services/usernamePolicy.js";
import { expireVoltPlusMembership, isPlusMemberActive } from "../services/voltPlus.js";
import { syncSocketProfile } from "../services/profileSync.js";

const router = Router();

function ratingBySkillLevel(skillLevel) {
  switch (skillLevel) {
    case "Новичок": return 1100;
    case "Любитель": return 1400;
    case "Профи": return 1700;
    default: return 1300;
  }
}

router.post("/check-email", authLimiter, async (req, res) => {
  const { email } = req.body ?? {};
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";

  if (!/^\S+@\S+\.\S+$/.test(normalized)) {
    return res.status(400).json({ error: "invalid-email", message: "Введите корректный адрес email" });
  }

  try {
    const exists = await User.findOne({ where: { email: normalized }, attributes: ["id"] });
    if (exists) {
      return res.status(409).json({ error: "email-taken", message: "Этот email уже зарегистрирован" });
    }
    return res.json({ available: true });
  } catch (err) {
    console.error("Ошибка проверки email:", err);
    return res.status(500).json({ error: "Не удалось проверить email" });
  }
});

router.post("/register", authLimiter, async (req, res) => {
  const { username, password, email, skillLevel, profile, acceptedPrivacy } = req.body ?? {};

  if (acceptedPrivacy !== true) {
    return res.status(400).json({ error: "Требуется согласие с политикой конфиденциальности" });
  }

  const usernameResult = validateUsername(username);
  if (!usernameResult.valid) {
    return res.status(400).json({
      error: usernameResult.code,
      message: usernameResult.error,
    });
  }
  const normalizedUsername = usernameResult.value;

  const passwordErrors = getPasswordPolicyErrors(password);
  if (passwordErrors.length) {
    return res.status(400).json({
      error: "weak-password",
      message: passwordErrors.join(" "),
      requirements: passwordErrors,
    });
  }

  // Сохраняем прежнее поведение: email необязателен в API, но если передан — валидируется.
  if (email !== undefined && email !== null && email !== "" &&
      !/^\S+@\S+\.\S+$/.test(String(email).trim())) {
    return res.status(400).json({ error: "Некорректный email" });
  }
  const normalizedEmail = typeof email === "string" && email.trim()
    ? email.trim().toLowerCase()
    : null;

  try {
    const exists = await User.findOne({ where: { username: normalizedUsername } });
    if (exists) return res.status(409).json({ error: "Имя пользователя уже занято" });

    if (normalizedEmail) {
      const emailTaken = await User.findOne({ where: { email: normalizedEmail }, attributes: ["id"] });
      if (emailTaken) {
        return res.status(409).json({ error: "email-taken", message: "Этот email уже зарегистрирован" });
      }
    }

    // Registration defaults are resolved from current active catalog rows, never from hard-coded assets.
    const [defaultAvatar, defaultBoard] = await Promise.all([
      CatalogItem.findOne({ where: { category: "avatar", key: "volt", isActive: true } }),
      CatalogItem.findOne({ where: { category: "board", key: "classic", isActive: true } }),
    ]);
    if (!defaultAvatar || !defaultBoard) {
      console.error("Регистрация невозможна: в каталоге БД нет активного аватара volt и/или доски classic.");
      return res.status(503).json({ error: "catalog-defaults-unavailable" });
    }

    const defaultAvatarId = Number(defaultAvatar.id);
    const defaultBoardId = Number(defaultBoard.id);
    const user = await User.create({
      username: normalizedUsername,
      password: await bcrypt.hash(password, 10),
      email: normalizedEmail,
      rating: ratingBySkillLevel(skillLevel),
      skillLevel,
      profileSettings: {
        avatarCatalogItemId: defaultAvatarId,
        avatarImageUrl: defaultAvatar.imageUrl || null,
        avatarColor: defaultAvatar.color || null,
        ownedAvatarCatalogItemIds: [defaultAvatarId],
        themeCatalogItemId: defaultBoardId,
        ownedThemeCatalogItemIds: [defaultBoardId],
        privacyAcceptedAt: new Date().toISOString(),
      },
    });

    const token = await issueToken(user.id);
    return res.status(201).json({ token, profile: toPublicProfile(user) });
  } catch (err) {
    if (err.name === "SequelizeUniqueConstraintError") {
      const field = err.errors?.[0]?.path;
      if (field === "email") {
        return res.status(409).json({ error: "email-taken", message: "Этот email уже зарегистрирован" });
      }
      if (field === "username") {
        return res.status(409).json({ error: "Имя пользователя уже занято" });
      }
    }
    console.error("Ошибка при регистрации:", err);
    return res.status(500).json({ error: "Не удалось зарегистрироваться" });
  }
});


router.post("/login", authLimiter, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Укажите имя пользователя и пароль" });
  }
  try {
    let user = await User.findOne({ where: { username } });
    const ok = user ? await bcrypt.compare(password, user.password) : false;
    if (!ok) return res.status(401).json({ error: "Неверное имя пользователя или пароль" });

    const expiredPlus = user.plusMember === true && !isPlusMemberActive(user);
    user = await expireVoltPlusMembership(user);
    if (expiredPlus) syncSocketProfile(req.app.get("io"), user.id, toPublicProfile(user));
    const token = await issueToken(user.id);
    return res.json({ token, profile: toPublicProfile(user) });
  } catch (err) {
    console.error("Ошибка авторизации:", err);
    return res.status(500).json({ error: "Ошибка авторизации" });
  }
});

router.get("/me", requireAuth, (req, res) => {
  return res.json({ profile: profilePayload(req.user) });
});

router.post("/logout", requireAuth, async (req, res) => {
  try {
    await revokeToken((req.headers.authorization || "").slice(7).trim());
  } catch (err) {
    console.error("Ошибка при отзыве токена:", err);
  }
  return res.status(204).end();
});

router.delete("/me", requireAuth, async (req, res) => {
  const userId = req.userId;
  const deletedAt = new Date().toISOString();

  try {
    const replacementUsername = `deleted-user-${userId}-${randomUUID()}`;
    const unusablePassword = await bcrypt.hash(randomBytes(32).toString("hex"), 10);

    await sequelize.transaction(async (transaction) => {
      const user = await User.findByPk(userId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!user || user.profileSettings?.accountDeleted) {
        const error = new Error("Account is already deleted or missing.");
        error.code = "ACCOUNT_NOT_FOUND";
        throw error;
      }

      const pendingPayments = await PendingPayment.count({
        where: { userId },
        transaction,
      });
      if (pendingPayments > 0) {
        const error = new Error("Account has pending payments.");
        error.code = "PENDING_PAYMENTS";
        throw error;
      }

      await PasswordResetToken.destroy({ where: { userId }, transaction });
      await user.update({
        username: replacementUsername,
        password: unusablePassword,
        email: null,
        coins: 0,
        vlt: 0,
        profileSettings: {
          accountDeleted: true,
          deletedAt,
          ownedAvatarCatalogItemIds: [],
          ownedThemeCatalogItemIds: [],
        },
      }, { transaction });
    });

    try {
      await revokeUserTokens(userId);
    } catch (tokenError) {
      console.error("Не удалось отозвать все Redis-сессии удалённого аккаунта:", tokenError);
    }
    req.app.get("io")?.in(`user:${userId}`).disconnectSockets(true);
    return res.status(204).end();
  } catch (err) {
    if (err.code === "PENDING_PAYMENTS") {
      return res.status(409).json({ error: "pending-payments" });
    }
    if (err.code === "ACCOUNT_NOT_FOUND") {
      return res.status(404).json({ error: "not-found" });
    }
    console.error("Ошибка при удалении аккаунта:", err);
    return res.status(500).json({ error: "Не удалось удалить аккаунт" });
  }
});

export default router;
