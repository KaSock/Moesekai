// Final-score prior per tier: log(final) from a per-region event-date trend of normal events, plus group, cell and
// optional unit / banner / chapter-character offsets fitted by scripts/prediction-backtest/fit-prior.mjs.
// CN scopes with a JP same-id final use that final times the fitted CN/JP ratio instead.
import type { EventGroup, Region } from "../../event-rules/types";
import type { LogNormalEstimate, PredictionContext } from "./types";

export const YEAR_MS = 365.25 * 24 * 3_600_000;
const HOUR_MS = 3_600_000;
/** Normal events without a unit (mixed-unit events). */
export const MIXED_UNIT = "mixed";

export interface PriorBaseTier {
    rank: number;
    /** Normal events of this tier in the fit. */
    n: number;
    /** log(final) at xRef and hoursRef, without gauge and unit / banner offsets. */
    a: number;
    /** Trend per year after the last knot. */
    b: number;
    /** Piecewise-linear trend terms [knot in years since epochMs, coefficient]: coefficient x min(0, x - knot). */
    knots: ReadonlyArray<readonly [number, number]>;
    /** Coefficient on log(hours / hoursRef). */
    c: number;
    /** Break-gauge offset. */
    g: number;
    /** Normal-event unit offsets; MIXED_UNIT for events without a unit. */
    unit: Readonly<Record<string, number>>;
    /** Normal-event banner-character offsets keyed by game character id. */
    banner: Readonly<Record<string, number>>;
    /** Predictive log sd for a normal event (leave-one-out residuals). */
    sigma: number;
}

export interface PriorGroupTier {
    rank: number;
    /** Group mean of log(final) minus the base prediction. */
    offset: number;
    /** Leave-one-event-out prediction error (log sd) of scopes in cells with data. */
    sigma: number;
    /** Standard error of the offset; added with the between-cell variance for a scope whose cell has no data. */
    se: number;
}

export interface PriorGroup {
    /** Region whose events estimated the offsets (a CN group without CN data borrows JP's). */
    source: Region;
    nEvents: number;
    tiers: ReadonlyArray<PriorGroupTier>;
}

export interface PriorCell {
    nEvents: number;
    /** n / (n + k): share of the cell's own mean in its offset; the rest stays with the parent. */
    weight: number;
    /** Offsets on top of the parent, already shrunk. */
    tiers: ReadonlyArray<{ rank: number; offset: number }>;
}

export interface PriorRegion {
    /** Years since epochMs of the latest training event start of the region. */
    xRef: number;
    base: ReadonlyArray<PriorBaseTier>;
    groups: Readonly<Partial<Record<EventGroup, PriorGroup>>>;
    /** Keyed by priorCellKey; only WL cells of a known turn and finales. */
    cells: Readonly<Record<string, PriorCell>>;
    /** Shrinkage constant k of the cells (sigma^2 / tau^2); null when cell offsets are off. */
    cellK: number | null;
    /** Chapter-character offsets for WL chapter scopes, keyed by game character id. */
    chapterCharacter: ReadonlyArray<{ rank: number; effects: Readonly<Record<string, number>> }>;
}

export interface PriorRatioTier {
    rank: number;
    n: number;
    /** log(CN final / JP same-id final) of a normal event at xRef with equal hours. */
    rho: number;
    /** Trend per year. */
    eta: number;
    /** Coefficient on log(CN hours / JP hours). */
    kappa: number;
    sigma: number;
}

export interface PriorRatio {
    xRef: number;
    base: ReadonlyArray<PriorRatioTier>;
    /** "turn:<t>" (edition, all WL groups of that turn) and ratioCellKey offsets on top of it. */
    offsets: Readonly<Record<string, PriorCell>>;
    k: number | null;
    /** Whether WL scopes follow the normal-event ratio trend; otherwise each edition keeps its own level. */
    wlTrend: boolean;
    /** JP scope hours by "<eventId>|overall" and "<eventId>|chapter"; empty when kappa is unused. */
    jpHours: Readonly<Record<string, number>>;
}

export interface PriorSection {
    version: 1;
    epochMs: number;
    hoursRef: number;
    /** Trend extrapolation beyond xRef is capped at this many years. */
    maxExtrapolationYears: number;
    /** Blend CN own history with the JP-anchored estimate by inverse variance instead of using the anchor alone. */
    cnBlend: boolean;
    /** Fit options, kept for audit. */
    features: Readonly<Record<string, boolean | number | string | null>>;
    regions: Readonly<Partial<Record<Region, PriorRegion>>>;
    cnRatio: PriorRatio | null;
}

export interface PriorPoint {
    rank: number;
    /** log(median). */
    mu: number;
    sigma: number;
}

type CellContext = Pick<PredictionContext, "region" | "group" | "wlTurn" | "eventId" | "breakGauge" | "unit">;

/**
 * Prior cell: finales by event id, normal events by break gauge, other WL scopes by turn and whether the event has
 * a unit (unit-themed WL1/WL2 events versus VS or mixed events). WL scopes of an unknown turn have no cell.
 */
export function priorCellKey(ctx: CellContext): string | null {
    if (ctx.group === "wl_finale") return `${ctx.region}|wl_finale|${ctx.wlTurn ?? "-"}|#${ctx.eventId}`;
    if (ctx.group === "normal") return `${ctx.region}|normal|-|${ctx.breakGauge ? "gauge" : "none"}`;
    if (ctx.wlTurn == null) return null;
    return `${ctx.region}|${ctx.group}|${ctx.wlTurn}|${ctx.unit != null ? "unit" : "all"}`;
}

/** CN/JP ratio offsets that apply to a scope: edition first, then the group within it. */
export function ratioCellKeys(ctx: Pick<PredictionContext, "group" | "wlTurn" | "eventId">): { edition: string; cell: string } | null {
    if (ctx.group === "normal" || ctx.wlTurn == null) return null;
    const cell = ctx.group === "wl_finale" ? `wl_finale|#${ctx.eventId}` : `${ctx.group}|${ctx.wlTurn}`;
    return { edition: `turn:${ctx.wlTurn}`, cell };
}

export function yearsSinceEpoch(ms: number, s: Pick<PriorSection, "epochMs">): number {
    return (ms - s.epochMs) / YEAR_MS;
}

function scopeHours(ctx: Pick<PredictionContext, "scopeStartAt" | "scopeEndAt">): number {
    return Math.max(1, (ctx.scopeEndAt - ctx.scopeStartAt) / HOUR_MS);
}

function tierOf<T extends { rank: number }>(tiers: ReadonlyArray<T> | undefined, rank: number): T | undefined {
    return tiers?.find((t) => t.rank === rank);
}

function ownCurve(ctx: PredictionContext, s: PriorSection): PriorPoint[] {
    const reg = s.regions[ctx.region];
    if (!reg) return [];
    const isNormal = ctx.group === "normal";
    const group = isNormal ? undefined : reg.groups[ctx.group];
    if (!isNormal && !group) return [];
    const x = yearsSinceEpoch(ctx.scopeStartAt, s);
    const dx = Math.min(x - reg.xRef, s.maxExtrapolationYears);
    const lh = Math.log(scopeHours(ctx) / s.hoursRef);
    const key = isNormal ? null : priorCellKey(ctx);
    const cell = key ? reg.cells[key] : undefined;
    const character = ctx.chapterCharacterId != null ? String(ctx.chapterCharacterId) : null;
    const out: PriorPoint[] = [];
    for (const t of reg.base) {
        let mu = t.a + t.b * dx + t.c * lh + (ctx.breakGauge ? t.g : 0);
        for (const [knot, coef] of t.knots) mu += coef * Math.min(0, x - knot);
        let v = t.sigma * t.sigma;
        if (isNormal) {
            mu += t.unit[ctx.unit ?? MIXED_UNIT] ?? 0;
            if (ctx.bannerCharacterId != null) mu += t.banner[String(ctx.bannerCharacterId)] ?? 0;
        } else {
            const gt = tierOf(group?.tiers, t.rank);
            if (!gt) continue;
            mu += gt.offset;
            // gt.sigma is a leave-one-event-out error, so it already covers the offsets of a cell with data.
            v = gt.sigma * gt.sigma;
            const ct = reg.cellK != null && cell ? tierOf(cell.tiers, t.rank) : undefined;
            if (ct) mu += ct.offset;
            // No cell data: the level comes from the group's other editions, so a new finale takes the level of
            // the finales already fitted (se equals sigma when there is only one).
            else v += gt.se * gt.se + (reg.cellK != null ? v / reg.cellK : 0);
            if (character) mu += tierOf(reg.chapterCharacter, t.rank)?.effects[character] ?? 0;
        }
        out.push({ rank: t.rank, mu, sigma: Math.sqrt(v) });
    }
    return out;
}

/** Linear in log(rank); flat outside the known ranks. */
function interpolateFlat(points: ReadonlyArray<PriorPoint>, rank: number): PriorPoint {
    if (rank <= points[0].rank) return { ...points[0], rank };
    const last = points[points.length - 1];
    if (rank >= last.rank) return { ...last, rank };
    return interpolateInside(points, rank) as PriorPoint;
}

function interpolateInside(points: ReadonlyArray<PriorPoint>, rank: number): PriorPoint | null {
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p.rank === rank) return p;
        if (p.rank > rank) {
            if (i === 0) return null;
            const q = points[i - 1];
            const f = (Math.log(rank) - Math.log(q.rank)) / (Math.log(p.rank) - Math.log(q.rank));
            return { rank, mu: q.mu + f * (p.mu - q.mu), sigma: q.sigma + f * (p.sigma - q.sigma) };
        }
    }
    return null;
}

function ratioCurve(ctx: PredictionContext, s: PriorSection): PriorPoint[] {
    const r = s.cnRatio;
    if (ctx.region !== "cn" || !r || r.base.length === 0 || !ctx.jpSameIdFinal) return [];
    const jp = Object.entries(ctx.jpSameIdFinal)
        .map(([rank, score]) => ({ rank: Number(rank), score }))
        .filter((p) => Number.isFinite(p.rank) && p.rank > 0 && Number.isFinite(p.score) && p.score > 0)
        .sort((a, b) => a.rank - b.rank);
    if (jp.length === 0) return [];
    const dx = Math.min(yearsSinceEpoch(ctx.scopeStartAt, s) - r.xRef, s.maxExtrapolationYears);
    const jpHours = r.jpHours[`${ctx.eventId}|${ctx.chapterCharacterId != null ? "chapter" : "overall"}`];
    const lhr = jpHours ? Math.log(scopeHours(ctx) / jpHours) : 0;
    const keys = ratioCellKeys(ctx);
    const edition = keys ? r.offsets[keys.edition] : undefined;
    const cell = keys ? r.offsets[keys.cell] : undefined;
    const ratios: PriorPoint[] = r.base.map((t) => {
        let mu = t.rho + (keys && !r.wlTrend ? 0 : t.eta * dx) + t.kappa * lhr;
        let v = t.sigma * t.sigma;
        if (keys) {
            mu += (edition ? tierOf(edition.tiers, t.rank)?.offset ?? 0 : 0) + (cell ? tierOf(cell.tiers, t.rank)?.offset ?? 0 : 0);
            if (r.k != null) v += (t.sigma * t.sigma) / ((edition?.nEvents ?? 0) + r.k);
        }
        return { rank: t.rank, mu, sigma: Math.sqrt(v) };
    });
    return jp.map((p) => {
        const q = interpolateFlat(ratios, p.rank);
        return { rank: p.rank, mu: Math.log(p.score) + q.mu, sigma: q.sigma };
    });
}

function blend(anchor: PriorPoint[], own: PriorPoint[]): PriorPoint[] {
    return anchor.map((p) => {
        const o = own.find((x) => x.rank === p.rank);
        if (!o) return p;
        const wa = 1 / (p.sigma * p.sigma);
        const wo = 1 / (o.sigma * o.sigma);
        return { rank: p.rank, mu: (p.mu * wa + o.mu * wo) / (wa + wo), sigma: Math.sqrt(1 / (wa + wo)) };
    });
}

/** Weighted pool-adjacent-violators: mu non-increasing as rank grows; sigma is kept per tier. */
function monotone(points: PriorPoint[]): PriorPoint[] {
    const blocks: { mu: number; w: number; n: number }[] = [];
    for (const p of points) {
        blocks.push({ mu: p.mu, w: 1 / (p.sigma * p.sigma), n: 1 });
        while (blocks.length > 1 && blocks[blocks.length - 2].mu < blocks[blocks.length - 1].mu) {
            const b = blocks.pop() as { mu: number; w: number; n: number };
            const a = blocks[blocks.length - 1];
            a.mu = (a.mu * a.w + b.mu * b.w) / (a.w + b.w);
            a.w += b.w;
            a.n += b.n;
        }
    }
    const out: PriorPoint[] = [];
    let i = 0;
    for (const b of blocks) {
        for (let j = 0; j < b.n; j++, i++) out.push({ ...points[i], mu: b.mu });
    }
    return out;
}

/**
 * Prior for every tier the section can serve for this scope, ascending by rank and non-increasing in score.
 * CN scopes with a JP same-id final use the JP-anchored curve (blended with CN history when cnBlend is set).
 */
export function priorCurve(ctx: PredictionContext, s: PriorSection): PriorPoint[] {
    const own = ownCurve(ctx, s).filter((p) => Number.isFinite(p.mu) && p.sigma > 0);
    const anchor = ratioCurve(ctx, s).filter((p) => Number.isFinite(p.mu) && p.sigma > 0);
    const points = anchor.length > 0 ? (s.cnBlend ? blend(anchor, own) : anchor) : own;
    return points.length > 0 ? monotone(points) : [];
}

/** Log-normal prior of the scope's final at `rank`; ranks between known tiers are interpolated in log(rank). */
export function finalPrior(ctx: PredictionContext, rank: number, s: PriorSection): LogNormalEstimate | null {
    const curve = priorCurve(ctx, s);
    if (curve.length === 0 || !(rank > 0)) return null;
    const p = interpolateInside(curve, rank);
    return p ? { median: Math.exp(p.mu), logSigma: p.sigma } : null;
}
