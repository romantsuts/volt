export const getTournamentAdminIds = () =>
    String(process.env.TOURNAMENT_ADMIN_IDS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

export const isTournamentAdmin = (userId) =>
    userId !== undefined &&
    userId !== null &&
    getTournamentAdminIds().includes(String(userId));

export const requireTournamentAdmin = (req, res, next) => {
    if (!isTournamentAdmin(req.userId)) {
        return res.status(403).json({ error: "admin-required" });
    }
    next();
};
