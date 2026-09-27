// Live PredictionContext: built from the scope's EventRules plus event meta, other tiers and JP finals.
// Field for field the same as contextFromDataset (dataset-context.ts) for the same event and scope.
import type { EventRules, Region } from "../../event-rules/types";
import type { DatasetFinal, DatasetScope, PredictionContext } from "./types";

type TierScore = { rank: number; score: number };
type Row = Readonly<Record<string, unknown>>;

/** Context of one scope for a snapshot, given that snapshot's tier scores (all ranks share one context). */
export type PredictionContextFactory = (otherTiers: ReadonlyArray<TierScore>) => PredictionContext;

/** Masterdata tables the context reads through resolveEventRules (group, turn, chapters, windows, gauge). */
export const PREDICTION_CONTEXT_RULE_TABLES: readonly string[] = ["events", "worldBlooms", "eventBreakTimes"];

/** Masterdata tables behind PredictionEventMeta.bannerCharacterId. */
export const PREDICTION_CONTEXT_META_TABLES: readonly string[] = ["eventStories", "gameCharacterUnits"];

export interface PredictionEventMeta {
    /** masterdata events.unit; "none" and empty map to null. */
    unit: string | null | undefined;
    bannerCharacterId: number | null | undefined;
}

export interface BuildPredictionContextArgs {
    /** Rules of the scope to predict, resolved without user overrides (the model is fitted on event defaults). */
    rules: EventRules;
    event: PredictionEventMeta;
    /** Current scores of the tiers at the prediction moment, the predicted tier included. */
    otherTiers: ReadonlyArray<TierScore>;
    /** JP finals table (finals-jp.json rows); read for CN scopes only. */
    jpFinals?: ReadonlyArray<DatasetFinal> | null;
}

function numberField(row: Row | undefined, key: string): number | null {
    const value = row?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Same definition as the dataset builder: events.unit, with "none" mapped to null. */
export function eventUnitOf(event: Row | null | undefined): string | null {
    const unit = event?.unit;
    return typeof unit === "string" && unit !== "" && unit !== "none" ? unit : null;
}

/** Banner character: eventStories.bannerGameCharacterUnitId mapped through gameCharacterUnits (rows already patched). */
export function bannerCharacterIdOf(
    eventId: number,
    eventStories: ReadonlyArray<Row> | null | undefined,
    gameCharacterUnits: ReadonlyArray<Row> | null | undefined,
): number | null {
    const story = eventStories?.find((row) => numberField(row, "eventId") === eventId);
    const unitId = numberField(story, "bannerGameCharacterUnitId");
    if (unitId === null) return null;
    const unit = gameCharacterUnits?.find((row) => numberField(row, "id") === unitId);
    return numberField(unit, "gameCharacterId");
}

function sameScope(a: DatasetScope, b: DatasetScope): boolean {
    if (a.kind === "overall" || b.kind === "overall") return a.kind === b.kind;
    return a.gameCharacterId === b.gameCharacterId;
}

/** JP final borders (rank -> score) of the same event id and scope; null when the table has none. */
export function jpSameIdFinalOf(
    finals: ReadonlyArray<DatasetFinal> | null | undefined,
    eventId: number,
    scope: DatasetScope,
): Record<number, number> | null {
    if (!finals) return null;
    const rows = finals
        .filter((f) => f.region === "jp" && f.eventId === eventId && sameScope(f.scope, scope) && Number.isFinite(f.score) && f.score > 0)
        .sort((a, b) => a.rank - b.rank);
    return rows.length > 0 ? Object.fromEntries(rows.map((f) => [f.rank, f.score])) : null;
}

/**
 * Observed tiers as the model expects them: positive scores only (a 0 is a missing tier, not an observation),
 * border ranks of the scope only when the rules list them, one entry per rank, ascending.
 */
export function normalizeOtherTiers(tiers: ReadonlyArray<TierScore>, borderRanks: readonly number[] = []): TierScore[] {
    const borders = borderRanks.length > 0 ? new Set(borderRanks) : null;
    const byRank = new Map<number, number>();
    for (const t of tiers) {
        if (!Number.isInteger(t.rank) || t.rank <= 0 || !Number.isFinite(t.score) || t.score <= 0) continue;
        if (borders && !borders.has(t.rank)) continue;
        byRank.set(t.rank, t.score);
    }
    return [...byRank].sort((a, b) => a[0] - b[0]).map(([rank, score]) => ({ rank, score }));
}

function scopeOfRules(rules: EventRules): { scope: DatasetScope; chapter: EventRules["chapters"][number] | null } {
    const isChapter = rules.scope.kind === "chapter" && (rules.group === "wl_chapter_48h" || rules.group === "wl_chapter_72h");
    if (!isChapter || rules.scope.kind !== "chapter") return { scope: { kind: "overall" }, chapter: null };
    const characterId = rules.scope.gameCharacterId;
    const chapter = rules.chapters.find((c) => c.gameCharacterId === characterId) ?? null;
    return { scope: { kind: "chapter", gameCharacterId: characterId }, chapter };
}

export function buildPredictionContext(args: BuildPredictionContextArgs): PredictionContext {
    const { rules, event } = args;
    const { scope, chapter } = scopeOfRules(rules);
    return {
        region: rules.region,
        eventId: rules.eventId,
        group: rules.group,
        wlTurn: rules.wlTurn,
        chapterCharacterId: chapter ? chapter.gameCharacterId : null,
        chapterNo: chapter ? chapter.chapterNo : null,
        autoSpecialMeasure: rules.auto.value.specialMeasure,
        scopeStartAt: rules.scopeStartAt,
        scopeEndAt: rules.scopeAggregateAt,
        eventEndAt: rules.aggregateAt,
        // The event's configuration, as in the dataset (breakTimeId != null); a user override does not change it.
        breakGauge: rules.breakGaugeConfigured,
        unit: event.unit != null && event.unit !== "" && event.unit !== "none" ? event.unit : null,
        bannerCharacterId: event.bannerCharacterId ?? null,
        jpSameIdFinal: rules.region === "cn" ? jpSameIdFinalOf(args.jpFinals, rules.eventId, scope) : null,
        otherTiers: normalizeOtherTiers(args.otherTiers, rules.rankingTiers),
    };
}

export interface FallbackPredictionContextArgs {
    region: Region;
    eventId: number;
    /** events.eventType as listed by the ranking API, if known. */
    eventType: string | null | undefined;
    startAt: number;
    endAt: number;
    chapterCharacterId: number | null;
    chapterNo: number | null;
    otherTiers: ReadonlyArray<TierScore>;
}

/** Chapters are 48 h or 72 h; longer than 60 h is the 72 h shape (same rule as resolveEventRules). */
const LONG_CHAPTER_MIN_HOURS = 60;

/**
 * Context for a scope whose rules could not be resolved (masterdata still loading or unavailable, or a chapter
 * masterdata does not list). The WL turn is unknown (null), so the model uses its turn-independent fallbacks.
 */
export function fallbackPredictionContext(args: FallbackPredictionContextArgs): PredictionContext {
    const hours = Math.round((args.endAt - args.startAt) / 3_600_000);
    const isChapter = args.chapterCharacterId != null;
    const group = isChapter
        ? (hours > LONG_CHAPTER_MIN_HOURS ? "wl_chapter_72h" : "wl_chapter_48h")
        : args.eventType === "world_bloom" ? "wl_overall" : "normal";
    return {
        region: args.region,
        eventId: args.eventId,
        group,
        wlTurn: null,
        chapterCharacterId: isChapter ? args.chapterCharacterId : null,
        chapterNo: isChapter ? args.chapterNo : null,
        autoSpecialMeasure: false,
        scopeStartAt: args.startAt,
        scopeEndAt: args.endAt,
        // A chapter's window does not tell where the event ends; any other scope is the whole event.
        eventEndAt: isChapter ? null : args.endAt,
        breakGauge: false,
        unit: null,
        bannerCharacterId: null,
        jpSameIdFinal: null,
        otherTiers: normalizeOtherTiers(args.otherTiers),
    };
}
