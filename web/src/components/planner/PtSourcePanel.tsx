"use client";
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "@/components/LocalizedLink";
import { useI18n } from "@/contexts/I18nContext";
import { fetchMasterDataForServer, fetchMusicMetas } from "@/lib/fetch";
import { loadTranslations } from "@/lib/translations";
import { DEFAULT_GAP_SECONDS, FIRE_MULTIPLIERS, fireMultiplier, playsPerHour } from "@/lib/goal-planner/core";
import { useDeckEngine } from "@/lib/deck-recommend/use-deck-engine";
import {
    CUSTOM_ROOM_PT_FACTOR,
    autoSpecialMeasureTeammates,
    readPlannerAccount,
} from "@/lib/deck-recommend/planner-args";
import type { EventRules } from "@/lib/event-rules/types";
import type { PtPlan, SongOption } from "@/lib/goal-planner/types";
import type {
    PlannerDeckEngine,
    PlannerDeckOption,
    PlannerDeckProfile,
    PlannerDeckRequest,
    PlannerLiveType,
    PlannerSongGainRequest,
    PlannerSongGainRow,
} from "@/lib/deck-recommend/planner-types";
import type { IMusicInfo, IMusicMeta } from "@/types/music";
import DeckPicker from "./DeckPicker";
import SongGainTable, { DIFFICULTY_BADGE_COLORS, type SongGainView } from "./SongGainTable";

interface PtSourcePanelProps {
    rules: EventRules;
    server: "jp" | "cn";
    eventId: number;
    eventType: string;
    chapterCharacterId: number | null;
    value: PtPlan | null;
    onChange(pt: PtPlan | null, songOptions: SongOption[]): void;
}

type Mode = PtPlan["mode"];
type LiveChoice = "coop" | "solo";

interface SongEntry {
    musicId: number;
    title: string;
    subtitle?: string;
    search: string;
    /** Song length in seconds by difficulty (music metas). */
    seconds: Record<string, number>;
}

interface SongData {
    server: string;
    songs: SongEntry[];
    defaultMusicId: number | null;
}

interface DeckRun {
    ctx: string;
    req: PlannerDeckRequest;
    options: PlannerDeckOption[];
}

interface GainSpec {
    ctx: string;
    mode: Mode;
    server: "jp" | "cn";
    eventId: number;
    eventType: string;
    liveType: PlannerLiveType;
    autoLiveType: PlannerLiveType;
    teammates: { power: number; scoreUp: number } | null;
    profile: PlannerDeckProfile;
    fire: number;
    autoFire: number;
}

interface GainState {
    key: string;
    ctx: string;
    mode: Mode;
    manual: PlannerSongGainRow[];
    auto: PlannerSongGainRow[];
    error: string | null;
}

type PanelError = { kind: "engine"; message: string } | { kind: "noResult" };

interface ComputedView extends SongGainView {
    musicId: number;
    seconds: number;
    playsPerHour: number;
}

const DIFFICULTY_ORDER = ["easy", "normal", "hard", "expert", "master", "append"];
const MODES: ReadonlyArray<{ value: Mode; key: string }> = [
    { value: "deck", key: "page.predictionPlanner.pt.mode.deck" },
    { value: "manual", key: "page.predictionPlanner.pt.mode.manual" },
    { value: "direct", key: "page.predictionPlanner.pt.mode.direct" },
];
const LIVE_LABEL_KEYS: Record<PlannerLiveType, string> = {
    multi: "page.predictionPlanner.pt.live.multi",
    solo: "page.predictionPlanner.pt.live.solo",
    auto: "page.predictionPlanner.pt.live.auto",
    cheerful: "page.predictionPlanner.pt.live.cheerful",
};
const SONG_OPTION_TOP = 10;
const SEARCH_RESULT_LIMIT = 8;
const GAIN_DEBOUNCE_MS = 200;
const DECK_RESULT_LIMIT = 5;

const INPUT_CLASS = "w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-mono font-bold text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-miku/30 focus:border-miku";
const LABEL_CLASS = "block text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-1";

function parseNumberInput(raw: string): number | null {
    const cleaned = raw.replace(/[,\s]/g, "");
    if (cleaned === "") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function songKey(musicId: number, difficulty: string): string {
    return `${musicId}:${difficulty}`;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function subscribeStorage(callback: () => void): () => void {
    window.addEventListener("storage", callback);
    return () => window.removeEventListener("storage", callback);
}

function accountSnapshot(): string {
    const account = readPlannerAccount();
    return account ? `${account.server}|${account.userId}` : "";
}

function emptySnapshot(): string {
    return "";
}

/** Chapter used for the support deck when the overall scope is selected: the running one, else the next, else the last. */
function overallChapterCharacter(rules: EventRules, now: number): number | undefined {
    const chapters = rules.chapters
        .filter((c) => c.gameCharacterId !== null)
        .sort((a, b) => a.startAt - b.startAt);
    if (chapters.length === 0) return undefined;
    const pick = chapters.find((c) => now < c.aggregateAt) ?? chapters[chapters.length - 1];
    return pick.gameCharacterId ?? undefined;
}

function buildSongData(server: string, musics: IMusicInfo[], metas: IMusicMeta[], titleMap: Record<string, string> | null, now: number): SongData {
    const secondsById = new Map<number, Record<string, number>>();
    for (const meta of metas) {
        const entry = secondsById.get(meta.music_id) ?? {};
        entry[meta.difficulty] = meta.music_time;
        secondsById.set(meta.music_id, entry);
    }
    const songs: SongEntry[] = [];
    for (const music of musics) {
        const seconds = secondsById.get(music.id);
        if (!seconds || music.publishedAt > now) continue;
        const subtitle = titleMap?.[music.title];
        songs.push({
            musicId: music.id,
            title: music.title,
            subtitle: subtitle && subtitle !== music.title ? subtitle : undefined,
            search: [String(music.id), music.title, music.pronunciation, subtitle ?? ""].join("\n").toLowerCase(),
            seconds,
        });
    }
    songs.sort((a, b) => a.musicId - b.musicId);
    const available = new Set(songs.map((s) => s.musicId));
    let defaultMusicId: number | null = null;
    let best = -Infinity;
    for (const meta of metas) {
        if (!available.has(meta.music_id)) continue;
        const v = meta.pspi_pt_per_hour_multi ?? 0;
        if (v > best) {
            best = v;
            defaultMusicId = meta.music_id;
        }
    }
    return { server, songs, defaultMusicId: defaultMusicId ?? songs[0]?.musicId ?? null };
}

function SegmentButton({ active, onClick, children, disabled }: { active: boolean; onClick(): void; children: React.ReactNode; disabled?: boolean }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-pressed={active}
            className={`px-2 sm:px-3 py-2 rounded-xl text-xs font-bold leading-tight break-keep transition-all border disabled:opacity-50 ${active
                ? "bg-miku text-white border-miku shadow-sm shadow-miku/30"
                : "bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                }`}
        >
            {children}
        </button>
    );
}

function NumberField({ label, value, onChange, placeholder }: { label: string; value: string; onChange(v: string): void; placeholder?: string }) {
    return (
        <label className="block min-w-0">
            <span className={LABEL_CLASS}>{label}</span>
            <input
                type="text"
                inputMode="decimal"
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
                className={INPUT_CLASS}
            />
        </label>
    );
}

/** Where the planner's PT per play comes from: the deck engine, manual deck parameters, or direct entry. */
export default function PtSourcePanel({ rules, server, eventId, eventType, chapterCharacterId, value, onChange }: PtSourcePanelProps) {
    const { t, formatNumber, locale } = useI18n();
    const engine = useDeckEngine();

    const engineRef = useRef<PlannerDeckEngine>(engine);
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        engineRef.current = engine;
        onChangeRef.current = onChange;
    });

    const accountKey = useSyncExternalStore(subscribeStorage, accountSnapshot, emptySnapshot);
    const account = useMemo(() => {
        if (!accountKey) return null;
        const [accountServer, userId] = accountKey.split("|");
        return accountServer === server && userId ? { server: accountServer as "jp" | "cn", userId } : null;
    }, [accountKey, server]);

    const [modeChoice, setModeChoice] = useState<Mode | null>(value?.mode ?? null);
    const mode: Mode = modeChoice ?? (account ? "deck" : "manual");

    // Preloads the engine and the account's data, as the deck-recommend page does.
    const warmup = engine.warmup;
    useEffect(() => {
        if (mode === "deck" && account) warmup(account.server, account.userId);
    }, [mode, account, warmup]);

    const [liveChoice, setLiveChoice] = useState<LiveChoice>("coop");
    const [musicChoice, setMusicChoice] = useState<number | null>(null);
    const [difficultyChoice, setDifficultyChoice] = useState("master");
    const [search, setSearch] = useState("");
    const [fire, setFire] = useState(value?.manualFire ?? 5);
    const [autoFireChoice, setAutoFireChoice] = useState(value?.autoFire ?? 5);
    const [customRoom, setCustomRoom] = useState(false);
    const [gapInput, setGapInput] = useState("");

    const [songData, setSongData] = useState<SongData | null>(null);

    const [deckRun, setDeckRun] = useState<DeckRun | null>(null);
    const [selectedRank, setSelectedRank] = useState<number | null>(null);
    const [running, setRunning] = useState(false);
    const [deckError, setDeckError] = useState<PanelError | null>(null);
    const [gapBonusInput, setGapBonusInput] = useState("");
    const runIdRef = useRef(0);

    const [manualBonus, setManualBonus] = useState("");
    const [manualPower, setManualPower] = useState("");
    const [manualLeaderSkill, setManualLeaderSkill] = useState("");
    const [manualMemberSkill, setManualMemberSkill] = useState("");
    const [manualProfile, setManualProfile] = useState<{ ctx: string; profile: PlannerDeckProfile } | null>(null);

    const initialDirect = value?.mode === "direct" ? value : null;
    const [directManual, setDirectManual] = useState(initialDirect ? String(initialDirect.manualPtPerPlay) : "");
    const [directAuto, setDirectAuto] = useState(initialDirect ? String(initialDirect.autoPtPerPlay) : "");
    const [directPph, setDirectPph] = useState(initialDirect ? String(Math.round(initialDirect.playsPerHour * 10) / 10) : "");

    const [gains, setGains] = useState<GainState | null>(null);

    // Song gains depend on the event only; deck results also depend on the chapter's support character.
    const eventCtx = `${server}:${eventId}`;
    const ctx = `${eventCtx}:${chapterCharacterId ?? "all"}`;
    const special = rules.auto.value.specialMeasure;
    const minAutoFire = Math.max(1, rules.auto.value.minFire);
    const maxAutoFire = Math.max(minAutoFire, rules.auto.value.maxFire);
    const autoFire = Math.min(maxAutoFire, Math.max(minAutoFire, autoFireChoice));
    const coopLive: PlannerLiveType = eventType === "cheerful_carnival" ? "cheerful" : "multi";
    const liveType: PlannerLiveType = liveChoice === "coop" ? coopLive : "solo";
    const gapSeconds = parseNumberInput(gapInput) ?? DEFAULT_GAP_SECONDS[liveType];
    const roomFactor = customRoom && liveChoice === "coop" ? CUSTOM_ROOM_PT_FACTOR : 1;
    const hasEngineGap = rules.engineCoverageGaps.length > 0;

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            fetchMasterDataForServer<IMusicInfo[]>(server, "musics.json"),
            fetchMusicMetas().catch(() => [] as IMusicMeta[]),
            loadTranslations(locale).catch(() => null),
        ])
            .then(([musics, metas, translations]) => {
                if (cancelled) return;
                setSongData(buildSongData(server, musics, metas, translations?.music?.title ?? null, Date.now()));
            })
            .catch(() => {
                if (!cancelled) setSongData({ server, songs: [], defaultMusicId: null });
            });
        return () => {
            cancelled = true;
        };
    }, [server, locale]);

    const songs = useMemo(() => (songData && songData.server === server ? songData.songs : []), [songData, server]);
    const songsLoading = !songData || songData.server !== server;
    const songById = useMemo(() => new Map(songs.map((s) => [s.musicId, s])), [songs]);

    const musicId = musicChoice !== null && songById.has(musicChoice) ? musicChoice : (songData?.server === server ? songData.defaultMusicId : null);
    const song = musicId !== null ? songById.get(musicId) ?? null : null;
    const songDifficulties = song ? DIFFICULTY_ORDER.filter((d) => song.seconds[d] !== undefined) : [];
    const difficulty = songDifficulties.includes(difficultyChoice)
        ? difficultyChoice
        : songDifficulties.includes("master") ? "master" : songDifficulties[songDifficulties.length - 1] ?? difficultyChoice;
    const selectedKey = musicId !== null ? songKey(musicId, difficulty) : null;
    const songSeconds = song?.seconds[difficulty] ?? null;

    const searchMatches = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return [];
        const out: SongEntry[] = [];
        for (const s of songs) {
            if (s.search.includes(q)) out.push(s);
            if (out.length >= SEARCH_RESULT_LIMIT) break;
        }
        return out;
    }, [search, songs]);

    // Deck results belong to the event/chapter they were computed for.
    const activeRun = deckRun && deckRun.ctx === ctx ? deckRun : null;
    const selectedOption = activeRun?.options.find((o) => o.rank === selectedRank) ?? null;
    const gapBonus = hasEngineGap ? parseNumberInput(gapBonusInput) : null;

    let profile: PlannerDeckProfile | null = null;
    if (mode === "deck" && selectedOption) {
        const skills = selectedOption.cards.slice(0, 5).map((c) => c.skillScoreUp);
        while (skills.length < 5) skills.push(0);
        profile = {
            totalPower: selectedOption.totalPower,
            eventBonusRate: gapBonus ?? selectedOption.eventBonus,
            skillScoreUps: [skills[0], skills[1], skills[2], skills[3], skills[4]],
        };
    } else if (mode === "manual" && manualProfile && manualProfile.ctx === eventCtx) {
        profile = manualProfile.profile;
    }

    const gainSpec: GainSpec | null = profile
        ? {
            ctx: eventCtx,
            mode,
            server,
            eventId,
            eventType,
            liveType,
            autoLiveType: special ? coopLive : "auto",
            teammates: special ? autoSpecialMeasureTeammates(rules) : null,
            profile,
            fire,
            autoFire,
        }
        : null;
    const gainKey = gainSpec ? JSON.stringify(gainSpec) : null;

    useEffect(() => {
        if (!gainKey) return;
        const spec = JSON.parse(gainKey) as GainSpec;
        let cancelled = false;
        const timer = window.setTimeout(() => {
            const base = { server: spec.server, eventId: spec.eventId, eventType: spec.eventType, profile: spec.profile };
            const manualReq: PlannerSongGainRequest = { ...base, liveType: spec.liveType, boost: spec.fire };
            const autoReq: PlannerSongGainRequest = {
                ...base,
                liveType: spec.autoLiveType,
                boost: spec.autoFire,
                teammates: spec.teammates ?? undefined,
            };
            (async () => {
                const manual = await engineRef.current.songGains(manualReq);
                const auto = await engineRef.current.songGains(autoReq);
                return { manual, auto };
            })()
                .then(({ manual, auto }) => {
                    if (!cancelled) setGains({ key: gainKey, ctx: spec.ctx, mode: spec.mode, manual, auto, error: null });
                })
                .catch((err) => {
                    if (!cancelled) setGains({ key: gainKey, ctx: spec.ctx, mode: spec.mode, manual: [], auto: [], error: errorMessage(err) });
                });
        }, GAIN_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [gainKey]);

    // Keeps the last rows of the same event and mode while a new request is in flight.
    const activeGains = profile && gains && gains.ctx === eventCtx && gains.mode === mode ? gains : null;
    const gainsPending = gainKey !== null && gains?.key !== gainKey;

    // The engine's own PT for the recommended song is exact; the rows cover every other song.
    const runReq = activeRun?.req;
    const exactKey = mode === "deck" && selectedOption && runReq && !hasEngineGap && runReq.liveType === liveType
        ? songKey(runReq.musicId, runReq.difficulty)
        : null;
    const exactNoBoost = exactKey && selectedOption && runReq ? selectedOption.eventPoint / fireMultiplier(runReq.boost) : null;

    const views = useMemo<ComputedView[]>(() => {
        if (!activeGains) return [];
        const multiplier = fireMultiplier(fire);
        const out: ComputedView[] = [];
        for (const row of activeGains.manual) {
            const key = songKey(row.musicId, row.difficulty);
            const entry = songById.get(row.musicId);
            // Rows can include songs not yet released on this server.
            if (songById.size > 0 && !entry) continue;
            const noBoost = key === exactKey && exactNoBoost !== null ? exactNoBoost : row.ptPerPlayNoBoost;
            const ptPerPlay = Math.floor(noBoost * multiplier * roomFactor);
            const pph = playsPerHour(row.seconds, gapSeconds);
            out.push({
                key,
                musicId: row.musicId,
                title: entry?.title ?? row.title,
                subtitle: entry?.subtitle,
                difficulty: row.difficulty,
                seconds: row.seconds,
                playsPerHour: pph,
                ptPerPlay,
                ptPerHour: ptPerPlay * pph,
                ptPerStamina: fire >= 1 ? ptPerPlay / fire : null,
            });
        }
        return out;
    }, [activeGains, fire, roomFactor, gapSeconds, songById, exactKey, exactNoBoost]);

    // Candidates for the song comparison: the best songs per hour and per play (per stamina at a fixed fire).
    const comparisonViews = useMemo(() => {
        const byHour = [...views].sort((a, b) => b.ptPerHour - a.ptPerHour).slice(0, SONG_OPTION_TOP);
        const byPlay = [...views].sort((a, b) => b.ptPerPlay - a.ptPerPlay).slice(0, SONG_OPTION_TOP);
        return [...byHour, ...byPlay];
    }, [views]);

    const bestAuto = useMemo(() => {
        if (!activeGains) return null;
        let best: PlannerSongGainRow | null = null;
        for (const row of activeGains.auto) {
            if (!best || row.ptPerPlayNoBoost > best.ptPerPlayNoBoost) best = row;
        }
        return best;
    }, [activeGains]);

    const labelFor = (title: string, diff: string) => `${title} (${diff.toUpperCase()})`;

    let plan: PtPlan | null = null;
    let songOptions: SongOption[] = [];
    let autoSongLabel: string | null = null;
    if (mode === "direct") {
        const manualPt = parseNumberInput(directManual);
        const pph = parseNumberInput(directPph);
        if (manualPt !== null && manualPt > 0 && pph !== null && pph > 0) {
            plan = {
                mode: "direct",
                manualPtPerPlay: manualPt,
                manualFire: fire,
                playsPerHour: pph,
                // Only song time fills the break gauge; the typed rate includes the gap between plays.
                songSeconds: Math.max(1, 3600 / pph - gapSeconds),
                autoPtPerPlay: parseNumberInput(directAuto) ?? 0,
                autoFire,
                autoIsLowerBound: false,
            };
        }
    } else {
        const base = selectedKey ? views.find((v) => v.key === selectedKey) : undefined;
        if (base) {
            if (bestAuto) {
                const autoEntry = songById.get(bestAuto.musicId);
                autoSongLabel = labelFor(autoEntry?.title ?? bestAuto.title, bestAuto.difficulty);
            }
            const basePlan: PtPlan = {
                mode,
                manualPtPerPlay: base.ptPerPlay,
                manualFire: fire,
                playsPerHour: base.playsPerHour,
                songSeconds: base.seconds,
                // Auto is count-limited rather than time-limited, so it uses the highest-PT song.
                autoPtPerPlay: bestAuto ? Math.floor(bestAuto.ptPerPlayNoBoost * fireMultiplier(autoFire)) : 0,
                autoSongSeconds: bestAuto?.seconds,
                autoFire,
                autoIsLowerBound: special,
                songLabel: labelFor(base.title, base.difficulty),
            };
            plan = basePlan;
            const seen = new Set<string>([base.key]);
            songOptions = [{ key: base.key, label: basePlan.songLabel ?? base.title, pt: basePlan }];
            for (const v of comparisonViews) {
                if (seen.has(v.key)) continue;
                seen.add(v.key);
                const optionLabel = labelFor(v.title, v.difficulty);
                songOptions.push({
                    key: v.key,
                    label: optionLabel,
                    pt: {
                        ...basePlan,
                        manualPtPerPlay: v.ptPerPlay,
                        playsPerHour: v.playsPerHour,
                        songSeconds: v.seconds,
                        songLabel: optionLabel,
                    },
                });
            }
        }
    }

    const emitKey = JSON.stringify([plan, songOptions]);
    const lastEmitRef = useRef<string | null>(null);
    useEffect(() => {
        if (lastEmitRef.current === emitKey) return;
        lastEmitRef.current = emitKey;
        const [nextPlan, nextOptions] = JSON.parse(emitKey) as [PtPlan | null, SongOption[]];
        onChangeRef.current(nextPlan, nextOptions);
    }, [emitKey]);

    const pickSong = (entry: SongEntry) => {
        setMusicChoice(entry.musicId);
        setSearch("");
    };

    const switchSong = (key: string) => {
        const [id, diff] = key.split(":");
        setMusicChoice(Number(id));
        setDifficultyChoice(diff);
    };

    const selectDeck = (rank: number) => {
        setSelectedRank(rank);
        const option = activeRun?.options.find((o) => o.rank === rank);
        if (option && hasEngineGap) setGapBonusInput(String(Math.round(option.eventBonus * 10) / 10));
    };

    const calculateDeck = async () => {
        if (!account || musicId === null) return;
        const supportCharacterId = rules.chapters.some((c) => c.gameCharacterId !== null)
            ? chapterCharacterId ?? overallChapterCharacter(rules, Date.now())
            : undefined;
        const req: PlannerDeckRequest = {
            server,
            userId: account.userId,
            eventId,
            eventType,
            liveType,
            musicId,
            difficulty,
            boost: fire,
            supportCharacterId,
            limit: DECK_RESULT_LIMIT,
        };
        const runId = ++runIdRef.current;
        const runCtx = ctx;
        setRunning(true);
        setDeckError(null);
        try {
            const options = await engineRef.current.recommend(req);
            if (runId !== runIdRef.current) return;
            const top = options.slice(0, DECK_RESULT_LIMIT);
            setDeckRun({ ctx: runCtx, req, options: top });
            setSelectedRank(top[0]?.rank ?? null);
            if (top[0] && hasEngineGap) setGapBonusInput(String(Math.round(top[0].eventBonus * 10) / 10));
            if (top.length === 0) setDeckError({ kind: "noResult" });
        } catch (err) {
            if (runId === runIdRef.current) setDeckError({ kind: "engine", message: errorMessage(err) });
        } finally {
            if (runId === runIdRef.current) setRunning(false);
        }
    };

    const cancelDeck = () => {
        runIdRef.current += 1;
        engineRef.current.cancel();
        setRunning(false);
    };

    const calculateManual = () => {
        const power = parseNumberInput(manualPower);
        if (power === null || power <= 0) return;
        const leader = parseNumberInput(manualLeaderSkill) ?? 0;
        const member = parseNumberInput(manualMemberSkill) ?? 0;
        setManualProfile({
            ctx: eventCtx,
            profile: {
                totalPower: power,
                eventBonusRate: parseNumberInput(manualBonus) ?? 0,
                skillScoreUps: [leader, member, member, member, member],
            },
        });
    };

    const engineErrorText = (message: string) => t("page.predictionPlanner.pt.errors.engine", { message });
    // The hook reports a failed run both in its state and through the rejected promise; show it once.
    const errorSet = new Set<string>();
    if (mode !== "direct") {
        if (engine.status === "error" && engine.error) errorSet.add(engineErrorText(engine.error));
        if (mode === "deck" && deckError) {
            errorSet.add(deckError.kind === "noResult" ? t("page.predictionPlanner.pt.errors.noResult") : engineErrorText(deckError.message));
        }
        if (activeGains?.error) errorSet.add(engineErrorText(activeGains.error));
    }
    const errors = [...errorSet];

    const progressPercent = Math.round(engine.progress?.percent ?? 0);
    const liveOptions: PlannerLiveType[] = [coopLive, "solo"];
    const fireOptions = FIRE_MULTIPLIERS.map((m, count) => ({ count, m }));

    // Rendered right under the calculate row of the deck and manual modes.
    const statTiles = mode !== "direct" && plan ? (
        <div className={`grid grid-cols-2 sm:grid-cols-3 gap-2 transition-opacity ${gainsPending ? "opacity-60" : ""}`}>
            <div className="bg-slate-50 dark:bg-slate-800/60 p-3 rounded-xl border border-slate-100 dark:border-slate-800 min-w-0">
                <span className="text-[11px] font-bold text-slate-400 block mb-0.5">{t("page.predictionPlanner.pt.direct.manualPt")}</span>
                <span className="text-base font-black font-mono text-slate-800 dark:text-slate-100">{formatNumber(plan.manualPtPerPlay)}</span>
            </div>
            <div className="bg-slate-50 dark:bg-slate-800/60 p-3 rounded-xl border border-slate-100 dark:border-slate-800 min-w-0">
                <span className="text-[11px] font-bold text-slate-400 block mb-0.5">{t("page.predictionPlanner.pt.direct.playsPerHour")}</span>
                <span className="text-base font-black font-mono text-slate-800 dark:text-slate-100">{formatNumber(plan.playsPerHour, { maximumFractionDigits: 1 })}</span>
            </div>
            <div className="col-span-2 sm:col-span-1 bg-slate-50 dark:bg-slate-800/60 p-3 rounded-xl border border-slate-100 dark:border-slate-800 min-w-0">
                <span className="text-[11px] font-bold text-slate-400 flex flex-wrap items-center gap-1.5 mb-0.5">
                    <span>{t("page.predictionPlanner.pt.direct.autoPt")}</span>
                    {plan.autoIsLowerBound && (
                        <span className="px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800 text-[10px] leading-none">
                            {t("page.predictionPlanner.pt.autoLowerBound")}
                        </span>
                    )}
                </span>
                <span className="text-base font-black font-mono text-slate-800 dark:text-slate-100">{formatNumber(plan.autoPtPerPlay)}</span>
                {autoSongLabel && (
                    <span className="block text-[10px] text-slate-400 truncate" title={autoSongLabel}>
                        {t("page.predictionPlanner.pt.live.auto")} · {autoSongLabel}
                    </span>
                )}
            </div>
        </div>
    ) : null;

    return (
        <section className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4 sm:p-5 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <h2 className="text-sm sm:text-base font-bold text-slate-800 dark:text-slate-100">{t("page.predictionPlanner.pt.title")}</h2>
                <div className="grid grid-cols-3 gap-1.5 sm:flex">
                    {MODES.map((m) => (
                        <SegmentButton key={m.value} active={mode === m.value} onClick={() => setModeChoice(m.value)}>
                            {t(m.key)}
                        </SegmentButton>
                    ))}
                </div>
            </div>

            {mode !== "direct" && (
                <div className="space-y-4">
                    <div>
                        <span className={LABEL_CLASS}>{t("page.predictionPlanner.pt.liveType")}</span>
                        <div className="grid grid-cols-2 gap-2 sm:flex">
                            {liveOptions.map((lt) => (
                                <SegmentButton
                                    key={lt}
                                    active={liveType === lt}
                                    onClick={() => {
                                        setLiveChoice(lt === "solo" ? "solo" : "coop");
                                        setGapInput("");
                                    }}
                                >
                                    {t(LIVE_LABEL_KEYS[lt])}
                                </SegmentButton>
                            ))}
                        </div>
                    </div>

                    <div>
                        <span className={LABEL_CLASS}>{t("page.predictionPlanner.pt.song")}</span>
                        {songsLoading ? (
                            <div className="flex items-center gap-2 py-2 text-xs text-slate-400">
                                <span className="loading-spinner" aria-hidden="true" />
                            </div>
                        ) : song ? (
                            <div className="mb-2 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 min-w-0">
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-[10px] font-mono text-slate-400 shrink-0">#{song.musicId}</span>
                                    <span className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">{song.title}</span>
                                    {songSeconds !== null && (
                                        <span className="ml-auto text-[10px] font-mono text-slate-400 shrink-0">{formatNumber(songSeconds, { maximumFractionDigits: 1 })}s</span>
                                    )}
                                </div>
                                {song.subtitle && <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{song.subtitle}</div>}
                            </div>
                        ) : null}
                        <div className="relative">
                            <input
                                type="search"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder={t("page.predictionPlanner.pt.songSearch")}
                                aria-label={t("page.predictionPlanner.pt.songSearch")}
                                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-miku/30 focus:border-miku"
                            />
                            {searchMatches.length > 0 && (
                                <ul className="absolute z-20 left-0 right-0 mt-1 max-h-72 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg">
                                    {searchMatches.map((entry) => (
                                        <li key={entry.musicId}>
                                            <button
                                                type="button"
                                                onClick={() => pickSong(entry)}
                                                className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 min-w-0"
                                            >
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <span className="text-[10px] font-mono text-slate-400 shrink-0">#{entry.musicId}</span>
                                                    <span className="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{entry.title}</span>
                                                </div>
                                                {entry.subtitle && <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{entry.subtitle}</div>}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>

                    {songDifficulties.length > 0 && (
                        <div>
                            <span className={LABEL_CLASS}>{t("page.predictionPlanner.pt.difficulty")}</span>
                            <div className="flex flex-wrap gap-1.5">
                                {songDifficulties.map((d) => (
                                    <button
                                        key={d}
                                        type="button"
                                        onClick={() => setDifficultyChoice(d)}
                                        aria-pressed={difficulty === d}
                                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold uppercase transition-all ${difficulty === d
                                            ? `${DIFFICULTY_BADGE_COLORS[d] ?? "bg-miku text-white"} shadow-md`
                                            : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700"
                                            }`}
                                    >
                                        {d}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            <div className="grid grid-cols-2 gap-3">
                <label className="block min-w-0">
                    <span className={LABEL_CLASS}>{t("page.predictionPlanner.pt.fire")}</span>
                    <select
                        value={fire}
                        onChange={(e) => setFire(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-miku/30"
                    >
                        {fireOptions.map(({ count, m }) => (
                            <option key={count} value={count}>{t("page.predictionPlanner.pt.fireOption", { count, multiplier: m })}</option>
                        ))}
                    </select>
                </label>
                <label className="block min-w-0">
                    <span className={LABEL_CLASS}>{t("page.predictionPlanner.pt.autoFire")}</span>
                    <select
                        value={autoFire}
                        onChange={(e) => setAutoFireChoice(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-miku/30"
                    >
                        {fireOptions.filter(({ count }) => count >= minAutoFire && count <= maxAutoFire).map(({ count, m }) => (
                            <option key={count} value={count}>{t("page.predictionPlanner.pt.fireOption", { count, multiplier: m })}</option>
                        ))}
                    </select>
                </label>
            </div>

            {mode !== "direct" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:items-end">
                    <NumberField
                        label={t("page.predictionPlanner.pt.gapSeconds")}
                        value={gapInput}
                        onChange={setGapInput}
                        placeholder={String(DEFAULT_GAP_SECONDS[liveType])}
                    />
                    {liveChoice === "coop" && (
                        <label className="flex items-start gap-2 cursor-pointer select-none sm:pb-2">
                            <input
                                type="checkbox"
                                checked={customRoom}
                                onChange={(e) => setCustomRoom(e.target.checked)}
                                className="mt-0.5 w-4 h-4 shrink-0 accent-miku"
                            />
                            <span className="text-xs text-slate-600 dark:text-slate-300">
                                {t("page.predictionPlanner.pt.customRoom", { percent: formatNumber(CUSTOM_ROOM_PT_FACTOR * 100, { maximumFractionDigits: 1 }) })}
                            </span>
                        </label>
                    )}
                </div>
            )}

            {mode === "deck" && (
                <div className="space-y-3">
                    {!account ? (
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
                            <span className="text-xs text-slate-600 dark:text-slate-300">{t("page.predictionPlanner.pt.deck.needAccount")}</span>
                            <Link
                                href="/deck-recommend/"
                                className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg bg-miku text-white text-xs font-bold shadow-sm shadow-miku/30 hover:opacity-90 shrink-0"
                            >
                                {t("page.predictionPlanner.pt.deck.goToDeck")}
                            </Link>
                        </div>
                    ) : (
                        <>
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                <span className="text-xs text-slate-500 dark:text-slate-400 font-mono break-all">
                                    {t("page.predictionPlanner.pt.deck.account", { userId: account.userId, server: account.server.toUpperCase() })}
                                </span>
                                {running ? (
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold text-miku">
                                            {t("page.predictionPlanner.pt.deck.calculating", { percent: progressPercent })}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={cancelDeck}
                                            className="px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                                        >
                                            {t("page.predictionPlanner.pt.deck.cancel")}
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={calculateDeck}
                                        disabled={musicId === null}
                                        className="px-4 py-2 rounded-xl bg-miku text-white text-xs font-bold shadow-sm shadow-miku/30 hover:opacity-90 disabled:opacity-50"
                                    >
                                        {t("page.predictionPlanner.pt.deck.calculate")}
                                    </button>
                                )}
                            </div>
                            {running && (
                                <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                                    <div className="h-full bg-miku transition-all" style={{ width: `${progressPercent}%` }} />
                                </div>
                            )}
                        </>
                    )}

                    {statTiles}

                    {hasEngineGap && (
                        <div className="space-y-2">
                            <p className="px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300 text-xs break-words">
                                {t("page.predictionPlanner.rules.warnings.engineGap", { tables: rules.engineCoverageGaps.join(", ") })}
                            </p>
                            {selectedOption && (
                                <NumberField
                                    label={t("page.predictionPlanner.pt.manual.bonus")}
                                    value={gapBonusInput}
                                    onChange={setGapBonusInput}
                                    placeholder={String(Math.round(selectedOption.eventBonus * 10) / 10)}
                                />
                            )}
                        </div>
                    )}

                    {activeRun && activeRun.options.length > 0 && (
                        <DeckPicker options={activeRun.options} selectedRank={selectedRank} onSelect={selectDeck} />
                    )}
                </div>
            )}

            {mode === "manual" && (
                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                        <NumberField label={t("page.predictionPlanner.pt.manual.bonus")} value={manualBonus} onChange={setManualBonus} placeholder="0" />
                        <NumberField label={t("page.predictionPlanner.pt.manual.power")} value={manualPower} onChange={setManualPower} placeholder="0" />
                        <NumberField label={t("page.predictionPlanner.pt.manual.leaderSkill")} value={manualLeaderSkill} onChange={setManualLeaderSkill} placeholder="0" />
                        <NumberField label={t("page.predictionPlanner.pt.manual.memberSkill")} value={manualMemberSkill} onChange={setManualMemberSkill} placeholder="0" />
                    </div>
                    <div className="flex justify-end">
                        <button
                            type="button"
                            onClick={calculateManual}
                            disabled={musicId === null || !(parseNumberInput(manualPower) ?? 0)}
                            className="px-4 py-2 rounded-xl bg-miku text-white text-xs font-bold shadow-sm shadow-miku/30 hover:opacity-90 disabled:opacity-50"
                        >
                            {t("page.predictionPlanner.pt.manual.calculate")}
                        </button>
                    </div>
                    {statTiles}
                </div>
            )}

            {mode === "direct" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <NumberField label={t("page.predictionPlanner.pt.direct.manualPt")} value={directManual} onChange={setDirectManual} placeholder="0" />
                    <NumberField label={t("page.predictionPlanner.pt.direct.autoPt")} value={directAuto} onChange={setDirectAuto} placeholder="0" />
                    <NumberField label={t("page.predictionPlanner.pt.direct.playsPerHour")} value={directPph} onChange={setDirectPph} placeholder="0" />
                    <NumberField
                        label={t("page.predictionPlanner.pt.gapSeconds")}
                        value={gapInput}
                        onChange={setGapInput}
                        placeholder={String(DEFAULT_GAP_SECONDS[liveType])}
                    />
                </div>
            )}

            {errors.length > 0 && (
                <ul className="space-y-1.5">
                    {errors.map((text, i) => (
                        <li key={i} className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-600 dark:bg-red-950/40 dark:border-red-900 dark:text-red-300 text-xs break-words">
                            {text}
                        </li>
                    ))}
                </ul>
            )}

            {mode !== "direct" && views.length > 0 && (
                <SongGainTable rows={views} selectedKey={selectedKey} onUse={switchSong} />
            )}
        </section>
    );
}
