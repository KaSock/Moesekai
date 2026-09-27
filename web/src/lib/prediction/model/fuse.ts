// Fusion of the final prior with the progress estimate (F4), calibrated P10/P90 and the physical ceiling.
// Both estimates are log-normal. Their error scales and correlation are learned per cell and progress knot from
// an inner rolling backtest (scripts/prediction-backtest/fit-fuse.mjs), which gives the minimum-variance weight;
// P10/P50/P90 come from empirical quantiles of the standardised fused residual in the same cell and knot.
import type { Region } from "../../event-rules/types";
import type { LogNormalEstimate, PredictionContext, QuantileEstimate } from "./types";

const HOUR_MS = 3_600_000;
const MIN_LOG_SIGMA = 1e-4;
const Z90 = 1.2815515655446004;

/** Calibration at one progress knot; scales multiply the modules' own logSigma. */
export interface FuseKnot {
    priorScale: number;
    observedScale: number;
    /** Correlation of the standardised prior and progress-estimate errors. */
    corr: number;
    /** Quantiles of log(actual / fused median) / fused logSigma. */
    q10: number;
    q50: number;
    q90: number;
}

export interface FuseCell {
    /** Weight of the cell's own data (scope-cuts over all knots); the rest came from its parent. */
    n: number;
    /** One entry per section knot, already shrunk toward the parent cell. */
    knots: FuseKnot[];
}

export interface FuseCeiling {
    /** Ascending ranks. */
    ranks: number[];
    /** Highest one-hour gain seen at each rank or any worse rank (non-increasing in rank). */
    perHour: number[];
}

/** A cell whose rolling backtest was worse than tori-v2; predictFromSections hands it to the legacy engine. */
export interface FuseFallback {
    events: number;
    points: number;
    mape: number;
    baselineMape: number;
}

export interface FuseSection {
    version: 1;
    /** Progress knots of every cell's calibration, ascending; values between knots interpolate linearly. */
    knots: number[];
    /** Keyed by fuseCellKey and its lookup-chain parents; "*" is the root. */
    cells: Record<string, FuseCell>;
    /** Shift the median by the cell's q50 (median of the standardised residual). */
    biasCorrection: boolean;
    /** Break-time set of the newest gauge event per region in the fit; a gauge event is assumed to run it. */
    gaugeSet: Partial<Record<Region, number>>;
    /** Editions ("region|turn") that had VS-only events; a unit-less WL scope of such an edition is a VS scope. */
    vsEditions: string[];
    /** Multiplies the historical top speed in the physical ceiling. */
    ceilingMargin: number;
    ceiling: Partial<Record<Region, FuseCeiling>>;
    /** Keyed by fuseCellKey. */
    fallback: Record<string, FuseFallback>;
    /** Fit settings, for reproducibility only. */
    fit: Record<string, number | string | boolean>;
}

type KeyContext = Pick<PredictionContext, "region" | "group" | "wlTurn" | "eventId" | "breakGauge" | "unit">;

/**
 * Cell of a scope, in the backtest's cell format (scripts/prediction-backtest/dataset.mjs cellOf): finales by
 * (region, eventId), normal events by break-time set, WL scopes by group x turn plus "vs" for VS-only editions.
 */
export function fuseCellKey(ctx: KeyContext, s: Pick<FuseSection, "gaugeSet" | "vsEditions">): string {
    const turn = ctx.wlTurn ?? "-";
    if (ctx.group === "wl_finale") return `${ctx.region}|wl_finale|${turn}|#${ctx.eventId}`;
    if (ctx.group === "normal") return `${ctx.region}|normal|-|bt${ctx.breakGauge ? s.gaugeSet[ctx.region] ?? "?" : 0}`;
    const vs = ctx.unit == null && s.vsEditions.includes(`${ctx.region}|${turn}`);
    return `${ctx.region}|${ctx.group}|${turn}|${vs ? "vs" : ""}`;
}

/**
 * Next cell a key borrows from: a non-finale JP cell pools into its region x group ("jp|group"), a non-finale CN
 * cell borrows the same JP cell (CN has almost no series), finales go straight to the root "*" because editions
 * are never pooled, and a pool goes to the root.
 */
export function fuseParentKey(key: string): string | null {
    if (key === "*") return null;
    const parts = key.split("|");
    if (parts.length < 4 || parts[1] === "wl_finale") return "*";
    if (parts[0] === "cn") return ["jp", ...parts.slice(1)].join("|");
    return `${parts[0]}|${parts[1]}`;
}

/** The key followed by every cell it borrows from, nearest first, ending at "*". */
export function fuseLookupChain(key: string): string[] {
    const chain: string[] = [];
    for (let k: string | null = key; k != null; k = fuseParentKey(k)) chain.push(k);
    return chain;
}

function resolveCell(key: string, s: FuseSection): FuseCell | null {
    for (const k of fuseLookupChain(key)) {
        const cell = s.cells[k];
        if (cell && cell.knots.length === s.knots.length) return cell;
    }
    return null;
}

/** Calibration without evidence: module sigmas as they are, normal quantiles. */
export const DEFAULT_FUSE_KNOT: FuseKnot = { priorScale: 1, observedScale: 1, corr: 0, q10: -Z90, q50: 0, q90: Z90 };

/** Calibration of a cell key at `progress`, linear between knots and flat outside them. */
export function calibrationForCell(key: string, progress: number, s: FuseSection): FuseKnot {
    const cell = resolveCell(key, s);
    if (!cell || s.knots.length === 0) return DEFAULT_FUSE_KNOT;
    const k = s.knots;
    if (progress <= k[0]) return cell.knots[0];
    for (let i = 1; i < k.length; i++) {
        if (progress <= k[i]) {
            const w = (progress - k[i - 1]) / (k[i] - k[i - 1]);
            const a = cell.knots[i - 1];
            const b = cell.knots[i];
            const lerp = (x: number, y: number) => x + w * (y - x);
            return {
                priorScale: lerp(a.priorScale, b.priorScale),
                observedScale: lerp(a.observedScale, b.observedScale),
                corr: lerp(a.corr, b.corr),
                q10: lerp(a.q10, b.q10),
                q50: lerp(a.q50, b.q50),
                q90: lerp(a.q90, b.q90),
            };
        }
    }
    return cell.knots[k.length - 1];
}

/** Calibration of a scope at `progress`. */
export function calibrationAt(ctx: KeyContext, progress: number, s: FuseSection): FuseKnot {
    return calibrationForCell(fuseCellKey(ctx, s), progress, s);
}

export function fallbackFor(ctx: KeyContext, s: FuseSection): FuseFallback | null {
    return s.fallback[fuseCellKey(ctx, s)] ?? null;
}

function usable(e: LogNormalEstimate | null): e is LogNormalEstimate {
    return !!e && e.median > 0 && Number.isFinite(e.median) && Number.isFinite(e.logSigma) && e.logSigma >= 0;
}

/** Minimum-variance weight of the progress estimate given both variances and their covariance, in [0, 1]. */
export function fusionWeight(priorVar: number, observedVar: number, cov: number): number {
    const den = priorVar + observedVar - 2 * cov;
    if (!(den > 0)) return observedVar <= priorVar ? 1 : 0;
    return Math.min(1, Math.max(0, (priorVar - cov) / den));
}

/** Fused log median and log sd before calibration quantiles; null without any usable estimate. */
export function fuseLog(
    prior: LogNormalEstimate | null,
    observed: LogNormalEstimate | null,
    progress: number,
    cal: FuseKnot,
    firstKnot: number,
): { mu: number; sd: number; weight: number } | null {
    const hasPrior = usable(prior);
    const hasObs = usable(observed);
    if (!hasPrior && !hasObs) return null;
    const vp = hasPrior ? (cal.priorScale * Math.max(prior.logSigma, MIN_LOG_SIGMA)) ** 2 : Infinity;
    const vo = hasObs ? (cal.observedScale * observed.logSigma) ** 2 : Infinity;
    if (!hasPrior) return { mu: Math.log(observed!.median), sd: Math.sqrt(vo), weight: 1 };
    if (!hasObs) return { mu: Math.log(prior.median), sd: Math.sqrt(vp), weight: 0 };
    const cov = cal.corr * Math.sqrt(vp * vo);
    let w = fusionWeight(vp, vo, cov);
    // Before the first knot there is no backtest evidence; the progress estimate fades out toward the start.
    if (progress < firstKnot && firstKnot > 0) w *= Math.max(0, progress) / firstKnot;
    const v = w * w * vo + (1 - w) * (1 - w) * vp + 2 * w * (1 - w) * cov;
    return { mu: w * Math.log(observed.median) + (1 - w) * Math.log(prior.median), sd: Math.sqrt(Math.max(v, 0)), weight: w };
}

function speedAt(table: FuseCeiling, rank: number): number {
    const { ranks, perHour } = table;
    if (ranks.length === 0 || rank < ranks[0]) return Infinity;
    for (let i = 0; i < ranks.length; i++) {
        if (ranks[i] === rank) return perHour[i];
        // Between two known ranks the better rank's (higher) speed keeps the bound conservative.
        if (ranks[i] > rank) return perHour[i - 1];
    }
    return perHour[perHour.length - 1];
}

/**
 * Highest final the tier can physically reach: its current score plus the fastest one-hour gain ever seen at
 * that rank (or any worse rank) sustained for every remaining hour. Infinity when the rank has no history or the
 * current score is unknown (<= 0).
 */
export function physicalCeiling(ctx: Pick<PredictionContext, "region">, rank: number, currentScore: number, remainingHours: number, s: FuseSection): number {
    const table = s.ceiling[ctx.region];
    if (!table || !(currentScore > 0)) return Infinity;
    return currentScore + speedAt(table, rank) * s.ceilingMargin * Math.max(0, remainingHours);
}

/** Clamps a quantile triple into [currentScore, ceiling] (currentScore <= 0 means unknown: no floor). */
export function clampQuantiles(q: QuantileEstimate, currentScore: number, ceiling: number): QuantileEstimate {
    const lo = currentScore > 0 ? currentScore : 0;
    const hi = Math.max(lo, ceiling);
    const c = (x: number) => Math.min(hi, Math.max(lo, x));
    return { p10: c(q.p10), p50: c(q.p50), p90: c(q.p90) };
}

/**
 * Calibrated P10/P50/P90 of the minimum-variance blend of the prior and the progress estimate, before the floor
 * and the ceiling; null without any usable estimate.
 */
export function fuseQuantiles(
    ctx: KeyContext,
    prior: LogNormalEstimate | null,
    observed: LogNormalEstimate | null,
    progress: number,
    s: FuseSection,
): QuantileEstimate | null {
    const p = Math.min(1, Math.max(0, progress));
    const cal = calibrationAt(ctx, p, s);
    const fused = fuseLog(prior, observed, p, cal, s.knots[0] ?? 0);
    if (!fused) return null;
    const { mu, sd } = fused;
    const p10 = Math.exp(mu + cal.q10 * sd);
    const p90 = Math.exp(mu + cal.q90 * sd);
    const p50 = Math.min(p90, Math.max(p10, Math.exp(mu + (s.biasCorrection ? cal.q50 : 0) * sd)));
    return { p10, p50, p90 };
}

/**
 * Fused final estimate of one tier: fuseQuantiles floored at the current score and capped by the physical
 * ceiling over the time left after `progress`. Without any usable estimate the current score is returned for all
 * three quantiles.
 */
export function fuseEstimates(
    ctx: PredictionContext,
    rank: number,
    prior: LogNormalEstimate | null,
    observed: LogNormalEstimate | null,
    progress: number,
    currentScore: number,
    s: FuseSection,
): QuantileEstimate {
    const q = fuseQuantiles(ctx, prior, observed, progress, s);
    const cur = currentScore > 0 ? currentScore : 0;
    if (!q) return { p10: cur, p50: cur, p90: cur };
    const p = Math.min(1, Math.max(0, progress));
    const remainingHours = (1 - p) * Math.max(0, ctx.scopeEndAt - ctx.scopeStartAt) / HOUR_MS;
    return clampQuantiles(q, currentScore, physicalCeiling(ctx, rank, currentScore, remainingHours, s));
}
