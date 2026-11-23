import { Router } from "express";
import { User } from "../db/db.js";
import { resolveToken } from "../services/authTokens.js";
import { getSystemSettings } from "../services/systemSettings.js";
import { isTournamentAdmin } from "../tournaments/admin.js";

const router = Router();

router.get("/status", async (req, res) => {
    try {
        const authorization = req.headers.authorization || "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
        const userId = token ? await resolveToken(token) : null;
        const [user, settings] = await Promise.all([
            userId ? User.findByPk(userId, { attributes: ["id", "role"] }) : Promise.resolve(null),
            getSystemSettings(),
        ]);
        console.log("asdjkfhalsdjkfh", user);
        
        res.setHeader("Cache-Control", "no-store");

        return res.json({
            dailyBonusCoins: settings.dailyBonusCoins,
            dailyBonusCooldownHours: settings.dailyBonusCooldownHours,
            plusDailyBonusCoins: settings.plusDailyBonusCoins,
            plusDailyBonusCooldownHours: settings.plusDailyBonusCooldownHours,
            plusPriceRub: settings.plusPriceRub,
            maintenanceEnabled: settings.maintenanceEnabled,
            maintenanceTitle: settings.maintenanceTitle,
            maintenanceMessage: settings.maintenanceMessage,
            maintenanceEta: settings.maintenanceEta,
            isAdmin: isTournamentAdmin(user),
        });
    } catch (error) {
        console.error("System status error:", error);
        return res.status(503).json({ error: "Не удалось загрузить настройки сервиса." });
    }
});

export default router;
