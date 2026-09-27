// Cross-tier relations (F3). Along a cell's rank ladder, final log-ratios between adjacent tiers follow a
// Gaussian prior fitted on past scopes (AR(1)-correlated steps). Single-tier estimates made at the same
// moment have correlated errors (a tier's share of its final moves with its neighbours'), modelled as a
// common factor plus a Markov chain along the ladder. Generalised least squares then reduces single-tier
// noise and fills ladder tiers that have no estimate.
import type { PredictionContext, LogNormalEstimate, QuantileEstimate } from "./types";

/** Relation between two adjacent ladder ranks (upper = better rank). */
export interface TierPair {
    /** Expected log(final_lower / final_upper) for a new scope of the cell. */
    logRatio: number;
    /** Predictive SD of that log ratio. */
    logRatioSigma: number;
    /**
     * Correlation over past scopes of the two tiers' log(current / final) at each progress knot, i.e. of
     * their single-tier estimation errors; null when no past scope has both series.
     */
    errorCorr: number[] | null;
    /** Own-cell scopes behind logRatio and errorCorr. */
    n: number;
    nSeries: number;
}

export interface TiersCell {
    /** Ladder ranks, ascending; empty for a cell that must pass estimates through without borrowing a family. */
    ranks: number[];
    /** pairs[i] links ranks[i] and ranks[i + 1]; null breaks the ladder there. */
    pairs: (TierPair | null)[];
    /** Correlation of consecutive standardised log-ratio residuals along the ladder. */
    ratioCorr: number;
    /** Error correlation shared by every pair of tiers at each progress knot; null without series. */
    commonCorr: number[] | null;
    /**
     * Adjust estimated tiers; when false (no series, or the rolling backtest showed no gain) they pass through
     * and only missing ladder tiers are filled.
     */
    adjust: boolean;
}

export interface TiersSection {
    version: 1;
    progressKnots: number[];
    /** Keyed by tiersCellKey(ctx). */
    cells: Record<string, TiersCell>;
    /** Pooled cells keyed by tiersFamilyKey(ctx); used for a cell without data of its own. */
    families: Record<string, TiersCell>;
}

type CellKeyInput = Pick<PredictionContext, "region" | "group" | "wlTurn" | "eventId" | "breakGauge" | "unit">;

/**
 * Cell of the tiers fit. Finales are keyed by (region, eventId) and never share a family; normal events
 * split by break gauge; WL chapter and overall scopes by group, turn and whether the edition is
 * unit-themed (VS and mixed-member editions have no unit), so VS chapters never share a cell with unit
 * chapters of the same length.
 */
export function tiersCellKey(ctx: CellKeyInput): string {
    if (ctx.group === "wl_finale") return `${ctx.region}|wl_finale|#${ctx.eventId}`;
    if (ctx.group === "normal") return `${ctx.region}|normal|${ctx.breakGauge ? "gauge" : "base"}`;
    return `${ctx.region}|${ctx.group}|${ctx.wlTurn ?? "unknown"}|${ctx.unit != null ? "unit" : "nounit"}`;
}

export function tiersFamilyKey(ctx: CellKeyInput): string | null {
    return ctx.group === "wl_finale" ? null : `${ctx.region}|${ctx.group}`;
}

export const DEFAULT_PROGRESS_KNOTS: readonly number[] = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.97];

const MIN_LOG_SIGMA = 1e-3;
const MAX_CORR = 0.98;
const Z90 = 1.2815515655446004;

export function lookupTiersCell(ctx: CellKeyInput, s: TiersSection): TiersCell | null {
    const own = s.cells[tiersCellKey(ctx)];
    if (own) return own;
    const family = tiersFamilyKey(ctx);
    return family ? s.families[family] ?? null : null;
}

/** Piecewise-linear in progress, flat outside the knots. */
export function valueAtProgress(knots: readonly number[], values: readonly number[], progress: number): number {
    if (progress <= knots[0]) return values[0];
    for (let i = 1; i < knots.length; i++) {
        if (progress <= knots[i]) {
            const f = (progress - knots[i - 1]) / (knots[i] - knots[i - 1]);
            return values[i - 1] + f * (values[i] - values[i - 1]);
        }
    }
    return values[values.length - 1];
}

type Matrix = number[][];

function zeros(n: number, m = n): Matrix {
    return Array.from({ length: n }, () => new Array<number>(m).fill(0));
}

/** Precision of a unit-variance AR(1) vector with step correlations rho[j] (tridiagonal). */
function markovPrecision(rho: readonly number[]): Matrix {
    const q = rho.length + 1;
    const p = zeros(q);
    p[0][0] = 1;
    rho.forEach((r, j) => {
        const c = 1 / (1 - r * r);
        p[j][j] += r * r * c;
        p[j + 1][j + 1] += c;
        p[j][j + 1] -= r * c;
        p[j + 1][j] -= r * c;
    });
    return p;
}

function cholesky(a: Matrix): Matrix {
    const n = a.length;
    const l = zeros(n);
    for (let j = 0; j < n; j++) {
        let d = a[j][j];
        for (let k = 0; k < j; k++) d -= l[j][k] * l[j][k];
        if (!(d > 0)) throw new Error("tiers: matrix is not positive definite");
        l[j][j] = Math.sqrt(d);
        for (let i = j + 1; i < n; i++) {
            let v = a[i][j];
            for (let k = 0; k < j; k++) v -= l[i][k] * l[j][k];
            l[i][j] = v / l[j][j];
        }
    }
    return l;
}

function choleskySolve(l: Matrix, rhs: readonly number[]): number[] {
    const n = rhs.length;
    const z = rhs.slice();
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < i; k++) z[i] -= l[i][k] * z[k];
        z[i] /= l[i][i];
    }
    for (let i = n - 1; i >= 0; i--) {
        for (let k = i + 1; k < n; k++) z[i] -= l[k][i] * z[k];
        z[i] /= l[i][i];
    }
    return z;
}

function inverse(a: Matrix): Matrix {
    const l = cholesky(a);
    const n = a.length;
    const cols = Array.from({ length: n }, (_, i) => {
        const e = new Array<number>(n).fill(0);
        e[i] = 1;
        return choleskySolve(l, e);
    });
    return cols.map((_, i) => cols.map((col) => col[i]));
}

/**
 * Prior precision and linear term of the ladder values x over one segment: the steps x[k+1] - x[k] are
 * N(logRatio_k, logRatioSigma_k^2) with AR(1) correlation `ratioCorr` between consecutive steps.
 * The level is left free (improper prior), so estimates are needed to pin it.
 */
function ladderPrior(pairs: readonly TierPair[], ratioCorr: number): { p: Matrix; b: number[] } {
    const m = pairs.length + 1;
    const p = zeros(m);
    const b = new Array<number>(m).fill(0);
    if (pairs.length === 0) return { p, b };
    const stepPrecision = markovPrecision(pairs.slice(1).map(() => ratioCorr));
    const tau = pairs.map((x) => x.logRatioSigma);
    for (let k = 0; k < pairs.length; k++) {
        for (let l = 0; l < pairs.length; l++) {
            const w = stepPrecision[k][l] / (tau[k] * tau[l]);
            if (w === 0) continue;
            // (x[k+1] - x[k] - d_k) * w * (x[l+1] - x[l] - d_l)
            p[k + 1][l + 1] += w;
            p[k][l] += w;
            p[k + 1][l] -= w;
            p[k][l + 1] -= w;
            b[k + 1] += w * pairs[l].logRatio;
            b[k] -= w * pairs[l].logRatio;
        }
    }
    return { p, b };
}

interface Observation {
    pos: number;
    y: number;
    s: number;
}

/** Error correlation matrix of the estimated positions: common factor plus a Markov chain along the ladder. */
function errorCorrelation(
    obs: readonly Observation[],
    pairs: readonly TierPair[],
    commonCorr: readonly number[] | null,
    knots: readonly number[],
    progress: number,
): Matrix {
    const q = obs.length;
    const common = commonCorr ? Math.min(Math.max(valueAtProgress(knots, commonCorr, progress), 0), MAX_CORR) : 0;
    const step = pairs.map((p) => {
        if (!p.errorCorr || common >= MAX_CORR) return 0;
        const adjacent = valueAtProgress(knots, p.errorCorr, progress);
        return Math.min(Math.max((adjacent - common) / (1 - common), 0), MAX_CORR);
    });
    const r = zeros(q);
    for (let i = 0; i < q; i++) {
        r[i][i] = 1;
        let chain = 1;
        for (let j = i + 1; j < q; j++) {
            for (let k = obs[j - 1].pos; k < obs[j].pos; k++) chain *= step[k];
            r[i][j] = r[j][i] = common + (1 - common) * chain;
        }
    }
    return r;
}

function observationPrecision(obs: readonly Observation[], corr: Matrix): Matrix {
    const q = obs.length;
    const cov = zeros(q);
    for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) cov[i][j] = corr[i][j] * obs[i].s * obs[j].s;
    return inverse(cov);
}

/** GLS over one segment: prior on the ladder plus correlated estimates. Returns every position. */
function solveSegment(pairs: readonly TierPair[], ratioCorr: number, obs: readonly Observation[], obsPrecision: Matrix): LogNormalEstimate[] {
    const { p, b } = ladderPrior(pairs, ratioCorr);
    obs.forEach((oi, i) => {
        obs.forEach((oj, j) => {
            p[oi.pos][oj.pos] += obsPrecision[i][j];
            b[oi.pos] += obsPrecision[i][j] * oj.y;
        });
    });
    const cov = inverse(p);
    const x = cov.map((row) => row.reduce((sum, v, j) => sum + v * b[j], 0));
    return x.map((xi, i) => ({ median: Math.exp(xi), logSigma: Math.sqrt(Math.max(cov[i][i], 0)) }));
}

/**
 * Fill-only: estimated positions stay as given; each missing position is its conditional distribution
 * under the ladder prior given the estimated positions, plus the propagated estimate errors.
 */
function fillSegment(pairs: readonly TierPair[], ratioCorr: number, obs: readonly Observation[], obsCov: Matrix): Map<number, LogNormalEstimate> {
    const out = new Map<number, LogNormalEstimate>();
    const m = pairs.length + 1;
    const observed = new Set(obs.map((o) => o.pos));
    const missing = Array.from({ length: m }, (_, i) => i).filter((i) => !observed.has(i));
    if (missing.length === 0) return out;
    const { p, b } = ladderPrior(pairs, ratioCorr);
    const puu = missing.map((i) => missing.map((j) => p[i][j]));
    const cuu = inverse(puu);
    // mean = Cuu (b_U - P_UO y_O); gain M = -Cuu P_UO.
    const rhs = missing.map((i) => b[i] - obs.reduce((sum, o) => sum + p[i][o.pos] * o.y, 0));
    const gain = missing.map((_, a) => obs.map((o) => -missing.reduce((sum, j, c) => sum + cuu[a][c] * p[j][o.pos], 0)));
    missing.forEach((pos, a) => {
        const mean = cuu[a].reduce((sum, v, c) => sum + v * rhs[c], 0);
        let variance = cuu[a][a];
        for (let i = 0; i < obs.length; i++) for (let j = 0; j < obs.length; j++) variance += gain[a][i] * obsCov[i][j] * gain[a][j];
        out.set(pos, { median: Math.exp(mean), logSigma: Math.sqrt(Math.max(variance, 0)) });
    });
    return out;
}

/**
 * Cross-tier adjustment of single-tier final estimates.
 *
 * `estimates` are observation-based single-tier estimates made at `atMs` (current score over expected
 * share, with its log sigma), not prior-fused ones: the historical tier ratios enter here, the prior
 * enters in the fuse step. Returns every input tier (median adjusted when the cell allows it, sigma kept)
 * plus every ladder tier of the cell connected to an estimated tier; ranks outside the ladder pass
 * through. Without `atMs` the error correlation cannot be placed in time, so estimated tiers pass
 * through and only missing ladder tiers are filled. A finale has no cell until it has data of its own,
 * so its estimates pass through unchanged, which keeps any T1000/T1500 cliff they show.
 */
export function adjustAcrossTiers(
    ctx: PredictionContext,
    estimates: ReadonlyMap<number, LogNormalEstimate>,
    s: TiersSection,
    atMs?: number,
): Map<number, LogNormalEstimate> {
    const out = new Map<number, LogNormalEstimate>();
    for (const [rank, e] of estimates) out.set(rank, { median: e.median, logSigma: e.logSigma });
    const cell = lookupTiersCell(ctx, s);
    if (!cell) return out;

    const duration = ctx.scopeEndAt - ctx.scopeStartAt;
    const progress = atMs == null || !(duration > 0)
        ? null
        : Math.min(Math.max((atMs - ctx.scopeStartAt) / duration, 0), 1);
    const adjust = cell.adjust && progress != null;

    let start = 0;
    for (let end = 0; end < cell.ranks.length; end++) {
        if (end < cell.pairs.length && cell.pairs[end]) continue;
        const pairs = cell.pairs.slice(start, end) as TierPair[];
        const obs: Observation[] = [];
        for (let i = start; i <= end; i++) {
            const e = estimates.get(cell.ranks[i]);
            if (e && e.median > 0 && Number.isFinite(e.median) && Number.isFinite(e.logSigma)) {
                obs.push({ pos: i - start, y: Math.log(e.median), s: Math.max(e.logSigma, MIN_LOG_SIGMA) });
            }
        }
        if (obs.length > 0) {
            if (adjust) {
                const corr = errorCorrelation(obs, pairs, cell.commonCorr, s.progressKnots, progress);
                const solved = solveSegment(pairs, cell.ratioCorr, obs, observationPrecision(obs, corr));
                const observed = new Set(obs.map((o) => o.pos));
                solved.forEach((est, i) => {
                    const rank = cell.ranks[start + i];
                    // Backtests show the GLS variance reduction is overconfident, so estimated tiers keep their sigma.
                    out.set(rank, observed.has(i) ? { median: est.median, logSigma: estimates.get(rank)!.logSigma } : est);
                });
            } else {
                const cov = obs.map((oi) => obs.map((oj) => (oi === oj ? oi.s * oi.s : 0)));
                for (const [i, est] of fillSegment(pairs, cell.ratioCorr, obs, cov)) out.set(cell.ranks[start + i], est);
            }
        }
        start = end + 1;
    }
    return out;
}

/** Log-normal estimate to P10 / P50 / P90. */
export function logNormalQuantiles(e: LogNormalEstimate): QuantileEstimate {
    return {
        p10: e.median * Math.exp(-Z90 * e.logSigma),
        p50: e.median,
        p90: e.median * Math.exp(Z90 * e.logSigma),
    };
}

/** Weighted pool-adjacent-violators fit of a non-increasing sequence. */
function isotonicNonIncreasing(values: readonly number[], weights: readonly number[]): number[] {
    const blocks: { value: number; weight: number; count: number }[] = [];
    for (let i = 0; i < values.length; i++) {
        blocks.push({ value: values[i], weight: weights[i], count: 1 });
        while (blocks.length > 1 && blocks[blocks.length - 2].value < blocks[blocks.length - 1].value) {
            const top = blocks.pop()!;
            const prev = blocks[blocks.length - 1];
            const weight = prev.weight + top.weight;
            prev.value = (prev.value * prev.weight + top.value * top.weight) / weight;
            prev.weight = weight;
            prev.count += top.count;
        }
    }
    const out: number[] = [];
    for (const blk of blocks) for (let k = 0; k < blk.count; k++) out.push(blk.value);
    return out;
}

/**
 * Makes P10, P50 and P90 each non-increasing in rank by weighted isotonic regression (weight = inverse
 * squared relative P10-P90 width, so a precise tier moves less than a vague neighbour). Tiers that do
 * not violate the order are untouched, so a steep drop such as the finale T1000/T1500 cliff is kept.
 * The same weights for all three quantiles keep p10 <= p50 <= p90.
 */
export function enforceMonotone(q: ReadonlyMap<number, QuantileEstimate>): Map<number, QuantileEstimate> {
    const ranks = [...q.keys()].sort((x, y) => x - y);
    const rows = ranks.map((r) => q.get(r)!);
    const weights = rows.map((e) => {
        const width = (e.p90 - e.p10) / Math.max(e.p50, 1);
        return 1 / Math.max(width, 1e-3) ** 2;
    });
    const p10 = isotonicNonIncreasing(rows.map((e) => e.p10), weights);
    const p50 = isotonicNonIncreasing(rows.map((e) => e.p50), weights);
    const p90 = isotonicNonIncreasing(rows.map((e) => e.p90), weights);
    return new Map(ranks.map((r, i) => [r, { p10: p10[i], p50: p50[i], p90: p90[i] }]));
}
