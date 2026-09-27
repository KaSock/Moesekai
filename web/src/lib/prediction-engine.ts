/**
 * PJSK event ranking prediction engine.
 *
 * The model lives in lib/prediction/model (prior, curve, tiers, fuse); predictFromSections is the single
 * entry point shared with the rolling backtest (scripts/prediction-backtest), so the backtested code path is
 * the shipped one. Parameters come from lib/prediction/priors.json, fitted per edition (group x WL turn x
 * region, finales per event) by the fit-*.mjs scripts. Cells whose backtest lost to the previous engine are
 * listed in priors.json fuse.fallback and run that engine (lib/prediction/legacy/tori-v2.ts, the same frozen code
 * as the backtest's tori-v2 baseline). This file adapts one tier's history to the model and shapes the page's output.
 */

import type { ServerType } from "@/types/prediction";
import { calculateEventPrediction as toriV2Prediction } from "./prediction/legacy/tori-v2.ts";
import { projectPath } from "./prediction/model/curve.ts";
import { predictFromSections } from "./prediction/model/predict.ts";
import type { ObservedTier, PredictionSections } from "./prediction/model/predict";
import type { PredictionContext, QuantileEstimate } from "./prediction/model/types";
import PRIORS_JSON from "./prediction/priors.json";

export type { PredictionSections } from "./prediction/model/predict";

export interface PredictionEngineInput {
    server: ServerType;
    rank: number;
    startAt: number;
    endAt: number;
    historyPoints: { t: string | number; y: number }[];
    /** Event, scope and same-moment tiers; the model reads the scope window from here. */
    context: PredictionContext;
}

export interface PredictionEngineOutput {
    currentScore: number;
    predictedScore: number;       // P50
    predictedScoreP10: number;
    predictedScoreP90: number;
    effectiveHourlySpeed: number;
    rolling24hSpeed: number;
    progress: number;
    isJpRestActive: boolean;
    predictPoints: { t: string; y: number }[];
}

const PRIORS = PRIORS_JSON as unknown as PredictionSections;

const HOUR_MS = 3_600_000;

// ─── Observed velocity (display only: rolling 24 h speed) ────────────────────

interface VelocityPoint {
    t: number;
    dtHours: number;
    speed: number;
}

/** Per-interval speeds smoothed by a 5-point running median (absorbs MySekai stamina dumps). */
function extractFilteredVelocities(points: ReadonlyArray<readonly [number, number]>): VelocityPoint[] {
    const raw: VelocityPoint[] = [];
    for (let i = 1; i < points.length; i++) {
        const [tPrev, yPrev] = points[i - 1];
        const [tCurr, yCurr] = points[i];
        const dtHours = (tCurr - tPrev) / HOUR_MS;
        if (dtHours <= 0) continue;
        raw.push({ t: tCurr, dtHours, speed: Math.max(0, yCurr - yPrev) / dtHours });
    }

    const windowSize = 5;
    return raw.map((r, i) => {
        const start = Math.max(0, i - Math.floor(windowSize / 2));
        const end = Math.min(raw.length, i + Math.ceil(windowSize / 2));
        const speeds = raw.slice(start, end).map((v) => v.speed).sort((a, b) => a - b);
        return { t: r.t, dtHours: r.dtHours, speed: speeds[Math.floor(speeds.length / 2)] };
    });
}

function rolling24hSpeedOf(points: ReadonlyArray<readonly [number, number]>, nowMs: number, elapsedHours: number, currentScore: number): number {
    const recent = extractFilteredVelocities(points).filter((d) => nowMs - d.t <= 24 * HOUR_MS);
    const hours = recent.reduce((acc, d) => acc + d.dtHours, 0);
    if (hours <= 0) return currentScore / elapsedHours;
    return recent.reduce((acc, d) => acc + d.speed * d.dtHours, 0) / hours;
}

// ─── Model adapter ───────────────────────────────────────────────────────────

/**
 * The other tiers' same-moment scores from the context plus the predicted tier's latest score, in the
 * backtest's observation shape. The callers end each tier's history on the snapshot, so every call for one
 * snapshot sees the same observations and the tiers stay jointly consistent (predictFromSections enforces
 * monotone quantiles across them).
 */
function observedTiers(rank: number, currentScore: number, atMs: number, ctx: PredictionContext): ObservedTier[] {
    const byRank = new Map<number, number>();
    for (const t of ctx.otherTiers) byRank.set(t.rank, t.score);
    if (currentScore > 0) byRank.set(rank, currentScore);
    else byRank.delete(rank);
    return [...byRank]
        .sort((a, b) => a[0] - b[0])
        .map(([r, score]) => ({ rank: r, score, at: atMs, points: [[atMs, score]] }));
}

function roundedQuantiles(q: QuantileEstimate | undefined, currentScore: number): { p10: number; p50: number; p90: number } {
    if (!q || ![q.p10, q.p50, q.p90].every(Number.isFinite)) {
        return { p10: currentScore, p50: currentScore, p90: currentScore };
    }
    const p50 = Math.max(currentScore, Math.round(q.p50));
    return {
        p10: Math.min(p50, Math.max(currentScore, Math.round(q.p10))),
        p50,
        p90: Math.max(p50, Math.round(q.p90)),
    };
}

interface SnapshotEstimates {
    sections: PredictionSections;
    key: string;
    estimates: Map<number, QuantileEstimate> | null;
}

/**
 * Callers predict every tier of one snapshot with one (immutable) context object, and the fused estimates
 * depend only on the snapshot, so the last result per context is reused across its tiers.
 */
const lastEstimates = new WeakMap<PredictionContext, SnapshotEstimates>();

/** predictFromSections for one snapshot; null for a cell recorded as a tori-v2 fallback. */
function snapshotEstimates(
    sections: PredictionSections,
    ctx: PredictionContext,
    atMs: number,
    observed: readonly ObservedTier[],
    ranks: readonly number[],
): Map<number, QuantileEstimate> | null {
    const key = `${atMs}|${observed.map((o) => `${o.rank}:${o.score}`).join(",")}|${ranks.join(",")}`;
    const hit = lastEstimates.get(ctx);
    if (hit && hit.sections === sections && hit.key === key) return hit.estimates;
    const estimates = predictFromSections(sections, ctx, atMs, observed, { ranks });
    lastEstimates.set(ctx, { sections, key, estimates });
    return estimates;
}

/** The previous engine with the inputs the site passed it (990 bonus for WL scopes, chapter character). */
function legacyPrediction(input: PredictionEngineInput): PredictionEngineOutput {
    const ctx = input.context;
    const isWl = ctx.group !== "normal";
    const out = toriV2Prediction({
        server: input.server,
        rank: input.rank,
        startAt: ctx.scopeStartAt,
        endAt: ctx.scopeEndAt,
        historyPoints: input.historyPoints,
        bonusPercent: isWl ? 990 : 475,
        ...(ctx.chapterCharacterId != null
            ? { characterId: ctx.chapterCharacterId }
            : { eventType: isWl ? "world_bloom" : undefined }),
    });
    return { ...out, isJpRestActive: ctx.breakGauge };
}

// ─── Core calculation ────────────────────────────────────────────────────────

export function calculateEventPrediction(input: PredictionEngineInput, sections: PredictionSections = PRIORS): PredictionEngineOutput {
    const { rank, historyPoints, context } = input;
    const startAt = context.scopeStartAt;
    const endAt = context.scopeEndAt;
    const isRestActive = context.breakGauge;

    if (!historyPoints || historyPoints.length === 0) {
        return {
            currentScore: 0,
            predictedScore: 0,
            predictedScoreP10: 0,
            predictedScoreP90: 0,
            effectiveHourlySpeed: 0,
            rolling24hSpeed: 0,
            progress: 0,
            isJpRestActive: isRestActive,
            predictPoints: [],
        };
    }

    const points = historyPoints.map((p) => [new Date(p.t).getTime(), p.y] as const);
    const [latestTime, currentScore] = points[points.length - 1];

    const totalDurationHours = Math.max(1, (endAt - startAt) / HOUR_MS);
    const elapsedHours = Math.max(0.1, (latestTime - startAt) / HOUR_MS);
    const remainingHours = Math.max(0, (endAt - latestTime) / HOUR_MS);
    const progress = Math.min(1.0, elapsedHours / totalDurationHours);

    if (remainingHours <= 0 || progress >= 0.999) {
        return {
            currentScore,
            predictedScore: currentScore,
            predictedScoreP10: currentScore,
            predictedScoreP90: currentScore,
            effectiveHourlySpeed: 0,
            rolling24hSpeed: 0,
            progress: 1.0,
            isJpRestActive: isRestActive,
            predictPoints: points.map(([t, y]) => ({ t: new Date(t).toISOString(), y })),
        };
    }

    const observed = observedTiers(rank, currentScore, latestTime, context);
    const ranks = [...new Set([...observed.map((o) => o.rank), rank])].sort((a, b) => a - b);
    const estimates = snapshotEstimates(sections, context, latestTime, observed, ranks);
    if (!estimates) return legacyPrediction(input);
    const { p10, p50, p90 } = roundedQuantiles(estimates.get(rank), currentScore);

    const stepHours = Math.max(2, Math.min(6, Math.floor(remainingHours / 20)));
    const predictPoints = projectPath(context, latestTime, currentScore, p50, stepHours * HOUR_MS, sections.curve, rank)
        .map((p) => ({ t: new Date(p.t).toISOString(), y: p.y }));

    return {
        currentScore,
        predictedScore: p50,
        predictedScoreP10: p10,
        predictedScoreP90: p90,
        effectiveHourlySpeed: Math.round((p50 - currentScore) / remainingHours),
        rolling24hSpeed: Math.round(rolling24hSpeedOf(points, latestTime, elapsedHours, currentScore)),
        progress,
        isJpRestActive: isRestActive,
        predictPoints,
    };
}
