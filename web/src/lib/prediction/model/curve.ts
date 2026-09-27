// Progress curve: expected share of a scope's final reached at a given time, per curve cell.
// The rate at hour h of a scope is exp(open[hours since start] + end[hours to end] + rhythm[local clock hour]
// + trend[progress bin]); the share is its normalised cumulative sum, so it is monotone, 0 at the scope start
// and 1 at the scope end. Factors are fitted per anchor rank by scripts/prediction-backtest/fit-curve.mjs and
// interpolated in log10(rank). When the context knows the event end, a WL chapter also adds the hours-to-end term
// fitted for its position on top of its chapter cell: the event's final sprint lands in the chapter that ends with
// the event, most visibly below the chapter title border.
import type { Region } from "../../event-rules/types";
import type { PredictionContext } from "./types";

/**
 * Context fields the curve reads. `eventEndAt` is the whole event's aggregateAt (null or absent = unknown).
 * Without it a chapter's position is unknown and the chapter uses its chapter cell alone; fit-curve.mjs takes
 * positions from the same context builder, so it fits a chapter-position table only for contexts that carry it.
 */
export type CurveContext = Pick<
    PredictionContext,
    "region" | "group" | "wlTurn" | "eventId" | "breakGauge" | "chapterCharacterId" | "scopeStartAt" | "scopeEndAt"
> & { eventEndAt?: number | null };

const HOUR_MS = 3_600_000;

/** Returned by shareLogSigma when the section holds no residuals at all (an empty training set). */
const NO_DATA_LOG_SIGMA = 1;

export const REGION_TZ_OFFSET_MINUTES: Readonly<Record<Region, number>> = { jp: 540, cn: 480 };

/** Rank used when a caller does not name one. */
export const CURVE_DEFAULT_RANK = 1000;

/** Chapter characters 21-26 are the Virtual Singers. */
const VS_CHARACTER_MIN = 21;
const VS_CHARACTER_MAX = 26;

/** Natural-log rate factors of one anchor rank; the clock-hour rhythm lives in the cell's rank band. */
export interface CurveProfile {
    /** One value per `openEdgesHours` bin; hours past the last edge use 0. */
    open: number[];
    /** One value per `endEdgesHours` bin; hours before the last edge use 0. */
    end: number[];
    /** `trendBins` equal progress bins, mean 0. */
    trend: number[];
}

export interface CurveCell {
    /** Training scopes with usable series, and distinct events among them. */
    scopes: number;
    events: number;
    /** Cell this one was shrunk toward at fit time and its pseudo-scope weight (0 = own data only). */
    shrunkToward: string | null;
    shrinkWeight: number;
    /** Per `rhythmBands` entry: 24 local clock-hour log factors (mean 0); null where the band has no series. */
    rhythm: Array<number[] | null>;
    /** Per anchor rank; null where the cell has no series of that rank. */
    profiles: Array<CurveProfile | null>;
    /** Per anchor rank: RMS of log(actual share / expected share) at each `sigmaGrid` progress. */
    sigma: Array<number[] | null>;
}

/** A chapter scope that ends with its event is "last"; every earlier chapter is "other". */
export type ChapterPosition = "last" | "other";

/** Hours-to-end log factors added for one chapter position, relative to the chapter cell the context resolves to. */
export interface ChapterPositionCell {
    /** Training scopes of this position behind the estimate. */
    scopes: number;
    shrunkToward: string | null;
    shrinkWeight: number;
    /** Per anchor rank: one value per `endEdgesHours` bin; null where no scope of the position has that rank. */
    end: Array<number[] | null>;
}

export interface CurveSection {
    version: 1;
    /** Anchor ranks (the published border ranks), ascending; other ranks interpolate in log10(rank). */
    anchors: number[];
    /** Inclusive upper rank of each rhythm band, ascending; the last band is open-ended. */
    rhythmBands: number[];
    openEdgesHours: number[];
    endEdgesHours: number[];
    trendBins: number;
    /** Progress points of `sigma`; the sigma falls linearly to 0 at progress 1. */
    sigmaGrid: number[];
    /** Whether a CN cell without data may use the JP cell with the same key (never for finales). */
    cnFromJp: boolean;
    /** Whether a WL chapter or overall cell without data may use the same cell pooled over WL turns. */
    crossTurn: boolean;
    cells: Record<string, CurveCell>;
    /** Keyed by region|group|turn|position for the chapter groups, plus the same keys pooled over WL turns ("*"). */
    chapterPosition: Record<string, ChapterPositionCell>;
    /** Residual sigma of a share that is linear in time, used when no cell in the lookup chain has data. */
    uniformSigma: Array<number[] | null>;
    /** Fit settings, for reproducibility only. */
    fit: Record<string, number | string | boolean>;
}

/** Hour cells of a scope: cell k covers [startAt + k h, min(endAt, startAt + (k + 1) h)). */
export interface HourGrid {
    startAt: number;
    endAt: number;
    /** Length of each cell in hours (the last one may be shorter). */
    len: Float64Array;
    openBin: Int16Array;
    endBin: Int16Array;
    localHour: Int16Array;
    trendBin: Int16Array;
}

export function isVsCharacter(characterId: number | null): boolean {
    return characterId != null && characterId >= VS_CHARACTER_MIN && characterId <= VS_CHARACTER_MAX;
}

/**
 * Curve cell of a context: region x group x WL turn, plus the break gauge for normal events, VS versus unit
 * chapters for chapter scopes, and the event id for finales.
 */
export function curveCellKey(ctx: Pick<CurveContext, "region" | "group" | "wlTurn" | "eventId" | "breakGauge" | "chapterCharacterId">): string {
    const base = `${ctx.region}|${ctx.group}|${ctx.wlTurn ?? "-"}`;
    switch (ctx.group) {
        case "wl_finale":
            return `${base}|#${ctx.eventId}`;
        case "normal":
            return `${base}|${ctx.breakGauge ? "gauge" : "nogauge"}`;
        case "wl_chapter_48h":
        case "wl_chapter_72h":
            return `${base}|${isVsCharacter(ctx.chapterCharacterId) ? "vs" : "unit"}`;
        default:
            return base;
    }
}

/** Pooled cell of a variant cell (region x group x turn); null for WL overall and finales. */
export function curveParentKey(key: string): string | null {
    const parts = key.split("|");
    if (parts.length < 4 || parts[3].startsWith("#")) return null;
    return parts.slice(0, 3).join("|");
}

/** Same cell pooled over every WL turn ("*"); null for normal events, finales and keys already pooled. */
export function curveTurnPooledKey(key: string): string | null {
    const parts = key.split("|");
    if (!parts[1].startsWith("wl_") || parts[1] === "wl_finale" || parts[2] === "*") return null;
    parts[2] = "*";
    return parts.join("|");
}

function withRegion(key: string, region: Region): string {
    return `${region}${key.slice(key.indexOf("|"))}`;
}

function isFinaleKey(key: string): boolean {
    return key.split("|")[1] === "wl_finale";
}

export interface CurveSharing {
    cnFromJp: boolean;
    crossTurn: boolean;
}

/**
 * Lookup order: own cell, its pooled parent; then (CN, if enabled) the same JP cells; then (if enabled) the same
 * cells pooled over WL turns. Finales only ever use their own cell.
 */
export function curveLookupChain(key: string, sharing: CurveSharing): string[] {
    if (isFinaleKey(key)) return [key];
    const edition = [key];
    const parent = curveParentKey(key);
    if (parent) edition.push(parent);
    const regions = (keys: string[]) => (sharing.cnFromJp && key.startsWith("cn|") ? [...keys, ...keys.map((k) => withRegion(k, "jp"))] : keys);
    const chain = regions(edition);
    const pooled = curveTurnPooledKey(key);
    if (sharing.crossTurn && pooled) {
        const pooledParent = curveParentKey(pooled);
        chain.push(...regions(pooledParent ? [pooled, pooledParent] : [pooled]));
    }
    return chain;
}

function isChapterGroup(group: CurveContext["group"]): boolean {
    return group === "wl_chapter_48h" || group === "wl_chapter_72h";
}

/** Position of a chapter scope; null when the scope is not a chapter or the event end is unknown. */
export function chapterPosition(ctx: Pick<CurveContext, "group" | "scopeEndAt" | "eventEndAt">): ChapterPosition | null {
    if (!isChapterGroup(ctx.group) || ctx.eventEndAt == null) return null;
    return ctx.scopeEndAt >= ctx.eventEndAt ? "last" : "other";
}

/** Chapter-position cell of a context (region x group x WL turn x position); null when the position is unknown. */
export function chapterPositionKey(ctx: Pick<CurveContext, "region" | "group" | "wlTurn" | "scopeEndAt" | "eventEndAt">): string | null {
    const position = chapterPosition(ctx);
    return position ? `${ctx.region}|${ctx.group}|${ctx.wlTurn ?? "-"}|${position}` : null;
}

/** Own position cell, then (CN, if enabled) the JP one; then (if enabled) the same cells pooled over WL turns. */
export function chapterPositionLookupChain(key: string, sharing: CurveSharing): string[] {
    const regions = (k: string) => (sharing.cnFromJp && k.startsWith("cn|") ? [k, withRegion(k, "jp")] : [k]);
    const chain = regions(key);
    const pooled = curveTurnPooledKey(key);
    if (sharing.crossTurn && pooled) chain.push(...regions(pooled));
    return chain;
}

function hasAny(xs: ReadonlyArray<unknown> | undefined): boolean {
    return !!xs && xs.some((x) => x != null);
}

/** First cell of the context's lookup chain that has data in `field`. */
export function resolveCurveCell(ctx: CurveContext, s: Pick<CurveSection, "cells" | "cnFromJp" | "crossTurn">, field: "profiles" | "sigma"): CurveCell | null {
    for (const key of curveLookupChain(curveCellKey(ctx), s)) {
        const cell = s.cells[key];
        if (cell && hasAny(cell[field])) return cell;
    }
    return null;
}

function binOf(x: number, edges: ReadonlyArray<number>): number {
    for (let i = 0; i < edges.length; i++) if (x < edges[i]) return i;
    return edges.length;
}

export function buildHourGrid(region: Region, startAt: number, endAt: number, s: Pick<CurveSection, "openEdgesHours" | "endEdgesHours" | "trendBins">): HourGrid {
    const span = Math.max(0, endAt - startAt);
    const n = Math.max(1, Math.ceil(span / HOUR_MS - 1e-9));
    const len = new Float64Array(n);
    const openBin = new Int16Array(n);
    const endBin = new Int16Array(n);
    const localHour = new Int16Array(n);
    const trendBin = new Int16Array(n);
    const tz = REGION_TZ_OFFSET_MINUTES[region] * 60_000;
    for (let k = 0; k < n; k++) {
        const a = startAt + k * HOUR_MS;
        const b = Math.min(endAt, a + HOUR_MS);
        const mid = (a + b) / 2;
        len[k] = Math.max(0, b - a) / HOUR_MS;
        openBin[k] = binOf((mid - startAt) / HOUR_MS, s.openEdgesHours);
        endBin[k] = binOf((endAt - mid) / HOUR_MS, s.endEdgesHours);
        localHour[k] = Math.floor((((mid + tz) / HOUR_MS) % 24 + 24) % 24);
        trendBin[k] = span > 0 ? Math.min(s.trendBins - 1, Math.floor(((mid - startAt) / span) * s.trendBins)) : 0;
    }
    return { startAt, endAt, len, openBin, endBin, localHour, trendBin };
}

/** A rank-level profile together with the clock-hour rhythm of its band. */
export interface RateProfile extends CurveProfile {
    rhythm: number[];
}

/** Log rate of each hour cell under a profile (reference bins past the last edge are 0). */
export function logRates(grid: HourGrid, p: RateProfile): Float64Array {
    const out = new Float64Array(grid.len.length);
    for (let k = 0; k < out.length; k++) {
        const o = grid.openBin[k] < p.open.length ? p.open[grid.openBin[k]] : 0;
        const e = grid.endBin[k] < p.end.length ? p.end[grid.endBin[k]] : 0;
        out[k] = o + e + p.rhythm[grid.localHour[k]] + p.trend[grid.trendBin[k]];
    }
    return out;
}

/** Normalised cumulative share at every cell boundary (length n + 1, first 0, last 1). */
export function cumulativeShare(grid: HourGrid, p: RateProfile | null): Float64Array {
    const n = grid.len.length;
    const cum = new Float64Array(n + 1);
    const lr = p ? logRates(grid, p) : null;
    for (let k = 0; k < n; k++) cum[k + 1] = cum[k] + grid.len[k] * (lr ? Math.exp(lr[k]) : 1);
    const total = cum[n];
    if (total > 0) for (let k = 1; k <= n; k++) cum[k] /= total;
    cum[n] = 1;
    return cum;
}

/** Share at `atMs` from a cumulative array, linear inside each hour cell. */
export function shareAt(grid: HourGrid, cum: Float64Array, atMs: number): number {
    if (!(atMs > grid.startAt)) return 0;
    if (atMs >= grid.endAt) return 1;
    const k = Math.min(grid.len.length - 1, Math.floor((atMs - grid.startAt) / HOUR_MS));
    const cellStart = grid.startAt + k * HOUR_MS;
    const frac = grid.len[k] > 0 ? Math.min(1, (atMs - cellStart) / (grid.len[k] * HOUR_MS)) : 1;
    return Math.min(1, Math.max(0, cum[k] + frac * (cum[k + 1] - cum[k])));
}

function lerpArrays(a: ReadonlyArray<number>, b: ReadonlyArray<number>, w: number): number[] {
    return a.map((x, i) => x + w * (b[i] - x));
}

/** Items of `items` interpolated linearly in log10(rank) between the nearest non-null anchors, clamped at the ends. */
function atRank<T>(anchors: ReadonlyArray<number>, items: ReadonlyArray<T | null>, rank: number, lerp: (a: T, b: T, w: number) => T): T | null {
    const x = Math.log10(Math.max(1, rank));
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < anchors.length; i++) {
        if (items[i] == null) continue;
        const xi = Math.log10(anchors[i]);
        if (xi <= x) lo = i;
        if (xi >= x && hi < 0) hi = i;
    }
    if (lo < 0 && hi < 0) return null;
    if (lo < 0) return items[hi];
    if (hi < 0 || hi === lo) return items[lo];
    const x0 = Math.log10(anchors[lo]);
    const x1 = Math.log10(anchors[hi]);
    return lerp(items[lo] as T, items[hi] as T, (x - x0) / (x1 - x0));
}

/** Index of the rhythm band of a rank. */
export function rhythmBandOf(bands: ReadonlyArray<number>, rank: number): number {
    for (let i = 0; i < bands.length; i++) if (rank <= bands[i]) return i;
    return bands.length;
}

function bandRhythm(cell: CurveCell, bands: ReadonlyArray<number>, rank: number): number[] | null {
    const b = rhythmBandOf(bands, rank);
    if (cell.rhythm[b]) return cell.rhythm[b];
    for (let d = 1; d < cell.rhythm.length; d++) {
        const near = cell.rhythm[b - d] ?? cell.rhythm[b + d];
        if (near) return near;
    }
    return null;
}

export function profileAtRank(cell: CurveCell, s: Pick<CurveSection, "anchors" | "rhythmBands">, rank: number): RateProfile | null {
    const p = atRank(s.anchors, cell.profiles, rank, (a, b, w) => ({
        open: lerpArrays(a.open, b.open, w),
        end: lerpArrays(a.end, b.end, w),
        trend: lerpArrays(a.trend, b.trend, w),
    }));
    const rhythm = bandRhythm(cell, s.rhythmBands, rank);
    return p && rhythm ? { ...p, rhythm } : null;
}

/** Chapter-position end factors at a rank from the first cell of the lookup chain with data; null when none applies. */
export function chapterPositionEnd(ctx: CurveContext, s: Pick<CurveSection, "chapterPosition" | "anchors" | "cnFromJp" | "crossTurn">, rank: number): number[] | null {
    const key = chapterPositionKey(ctx);
    if (!key) return null;
    for (const k of chapterPositionLookupChain(key, s)) {
        // Sections fitted before chapter-position terms existed have no table.
        const cell = s.chapterPosition?.[k];
        if (cell && hasAny(cell.end)) return atRank(s.anchors, cell.end, rank, (a, b, w) => lerpArrays(a, b, w));
    }
    return null;
}

/** Rate profile of a context at one rank: its cell's profile plus, where known, its chapter position's end factors. */
export function contextProfile(ctx: CurveContext, s: CurveSection, rank: number): RateProfile | null {
    const cell = resolveCurveCell(ctx, s, "profiles");
    const profile = cell ? profileAtRank(cell, s, rank) : null;
    const extra = profile ? chapterPositionEnd(ctx, s, rank) : null;
    return profile && extra ? { ...profile, end: profile.end.map((x, i) => x + extra[i]) } : profile;
}

/** Grid and cumulative share of a context's scope at one rank; a linear share when no cell has data. */
export function shareCurve(ctx: CurveContext, s: CurveSection, rank: number = CURVE_DEFAULT_RANK): { grid: HourGrid; cum: Float64Array } {
    const grid = buildHourGrid(ctx.region, ctx.scopeStartAt, ctx.scopeEndAt, s);
    return { grid, cum: cumulativeShare(grid, contextProfile(ctx, s, rank)) };
}

/** Expected fraction of the scope's final reached at `atMs`: monotone, 0 at scopeStartAt, 1 at scopeEndAt. */
export function expectedShare(ctx: CurveContext, atMs: number, s: CurveSection, rank: number = CURVE_DEFAULT_RANK): number {
    if (!(atMs > ctx.scopeStartAt)) return 0;
    if (atMs >= ctx.scopeEndAt) return 1;
    const { grid, cum } = shareCurve(ctx, s, rank);
    return shareAt(grid, cum, atMs);
}

function sigmaOnGrid(grid: ReadonlyArray<number>, values: ReadonlyArray<number>, progress: number): number {
    if (progress >= 1) return 0;
    if (progress <= grid[0]) return values[0];
    for (let i = 1; i < grid.length; i++) {
        if (progress <= grid[i]) {
            const w = (progress - grid[i - 1]) / (grid[i] - grid[i - 1]);
            return values[i - 1] + w * (values[i] - values[i - 1]);
        }
    }
    const last = grid.length - 1;
    return values[last] * (1 - progress) / (1 - grid[last]);
}

/** Uncertainty (log units) of currentScore / expectedShare as an estimate of the final at `atMs`; 0 at the scope end. */
export function shareLogSigma(ctx: CurveContext, atMs: number, s: CurveSection, rank: number = CURVE_DEFAULT_RANK): number {
    const span = ctx.scopeEndAt - ctx.scopeStartAt;
    if (!(span > 0) || atMs >= ctx.scopeEndAt) return 0;
    const progress = Math.max(0, (atMs - ctx.scopeStartAt) / span);
    const cell = resolveCurveCell(ctx, s, "sigma");
    const values = atRank(s.anchors, cell ? cell.sigma : s.uniformSigma, rank, (a, b, w) => lerpArrays(a, b, w));
    if (!values) return NO_DATA_LOG_SIGMA;
    return sigmaOnGrid(s.sigmaGrid, values, progress);
}

/**
 * Expected path from (fromMs, currentScore) to (scopeEndAt, finalMedian), following the share curve.
 * Points every `stepMs` plus the scope end; scores are non-decreasing and rounded.
 */
export function projectPath(
    ctx: CurveContext,
    fromMs: number,
    currentScore: number,
    finalMedian: number,
    stepMs: number,
    s: CurveSection,
    rank: number = CURVE_DEFAULT_RANK,
): { t: number; y: number }[] {
    const endAt = ctx.scopeEndAt;
    if (fromMs >= endAt) return [{ t: fromMs, y: Math.round(currentScore) }];
    const { grid, cum } = shareCurve(ctx, s, rank);
    const s0 = shareAt(grid, cum, fromMs);
    const gap = Math.max(0, finalMedian - currentScore);
    const step = Math.max(60_000, stepMs);
    const out: { t: number; y: number }[] = [];
    for (let t = fromMs; ; t += step) {
        const at = Math.min(t, endAt);
        const frac = s0 < 1 ? (shareAt(grid, cum, at) - s0) / (1 - s0) : 1;
        out.push({ t: at, y: Math.round(currentScore + gap * (at >= endAt ? 1 : frac)) });
        if (at >= endAt) break;
    }
    return out;
}
