// Single prediction path shared by the rolling backtest (scripts/prediction-backtest) and lib/prediction-engine.ts:
// progress estimates (current / expected share) -> cross-tier adjustment -> fusion with the final prior ->
// monotone quantiles across ranks -> floor at the current score and the physical ceiling -> running minimum
// over ranks.
import { expectedShare, shareLogSigma } from "./curve.ts";
import { clampQuantiles, fallbackFor, fuseQuantiles, physicalCeiling } from "./fuse.ts";
import { finalPrior } from "./prior.ts";
import { adjustAcrossTiers, enforceMonotone } from "./tiers.ts";
import type { CurveSection } from "./curve";
import type { FuseSection } from "./fuse";
import type { PriorSection } from "./prior";
import type { TiersSection } from "./tiers";
import type { LogNormalEstimate, PredictionContext, PriorsFile, QuantileEstimate } from "./types";

const HOUR_MS = 3_600_000;
/** Below this expected share the current score says too little about the final to divide by it. */
export const MIN_EXPECTED_SHARE = 0.002;

export type PredictionSections = Pick<PriorsFile<PriorSection, CurveSection, TiersSection, FuseSection>, "prior" | "curve" | "tiers" | "fuse">;
export type ComponentSections = Pick<PredictionSections, "prior" | "curve" | "tiers">;

export interface ObservedTier {
    rank: number;
    score: number;
    /** Time of the score; defaults to atMs. */
    at?: number;
    points?: ReadonlyArray<readonly [number, number]>;
}

export interface TierComponents {
    rank: number;
    /** Latest observed score, null when the rank was not observed. */
    currentScore: number | null;
    /** Time of currentScore. */
    currentAt: number | null;
    prior: LogNormalEstimate | null;
    /** Progress estimate after the cross-tier adjustment (also fills unobserved ladder ranks). */
    observed: LogNormalEstimate | null;
}

export interface PredictOptions {
    /** Ranks to return; default the observed ranks. */
    ranks?: readonly number[];
    /** tori-v2 behaviour for a fallback cell; without it such a cell returns null. */
    legacy?: () => ReadonlyMap<number, QuantileEstimate> | null;
}

function latestByRank(ctx: PredictionContext, atMs: number, observed: readonly ObservedTier[]): Map<number, { score: number; at: number }> {
    const out = new Map<number, { score: number; at: number }>();
    for (const o of observed) {
        const at = Math.min(o.at ?? atMs, atMs);
        if (!(o.rank > 0) || !Number.isFinite(o.score) || o.score < 0 || !Number.isFinite(at) || at < ctx.scopeStartAt) continue;
        const prev = out.get(o.rank);
        if (!prev || at >= prev.at) out.set(o.rank, { score: o.score, at });
    }
    return out;
}

/** Prior and progress estimate of every requested rank (default: the observed ranks), before fusion. */
export function componentEstimates(
    sections: ComponentSections,
    ctx: PredictionContext,
    atMs: number,
    observedTiers: readonly ObservedTier[],
    ranks?: readonly number[],
): Map<number, TierComponents> {
    const latest = latestByRank(ctx, atMs, observedTiers);
    const single = new Map<number, LogNormalEstimate>();
    for (const [rank, o] of latest) {
        if (!(o.score > 0)) continue;
        const share = expectedShare(ctx, o.at, sections.curve, rank);
        if (!(share >= MIN_EXPECTED_SHARE)) continue;
        single.set(rank, { median: o.score / share, logSigma: shareLogSigma(ctx, o.at, sections.curve, rank) });
    }
    const adjusted = adjustAcrossTiers(ctx, single, sections.tiers, atMs);
    const out = new Map<number, TierComponents>();
    const wanted = ranks ? [...new Set(ranks)] : [...latest.keys()];
    for (const rank of wanted.sort((a, b) => a - b)) {
        out.set(rank, {
            rank,
            currentScore: latest.get(rank)?.score ?? null,
            currentAt: latest.get(rank)?.at ?? null,
            prior: finalPrior(ctx, rank, sections.prior),
            observed: adjusted.get(rank) ?? null,
        });
    }
    return out;
}

/**
 * Fuses components into quantiles, makes them non-increasing in rank, then floors each rank at its current score
 * and caps it by the physical ceiling over the time left after that score was observed. Tiers observed at
 * different times get ceilings out of rank order, so a running minimum over ascending ranks (per quantile) follows
 * the clamp; it only lowers values, which keeps the ceiling, the floor (current scores fall with rank) and
 * P10 <= P50 <= P90.
 */
export function fuseComponents(ctx: PredictionContext, atMs: number, components: ReadonlyMap<number, TierComponents>, fuse: FuseSection): Map<number, QuantileEstimate> {
    const span = ctx.scopeEndAt - ctx.scopeStartAt;
    const progress = span > 0 ? Math.min(1, Math.max(0, (atMs - ctx.scopeStartAt) / span)) : 1;
    const fused = new Map<number, QuantileEstimate>();
    for (const c of components.values()) {
        const q = fuseQuantiles(ctx, c.prior, c.observed, progress, fuse);
        if (q) fused.set(c.rank, q);
    }
    const monotone = enforceMonotone(fused);
    const out = new Map<number, QuantileEstimate>();
    let above: QuantileEstimate = { p10: Infinity, p50: Infinity, p90: Infinity };
    for (const rank of [...monotone.keys()].sort((a, b) => a - b)) {
        const c = components.get(rank);
        const current = c?.currentScore ?? 0;
        const remainingHours = Math.max(0, ctx.scopeEndAt - Math.min(c?.currentAt ?? atMs, atMs)) / HOUR_MS;
        const q = clampQuantiles(monotone.get(rank)!, current, physicalCeiling(ctx, rank, current, remainingHours, fuse));
        above = { p10: Math.min(above.p10, q.p10), p50: Math.min(above.p50, q.p50), p90: Math.min(above.p90, q.p90) };
        out.set(rank, above);
    }
    return out;
}

/**
 * Final P10/P50/P90 per rank. Returns null for a cell recorded as a tori-v2 fallback in priors.json unless
 * `options.legacy` supplies that behaviour.
 */
export function predictFromSections(
    sections: PredictionSections,
    ctx: PredictionContext,
    atMs: number,
    observedTiers: readonly ObservedTier[],
    options: PredictOptions = {},
): Map<number, QuantileEstimate> | null {
    if (fallbackFor(ctx, sections.fuse)) {
        const legacy = options.legacy?.();
        return legacy ? new Map(legacy) : null;
    }
    const components = componentEstimates(sections, ctx, atMs, observedTiers, options.ranks);
    return fuseComponents(ctx, atMs, components, sections.fuse);
}
