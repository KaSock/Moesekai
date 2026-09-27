/**
 * Planner-side deck-engine arguments and result mapping.
 *
 * Shares the deck-recommend page's storage keys, account fallback and saved configuration.
 * Engine facts cited below were measured by scripts/test-planner-deck.mjs against
 * @empty-sekai/allium-deck-wasm 0.0.14 with real JP/CN masterdata.
 */
import { getAccounts, isValidServer, type ServerType } from "@/lib/account";
import type { EventRules, Region } from "../event-rules/types";
import { DEFAULT_GAP_SECONDS, fireMultiplier, playsPerHour } from "../goal-planner/core.ts";
import type { DeckMusicRow, DeckResultDeck, DeckWorkerInput } from "./engine-types";
import type {
    PlannerAccount,
    PlannerDeckOption,
    PlannerDeckRequest,
    PlannerLiveType,
    PlannerSongGainRequest,
    PlannerSongGainRow,
} from "./planner-types";
import {
    buildDeckWorkerArgs,
    DEFAULT_CARD_CONFIG,
    DEFAULT_DECK_FORM_STATE,
    type DeckFormState,
} from "./worker-args.ts";

export const DECK_USER_ID_STORAGE_KEY = "deck_recommend_userid";
export const DECK_SERVER_STORAGE_KEY = "deck_recommend_server";
export const DECK_SAVED_CONFIG_KEY = "deck_recommend_saved_config_v2";

/** Server the deck-recommend page starts with when nothing valid is stored. */
const DEFAULT_DECK_SERVER: ServerType = "jp";
const DEFAULT_PLANNER_DECK_LIMIT = 5;

/**
 * Custom-room PT as a fraction of an ordinary multi live.
 * The engine has no custom-room model (0.0.14 accepts no room option and contains no room identifier),
 * and official v6.2.0 (note_364) only says custom-room event points are reduced uniformly,
 * so this is the pjsekai.com wiki figure (secondary source).
 */
export const CUSTOM_ROOM_PT_FACTOR = 0.2;

/** Account the deck-recommend page restores: its own last selection, else the first saved account. */
export function resolveDeckAccount(): { server: ServerType | null; userId: string | null } {
    let server = localStorage.getItem(DECK_SERVER_STORAGE_KEY);
    let userId = localStorage.getItem(DECK_USER_ID_STORAGE_KEY);
    if (!userId) {
        const accounts = getAccounts();
        if (accounts.length > 0) {
            userId = accounts[0].gameId;
            server = accounts[0].server;
        }
    }
    return {
        server: server && isValidServer(server) ? server : null,
        userId: userId || null,
    };
}

/** Saved deck-recommend form state, with missing rarity configs filled from the defaults; null when absent or broken. */
export function parseSavedDeckConfig(raw: string | null): Partial<DeckFormState> | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<DeckFormState>;
        return { ...parsed, cardConfig: { ...DEFAULT_CARD_CONFIG, ...(parsed.cardConfig ?? {}) } };
    } catch {
        return null;
    }
}

export function readSavedDeckConfig(): Partial<DeckFormState> | null {
    if (typeof localStorage === "undefined") return null;
    return parseSavedDeckConfig(localStorage.getItem(DECK_SAVED_CONFIG_KEY));
}

/** The account the deck-recommend page would use, when it is on a server the planner supports. */
export function readPlannerAccount(): PlannerAccount | null {
    if (typeof localStorage === "undefined") return null;
    const { server, userId } = resolveDeckAccount();
    const trimmed = userId?.trim();
    if (!trimmed) return null;
    const effective = server ?? DEFAULT_DECK_SERVER;
    return effective === "jp" || effective === "cn" ? { server: effective, userId: trimmed } : null;
}

/**
 * Search constraints of a single deck-page run. The planner asks for the best-PT deck of its own event,
 * so these are reset while account-level assumptions (training config, data overrides, excluded cards,
 * skill order, multi-live teammates, timeout) are kept from the saved configuration.
 */
const PLANNER_SEARCH_RESET = {
    eventBonusCharacterIds: [],
    challengeCharacterId: null,
    target: "score",
    bonusTargets: "",
    simulateEnabled: false,
    minimize: false,
    leaderCharacterId: null,
    fixedCards: [],
    fixedCharacters: [],
    unitFilter: "",
    attrFilter: "",
    characterFilterIds: [],
    filterOtherUnit: false,
    useCurrentDeck: false,
} satisfies Partial<DeckFormState>;

/** Worker input for a planner deck search; the caller adds the OAuth token like the deck page does. */
export function buildPlannerWorkerArgs(
    req: PlannerDeckRequest,
    saved: Partial<DeckFormState> | null = readSavedDeckConfig(),
): DeckWorkerInput {
    const state: DeckFormState = {
        ...DEFAULT_DECK_FORM_STATE,
        ...(saved ?? {}),
        ...PLANNER_SEARCH_RESET,
        mode: "event",
        eventId: String(req.eventId),
        selectedEventType: req.eventType,
        liveType: req.liveType,
        supportCharacterId: req.supportCharacterId ?? null,
        musicId: String(req.musicId),
        difficulty: req.difficulty,
        boost: String(req.boost),
        limit: String(req.limit ?? DEFAULT_PLANNER_DECK_LIMIT),
    };
    return buildDeckWorkerArgs(state, { server: req.server, userId: req.userId, bonusTargets: null });
}

/** Planner view of the worker's result decks. */
export function plannerDeckOptions(decks: readonly DeckResultDeck[]): PlannerDeckOption[] {
    return decks.map((deck) => ({
        rank: deck.rank,
        // recommend already applies the fire multiplier: its PT equals the boost-0 PT times the official
        // v4.0.0 table exactly (JP #217, CN #178; solo, multi and auto; 0-10 fires).
        eventPoint: deck.eventPoint ?? deck.score,
        liveScore: deck.liveScore,
        totalPower: deck.totalPower,
        eventBonus: deck.eventBonus ?? 0,
        effectiveSkill: deck.effectiveSkill,
        cards: deck.cards,
    }));
}

/** Body of the worker's `music` message (MusicRequest in engine-worker.ts). */
export interface DeckMusicRequest {
    requestId: number;
    liveType: string;
    eventType?: string;
    skillOrder?: string;
    teammates?: { power?: number; scoreUp?: number };
    deck: {
        totalPower: number;
        eventBonusRate: number;
        supportDeckBonusRate: number;
        cards: { skillScoreUp: number; skillLifeRecovery: number }[];
    };
}

function isMultiLive(liveType: PlannerLiveType): boolean {
    return liveType === "multi" || liveType === "cheerful";
}

export function buildPlannerMusicRequest(req: PlannerSongGainRequest, requestId: number): DeckMusicRequest {
    return {
        requestId,
        liveType: req.liveType,
        eventType: req.eventType,
        // recommendMusic rejects teammate parameters for non-multi lives, and the worker then answers with no rows.
        teammates: isMultiLive(req.liveType) ? req.teammates : undefined,
        deck: {
            totalPower: req.profile.totalPower,
            // Profile bonus is the deck total (support deck included), as on the deck page.
            eventBonusRate: req.profile.eventBonusRate,
            supportDeckBonusRate: 0,
            cards: req.profile.skillScoreUps.map((skillScoreUp) => ({ skillScoreUp, skillLifeRecovery: 0 })),
        },
    };
}

/** Songs the planner can list: titles of the server's released songs and chart lengths. */
export interface SongGainCatalog {
    titles: ReadonlyMap<number, string>;
    /** Keyed by songChartKey(musicId, difficulty). */
    seconds: ReadonlyMap<string, number>;
}

export function songChartKey(musicId: number, difficulty: string): string {
    return `${musicId}:${difficulty}`;
}

export function buildSongGainCatalog(
    musics: ReadonlyArray<{ id: number; title: string; publishedAt?: number }>,
    metas: ReadonlyArray<{ music_id: number; difficulty: string; music_time: number }>,
    now: number,
): SongGainCatalog {
    const titles = new Map<number, string>();
    for (const music of musics) {
        if ((music.publishedAt ?? 0) <= now) titles.set(music.id, music.title);
    }
    const seconds = new Map<string, number>();
    for (const meta of metas) {
        if (meta.music_time > 0) seconds.set(songChartKey(meta.music_id, meta.difficulty), meta.music_time);
    }
    return { titles, seconds };
}

/** Song-gain rows from the worker's music rows; charts missing from the catalog are dropped. */
export function buildSongGainRows(
    rows: readonly DeckMusicRow[],
    catalog: SongGainCatalog,
    req: Pick<PlannerSongGainRequest, "liveType" | "boost" | "gapSeconds">,
): PlannerSongGainRow[] {
    // recommendMusic PT excludes the fire multiplier: it equals recommend's boost-0 PT (JP #217, CN #178;
    // solo, multi, auto), and the engine floors before applying boost, so the product is exact.
    const multiplier = fireMultiplier(req.boost);
    const gapSeconds = req.gapSeconds ?? DEFAULT_GAP_SECONDS[req.liveType];
    const out: PlannerSongGainRow[] = [];
    for (const row of rows) {
        const title = catalog.titles.get(row.musicId);
        const seconds = catalog.seconds.get(songChartKey(row.musicId, row.difficulty));
        if (title === undefined || seconds === undefined || row.eventPoint === undefined) continue;
        const ptPerPlay = row.eventPoint * multiplier;
        const perHour = playsPerHour(seconds, gapSeconds);
        out.push({
            musicId: row.musicId,
            difficulty: row.difficulty,
            title,
            seconds,
            liveScore: row.liveScore,
            ptPerPlayNoBoost: row.eventPoint,
            ptPerPlay,
            playsPerHour: perHour,
            ptPerHour: ptPerPlay * perHour,
            // A 0-fire play spends no stamina; 0 marks "not applicable".
            ptPerStamina: req.boost > 0 ? ptPerPlay / req.boost : 0,
        });
    }
    return out;
}

/** Engine multi_live_teammate_score_up is a teammate's effective skill: leader in full plus 20% of the other four. */
const TEAMMATE_EFFECTIVE_SKILL_FACTOR = 1 + 4 * 0.2;

/**
 * Theoretical-max teammate measured with a max box (every rarity-4 and birthday card released by the
 * region's #180 end, fully trained with canvases; area items, character ranks and gates at their masterdata
 * caps; every title at max level) searched for target=power in #180, whose 2% fixture cap applies.
 * scoreUp is the best uncapped effective skill of the same box (JP five 160% cards, CN 150/150/150/140/140).
 */
const MEASURED_MAX_TEAMMATE: Record<Region, { power: number; scoreUp: number }> = {
    jp: { power: 451_935, scoreUp: 288 },
    cn: { power: 393_515, scoreUp: 266 },
};

/**
 * Teammates for the Auto special-measure lower bound (Auto PT is at least a multi live whose four
 * teammates have theoretical-max power and skill).
 *
 * - scoreUp: every card at the event's skill cap (140 -> 252, which the #180 max box reaches exactly);
 *   without a cap, the measured uncapped maximum.
 * - power: the event's power cap when set, since displayed power cannot exceed it; otherwise the measured
 *   #180 maximum. Newer content only raises the real maximum, so the figure stays a lower bound, and
 *   10% less teammate power moves multi PT by only 0.26% (JP) / 0.31% (CN).
 *
 * With these teammates the #180 multi PT on music 74 master is 1.86x (JP) / 1.82x (CN) the Auto PT of the same deck.
 */
export function autoSpecialMeasureTeammates(rules: EventRules): { power: number; scoreUp: number } {
    const measured = MEASURED_MAX_TEAMMATE[rules.region];
    const skillCap = rules.skillCap.value;
    return {
        power: rules.powerCap.value ?? measured.power,
        scoreUp: skillCap !== null ? Math.round(skillCap * TEAMMATE_EFFECTIVE_SKILL_FACTOR) : measured.scoreUp,
    };
}
