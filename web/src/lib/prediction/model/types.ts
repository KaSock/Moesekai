// Prediction-model types: inference context, backtest dataset formats, priors.json layout.
// Relative `import type` only, so the backtest scripts can run it with node --experimental-strip-types.
import type { EventGroup, Region, WlTurn } from "../../event-rules/types";

export interface PredictionContext {
    region: Region;
    eventId: number;
    group: EventGroup;
    wlTurn: WlTurn;
    /** Chapter character and chapter number for a chapter scope; null for overall / normal events. */
    chapterCharacterId: number | null;
    chapterNo: number | null;
    /** Whether the finale runs the Auto special measure (true for #180 in both regions, false for #218). */
    autoSpecialMeasure: boolean;
    scopeStartAt: number;
    scopeEndAt: number;
    /** The whole event's aggregateAt, also for a chapter scope; null when unknown. */
    eventEndAt: number | null;
    breakGauge: boolean;
    unit: string | null;
    bannerCharacterId: number | null;
    /** CN: final borders of the JP event with the same id (rank -> score); null when unknown. */
    jpSameIdFinal: Readonly<Record<number, number>> | null;
    /** Current scores of other tiers at the same moment. */
    otherTiers: ReadonlyArray<{ rank: number; score: number }>;
}

export type DatasetScope = { kind: "overall" } | { kind: "chapter"; gameCharacterId: number };

export interface DatasetEvent {
    region: Region;
    /** Game event id (masterdata events.id), not the row id of the local legacy table. */
    eventId: number;
    name: string;
    eventType: string;
    startAt: number;
    aggregateAt: number;
    days: number;
    group: EventGroup;
    wlTurn: WlTurn;
    isFinale: boolean;
    chapters: ReadonlyArray<{ chapterNo: number; gameCharacterId: number | null; startAt: number; aggregateAt: number }>;
    unit: string | null;
    bannerCharacterId: number | null;
    breakTimeId: number | null;
    autoSpecialMeasure: boolean;
    bonusRatio: number | null;
}

export interface DatasetSeries {
    region: Region;
    eventId: number;
    scope: DatasetScope;
    rank: number;
    /** [timestamp ms, score], ascending in time. */
    points: ReadonlyArray<readonly [number, number]>;
    source: string;
}

export interface DatasetFinal {
    region: Region;
    eventId: number;
    scope: DatasetScope;
    rank: number;
    score: number;
    source: string;
}

/** Single-tier final estimate used by every module: median and standard deviation on the log scale. */
export interface LogNormalEstimate {
    median: number;
    logSigma: number;
}

export interface QuantileEstimate {
    p10: number;
    p50: number;
    p90: number;
}

/** Top-level layout of priors.json; each section's inner shape is the type exported by its module. */
export interface PriorsFile<Prior = unknown, Curve = unknown, Tiers = unknown, Fuse = unknown> {
    version: 1;
    generatedAt: string;
    /** Data cut-off of the fit: last event id included per region. */
    dataThrough: Readonly<Record<Region, number>>;
    prior: Prior;
    curve: Curve;
    tiers: Tiers;
    fuse: Fuse;
}
