import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CircleHelp, Crown, LoaderCircle, Swords, Trophy } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "../context/AuthContext";
import { api } from "../services/api";
import { socketService } from "../services/socketService";
import BrandedConfirmModal from "../components/BrandedConfirmModal";

const statusLabels = {
    registration: "Регистрация",
    active: "Идёт турнир",
    completed: "Завершён",
};

const matchStatusLabels = {
    waiting: "Ожидает предыдущий раунд",
    ready: "Можно играть",
    playing: "Идёт матч",
    bye: "BYE · автоматический проход",
    completed: "Завершён",
};

const getRoundTitle = (roundNumber, roundCount) => {
    const roundsFromFinal = roundCount - roundNumber;
    if (roundsFromFinal === 0) return "Финал";
    if (roundsFromFinal === 1) return "Полуфинал";
    if (roundsFromFinal === 2) return "Четвертьфинал";
    return `Раунд ${roundNumber}`;
};

const getPlayerName = (player, fallback) => player?.username || fallback;

const formatCountdown = (scheduledAt, now) => {
    const remainingMinutes = Math.max(0, Math.ceil((new Date(scheduledAt).getTime() - now) / 60000));
    const days = Math.floor(remainingMinutes / 1440);
    const hours = Math.floor((remainingMinutes % 1440) / 60);
    const minutes = remainingMinutes % 60;
    return `${days} дн. ${hours} ч. ${minutes} мин.`;
};

const getScheduleStatus = (item, now) => {
    if (!item?.scheduledAt) return null;
    const date = new Date(item.scheduledAt);
    if (item.status !== "registration") return `Начало: ${date.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}`;
    if (date.getTime() > now) return `До автоматического старта: ${formatCountdown(item.scheduledAt, now)}`;
    if ((item.participantCount ?? 0) < 2) return "Время наступило — ждём минимум двух участников; регистрация остаётся открытой.";
    return "Время наступило — ожидается автоматический запуск сетки.";
};

const formatCheckInRemaining = (deadlineAt, now) => {
    const remainingSeconds = Math.max(0, Math.ceil((new Date(deadlineAt).getTime() - now) / 1000));
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export default function TournamentRoomScreen() {
    const { id } = useParams();
    const navigate = useNavigate();
    const ADMIN_ROUTE = import.meta.env.VITE_ADMIN_ROUTE || "/volt-panel";
    const { userProfile } = useAuth();
    const [tournaments, setTournaments] = useState([]);
    const [tournament, setTournament] = useState(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [activeMatchId, setActiveMatchId] = useState(null);
    const [waitingMatchId, setWaitingMatchId] = useState(null);
    const [waitingReason, setWaitingReason] = useState("");
    const [registrationConfirmOpen, setRegistrationConfirmOpen] = useState(false);
    const [registrationFeeChanged, setRegistrationFeeChanged] = useState(false);
    const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");
    const [clockNow, setClockNow] = useState(Date.now());
    const joinTimeoutRef = useRef(null);

    const load = useCallback(async ({ silent = false } = {}) => {
        if (!silent) setLoading(true);
        setError("");
        try {
            if (id) {
                const result = await api.tournament(id);
                setTournament(result.tournament);
                setIsAdmin(Boolean(result.isAdmin));
            } else {
                const result = await api.tournaments();
                setTournaments(result.tournaments || []);
                setIsAdmin(Boolean(result.isAdmin));
                setTournament(null);
            }
        } catch (loadError) {
            setError(loadError.message || "Не удалось загрузить турниры.");
        } finally {
            if (!silent) setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        if (id) return undefined;
        const timer = window.setInterval(() => load({ silent: true }), 15000);
        return () => window.clearInterval(timer);
    }, [id, load]);

    useEffect(() => {
        const socket = socketService.socket;
        const tournamentId = id ? Number(id) : null;

        const handleUpdated = (event) => {
            if (!tournamentId || String(event?.tournamentId) === String(tournamentId)) load();
        };
        const clearJoinTimeout = () => {
            if (joinTimeoutRef.current) {
                window.clearTimeout(joinTimeoutRef.current);
                joinTimeoutRef.current = null;
            }
        };
        const handleWaiting = (event) => {
            if (String(event?.tournamentId) === String(tournamentId)) {
                clearJoinTimeout();
                setBusy(false);
                setActiveMatchId(event.matchId);
                setWaitingMatchId(event.matchId);
                setWaitingReason(event.reason || "opponent");
                setNotice(event.reason === "capacity"
                    ? "Все игровые столы заняты. Повторите подключение, когда стол освободится."
                    : event.reason === "starting"
                        ? "Оба игрока подключились. Сервер готовит игровую комнату…"
                        : "Подключение принято. Ожидаем соперника; игровые часы пока не запущены.");
            }
        };
        const handleStarting = (event) => {
            if (String(event?.tournamentId) !== String(tournamentId)) return;
            setBusy(true);
            setActiveMatchId(event.matchId);
            setWaitingMatchId(null);
            setWaitingReason("");
            setNotice("Оба игрока подключились. Подготавливаем игровую комнату…");
            if (joinTimeoutRef.current) window.clearTimeout(joinTimeoutRef.current);
            joinTimeoutRef.current = window.setTimeout(() => {
                setBusy(false);
                setNotice("");
                setError("Сервер получил обоих игроков, но не отправил игровую комнату. Проверьте журнал сервера Redis/Socket.IO.");
                joinTimeoutRef.current = null;
            }, 30000);
        };
        const handleJoinError = (event) => {
            clearJoinTimeout();
            setNotice("");
            setWaitingMatchId(null);
            setWaitingReason("");
            setError(event?.error || "Не удалось войти в турнирную партию.");
            setBusy(false);
        };
        const openGame = (event) => {
            if (!event?.roomId || String(event.tournamentId) !== String(tournamentId)) return;
            clearJoinTimeout();
            setBusy(false);
            setWaitingMatchId(null);
            setWaitingReason("");
            sessionStorage.setItem("currentRoom", JSON.stringify({ ...event, tournamentId }));
            navigate(`/game/tournament/${event.roomId}`);
        };
        const openAvailableGame = (event) => {
            if (String(event?.tournamentId) !== String(tournamentId) || !event?.roomId) return;
            clearJoinTimeout();
            setBusy(false);
            setWaitingMatchId(null);
            setWaitingReason("");
            sessionStorage.setItem("currentRoom", JSON.stringify(event));
            navigate(`/game/tournament/${event.roomId}`);
        };

        const subscribeToTournament = () => {
            if (tournamentId) socket.emit("tournament:subscribe", { tournamentId });
        };
        subscribeToTournament();
        socket.on("connect", subscribeToTournament);
        socket.on("tournament:updated", handleUpdated);
        socket.on("tournament:waiting-for-opponent", handleWaiting);
        socket.on("tournament:starting-match", handleStarting);
        socket.on("tournament:join-error", handleJoinError);
        socket.on("tournament:game-available", openAvailableGame);
        socket.on("game-started", openGame);

        return () => {
            socket.off("connect", subscribeToTournament);
            socket.off("tournament:updated", handleUpdated);
            socket.off("tournament:waiting-for-opponent", handleWaiting);
            socket.off("tournament:starting-match", handleStarting);
            socket.off("tournament:join-error", handleJoinError);
            socket.off("tournament:game-available", openAvailableGame);
            socket.off("game-started", openGame);
            clearJoinTimeout();
            if (tournamentId) socket.emit("tournament:unsubscribe", { tournamentId });
        };
    }, [id, load, navigate]);

    const rounds = useMemo(() => {
        if (!tournament?.matches?.length) return [];
        const byRound = new Map();
        for (const match of tournament.matches) {
            if (!byRound.has(match.roundNumber)) byRound.set(match.roundNumber, []);
            byRound.get(match.roundNumber).push(match);
        }
        return [...byRound.entries()]
            .sort(([a], [b]) => a - b)
            .map(([roundNumber, matches]) => ({
                roundNumber,
                matches: matches.sort((a, b) => a.position - b.position),
            }));
    }, [tournament?.matches]);

    const handleRegister = async () => {
        if (!tournament) return;
        const confirmedFee = Number(tournament.entryFeeCoins) || 0;
        setBusy(true);
        setError("");
        try {
            const registration = await api.registerTournament(tournament.id, confirmedFee);
            setRegistrationConfirmOpen(false);
            setRegistrationFeeChanged(false);
            setNotice(registration.chargedCoins > 0
                ? `Вы зарегистрированы. Списано ${Number(registration.chargedCoins).toLocaleString("ru-RU")} монет.`
                : "Вы зарегистрированы на турнир.");
            await load();
        } catch (registerError) {
            let feeWasUpdated = false;
            if (registerError.status === 409) {
                try {
                    const latest = await api.tournament(tournament.id);
                    const latestTournament = latest?.tournament;
                    const latestFee = Number(latestTournament?.entryFeeCoins) || 0;
                    if (latestTournament?.status === "registration" && latestFee !== confirmedFee) {
                        setTournament(latestTournament);
                        setRegistrationFeeChanged(true);
                        setRegistrationConfirmOpen(true);
                        setError("");
                        feeWasUpdated = true;
                    }
                } catch {
                    feeWasUpdated = false;
                }
            }
            if (!feeWasUpdated) {
                setRegistrationConfirmOpen(false);
                setError(registerError.message || "Не удалось зарегистрироваться.");
            }
        } finally {
            setBusy(false);
        }
    };

    const handleCancelRegistration = async () => {
        if (!tournament) return;
        setBusy(true);
        setError("");
        try {
            await api.cancelTournamentRegistration(tournament.id);
            setCancelConfirmOpen(false);
            setNotice("Регистрация отменена, место освобождено. Уже списанный взнос не возвращается и не переходит в призовой пул.");
            await load();
        } catch (cancelError) {
            setCancelConfirmOpen(false);
            setError(cancelError.message || "Не удалось отменить регистрацию.");
        } finally {
            setBusy(false);
        }
    };

    const handleJoinMatch = (match) => {
        const socket = socketService.socket;
        setError("");
        setNotice("");
        if (!socket.connected) {
            setError("Нет соединения с игровым сервером. Подождите подключения и повторите попытку.");
            return;
        }
        setBusy(true);
        setActiveMatchId(match.id);
        setWaitingMatchId(null);
        setWaitingReason("");
        let serverAcknowledged = false;
        if (joinTimeoutRef.current) window.clearTimeout(joinTimeoutRef.current);
        joinTimeoutRef.current = window.setTimeout(() => {
            setBusy(false);
            setNotice("");
            setWaitingMatchId(null);
            setWaitingReason("");
            setError(serverAcknowledged
                ? "Сервер получил запрос, но не отправил игровую комнату. Нужна проверка серверного лога турнира."
                : "Socket.IO-сервер не подтвердил запрос tournament:join-match. Проверьте, что запущена обновлённая серверная версия и зарегистрирован обработчик турниров.");
            joinTimeoutRef.current = null;
        }, 10000);
        socket.emit("tournament:join-match", { matchId: match.id }, (response) => {
            if (response?.ok) {
                serverAcknowledged = true;
                return;
            }
            if (response?.error) {
                if (joinTimeoutRef.current) window.clearTimeout(joinTimeoutRef.current);
                joinTimeoutRef.current = null;
                setBusy(false);
                setError(response.error);
            }
        });
    };

    const currentUserId = userProfile?.userId;

    if (loading) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center text-cyan-200 gap-3">
                <LoaderCircle className="w-5 h-5 animate-spin" /> Загружаем турниры…
            </div>
        );
    }

    if (!id) {
        return (
            <motion.section 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col gap-6 text-slate-100 animate-fadeIn">
                <div className="glass-card rounded-3xl p-6 md:p-8 border border-cyan-400/20 relative overflow-hidden">
                    <div className="absolute -right-16 -top-20 w-72 h-72 rounded-full bg-cyan-400/10 blur-3xl pointer-events-none" />
                    <div className="relative flex flex-col md:flex-row md:items-end justify-between gap-5">
                        <div>
                            <div className="inline-flex items-center gap-2 text-cyan-300 text-xs font-mono uppercase tracking-widest mb-3">
                                <Swords className="w-4 h-4" /> Комната турниров
                            </div>
                            <h1 className="text-3xl md:text-4xl font-black text-white">Турниры</h1>
                            <p className="text-slate-400 mt-2 max-w-xl">Откройте турнир и нажмите «Принять участие». Для каждой пары проходит одна партия до выбранного количества очков; BYE автоматически переводит участника дальше.</p>
                        </div>
                        <div className="text-xs font-mono text-slate-400 flex items-center gap-2">
                            <Swords className="w-4 h-4 text-purple-300" />Случайная сетка
                        </div>
                    </div>
                </div>

                {isAdmin && (
                    <button onClick={() => navigate(`${ADMIN_ROUTE}?section=tournaments`)} className="self-start rounded-xl border border-cyan-300/25 bg-cyan-400/5 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-400/10">
                        Управлять турнирами в админ-панели
                    </button>
                )}

                {error && <div role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-rose-200">{error}</div>}
                {notice && <div role="status" className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-emerald-200">{notice}</div>}

                <div className="flex items-center justify-between">
                    <h2 className="text-xl font-bold text-white">Список турниров</h2>
                    <button onClick={load} className="text-xs font-mono text-cyan-300 hover:text-cyan-100">Обновить</button>
                </div>
                {tournaments.length === 0 ? (
                    <div className="glass-card rounded-2xl border border-white/10 p-8 text-center text-slate-400">Пока турниров нет.</div>
                ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {tournaments.map((item) => (
                            <button
                                key={item.id}
                                onClick={() => navigate(`/tournaments/${item.id}`)} 
                                className="glass-card rounded-2xl border border-white/10 hover:border-cyan-400/40 p-5 text-left transition-all"
                            >
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h3 className="text-lg font-bold text-white">{item.title}</h3>
                                        <p className="text-xs text-slate-400 mt-1">Организатор: {item.creator?.username || "администратор"}</p>
                                    </div>
                                    <span className="shrink-0 text-[10px] uppercase tracking-wider font-mono rounded-full px-3 py-1 border border-cyan-400/20 text-cyan-200 bg-cyan-400/5">
                                        {statusLabels[item.status] || item.status}
                                    </span>
                                </div>
                                <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-300">
                                    <span>Участников: {item.participantCount}{item.maxParticipants ? ` / ${item.maxParticipants}` : ""}</span>
                                    <span>Одна партия · до {item.matchLength} очков</span>
                                    <span>{Number(item.clockTime ?? 3).toLocaleString("ru-RU")} мин / игрок · delay {item.delaySeconds ?? 12} сек</span>
                                    <span>Взнос: {Number(item.entryFeeCoins ?? 0).toLocaleString("ru-RU")} монет</span>
                                    <span>Награда: {Number(item.rewardCoins ?? 0).toLocaleString("ru-RU")} монет</span>
                                    {item.isRegistered && <span className="text-emerald-300">Вы зарегистрированы</span>}
                                </div>
                                {item.scheduledAt && (
                                    <div className="mt-4 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.04] px-3 py-2 text-xs">
                                        <div className="text-slate-400">Запланировано: {new Date(item.scheduledAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}</div>
                                        <div className={`mt-1 font-semibold ${item.status === "registration" ? "text-cyan-200" : "text-slate-300"}`}>
                                            {getScheduleStatus(item, clockNow)}
                                        </div>
                                    </div>
                                )}
                            </button>
                        ))}
                    </div>
                )}
            </motion.section>
        );
    }

    if (!tournament) {
        return (
            <div className="glass-card rounded-2xl p-8 text-center text-slate-300">
                {error || "Турнир не найден."}
                <div className="mt-4"><button onClick={() => navigate("/tournaments")} className="text-cyan-300">К списку турниров</button></div>
            </div>
        );
    }

    const participant = tournament.participants?.find((entry) => String(entry.userId) === String(currentUserId));
    const participantCount = tournament.participantCount ?? tournament.participants?.length ?? 0;
    const isFull = tournament.maxParticipants !== null && tournament.maxParticipants !== undefined
        && participantCount >= tournament.maxParticipants;
    const finalRoundNumber = rounds.at(-1)?.roundNumber || 1;

    return (
        <section className="flex flex-col gap-5 text-slate-100">
            <button onClick={() => navigate("/tournaments")} className="inline-flex items-center gap-2 text-sm text-cyan-300 hover:text-cyan-100 self-start">
                <ArrowLeft className="w-4 h-4" /> Все турниры
            </button>

            <div className="glass-card rounded-3xl p-6 md:p-8 border border-cyan-400/20 relative overflow-hidden">
                <div className="absolute -right-20 -top-24 w-80 h-80 rounded-full bg-purple-500/10 blur-3xl pointer-events-none" />
                <div className="relative flex flex-col xl:flex-row xl:items-center justify-between gap-6">
                    <div>
                        <div className="flex flex-wrap items-center gap-3 mb-3">
                            <span className="text-xs font-mono uppercase tracking-widest text-cyan-300">Комната турниров</span>
                            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] uppercase tracking-wider font-mono text-slate-300">
                                {statusLabels[tournament.status] || tournament.status}
                            </span>
                        </div>
                        <h1 className="text-3xl md:text-4xl font-black text-white">{tournament.title}</h1>
                        <p className="text-slate-400 mt-2">
                            {participantCount}{tournament.maxParticipants ? ` / ${tournament.maxParticipants}` : ""} участников · одна партия до {tournament.matchLength} очков · {Number(tournament.clockTime ?? 3).toLocaleString("ru-RU")} мин на игрока · delay {tournament.delaySeconds ?? 12} сек.
                        </p>
                        <p className="mt-1 text-xs text-slate-500">Победитель пары проходит в следующий раунд; победитель финала становится чемпионом.</p>
                        <p className="mt-2 text-sm text-amber-100">Взнос: {Number(tournament.entryFeeCoins ?? 0).toLocaleString("ru-RU")} монет · фиксированная награда: {Number(tournament.rewardCoins ?? 0).toLocaleString("ru-RU")} монет.</p>
                        {tournament.status === "registration" && Number(tournament.entryFeeCoins) > 0 && <p className="mt-1 text-xs text-amber-200">Взнос списывается сразу при регистрации и не возвращается при отмене, неявке или выбывании.</p>}
                        {tournament.status !== "registration" && <p className="mt-1 text-xs text-slate-400">Собрано: {Number(tournament.prizePoolCoins ?? 0).toLocaleString("ru-RU")} монет · выплата победителю ограничена пулом и составляет {Number(tournament.prizeCoins ?? 0).toLocaleString("ru-RU")} монет{tournament.status === "completed" ? ` · системе удержано ${Number(tournament.systemRetainedCoins ?? 0).toLocaleString("ru-RU")} монет` : ""}.</p>}
                        {tournament.scheduledAt && (
                            <p className="mt-2 text-xs text-cyan-200">
                                {getScheduleStatus({ ...tournament, participantCount }, clockNow)}
                            </p>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        {tournament.status === "registration" && !tournament.isRegistered && !isFull && (
                            <button onClick={() => { setRegistrationFeeChanged(false); setRegistrationConfirmOpen(true); }} disabled={busy} className="rounded-xl px-5 py-3 bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-bold disabled:opacity-50">
                                Принять участие
                            </button>
                        )}
                        {tournament.status === "registration" && !tournament.isRegistered && isFull && (
                            <span className="rounded-xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-amber-100">Свободных мест нет</span>
                        )}
                        {tournament.isRegistered && tournament.status === "registration" && (
                            <>
                                <span className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-emerald-200">Вы зарегистрированы</span>
                                <button
                                    type="button"
                                    onClick={() => setCancelConfirmOpen(true)}
                                    disabled={busy}
                                    className="rounded-xl border border-rose-300/30 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/20 disabled:opacity-50"
                                >
                                    Отменить регистрацию
                                </button>
                            </>
                        )}
                        {isAdmin && <button onClick={() => navigate(`${ADMIN_ROUTE}?section=tournaments`)} className="rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-slate-200 hover:bg-white/10">Админ-панель</button>}
                    </div>
                </div>
            </div>

            {error && <div role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-rose-200">{error}</div>}
            {notice && <div role="status" className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-emerald-200">{notice}</div>}

            {tournament.champion && (
                <div className="rounded-2xl border border-amber-300/30 bg-amber-400/10 p-5 flex items-center gap-4 text-amber-100">
                    <Crown className="w-7 h-7 text-amber-300" />
                    <div><div className="text-xs uppercase tracking-widest font-mono text-amber-300">Победитель турнира</div><div className="text-xl font-bold">{tournament.champion.username}</div><div className="mt-1 text-xs text-amber-100">{tournament.prizePaidCoins != null ? `Фактически выплачено: ${Number(tournament.prizePaidCoins).toLocaleString("ru-RU")} монет` : "Фактическая выплата не подтверждена"}</div></div>
                </div>
            )}
            {tournament.status === "completed" && !tournament.champion && (
                <div className="rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-4 text-sm text-amber-100">
                    Турнир завершён без чемпиона: в финале не осталось участника, который мог бы получить титул. Награда не выплачена; системе/организатору удержано {Number(tournament.systemRetainedCoins ?? tournament.prizePoolCoins ?? 0).toLocaleString("ru-RU")} монет.
                </div>
            )}

            {tournament.status === "registration" && (
                <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-5">
                    <div className="glass-card rounded-2xl border border-white/10 p-5">
                        <h2 className="text-lg font-bold text-white mb-4">Зарегистрированные игроки</h2>
                        {tournament.participants?.length ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {tournament.participants.map((entry) => (
                                    <div key={entry.userId} className="rounded-xl bg-slate-950/40 border border-white/5 px-4 py-3 flex items-center justify-between gap-3">
                                        <span>{entry.user?.username || `Игрок ${entry.userId}`}</span>
                                        <span className="flex items-center gap-2 text-xs">
                                            {Number(entry.entryFeeCoins) > 0 && <span className={entry.paymentStatus === "paid" ? "text-emerald-300" : "text-amber-300"}>{entry.paymentStatus === "paid" ? "Взнос уплачен" : "Ожидает оплаты"}</span>}
                                            {String(entry.userId) === String(currentUserId) && <span className="text-cyan-300">Вы</span>}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ) : <p className="text-sm text-slate-400">Пока никто не зарегистрировался.</p>}
                    </div>
                    <div className="glass-card rounded-2xl border border-white/10 p-5 text-sm text-slate-300">
                        <div className="flex items-center gap-2 text-cyan-200 font-bold mb-2"><CircleHelp className="w-4 h-4" /> Как проходит турнир</div>
                        <p>В назначенное время сетка запускается, если зарегистрированы минимум два игрока; иначе регистрация остаётся открытой. Свободные места в сетке становятся BYE.</p>
                        <p className="mt-2">В каждой готовой паре оба игрока должны подключиться в течение 5 минут. Игровые часы стартуют только после подключения обоих; при неявке одного соперник проходит дальше, а при двойной неявке оба выбывают.</p>
                    </div>
                </div>
            )}

            {tournament.status !== "registration" && (
                <div className="glass-card rounded-2xl border border-white/10 p-5 md:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
                        <div>
                            <h2 className="text-xl font-bold text-white">Сетка турнира</h2>
                            <p className="text-xs text-slate-400 mt-1">Партии запускаются, когда оба игрока подключатся. Результаты сохраняются только в турнире.</p>
                        </div>
                        {participant && <span className="text-xs font-mono text-cyan-200">Ваш статус: {participant.status}</span>}
                    </div>
                    {rounds.length === 0 ? (
                        <p className="text-sm text-slate-400">Сетка ещё не сформирована.</p>
                    ) : (
                        <div className="overflow-x-auto pb-3">
                            <div className="grid gap-4 min-w-max" style={{ gridTemplateColumns: `repeat(${rounds.length}, minmax(260px, 1fr))` }}>
                                {rounds.map((round) => (
                                    <div key={round.roundNumber} className="flex flex-col gap-3">
                                        <h3 className="sticky top-0 text-sm font-bold text-cyan-200 bg-slate-950/80 backdrop-blur rounded-lg px-3 py-2">
                                            {getRoundTitle(round.roundNumber, finalRoundNumber)}
                                        </h3>
                                        {round.matches.map((match) => {
                                            const isPlayer = [match.playerAId, match.playerBId].some((playerId) => String(playerId) === String(currentUserId));
                                            const canPlay = isPlayer && ["ready", "playing"].includes(match.status);
                                            const playerAWon = match.winnerUserId != null && String(match.winnerUserId) === String(match.playerAId);
                                            const playerBWon = match.winnerUserId != null && String(match.winnerUserId) === String(match.playerBId);
                                            const emptySlotName = ["double-no-show", "empty-slot"].includes(match.forfeitReason) ? "BYE · пустой слот" : "Ожидает игрока";
                                            const playerAName = getPlayerName(match.playerA, match.status === "bye" ? "BYE" : emptySlotName);
                                            const playerBName = getPlayerName(match.playerB, match.status === "bye" || ["double-no-show", "empty-slot"].includes(match.forfeitReason) ? "BYE · пустой слот" : "Ожидает игрока");
                                            return (
                                                <article key={match.id} className={`rounded-xl border p-3 bg-slate-950/50 ${match.status === "completed" ? "border-emerald-400/20" : "border-white/10"}`}>
                                                    <div className="flex items-center justify-between gap-2 mb-2">
                                                        <span className="text-[10px] font-mono text-slate-500">Пара {match.position}</span>
                                                        <span className={`text-[10px] ${match.status === "completed" ? "text-emerald-300" : match.status === "playing" ? "text-amber-300" : "text-slate-400"}`}>
                                                            {matchStatusLabels[match.status] || match.status}
                                                        </span>
                                                    </div>
                                                    <div className={`flex justify-between gap-3 py-2 border-b border-white/5 ${playerAWon ? "text-emerald-200 font-bold" : "text-slate-200"}`}>
                                                        <span className="truncate">{playerAName}</span><span>{match.playerAScore ?? 0}</span>
                                                    </div>
                                                    <div className={`flex justify-between gap-3 py-2 ${playerBWon ? "text-emerald-200 font-bold" : "text-slate-200"}`}>
                                                        <span className="truncate">{playerBName}</span><span>{match.playerBScore ?? 0}</span>
                                                    </div>
                                                    {match.status === "ready" && match.checkInDeadlineAt && (
                                                        <div className="mt-2 rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-2.5 py-2 text-[10px] text-amber-100">
                                                            Подключитесь в течение 5 минут. {new Date(match.checkInDeadlineAt).getTime() <= clockNow
                                                                ? "Дедлайн истёк; сервер определяет результат по явке."
                                                                : `До дедлайна: ${formatCheckInRemaining(match.checkInDeadlineAt, clockNow)}`}
                                                        </div>
                                                    )}
                                                    {match.isForfeit && match.forfeitReason === "no-show" && (
                                                        <div className="mt-2 text-[10px] text-amber-200">Техническое поражение: соперник не подключился за 5 минут.</div>
                                                    )}
                                                    {match.isForfeit && match.forfeitReason === "double-no-show" && (
                                                        <div className="mt-2 text-[10px] text-amber-200">
                                                            Оба игрока не подключились за 5 минут. Оба выбыли; пустой слот передан дальше как BYE.
                                                        </div>
                                                    )}
                                                    {match.forfeitReason === "empty-slot" && (
                                                        <div className="mt-2 text-[10px] text-slate-400">Пустой слот после двойной неявки; он считается BYE.</div>
                                                    )}
                                                    {match.games?.length > 0 && (
                                                        <div className="mt-2 space-y-1.5">
                                                            <div className="text-[10px] font-semibold text-slate-400">Результат партии</div>
                                                            {match.games.map((game) => (
                                                                <button
                                                                    key={game.id || game.gameNumber}
                                                                    type="button"
                                                                    onClick={() => navigate(`/tournaments/${tournament.id}/matches/${match.id}/games/${game.gameNumber}`)}
                                                                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-2 text-left text-[10px] transition hover:border-cyan-300/25 hover:bg-cyan-300/5"
                                                                >
                                                                    <span className="text-slate-300">Игра {game.gameNumber}</span>
                                                                    <span className="font-mono font-bold text-white">{game.playerAScore}:{game.playerBScore}</span>
                                                                    <span className={game.isForfeit ? "text-amber-200" : "text-emerald-200"}>{game.isForfeit ? "Тех. поражение" : "Результат"}</span>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {match.status === "bye" && <div className="text-[10px] text-cyan-300 mt-1">Игрок прошёл дальше без партии</div>}
                                                    {canPlay && waitingMatchId === match.id && waitingReason !== "capacity" && (
                                                        <div role="status" className="mt-3 flex items-center gap-2 rounded-lg border border-cyan-300/25 bg-cyan-300/[0.06] px-3 py-2 text-xs font-semibold text-cyan-100">
                                                            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
                                                            {waitingReason === "starting" ? "Подключение… готовим игровую комнату" : "Ожидаем соперника… игровые часы не запущены"}
                                                        </div>
                                                    )}
                                                    {canPlay && waitingMatchId === match.id && waitingReason === "capacity" && (
                                                        <div className="mt-3 space-y-2">
                                                            <div className="rounded-lg border border-amber-300/20 bg-amber-300/[0.05] px-3 py-2 text-xs text-amber-100">Ожидаем свободный игровой стол.</div>
                                                            <button type="button" onClick={() => handleJoinMatch(match)} disabled={busy} className="w-full rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-white/5 disabled:opacity-60">Повторить подключение</button>
                                                        </div>
                                                    )}
                                                    {canPlay && waitingMatchId !== match.id && (
                                                        <button
                                                            onClick={() => handleJoinMatch(match)}
                                                            disabled={busy && activeMatchId === match.id}
                                                            className="mt-3 w-full rounded-lg bg-gradient-to-r from-cyan-500/80 to-purple-600/80 hover:from-cyan-400 hover:to-purple-500 px-3 py-2 text-xs font-bold text-white disabled:opacity-60"
                                                        >
                                                            {match.status === "playing" ? "Вернуться в партию" : busy && activeMatchId === match.id ? "Подключаемся…" : "Подключиться к игре"}
                                                        </button>
                                                    )}
                                                </article>
                                            );
                                        })}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            <BrandedConfirmModal
                open={registrationConfirmOpen}
                title="Подтвердить регистрацию?"
                confirmText="Списать и зарегистрироваться"
                cancelText="Отказаться"
                busy={busy}
                onClose={() => setRegistrationConfirmOpen(false)}
                onConfirm={handleRegister}
            >
                <p>
                    {Number(tournament.entryFeeCoins) > 0
                        ? <>При регистрации с баланса спишется ровно <strong className="text-white">{Number(tournament.entryFeeCoins).toLocaleString("ru-RU")} монет</strong>.</>
                        : "Участие бесплатное, списания не будет."}
                </p>
                {registrationFeeChanged && (
                    <p role="status" className="mt-3 rounded-xl border border-amber-300/25 bg-amber-300/[0.06] px-3 py-2 text-amber-100">Размер взноса изменился. Мы обновили сумму выше; подтвердите её ещё раз, чтобы продолжить.</p>
                )}
                {Number(tournament.entryFeeCoins) > 0 && (
                    <p className="mt-2 text-amber-200">Взнос списывается сразу и не возвращается. Если отменить регистрацию до старта, место освободится, но взнос не будет возвращён и не попадёт в призовой пул.</p>
                )}
                {userProfile?.coins != null && <p className="mt-2 text-xs text-slate-500">Текущий баланс: {Number(userProfile.coins).toLocaleString("ru-RU")} монет.</p>}
            </BrandedConfirmModal>

            <BrandedConfirmModal
                open={cancelConfirmOpen}
                title="Отменить регистрацию?"
                tone="danger"
                confirmText="Отменить без возврата"
                cancelText="Оставить регистрацию"
                busy={busy}
                onClose={() => setCancelConfirmOpen(false)}
                onConfirm={handleCancelRegistration}
            >
                <p>Место в сетке освободится, но уже списанный взнос <strong className="text-white">не возвращается</strong>, никому не перечисляется и не увеличивает призовой пул.</p>
                <p className="mt-2 text-amber-200">Если зарегистрироваться повторно, взнос будет списан заново. Отменить участие можно только пока открыт статус «Регистрация».</p>
            </BrandedConfirmModal>
        </section>
    );
}
