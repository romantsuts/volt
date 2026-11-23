import { createElement, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import NotFoundScreen from "./NotFoundScreen"; // путь подстрой: если NotFoundScreen в screens, то "./NotFoundScreen"

import {
  Activity,
  ArrowLeft,
  Check,
  Coins,
  Crown,
  ExternalLink,
  ImagePlus,
  LayoutDashboard,
  LoaderCircle,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Settings,
  Swords,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { api } from "../services/api";
import { useAuth } from "../context/AuthContext";
import BrandedConfirmModal from "../components/BrandedConfirmModal";
import AdminMonitoringPanel from "./AdminMonitoringPanel";
import AdminMailingPanel from "./AdminMailingPanel";

const sections = [
  { id: "tournaments", label: "Турниры", icon: Swords },
  { id: "boards", label: "Доски", icon: LayoutDashboard },
  { id: "avatars", label: "Аватары", icon: UserRound },
  { id: "monitoring", label: "Мониторинг", icon: Activity },
  { id: "mailing", label: "Рассылка", icon: Mail },
  { id: "settings", label: "Настройки системы", icon: Settings },
];

const tournamentStatuses = {
  registration: "Регистрация",
  active: "Идёт турнир",
  completed: "Завершён",
};

const toLocalDateTimeInput = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const toServerDateTime = (value) => value ? new Date(value).toISOString() : null;

const formatTournamentCountdown = (scheduledAt, now) => {
  const minutesLeft = Math.max(0, Math.ceil((new Date(scheduledAt).getTime() - now) / 60000));
  const days = Math.floor(minutesLeft / 1440);
  const hours = Math.floor((minutesLeft % 1440) / 60);
  const minutes = minutesLeft % 60;
  return `${days} дн. ${hours} ч. ${minutes} мин.`;
};

const getAdminScheduleStatus = (item, now) => {
  if (!item.scheduledAt) return "Время начала не задано";
  const scheduledAt = new Date(item.scheduledAt);
  if (item.status !== "registration") return `Начало: ${scheduledAt.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}`;
  if (scheduledAt.getTime() > now) return `До старта: ${formatTournamentCountdown(item.scheduledAt, now)}`;
  if ((item.participantCount ?? 0) < 2) return "Время прошло — ждём минимум двух участников, регистрация открыта";
  return "Время прошло — ожидается автоматический запуск";
};

const emptyCatalogForm = {
  key: "",
  name: "",
  description: "",
  imageUrl: "",
  priceCoins: "0",
  priceVlt: "0",
  plusMember: false,
  rarity: "common",
  color: "",
  boardColorGradient: ["", ""],
  triangles: ["", ""],
  checkers: { white: "", black: "" },
  isActive: true,
  sortOrder: "100",
};

// U1: вставка палитры доски одним блоком вместо шести отдельных полей.
const PALETTE_EXAMPLE = `boardColorGradient: ["#082f49", "#0c4a6e"],
triangles: ["#0284c7", "#115e59"], 
checkers: { white: "#7dd3fc", black: "#fb923c" }`;

const paletteToText = (source = {}) => {
  const gradient = Array.isArray(source.boardColorGradient) ? source.boardColorGradient : ["", ""];
  const triangles = Array.isArray(source.triangles) ? source.triangles : ["", ""];
  return [
    `boardColorGradient: ["${gradient[0] || ""}", "${gradient[1] || ""}"],`,
    "",
    `triangles: ["${triangles[0] || ""}", "${triangles[1] || ""}"],`,
    "",
    `checkers: { white: "${source.checkers?.white || ""}", black: "${source.checkers?.black || ""}" }`,
  ].join("\n");
};

// Принимает и «JS-вид» с ключами без кавычек, и валидный JSON. Без eval.
const parsePaletteText = (text) => {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .trim();
  if (!stripped) throw new Error("Вставьте палитру или нажмите «Взять из полей».");

  const wrapped = stripped.startsWith("{") ? stripped : `{ ${stripped} }`;
  const relaxed = wrapped
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/'([^']*)'/g, '"$1"');

  let parsed;
  try {
    parsed = JSON.parse(relaxed);
  } catch {
    throw new Error("Не удалось разобрать палитру. Проверьте скобки, запятые и кавычки.");
  }

  const isHex = (value) => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
  const readPair = (value, label) => {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(isHex)) {
      throw new Error(`${label}: нужно ровно два цвета в формате #RRGGBB.`);
    }
    return [...value];
  };
  const white = parsed.checkers?.white;
  const black = parsed.checkers?.black;
  if (!isHex(white) || !isHex(black)) {
    throw new Error("checkers: нужны white и black в формате #RRGGBB.");
  }

  return {
    boardColorGradient: readPair(parsed.boardColorGradient, "boardColorGradient"),
    triangles: readPair(parsed.triangles, "triangles"),
    checkers: { white, black },
  };
};

function Field({ label, hint, children }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-sm font-semibold text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

const inputClass = "w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 shadow-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100";
const buttonClass = "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

function Notice({ error, notice }) {
  if (!error && !notice) return null;
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${error ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`} role={error ? "alert" : "status"}>
      {error || notice}
    </div>
  );
}

function TournamentPanel({ tournaments, reload, onMessage, navigate }) {
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [startingId, setStartingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ title: "", scheduledAt: "", maxParticipants: "", matchLength: 3, clockTime: 3, delaySeconds: 12, entryFeeCoins: 0, rewardCoins: 0 });
  const [editForm, setEditForm] = useState(null);
  const [clockNow, setClockNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const updateForm = (field, value) => setForm((previous) => ({ ...previous, [field]: value }));

  const createTournament = async (event) => {
    event.preventDefault();
    setCreating(true);
    onMessage("", "");
    try {
      await api.createTournament({
        title: form.title.trim(),
        scheduledAt: toServerDateTime(form.scheduledAt),
        maxParticipants: form.maxParticipants === "" ? null : Number(form.maxParticipants),
        matchLength: Number(form.matchLength),
        clockTime: Number(form.clockTime),
        delaySeconds: Number(form.delaySeconds),
        entryFeeCoins: Number(form.entryFeeCoins),
        rewardCoins: Number(form.rewardCoins),
      });
      setForm({ title: "", scheduledAt: "", maxParticipants: "", matchLength: 3, clockTime: 3, delaySeconds: 12, entryFeeCoins: 0, rewardCoins: 0 });
      onMessage("", "Турнир создан. Пока он находится в статусе регистрации.");
      await reload();
    } catch (error) {
      onMessage(error.message || "Не удалось создать турнир.", "");
    } finally {
      setCreating(false);
    }
  };

  const beginEdit = (item) => {
    setEditingId(item.id);
    setEditForm({
      title: item.title || "",
      scheduledAt: toLocalDateTimeInput(item.scheduledAt),
      maxParticipants: item.maxParticipants ?? "",
      matchLength: item.matchLength || 3,
      clockTime: item.clockTime ?? 3,
      delaySeconds: item.delaySeconds ?? 12,
      entryFeeCoins: item.entryFeeCoins ?? 0,
      rewardCoins: item.rewardCoins ?? 0,
    });
  };

  const saveEdit = async (id) => {
    if (!editForm) return;
    if (!editForm.scheduledAt) {
      onMessage("Укажите дату и время начала турнира.", "");
      return;
    }
    setSavingId(id);
    onMessage("", "");
    try {
      await api.updateAdminTournament(id, {
        title: editForm.title.trim(),
        scheduledAt: toServerDateTime(editForm.scheduledAt),
        maxParticipants: editForm.maxParticipants === "" ? null : Number(editForm.maxParticipants),
        matchLength: Number(editForm.matchLength),
        clockTime: Number(editForm.clockTime),
        delaySeconds: Number(editForm.delaySeconds),
        entryFeeCoins: Number(editForm.entryFeeCoins),
        rewardCoins: Number(editForm.rewardCoins),
      });
      setEditingId(null);
      setEditForm(null);
      onMessage("", "Настройки турнира сохранены.");
      await reload();
    } catch (error) {
      onMessage(error.message || "Не удалось сохранить настройки.", "");
    } finally {
      setSavingId(null);
    }
  };

  const startTournament = async (item) => {
    setStartingId(item.id);
    onMessage("", "");
    try {
      await api.startTournament(item.id);
      onMessage("", "Турнир запущен. Случайная сетка и пары сформированы автоматически.");
      await reload();
      navigate(`/tournaments/${item.id}`);
    } catch (error) {
      onMessage(error.message || "Не удалось запустить турнир.", "");
    } finally {
      setStartingId(null);
    }
  };

  const deleteTournament = async () => {
    const item = deleteTarget;
    if (!item) return;
    setDeletingId(item.id);
    onMessage("", "");
    try {
      await api.deleteAdminTournament(item.id);
      setDeleteTarget(null);
      if (editingId === item.id) {
        setEditingId(null);
        setEditForm(null);
      }
      onMessage("", "Турнир удалён.");
      await reload();
    } catch (error) {
      setDeleteTarget(null);
      onMessage(error.message || "Не удалось удалить турнир.", "");
    } finally {
      setDeletingId(null);
    }
  };

  const settingFields = (value, onChange, { entryFeeLocked = false } = {}) => (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <Field label="Лимит участников" hint="Пустое поле — без лимита, максимум 256.">
        <input className={inputClass} type="number" min="2" max="256" step="1" value={value.maxParticipants} onChange={(event) => onChange("maxParticipants", event.target.value)} placeholder="Без лимита" />
      </Field>
      <Field label="Взнос за участие, монет" hint={entryFeeLocked ? "Зафиксирован после первой регистрации: взносы уже списаны." : "Списывается с баланса при регистрации; возврата нет."}>
        <input className={inputClass} type="number" min="0" max="100000000" step="1" required disabled={entryFeeLocked} value={value.entryFeeCoins} onChange={(event) => onChange("entryFeeCoins", event.target.value)} />
      </Field>
      <Field label="Приз победителю сверх банка, монет" hint="Банк = все взносы участников. Победитель получает банк + эту сумму; доплату берёт на себя система.">
        <input className={inputClass} type="number" min="0" max="100000000" step="1" required value={value.rewardCoins} onChange={(event) => onChange("rewardCoins", event.target.value)} />
      </Field>
      <Field label="Очков до победы в одной игре">
        <select className={inputClass} value={value.matchLength} onChange={(event) => onChange("matchLength", event.target.value)}>
          <option value={3}>До 3 очков</option>
          <option value={5}>До 5 очков</option>
          <option value={7}>До 7 очков</option>
          <option value={9}>До 9 очков</option>
          <option value={11}>До 11 очков</option>
        </select>
      </Field>
      <Field label="Время на игрока" hint="Минуты на игровые часы (0,2–60).">
        <input className={inputClass} type="number" min="0.2" max="60" step="0.1" required value={value.clockTime} onChange={(event) => onChange("clockTime", event.target.value)} />
      </Field>
      <Field label="Delay, секунд" hint="Пауза перед списанием времени, 0–60 секунд.">
        <input className={inputClass} type="number" min="0" max="60" step="1" required value={value.delaySeconds} onChange={(event) => onChange("delaySeconds", event.target.value)} />
      </Field>
      <Field label="Дата и время начала" hint="Время указывается по часовому поясу вашего устройства. Сетка запустится автоматически.">
        <input className={inputClass} type="datetime-local" required value={value.scheduledAt || ""} onChange={(event) => onChange("scheduledAt", event.target.value)} />
      </Field>
    </div>
  );

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="mb-5 flex items-start gap-3">
          <div className="rounded-xl bg-cyan-50 p-2.5 text-cyan-700"><Plus className="h-5 w-5" /></div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">Создать турнир</h2>
            <p className="mt-1 text-sm text-slate-500">Задайте расписание и параметры одной партии, взнос в монетах и фиксированную награду. Взнос списывается при регистрации без возврата, а выплата победителю не превысит собранный пул. В указанное время сетка сформируется автоматически, если зарегистрированы минимум два участника.</p>
          </div>
        </div>
        <form className="space-y-4" onSubmit={createTournament}>
          <Field label="Название">
            <input className={inputClass} required maxLength={80} value={form.title} onChange={(event) => updateForm("title", event.target.value)} placeholder="Например, Осенний кубок" />
          </Field>
          {settingFields(form, updateForm)}
          <button className={`${buttonClass} bg-cyan-700 text-white hover:bg-cyan-800`} type="submit" disabled={creating || !form.title.trim() || !form.scheduledAt}>
            {creating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Создать турнир
          </button>
        </form>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Список турниров</h2>
            <p className="text-sm text-slate-500">Изменение настроек доступно до запуска.</p>
          </div>
          <button className={`${buttonClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-100`} onClick={reload} type="button"><RefreshCw className="h-4 w-4" />Обновить</button>
        </div>
        {tournaments.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">Турниров пока нет.</div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {tournaments.map((item) => {
              const isEditing = editingId === item.id;
              const canEdit = item.status === "registration";
              return (
                <article key={item.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-lg font-bold text-slate-900">{item.title}</h3>
                      <p className="mt-1 text-xs text-slate-500">Создан {new Date(item.createdAt).toLocaleString("ru-RU")}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${item.status === "registration" ? "bg-amber-50 text-amber-700" : item.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                      {tournamentStatuses[item.status] || item.status}
                    </span>
                  </div>

                  {isEditing && editForm ? (
                    <div className="mt-4 space-y-4 rounded-xl bg-slate-50 p-4">
                      <Field label="Название">
                        <input className={inputClass} maxLength={80} value={editForm.title} onChange={(event) => setEditForm((previous) => ({ ...previous, title: event.target.value }))} />
                      </Field>
                      {settingFields(editForm, (field, value) => setEditForm((previous) => ({ ...previous, [field]: value })), { entryFeeLocked: (item.participantCount ?? 0) > 0 })}
                      <div className="flex flex-wrap gap-2">
                        <button className={`${buttonClass} bg-cyan-700 text-white hover:bg-cyan-800`} type="button" disabled={savingId === item.id} onClick={() => saveEdit(item.id)}>
                          {savingId === item.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Сохранить
                        </button>
                        <button className={`${buttonClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-100`} type="button" onClick={() => { setEditingId(null); setEditForm(null); }}><X className="h-4 w-4" />Отмена</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 xl:grid-cols-3">
                        <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">Участники</div><div className="mt-1 font-bold text-slate-800">{item.participantCount ?? 0}{item.maxParticipants ? ` / ${item.maxParticipants}` : ""}</div></div>
                        <div className="rounded-xl bg-amber-50 p-3"><div className="text-xs text-amber-800">Взнос / игрок</div><div className="mt-1 font-bold text-slate-800">{Number(item.entryFeeCoins ?? 0).toLocaleString("ru-RU")} монет</div></div>
                        <div className="rounded-xl bg-emerald-50 p-3"><div className="text-xs text-emerald-800">Награда победителю</div><div className="mt-1 font-bold text-slate-800">{Number(item.rewardCoins ?? 0).toLocaleString("ru-RU")} монет</div>{item.status !== "registration" && <div className="mt-1 text-[11px] text-emerald-800">Пул: {Number(item.prizePoolCoins ?? 0).toLocaleString("ru-RU")} · выплата: {Number(item.prizeCoins ?? 0).toLocaleString("ru-RU")} · системе: {Number(item.systemRetainedCoins ?? 0).toLocaleString("ru-RU")} монет</div>}</div>
                        <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">Очков в игре</div><div className="mt-1 font-bold text-slate-800">До {item.matchLength}</div></div>
                        <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">Время / игрок</div><div className="mt-1 font-bold text-slate-800">{Number(item.clockTime ?? 3).toLocaleString("ru-RU")} мин</div></div>
                        <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">Delay</div><div className="mt-1 font-bold text-slate-800">{item.delaySeconds ?? 12} сек</div></div>
                        <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">Сетка</div><div className="mt-1 font-bold text-slate-800">{item.bracketSize || "Не создана"}</div></div>
                        <div className="rounded-xl bg-cyan-50 p-3"><div className="text-xs text-cyan-800">Старт</div><div className="mt-1 text-xs font-semibold leading-5 text-slate-800">{item.scheduledAt ? new Date(item.scheduledAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" }) : "Не задан"}</div><div className="mt-1 text-[11px] leading-4 text-cyan-900">{getAdminScheduleStatus(item, clockNow)}</div></div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {canEdit && <button className={`${buttonClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-100`} type="button" onClick={() => beginEdit(item)}><Pencil className="h-4 w-4" />Настроить</button>}
                        {canEdit && <button className={`${buttonClass} bg-emerald-700 text-white hover:bg-emerald-800`} type="button" disabled={(item.participantCount ?? 0) < 2 || startingId === item.id} onClick={() => startTournament(item)}>
                          {startingId === item.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                          Запустить и сформировать сетку
                        </button>}
                        {canEdit && <button className={`${buttonClass} border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100`} type="button" disabled={deletingId === item.id} onClick={() => setDeleteTarget(item)}>
                          {deletingId === item.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                          Удалить турнир
                        </button>}
                        <button className={`${buttonClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-100`} type="button" onClick={() => navigate(`/tournaments/${item.id}`)}><ExternalLink className="h-4 w-4" />Открыть турнир</button>
                      </div>
                      {canEdit && (item.participantCount ?? 0) < 2 && <p className="mt-2 text-xs text-amber-700">Для запуска нужно зарегистрировать минимум двух игроков.</p>}
                    </>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <BrandedConfirmModal
        open={Boolean(deleteTarget)}
        title={deleteTarget ? `Удалить турнир «${deleteTarget.title}»?` : "Удалить турнир?"}
        tone="danger"
        confirmText="Удалить турнир"
        cancelText="Оставить турнир"
        busy={deletingId === deleteTarget?.id}
        onClose={() => setDeleteTarget(null)}
        onConfirm={deleteTournament}
      >
        <p>Удаление доступно только до запуска и при отсутствии зарегистрированных участников.</p>
        <p className="mt-2 text-amber-200">Если взносы уже были списаны, они не возвращаются. Это действие нельзя отменить.</p>
      </BrandedConfirmModal>
    </div>
  );
}

function CatalogPanel({ category, items, reload, onMessage }) {
  const { refreshThemeCatalog } = useAuth();
  const [editingKey, setEditingKey] = useState(null);
  const [form, setForm] = useState(emptyCatalogForm);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  const [paletteText, setPaletteText] = useState("");
  const [paletteError, setPaletteError] = useState("");
  const kind = category === "board" ? "доску" : "аватар";
  const kindName = category === "board" ? "доски" : "аватары";
  const formPaletteReady = form.boardColorGradient.every(Boolean)
    && form.triangles.every(Boolean)
    && Boolean(form.checkers.white && form.checkers.black);
  const formPreviewStyle = category === "board"
    ? (formPaletteReady ? { background: `linear-gradient(135deg, ${form.boardColorGradient[0]}, ${form.boardColorGradient[1]})` } : undefined)
    : (form.color ? { backgroundColor: form.color } : undefined);

  const beginCreate = () => {
    setEditingKey("__new__");
    setForm({
      ...emptyCatalogForm,
      boardColorGradient: [...emptyCatalogForm.boardColorGradient],
      triangles: [...emptyCatalogForm.triangles],
      checkers: { ...emptyCatalogForm.checkers },
    });
    setPaletteText("");
    setPaletteError("");
    onMessage("", "");
  };

  const beginEdit = (item) => {
    setEditingKey(item.key);
    setForm({
      key: item.key,
      name: item.name || "",
      description: item.description || "",
      imageUrl: item.imageUrl || "",
      priceCoins: String(item.priceCoins ?? 0),
      priceVlt: String(item.priceVlt ?? 0),
      plusMember: item.plusMember === true,
      rarity: item.rarity || "common",
      color: item.color || "",
      boardColorGradient: Array.isArray(item.boardColorGradient) ? [...item.boardColorGradient] : [...emptyCatalogForm.boardColorGradient],
      triangles: Array.isArray(item.triangles) ? [...item.triangles] : [...emptyCatalogForm.triangles],
      checkers: item.checkers ? { ...item.checkers } : { ...emptyCatalogForm.checkers },
      isActive: item.isActive === true,
      sortOrder: String(item.sortOrder ?? 100),
    });
    setPaletteText(paletteToText(item));
    setPaletteError("");
    onMessage("", "");
  };

  const change = (field, value) => setForm((previous) => ({ ...previous, [field]: value }));
  const changePaletteColor = (field, index, value) => setForm((previous) => ({
    ...previous,
    [field]: previous[field].map((color, colorIndex) => colorIndex === index ? value : color),
  }));
  const changeCheckerColor = (checker, value) => setForm((previous) => ({
    ...previous,
    checkers: { ...previous.checkers, [checker]: value },
  }));

  const applyPaletteText = () => {
    try {
      const palette = parsePaletteText(paletteText);
      setForm((previous) => ({ ...previous, ...palette }));
      setPaletteError("");
      onMessage("", "Палитра применена. Проверьте предпросмотр и сохраните доску.");
    } catch (error) {
      setPaletteError(error.message || "Не удалось разобрать палитру.");
    }
  };

  const uploadImage = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    onMessage("", "");
    try {
      const result = await api.uploadCatalogImage(file);
      change("imageUrl", result.imageUrl);
      onMessage("", "Изображение загружено.");
    } catch (error) {
      onMessage(error.message || "Не удалось загрузить изображение.", "");
    } finally {
      setUploading(false);
    }
  };

  const saveItem = async (event) => {
    event.preventDefault();
    setSaving(true);
    onMessage("", "");
    const payload = {
      key: form.key.trim(),
      name: form.name.trim(),
      description: form.description.trim(),
      imageUrl: form.imageUrl || null,
      priceCoins: Number(form.priceCoins),
      priceVlt: Number(form.priceVlt),
      plusMember: form.plusMember === true ? true : null,
      rarity: form.rarity,
      ...(category === "board" ? {
        boardColorGradient: [...form.boardColorGradient],
        triangles: [...form.triangles],
        checkers: { ...form.checkers },
      } : { color: form.color }),
      isActive: form.isActive === true,
      sortOrder: Number(form.sortOrder),
    };
    try {
      if (editingKey === "__new__") {
        await api.createCatalogItem({ ...payload, category, key: form.key.trim() || undefined });
        onMessage("", `Новая позиция каталога «${form.name.trim()}» добавлена.`);
      } else {
        await api.updateCatalogItem(category, editingKey, payload);
        onMessage("", `Изменения для позиции «${form.name.trim()}» сохранены.`);
      }
      setEditingKey(null);
      setForm(emptyCatalogForm);
      setPaletteText("");
      setPaletteError("");
      await reload();
      if (category === "board") refreshThemeCatalog().catch(() => {});
    } catch (error) {
      onMessage(error.message || "Не удалось сохранить элемент каталога.", "");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (item) => {
    setBusyKey(item.key);
    onMessage("", "");
    try {
      await api.updateCatalogItem(category, item.key, { isActive: !item.isActive });
      onMessage("", item.isActive ? "Позиция скрыта из публичного каталога." : "Позиция снова опубликована.");
      await reload();
      if (category === "board") refreshThemeCatalog().catch(() => {});
    } catch (error) {
      onMessage(error.message || "Не удалось изменить видимость позиции.", "");
    } finally {
      setBusyKey(null);
    }
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setForm(emptyCatalogForm);
    setPaletteText("");
    setPaletteError("");
  };

  const renderEditor = (inline = false) => (
        <form className={`space-y-4 rounded-2xl border border-cyan-200 bg-cyan-50/50 p-5 shadow-sm ${inline ? "md:col-span-2 mt-4" : ""}`} onSubmit={saveItem}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-bold text-slate-900">{editingKey === "__new__" ? `Новая позиция: ${kind}` : `Редактирование: ${form.name}`}</h3>
              <p className="mt-1 text-xs text-slate-500">Загрузка: JPEG, PNG или WebP, до 8 МБ.</p>
            </div>
            <button type="button" className="rounded-lg p-2 text-slate-500 hover:bg-white" onClick={cancelEdit} aria-label="Закрыть форму"><X className="h-5 w-5" /></button>
          </div>
          <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Название">
                  <input className={inputClass} required maxLength={80} value={form.name} onChange={(event) => change("name", event.target.value)} />
                </Field>
                <Field label="ID / ключ" hint={editingKey === "__new__" ? "Можно оставить пустым — сгенерируется автоматически." : "Можно изменить: привязка профилей хранится по внутреннему ID записи БД."}>
                  <input className={inputClass} maxLength={100} value={form.key} onChange={(event) => change("key", event.target.value)} placeholder="Автоматически" />
                </Field>
              </div>
              <Field label="Описание">
                <textarea className={`${inputClass} min-h-20 resize-y`} maxLength={280} value={form.description} onChange={(event) => change("description", event.target.value)} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Цена в монетах"><input className={inputClass} type="number" min="0" max="1000000000" step="1" required value={form.priceCoins} onChange={(event) => change("priceCoins", event.target.value)} /></Field>
                <Field label="Порог VLT · опыт (не списывается)" hint="Аватар или доска разблокируется при достижении этого баланса VLT. Очки опыта не тратятся."><input className={inputClass} type="number" min="0" max="1000000000" step="1" required value={form.priceVlt} onChange={(event) => change("priceVlt", event.target.value)} /></Field>
                <Field label="Редкость">
                  <select className={inputClass} value={form.rarity} onChange={(event) => change("rarity", event.target.value)}>
                    <option value="common">Обычная</option><option value="rare">Редкая</option><option value="epic">Эпическая</option><option value="legendary">Легендарная</option>
                  </select>
                </Field>
                <Field label="Порядок"><input className={inputClass} type="number" step="1" value={form.sortOrder} onChange={(event) => change("sortOrder", event.target.value)} /></Field>
              </div>
              <label className="inline-flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-3">
                <input
                  className="mt-0.5 h-4 w-4 accent-amber-600"
                  type="checkbox"
                  checked={Boolean(form.plusMember)}
                  disabled={(category === "avatar" && form.key.trim() === "volt") || (category === "board" && form.key.trim() === "classic")}
                  onChange={(event) => change("plusMember", event.target.checked)}
                />
                <span>
                  <span className="flex items-center gap-1.5 text-sm font-bold text-amber-900"><Crown className="h-4 w-4" />Только для Volt Plus</span>
                  <span className="mt-1 block text-xs text-amber-800/80">Включённые позиции доступны участникам Plus без отдельной оплаты. Стартовые volt/classic остаются обычными.</span>
                </span>
              </label>
              {category === "board" && (
                <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
                  <div>
                    <h4 className="text-sm font-bold text-slate-800">Палитра игрового стола</h4>
                    <p className="mt-1 text-xs text-slate-500">Эти значения сохраняются на сервере и используются в партии.</p>
                  </div>
                  <div className="space-y-2 rounded-lg border border-dashed border-slate-300 bg-slate-50/60 p-3">
                    <Field label="Палитра кодом" hint="Вставьте блок целиком и нажмите «Применить». Поддерживаются ключи без кавычек и обычный JSON.">
                      <textarea
                        className={`${inputClass} min-h-[112px] resize-y font-mono text-xs leading-relaxed placeholder:text-[#b9b9b9]`}
                        value={paletteText}
                        onChange={(event) => setPaletteText(event.target.value)}
                        placeholder={PALETTE_EXAMPLE}
                        spellCheck={false}
                      />
                    </Field>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className={`${buttonClass} border border-cyan-200 bg-cyan-600 text-white hover:bg-cyan-700`} onClick={applyPaletteText}>Применить палитру</button>
                      <button type="button" className={`${buttonClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-100`} onClick={() => { setPaletteText(paletteToText(form)); setPaletteError(""); }}>Взять из полей</button>
                    </div>
                    {paletteError && <p className="text-xs font-semibold text-rose-600" role="alert">{paletteError}</p>}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 ">
                    <Field label="Градиент доски · цвет 1"><input className={`${inputClass} placeholder:text-[#b9b9b9]`} type="text" pattern="^#[0-9a-fA-F]{6}$" placeholder="#RRGGBB" required value={form.boardColorGradient[0]} onChange={(event) => changePaletteColor("boardColorGradient", 0, event.target.value)} /></Field>
                    <Field label="Градиент доски · цвет 2"><input className={`${inputClass} placeholder:text-[#b9b9b9]`} type="text" pattern="^#[0-9a-fA-F]{6}$" placeholder="#RRGGBB" required value={form.boardColorGradient[1]} onChange={(event) => changePaletteColor("boardColorGradient", 1, event.target.value)} /></Field>
                    <Field label="Пункты · цвет 1"><input className={`${inputClass} placeholder:text-[#b9b9b9]`} type="text" pattern="^#[0-9a-fA-F]{6}$" placeholder="#RRGGBB" required value={form.triangles[0]} onChange={(event) => changePaletteColor("triangles", 0, event.target.value)} /></Field>
                    <Field label="Пункты · цвет 2"><input className={`${inputClass} placeholder:text-[#b9b9b9]`} type="text" pattern="^#[0-9a-fA-F]{6}$" placeholder="#RRGGBB" required value={form.triangles[1]} onChange={(event) => changePaletteColor("triangles", 1, event.target.value)} /></Field>
                    <Field label="Белые шашки"><input className={`${inputClass} placeholder:text-[#b9b9b9]`} type="text" pattern="^#[0-9a-fA-F]{6}$" placeholder="#RRGGBB" required value={form.checkers.white} onChange={(event) => changeCheckerColor("white", event.target.value)} /></Field>
                    <Field label="Чёрные шашки"><input className={`${inputClass} placeholder:text-[#b9b9b9]`} type="text" pattern="^#[0-9a-fA-F]{6}$" placeholder="#RRGGBB" required value={form.checkers.black} onChange={(event) => changeCheckerColor("black", event.target.value)} /></Field>
                  </div>
                </section>
              )}
            </div>
            <div className="space-y-3">
              <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-white" style={formPreviewStyle}>
                {api.assetUrl(form.imageUrl) ? <img className="h-40 w-full object-contain" src={api.assetUrl(form.imageUrl)} alt="Предпросмотр" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /> : <div className="px-4 text-center text-sm font-semibold text-slate-500">Изображение не загружено</div>}
              </div>
              <label className={`${buttonClass} w-full cursor-pointer border border-slate-200 bg-white text-slate-700 hover:bg-slate-100`}>
                {uploading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                {uploading ? "Загрузка…" : "Загрузить изображение"}
                <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={uploadImage} />
              </label>
              {form.imageUrl && (
                <button className={`${buttonClass} w-full border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100`} type="button" disabled={saving || uploading} onClick={() => change("imageUrl", "")}>
                  <Trash2 className="h-4 w-4" />Убрать фото из позиции
                </button>
              )}
              {category === "avatar" && (
                <Field label="Цвет превью аватара">
                  <input className={inputClass} type="text" pattern="^#[0-9a-fA-F]{6}$" placeholder="#RRGGBB (необязательно)" value={form.color} onChange={(event) => change("color", event.target.value)} />
                </Field>
              )}
              <div>
                <span className="mb-1.5 block text-sm font-semibold text-slate-700">Публикация</span>
                <div className="grid grid-cols-2 gap-2">
                  <button className={`${buttonClass} ${form.isActive ? "bg-emerald-700 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`} type="button" aria-pressed={form.isActive} onClick={() => change("isActive", true)}>
                    <Check className="h-4 w-4" />Опубликовано
                  </button>
                  <button className={`${buttonClass} ${!form.isActive ? "bg-amber-600 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`} type="button" aria-pressed={!form.isActive} onClick={() => change("isActive", false)}>
                    <X className="h-4 w-4" />Скрыто
                  </button>
                </div>
                <p className="mt-1 text-xs text-slate-500">{form.isActive ? "Будет видна игрокам после сохранения." : "Останется только в админ-панели и будет скрыта от игроков."}</p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-cyan-100 pt-4">
            <button className={`${buttonClass} bg-cyan-700 text-white hover:bg-cyan-800`} type="submit" disabled={saving || uploading || !form.name.trim()}>
              {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {editingKey === "__new__"
                ? (form.isActive ? "Создать и опубликовать" : "Создать скрытую позицию")
                : (form.isActive ? "Сохранить и опубликовать" : "Сохранить скрытой")}
            </button>
            <button className={`${buttonClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-100`} type="button" onClick={cancelEdit}>Отмена</button>
          </div>
        </form>
  );

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Каталог: {kindName}</h2>
          <p className="mt-1 text-sm text-slate-500">Монеты списываются при покупке; VLT — порог опыта для разблокировки аватара или доски и не расходуются.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={`${buttonClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-100`} type="button" onClick={reload}><RefreshCw className="h-4 w-4" />Обновить</button>
          <button className={`${buttonClass} bg-cyan-700 text-white hover:bg-cyan-800`} type="button" onClick={beginCreate}><Plus className="h-4 w-4" />Добавить {kind}</button>
        </div>
      </section>

      {editingKey === "__new__" && renderEditor()}

      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">В каталоге пока нет позиций.</div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <article key={item.key} className={`grid overflow-hidden rounded-2xl border bg-white shadow-sm md:grid-cols-[176px_minmax(0,1fr)] ${item.isActive ? "border-slate-200" : "border-amber-200 opacity-75"}`}>
              <div className="relative flex h-36 items-center justify-center md:h-full md:min-h-[180px]" style={category === "board"
                ? (Array.isArray(item.boardColorGradient) && item.boardColorGradient.length === 2
                  ? { background: `linear-gradient(135deg, ${item.boardColorGradient[0]}, ${item.boardColorGradient[1]})` }
                  : undefined)
                : (item.color ? { backgroundColor: item.color } : undefined)}>
                {api.assetUrl(item.imageUrl) ? <img className="h-full w-full object-contain" src={api.assetUrl(item.imageUrl)} alt={item.name} onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /> : <div className="px-4 text-center text-sm text-slate-500">В записи каталога нет загруженного изображения</div>}
                <span className={`absolute left-3 top-3 rounded-full px-2.5 py-1 text-xs font-semibold ${item.isActive ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{item.isActive ? "Опубликовано" : "Скрыто"}</span>
              </div>
              <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_250px] md:items-center">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2"><h3 className="truncate font-bold text-slate-900">{item.name}</h3>{item.plusMember && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-800"><Crown className="h-3 w-3" />Plus</span>}</div>
                      <p className="mt-0.5 truncate text-xs text-slate-500">{item.key} · {item.rarity}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">Порядок #{item.sortOrder}</span>
                  </div>
                  {item.description && <p className="line-clamp-2 text-sm text-slate-500">{item.description}</p>}
                  <div className="grid max-w-md grid-cols-2 gap-2 text-sm">
                    <div className="rounded-lg bg-amber-50 px-3 py-2"><span className="text-xs text-amber-700">Монеты</span><div className="font-bold text-amber-900">{Number(item.priceCoins).toLocaleString("ru-RU")}</div></div>
                    <div className="rounded-lg bg-cyan-50 px-3 py-2"><span className="text-xs text-cyan-700">Порог VLT · XP</span><div className="font-bold text-cyan-900">{Number(item.priceVlt).toLocaleString("ru-RU")}</div></div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3 md:flex-col md:border-l md:border-t-0 md:pl-4 md:pt-0">
                  <button className={`${buttonClass} flex-1 border border-slate-200 bg-white px-3 text-slate-700 hover:bg-slate-100 md:w-full`} type="button" onClick={() => editingKey === item.key ? cancelEdit() : beginEdit(item)}><Pencil className="h-4 w-4" />{editingKey === item.key ? "Свернуть" : "Изменить"}</button>
                  <button className={`${buttonClass} flex-1 px-3 md:w-full ${item.isActive ? "border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100" : "border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"}`} type="button" disabled={busyKey === item.key} onClick={() => toggleActive(item)}>
                    {busyKey === item.key ? <LoaderCircle className="h-4 w-4 animate-spin" /> : item.isActive ? <X className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                    {item.isActive ? "Скрыть" : "Опубликовать"}
                  </button>
                </div>
              </div>
              {editingKey === item.key && renderEditor(true)}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function SystemSettingsPanel({ settings, onSaved, onMessage }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmMaintenanceOpen, setConfirmMaintenanceOpen] = useState(false);

  useEffect(() => {
    if (settings) setForm({ ...settings });
  }, [settings]);

  const change = (field, value) => setForm((previous) => ({ ...previous, [field]: value }));

  const saveSettings = async () => {
    if (!form) return;
    setSaving(true);
    onMessage("", "");
    try {
      const result = await api.updateAdminSystemSettings({
        dailyBonusCoins: Number(form.dailyBonusCoins),
        coinPackagePrices: Object.fromEntries(Object.entries(form.coinPackagePrices || {}).map(([id, price]) => [id, Number(price)])),
        dailyBonusCooldownHours: Number(form.dailyBonusCooldownHours),
        plusDailyBonusCoins: Number(form.plusDailyBonusCoins),
        plusDailyBonusCooldownHours: Number(form.plusDailyBonusCooldownHours),
        plusPriceRub: Number(form.plusPriceRub),
        maintenanceEnabled: Boolean(form.maintenanceEnabled),
        maintenanceTitle: form.maintenanceTitle,
        maintenanceMessage: form.maintenanceMessage,
        maintenanceEta: form.maintenanceEta,
      });
      setForm({ ...result.settings });
      onSaved(result.settings);
      onMessage("", "Настройки системы сохранены.");
      setConfirmMaintenanceOpen(false);
    } catch (error) {
      onMessage(error.message || "Не удалось сохранить настройки.", "");
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (form?.maintenanceEnabled && !settings?.maintenanceEnabled) {
      setConfirmMaintenanceOpen(true);
      return;
    }
    saveSettings();
  };

  if (!form) return <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-500">Настройки ещё не загружены.</div>;

  return (
    <>
      <form className="space-y-5" onSubmit={handleSubmit}>
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-5 flex items-start gap-3">
            <div className="rounded-xl bg-amber-100 p-2.5 text-amber-700"><Coins className="h-5 w-5" /></div>
            <div>
              <h3 className="text-lg font-bold text-slate-900">Ежедневный бонус</h3>
              <p className="mt-1 text-sm text-slate-500">Настройте размер начисления и период между получениями.</p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Бонус, монет" hint="0–10 000 000 монет за одно получение.">
              <input className={inputClass} type="number" min="0" max="10000000" step="1" required value={form.dailyBonusCoins} onChange={(event) => change("dailyBonusCoins", event.target.value)} />
            </Field>
            <Field label="Интервал, часов" hint="От 1 до 168 часов. Новое значение действует при следующей проверке бонуса.">
              <input className={inputClass} type="number" min="1" max="168" step="1" required value={form.dailyBonusCooldownHours} onChange={(event) => change("dailyBonusCooldownHours", event.target.value)} />
            </Field>
          </div>
          <div className="mt-5 border-t border-slate-100 pt-5">
            <h4 className="mb-3 flex items-center gap-2 text-sm font-bold text-amber-900"><Crown className="h-4 w-4" />Бонус для Plus Member</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Бонус Plus, монет" hint="Начисляется вместо обычного ежедневного бонуса.">
                <input className={inputClass} type="number" min="0" max="10000000" step="1" required value={form.plusDailyBonusCoins} onChange={(event) => change("plusDailyBonusCoins", event.target.value)} />
              </Field>
              <Field label="Интервал Plus, часов" hint="От 1 до 168 часов; используется общий таймер ежедневного бонуса.">
                <input className={inputClass} type="number" min="1" max="168" step="1" required value={form.plusDailyBonusCooldownHours} onChange={(event) => change("plusDailyBonusCooldownHours", event.target.value)} />
              </Field>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-amber-200 bg-amber-50/50 p-5 shadow-sm sm:p-6">
          <div className="mb-4 flex items-start gap-3">
            <div className="rounded-xl bg-amber-100 p-2.5 text-amber-800"><Crown className="h-5 w-5" /></div>
            <div>
              <h3 className="text-lg font-bold text-slate-900">Цены Volt Plus</h3>
              <p className="mt-1 text-sm text-slate-600">Оплата через Robokassa. Каждая покупка добавляет 30 дней; повторная оплата продлевает активный срок.</p>
            </div>
          </div>
          <div className="max-w-sm">
            <Field label="Подписка на 30 дней, ₽" hint="0 отключает оформление, пока цена не задана. Можно указать до двух знаков после запятой.">
              <input className={inputClass} type="number" min="0" max="1000000" step="0.01" required value={form.plusPriceRub} onChange={(event) => change("plusPriceRub", event.target.value)} />
            </Field>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-5 flex items-start gap-3">
            <div className="rounded-xl bg-amber-100 p-2.5 text-amber-700"><Coins className="h-5 w-5" /></div>
            <div>
              <h3 className="text-lg font-bold text-slate-900">Цены пакетов монет</h3>
              <p className="mt-1 text-sm text-slate-500">Количество монет фиксировано. Меняется только цена в рублях; уже созданные счета сохраняют цену на момент создания.</p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(form.coinPackages || []).map((pkg) => (
              <label key={pkg.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                <span className="block text-sm font-bold text-slate-800">{Number(pkg.coins).toLocaleString("ru-RU")} монет</span>
                <span className="mt-1 block text-xs text-slate-500">{pkg.id}</span>
                <span className="mt-3 block text-xs font-semibold text-slate-600">Цена, ₽</span>
                <input
                  className={`${inputClass} mt-1`}
                  type="number"
                  min="1"
                  max="1000000"
                  step="1"
                  required
                  value={form.coinPackagePrices?.[pkg.id] ?? pkg.price}
                  onChange={(event) => change("coinPackagePrices", { ...form.coinPackagePrices, [pkg.id]: event.target.value })}
                />
              </label>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-cyan-100 p-2.5 text-cyan-800"><Settings className="h-5 w-5" /></div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">Техническое обслуживание</h3>
                <p className="mt-1 max-w-2xl text-sm text-slate-500">Пользователям показывается безопасная фирменная страница с текстом ниже. Администраторы, турниры и уже открытые игровые партии остаются доступны.</p>
              </div>
            </div>
            <label className="inline-flex shrink-0 cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
              <input className="h-4 w-4 accent-cyan-700" type="checkbox" checked={Boolean(form.maintenanceEnabled)} onChange={(event) => change("maintenanceEnabled", event.target.checked)} />
              <span className={`text-sm font-bold ${form.maintenanceEnabled ? "text-rose-700" : "text-slate-600"}`}>
                {form.maintenanceEnabled ? "Режим включён" : "Режим выключен"}
              </span>
            </label>
          </div>
          <div className="grid gap-4">
            <Field label="Заголовок страницы" hint="До 120 символов.">
              <input className={inputClass} type="text" maxLength="120" required value={form.maintenanceTitle} onChange={(event) => change("maintenanceTitle", event.target.value)} />
            </Field>
            <Field label="Сообщение пользователям" hint="Обычный текст; HTML и скрипты не выполняются. До 2000 символов.">
              <textarea className={`${inputClass} min-h-28 resize-y`} maxLength="2000" value={form.maintenanceMessage} onChange={(event) => change("maintenanceMessage", event.target.value)} />
            </Field>
            <Field label="Ориентировочное время возвращения" hint="Необязательно, например: Сегодня до 22:00 МСК.">
              <input className={inputClass} type="text" maxLength="120" value={form.maintenanceEta} onChange={(event) => change("maintenanceEta", event.target.value)} />
            </Field>
          </div>
          <div className="mt-5 rounded-2xl border border-cyan-200 bg-slate-950 p-5 text-white">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-300">Предпросмотр шаблона</div>
            <h4 className="mt-3 text-lg font-black">{form.maintenanceTitle || "Техническое обслуживание"}</h4>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-300">{form.maintenanceMessage || "Текст сообщения появится здесь."}</p>
            {form.maintenanceEta && <p className="mt-3 border-t border-white/10 pt-3 text-xs text-cyan-200">{form.maintenanceEta}</p>}
          </div>
        </section>

        <div className="flex justify-end">
          <button className={`${buttonClass} bg-cyan-700 text-white hover:bg-cyan-800`} type="submit" disabled={saving}>
            {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Сохранить настройки
          </button>
        </div>
      </form>

      <BrandedConfirmModal
        open={confirmMaintenanceOpen}
        title="Включить обслуживание для пользователей?"
        confirmText="Включить режим"
        cancelText="Оставить выключенным"
        onConfirm={saveSettings}
        onClose={() => setConfirmMaintenanceOpen(false)}
        busy={saving}
        tone="danger"
      >
        Обычные страницы и новые игровые поиски станут недоступны. Администраторы, вход, турнирные комнаты и уже открытые игровые партии сохранят доступ.
      </BrandedConfirmModal>
    </>
  );
}

export default function AdminPanel() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialSection = searchParams.get("section");
  const [section, setSection] = useState(sections.some((item) => item.id === initialSection) ? initialSection : "tournaments");
  const [isAdmin, setIsAdmin] = useState(null);
  const [accessError, setAccessError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tournaments, setTournaments] = useState([]);
  const [catalogItems, setCatalogItems] = useState([]);
  const [systemSettings, setSystemSettings] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const requested = searchParams.get("section");
    if (sections.some((item) => item.id === requested)) setSection(requested);
  }, [searchParams]);

  const selectSection = (value) => {
    setSection(value);
    setSearchParams({ section: value }, { replace: true });
    setError("");
    setNotice("");
  };

  const setMessage = useCallback((nextError, nextNotice) => {
    setError(nextError || "");
    setNotice(nextNotice || "");
  }, []);

  const reload = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError("");
    try {
      if (section === "tournaments") {
        const result = await api.adminTournaments();
        setTournaments(result.tournaments || []);
      } else if (section === "settings") {
        const result = await api.adminSystemSettings();
        setSystemSettings(result.settings);
      } else if (section !== "monitoring" && section !== "mailing") {
        const result = await api.adminCatalog(section === "boards" ? "board" : "avatar");
        setCatalogItems(result.items || []);
      }
    } catch (loadError) {
      setError(loadError.message || "Не удалось загрузить данные.");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, section]);

  useEffect(() => {
    let mounted = true;
        api.adminMe()
      .then((result) => {
        if (mounted) {
          setIsAdmin(Boolean(result.isAdmin));
        }
      })
      .catch(() => {
        if (mounted) {
          // 404 от requireTournamentAdmin, 401 от протухшего токена, сетевые сбои —
          // для всех «нет доступа» выглядит одинаково: страница не найдена
          setIsAdmin(false);
        }
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (isAdmin) reload();
  }, [isAdmin, reload]);

  const sectionTitle = useMemo(() => sections.find((item) => item.id === section)?.label || "Администрирование", [section]);

  if (isAdmin === null) {
    return <div className="flex min-h-[50vh] items-center justify-center gap-3 rounded-3xl bg-slate-50 text-slate-600"><LoaderCircle className="h-5 w-5 animate-spin" />Проверяем доступ…</div>;
  }

  if (!isAdmin) return <NotFoundScreen />;

  return (
    <section className="min-h-[75vh] w-full rounded-3xl bg-slate-50 p-4 text-slate-800 shadow-xl sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-cyan-100 p-3 text-cyan-800"><ShieldCheck className="h-6 w-6" /></div>
            <div><div className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-800">Admin workspace</div><h1 className="mt-1 text-2xl font-black text-[#0f172a] sm:text-3xl">Админ-панель</h1><p className="mt-1 text-sm text-slate-500">Управление турнирами, каталогами, мониторингом, рассылками и настройками системы.</p></div>
          </div>
          <button className={`${buttonClass} self-start border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 sm:self-auto`} type="button" onClick={() => navigate("/")}><ArrowLeft className="h-4 w-4" />В приложение</button>
        </header>
            <nav className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm" aria-label="Разделы админ-панели">
              {sections.map((item) => (
                <button key={item.id} className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${section === item.id ? "bg-cyan-700 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`} type="button" onClick={() => selectSection(item.id)}>
                  {createElement(item.icon, { className: "h-4 w-4" })}{item.label}
                </button>
              ))}
            </nav>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-bold text-slate-900">{sectionTitle}</h2>
              {loading && <span className="inline-flex items-center gap-2 text-sm text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />Обновление</span>}
            </div>
            <Notice error={error} notice={notice} />

            {loading ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-500">Загружаем данные…</div>
            ) : section === "tournaments" ? (
              <TournamentPanel tournaments={tournaments} reload={reload} onMessage={setMessage} navigate={navigate} />
            ) : section === "settings" ? (
              <SystemSettingsPanel settings={systemSettings} onSaved={setSystemSettings} onMessage={setMessage} />
            ) : section === "monitoring" ? (
              <AdminMonitoringPanel />
            ) : section === "mailing" ? (
              <AdminMailingPanel onMessage={setMessage} />
            ) : (
              <CatalogPanel key={section} category={section === "boards" ? "board" : "avatar"} items={catalogItems} reload={reload} onMessage={setMessage} />
            )}
          
        
      </div>
    </section>
  );
}
