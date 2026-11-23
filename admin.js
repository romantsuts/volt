import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { Router } from "express";
import { Sequelize } from "sequelize";
import { User } from "../db/db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireTournamentAdmin, isTournamentAdmin } from "../tournaments/admin.js";
import { archiveCatalogItem, createCatalogItem, listCatalogItems, updateCatalogItem, CatalogError } from "../catalog/service.js";
import { CatalogItem } from "../catalog/models.js";
import { catalogUploadDir, ensureCatalogUploadDir } from "../catalog/storage.js";
import { deleteTournament, getTournamentList, updateTournamentSettings, TournamentError } from "../tournaments/service.js";
import { getSystemSettings, updateSystemSettings, SystemSettingsError } from "../services/systemSettings.js";
import { getAdminMetrics } from "../services/adminMetrics.js";
import {
    AdminMailingError,
    createMailingCampaign,
    getMailingCampaign,
    getMailingRecipientPreview,
} from "../services/adminMailings.js";

const router = Router();
const allowedMimeTypes = new Map([
    ["image/jpeg", ".jpg"],
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["image/svg+xml", ".svg"]
]);

const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, catalogUploadDir),
    filename: (_req, file, callback) => callback(null, `${randomUUID()}${allowedMimeTypes.get(file.mimetype) || ".bin"}`),
});
const upload = multer({
    storage,
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
        if (!allowedMimeTypes.has(file.mimetype)) return callback(new Error("Разрешены только JPEG, PNG, SVG и WebP."));
        callback(null, true);
    },
});

const runUpload = (req, res, next) => {
    ensureCatalogUploadDir()
        .then(() => upload.single("image")(req, res, (error) => {
            if (!error) return next();
            const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
            return res.status(status).json({ error: error.message || "Не удалось загрузить файл." });
        }))
        .catch(next);
};

const isRealImage = async (filePath, mimeType) => {
    const handle = await readFile(filePath);
    if (mimeType === "image/jpeg") return handle[0] === 0xff && handle[1] === 0xd8 && handle[2] === 0xff;
    if (mimeType === "image/png") return handle.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (mimeType === "image/webp") return handle.toString("ascii", 0, 4) === "RIFF" && handle.toString("ascii", 8, 12) === "WEBP";
    if (mimeType === "image/svg+xml") {
        const content = handle.toString("utf8").trim();
        return content.startsWith("<svg") || content.startsWith("<?xml");
    }
    return false;
};

const cleanupUnreferencedUpload = async (imageUrl) => {
    const prefix = "/uploads/catalog/";
    if (typeof imageUrl !== "string" || !imageUrl.startsWith(prefix)) return;
    const filename = imageUrl.slice(prefix.length);
    if (!filename || filename !== path.basename(filename)) return;
    const filePath = path.resolve(catalogUploadDir, filename);
    if (path.dirname(filePath) !== path.resolve(catalogUploadDir)) return;

    try {
        const [catalogReferences, profileReferences] = await Promise.all([
            CatalogItem.count({ where: { imageUrl } }),
            User.count({
                where: Sequelize.where(Sequelize.json("profileSettings.avatarImageUrl"), imageUrl),
            }),
        ]);
        if (catalogReferences > 0 || profileReferences > 0) return;
        await unlink(filePath).catch((error) => {
            if (error.code !== "ENOENT") throw error;
        });
    } catch (error) {
        // The catalog update should succeed even if an orphaned file cannot be cleaned up.
        console.warn("Не удалось безопасно удалить неиспользуемое фото каталога:", error);
    }
};

const respondError = (res, error) => {
    if (error instanceof CatalogError || error instanceof TournamentError || error instanceof SystemSettingsError || error instanceof AdminMailingError) {
        return res.status(error.status).json({ error: error.message });
    }
    console.error("Admin API error:", error);
    return res.status(500).json({ error: "Не удалось выполнить операцию в админ-панели." });
};

router.get("/me", requireAuth, (req, res) => {
    res.json({ isAdmin: isTournamentAdmin(req.user) });
});

router.get("/settings", requireAuth, requireTournamentAdmin, async (_req, res) => {
    try {
        return res.json({ settings: await getSystemSettings({ forceRefresh: true }) });
    } catch (error) {
        return respondError(res, error);
    }
});

router.patch("/settings", requireAuth, requireTournamentAdmin, async (req, res) => {
    try {
        const settings = await updateSystemSettings(req.body ?? {});
        return res.json({ settings });
    } catch (error) {
        return respondError(res, error);
    }
});

router.get("/metrics", requireAuth, requireTournamentAdmin, async (_req, res) => {
    try {
        res.setHeader("Cache-Control", "no-store");
        return res.json({ metrics: await getAdminMetrics() });
    } catch (error) {
        return respondError(res, error);
    }
});

router.get("/mailings/preview", requireAuth, requireTournamentAdmin, async (_req, res) => {
    try {
        return res.json({ audience: await getMailingRecipientPreview() });
    } catch (error) {
        return respondError(res, error);
    }
});

router.post("/mailings", requireAuth, requireTournamentAdmin, async (req, res) => {
    try {
        const campaign = await createMailingCampaign({ ...(req.body ?? {}), createdBy: req.userId });
        return res.status(202).json({ campaign });
    } catch (error) {
        return respondError(res, error);
    }
});

router.get("/mailings/:id", requireAuth, requireTournamentAdmin, async (req, res) => {
    try {
        return res.json({ campaign: await getMailingCampaign(req.params.id) });
    } catch (error) {
        return respondError(res, error);
    }
});

router.get("/catalog", requireAuth, requireTournamentAdmin, async (req, res) => {
    try {
        const category = ["board", "avatar"].includes(req.query.category) ? req.query.category : undefined;
        res.json({ items: await listCatalogItems({ category, includeInactive: true }) });
    } catch (error) {
        respondError(res, error);
    }
});

router.post("/catalog/upload", requireAuth, requireTournamentAdmin, runUpload, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Выберите файл изображения." });
    try {
        const valid = await isRealImage(req.file.path, req.file.mimetype);
        if (!valid) {
            await unlink(req.file.path).catch(() => {});
            return res.status(415).json({ error: "Содержимое файла не соответствует JPEG, PNG, SVG или WebP." });
        }
        res.status(201).json({ imageUrl: `/uploads/catalog/${path.basename(req.file.filename)}` });
    } catch (error) {
        await unlink(req.file.path).catch(() => {});
        respondError(res, error);
    }
});

router.post("/catalog/items", requireAuth, requireTournamentAdmin, async (req, res) => {
    try {
        const item = await createCatalogItem(req.body ?? {});
        res.status(201).json({ item });
    } catch (error) {
        respondError(res, error);
    }
});

router.patch("/catalog/items/:category/:key", requireAuth, requireTournamentAdmin, async (req, res) => {
    try {
        const previous = await CatalogItem.findOne({
            where: { category: req.params.category, key: req.params.key },
            attributes: ["imageUrl"],
        });
        const previousImageUrl = previous?.imageUrl;
        const item = await updateCatalogItem(req.params.category, req.params.key, req.body ?? {});
        if (previousImageUrl && previousImageUrl !== item.imageUrl) {
            await cleanupUnreferencedUpload(previousImageUrl);
        }
        res.json({ item });
    } catch (error) {
        respondError(res, error);
    }
});

router.delete("/catalog/items/:category/:key", requireAuth, requireTournamentAdmin, async (req, res) => {
    try {
        await archiveCatalogItem(req.params.category, req.params.key);
        res.json({ ok: true });
    } catch (error) {
        respondError(res, error);
    }
});

router.get("/tournaments", requireAuth, requireTournamentAdmin, async (req, res) => {
    try {
        res.json({ tournaments: await getTournamentList(req.userId) });
    } catch (error) {
        respondError(res, error);
    }
});

router.patch("/tournaments/:id", requireAuth, requireTournamentAdmin, async (req, res) => {
    const tournamentId = Number(req.params.id);
    if (!Number.isSafeInteger(tournamentId) || tournamentId < 1) {
        return res.status(400).json({ error: "Некорректный ID турнира." });
    }
    try {
        const tournament = await updateTournamentSettings(tournamentId, req.body ?? {});
        req.app.get("io")?.to(`tournament:${tournamentId}`).emit("tournament:updated", { tournamentId });
        res.json({ tournament });
    } catch (error) {
        respondError(res, error);
    }
});

router.delete("/tournaments/:id", requireAuth, requireTournamentAdmin, async (req, res) => {
    const tournamentId = Number(req.params.id);
    if (!Number.isSafeInteger(tournamentId) || tournamentId < 1) {
        return res.status(400).json({ error: "Некорректный ID турнира." });
    }
    try {
        const result = await deleteTournament(tournamentId);
        req.app.get("io")?.to(`tournament:${tournamentId}`).emit("tournament:deleted", { tournamentId });
        res.json(result);
    } catch (error) {
        respondError(res, error);
    }
});

export default router;
