#!/usr/bin/env node
// F2 进度曲线拟合：按曲线单元格（区服 × 组别 × WL 期数；普通活动再按有无疲劳槽，章节再按 VS / 团章节，终章按活动 id）
// 拟合乘性速率模型 exp(开活后小时段 + 距结束小时段 + 当地钟点 + 进度段)，累计后归一化即进度曲线（见 src/lib/prediction/model/curve.ts）。
// 每个档位（榜线名次）单独拟合开活 / 冲刺 / 进度段，因为奖励边界档（T100、T1000…）的冲刺明显强于相邻档，跨档平滑会把冲刺抹平；
// 当地钟点节律按档位段（T1–10、T20–100、T200–1000、T2000–10000、T20000+）合并拟合。近期活动按半衰期加权。
// 共享只通过显式收缩：变体单元格向同区服同组同期的合并单元格收缩，国服单元格向日服同键单元格收缩；
// WL 单元格缺数据时才借用跨届合并单元格（turnShrink = 0，回测见 wf/F2.md）；终章从不共享。
// sigma 取训练集内 log(实际占比 / 预期占比) 在各进度点的加权均方根（先在范围内、再跨范围加权）。
// WL 章节再按位置拟合一组“距结束小时段”修正（默认只拟合与活动同时结束的最后一章），相对该范围查到的章节单元格，
// 按区服 × 组别 × 期数 × 位置，单届向跨届合并值收缩：活动总榜的最终冲刺落在最后一章，章节称号线以下的档位尤其明显
// （R13-1，见 wf/F2-fix1.md），只对 T2000 起的锚点拟合（positionMinRank）。位置取自拟合所用的 context（默认即回测预测用的 contextFromDataset，线上 context 与之逐字段一致）：
// context 不带活动结束时间（eventEndAt）时既不拟合也不输出位置表，预测同样不修正，二者始终一致（R9-4）。
// 用法：node --experimental-strip-types scripts/prediction-backtest/fit-curve.mjs [--data <dir>] [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    buildHourGrid,
    chapterPositionKey,
    chapterPositionLookupChain,
    cumulativeShare,
    curveCellKey,
    curveLookupChain,
    curveParentKey,
    curveTurnPooledKey,
    profileAtRank,
    resolveCurveCell,
    rhythmBandOf,
    shareAt,
} from "../../src/lib/prediction/model/curve.ts";
import { contextFromDataset, scopeWindow } from "../../src/lib/prediction/model/dataset-context.ts";
import { DEFAULT_DATA_DIR, MODEL_WORK_DIR, actualFinals, indexDataset, loadDataset, scopeKey, scopesOf } from "./dataset.mjs";

const HOUR_MS = 3_600_000;
const YEAR_MS = 365.25 * 24 * HOUR_MS;

export const DEFAULT_FIT_DIR = path.join(MODEL_WORK_DIR, "fit");

export const CURVE_FIT_DEFAULTS = Object.freeze({
    anchors: [1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 100, 200, 300, 400, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000,
        10000, 20000, 30000, 40000, 50000, 100000],
    rhythmBands: [10, 100, 1000, 10000],
    openEdgesHours: [1, 2, 3, 6, 12, 24, 48],
    endEdgesHours: [1, 2, 3, 6, 12, 24, 48],
    trendBins: 5,
    sigmaGrid: [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95, 0.98],
    // 近期权重半衰期（年）；Infinity = 不加权。滚动回测：2 年 5.53%、1 年 4.86%、0.5 年 4.76%、0.35 年 4.74% MAPE（F2.md）。
    halfLifeYears: 0.5,
    iterations: 10,
    // 每个因子水平向 1 收缩的伪观测（加权小时）。
    factorPrior: 3,
    // 插值允许的最大观测间隔；更大的空档不产生增量，也不参与残差。
    maxGapHours: 2,
    minValidHours: 12,
    // 变体 → 合并单元格、国服 → 日服、单届 → 跨届合并的收缩伪样本数（范围数）；0 = 只在缺数据时借用。
    variantShrink: 5,
    regionShrink: 5,
    turnShrink: 0,
    cnFromJp: true,
    crossTurn: true,
    // 国服终章没有数据时借用日服同 id 终章的单元格，有数据时向它收缩（regionShrink）；不同活动的终章从不共用。
    // 滚动回测国服 #180（242 个预测点）：线性占比 MAPE 6.82%、覆盖率 76.0%；借用日服 #180 5.79%、81.4%
    // （T200–10000 与进度 25–75% 明显改善，T20000 起与结束前 12 小时内变差）；日服终章的预测不变。
    cnFinaleFromJp: true,
    // sigma 向查找链下一个单元格（或线性占比的 sigma）收缩的伪样本数。
    sigmaPrior: 3,
    // 拟合章节位置修正的位置；[] = 不拟合（输出与没有该修正时相同）。加上 "other"（更早的章）：
    // 滚动回测其他章 T2000+ MAPE 7.41 → 7.26%，T1–1000 4.38 → 4.45%，体积翻倍，未采用。
    chapterPositions: ["last"],
    // 位置修正单届向跨届合并值收缩的伪样本数（范围数）；滚动回测 0 / 5 / 只用合并值：最后一章 T2000+ MAPE 5.86 / 5.76 / 5.76%。
    positionShrink: 5,
    // 名次小于该值的锚点不加位置修正（输出全 0 的 end，插值时按无修正处理）；1 = 所有档位都修正。
    // 滚动回测（wf/M-r3.md）：最后一章 T1–1000 MAPE 无修正 3.79%，全档修正 3.98%，只修正 T2000 起 3.82%；
    // 最后一章 T2000+ 两种都从 8.42% 降到 6.04–6.05%。
    positionMinRank: 2000,
    // 拟合时给每个范围构造 context 的函数，单元格键与章节位置都从它来；应与预测时的 context 相同，测试可传入别的构造函数。
    contextOf: (ev, scope) => contextFromDataset(ev, scope, ev.aggregateAt, [], null),
});

const round3 = (x) => Math.round(x * 1e3) / 1e3;

// 各组别可能出现的变体（curveCellKey 的第 4 段）；用于判断合并单元格是否还会被查到。
const VARIANTS = { normal: ["gauge", "nogauge"], wl_chapter_48h: ["vs", "unit"], wl_chapter_72h: ["vs", "unit"] };

// ─── 序列预处理（与训练集无关，按活动对象缓存，跨折复用） ────────────────────

const scopeCache = new WeakMap();

/** 截至结算的点（结算后的点记在结算时刻），前面补上 (开始, 0)。 */
function cappedPoints(points, startAt, endAt) {
    const out = [[startAt, 0]];
    for (const [t, y] of points) {
        if (t <= startAt) continue;
        if (t > endAt + HOUR_MS) break;
        const tc = Math.min(t, endAt);
        const last = out[out.length - 1];
        if (tc === last[0]) last[1] = Math.max(last[1], y);
        else out.push([tc, y]);
    }
    return out;
}

/** t 时刻的分数：恰有观测点，或两侧观测间隔不超过 maxGapMs 时线性插值；否则 null。 */
function valueAt(pts, t, maxGapMs) {
    let lo = 0;
    let hi = pts.length - 1;
    let i = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid][0] <= t) {
            i = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (i < 0) return null;
    const [t0, y0] = pts[i];
    if (t0 === t) return y0;
    if (i + 1 >= pts.length) return null;
    const [t1, y1] = pts[i + 1];
    if (t1 - t0 > maxGapMs) return null;
    return y0 + ((y1 - y0) * (t - t0)) / (t1 - t0);
}

/**
 * 有效小时格的观测：z = 该格增量 / 有效小时的平均每小时增量，以及各因子族的水平（-1 = 参照水平）。
 * 可用小时太少时返回 null。
 */
function seriesObs(pts, grid, maxGapMs, minValidHours, nOpen, nEnd) {
    const n = grid.len.length;
    const v = new Float64Array(n + 1);
    for (let k = 0; k <= n; k++) {
        const y = valueAt(pts, k < n ? grid.startAt + k * HOUR_MS : grid.endAt, maxGapMs);
        v[k] = y == null ? NaN : y;
    }
    const cells = [];
    let sum = 0;
    let hours = 0;
    for (let k = 0; k < n; k++) {
        const d = v[k + 1] - v[k];
        if (Number.isNaN(d)) continue;
        const inc = Math.max(0, d);
        cells.push([k, inc]);
        sum += inc;
        hours += grid.len[k];
    }
    if (hours < minValidHours || !(sum > 0)) return null;
    const rate = sum / hours;
    const m = cells.length;
    const obs = {
        z: new Float64Array(m),
        len: new Float64Array(m),
        lev: [new Int16Array(m), new Int16Array(m), new Int16Array(m), new Int16Array(m)],
    };
    cells.forEach(([k, inc], j) => {
        obs.z[j] = inc / rate;
        obs.len[j] = grid.len[k];
        obs.lev[0][j] = grid.openBin[k] < nOpen ? grid.openBin[k] : -1;
        obs.lev[1][j] = grid.endBin[k] < nEnd ? grid.endBin[k] : -1;
        obs.lev[2][j] = grid.localHour[k];
        obs.lev[3][j] = grid.trendBin[k];
    });
    return obs;
}

/** 范围的预处理：网格，以及各档截断后的点与观测。 */
function scopePre(ev, scope, seriesByRank, o) {
    let byScope = scopeCache.get(ev);
    if (!byScope) scopeCache.set(ev, (byScope = new Map()));
    const key = [scopeKey(scope), o.maxGapHours, o.minValidHours, o.openEdgesHours.join(","), o.endEdgesHours.join(","),
        o.trendBins, seriesByRank.size].join("|");
    const hit = byScope.get(key);
    if (hit) return hit;

    const { startAt, endAt } = scopeWindow(ev, scope);
    const grid = buildHourGrid(ev.region, startAt, endAt, o);
    const maxGapMs = o.maxGapHours * HOUR_MS;
    const ranks = new Map();
    for (const [rank, s] of seriesByRank) {
        const pts = cappedPoints(s.points, startAt, endAt);
        const obs = seriesObs(pts, grid, maxGapMs, o.minValidHours, o.openEdgesHours.length, o.endEdgesHours.length);
        // 首个真实观测离开始超过 maxGap 的序列（晚开始或中途重置后被清洗）不参与残差。
        const earlyStart = pts.length > 1 && pts[1][0] - startAt <= maxGapMs;
        ranks.set(rank, { pts, obs, earlyStart });
    }
    const pre = { grid, ranks };
    byScope.set(key, pre);
    return pre;
}

// ─── 乘性速率模型（带收缩的迭代比例拟合） ──────────────────────────────────

/**
 * items: [{ obs, w, offset? }]（每条 = 一个范围的一个档位；offset = 各观测格已知的对数速率）。
 * fixedRhythm 给定时钟点节律不再拟合；families 为要拟合的因子族（0 开活、1 距结束、2 钟点、3 进度段）。
 * 返回 { fam: [open, end, rhythm, trend]（自然对数因子），counts }；counts[f][L] = 该水平有观测的范围权重和。
 */
function fitFactors(items, o, fixedRhythm = null, families = [0, 1, 2, 3]) {
    const fam = [
        new Float64Array(o.openEdgesHours.length),
        new Float64Array(o.endEdgesHours.length),
        fixedRhythm ? Float64Array.from(fixedRhythm) : new Float64Array(24),
        new Float64Array(o.trendBins),
    ];
    const fit = items.map(({ obs, offset }) => {
        const f = new Float64Array(obs.z.length);
        for (let j = 0; j < f.length; j++) f[j] = obs.len[j] * Math.exp(fam[2][obs.lev[2][j]] + (offset ? offset[j] : 0));
        return f;
    });
    const zSum = items.map(({ obs }) => obs.z.reduce((a, b) => a + b, 0));
    const scale = new Float64Array(items.length);
    for (let iter = 0; iter < o.iterations; iter++) {
        for (const f of families) {
            if (f === 2 && fixedRhythm) continue;
            const levels = fam[f];
            const num = new Float64Array(levels.length);
            const den = new Float64Array(levels.length);
            const cnt = new Float64Array(levels.length);
            items.forEach(({ obs, w }, i) => {
                const fi = fit[i];
                let fs = 0;
                for (let j = 0; j < fi.length; j++) fs += fi[j];
                scale[i] = fs > 0 ? zSum[i] / fs : 0;
                const lev = obs.lev[f];
                for (let j = 0; j < fi.length; j++) {
                    const L = lev[j];
                    if (L < 0) continue;
                    num[L] += w * obs.z[j];
                    den[L] += w * scale[i] * fi[j];
                    cnt[L] += w * obs.len[j];
                }
            });
            const mult = new Float64Array(levels.length).fill(1);
            for (let L = 0; L < levels.length; L++) {
                if (!(den[L] > 0)) continue;
                const m = Math.max(1e-3, (cnt[L] * (num[L] / den[L]) + o.factorPrior) / (cnt[L] + o.factorPrior));
                mult[L] = m;
                levels[L] += Math.log(m);
            }
            items.forEach(({ obs }, i) => {
                const fi = fit[i];
                const lev = obs.lev[f];
                for (let j = 0; j < fi.length; j++) if (lev[j] >= 0) fi[j] *= mult[lev[j]];
            });
        }
    }
    for (const f of [2, 3]) {
        const levels = fam[f];
        const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
        for (let L = 0; L < levels.length; L++) levels[L] -= mean;
    }
    const counts = fam.map((levels, f) => {
        const c = new Float64Array(levels.length);
        for (const { obs, w } of items) {
            const seen = new Uint8Array(levels.length);
            for (const L of obs.lev[f]) if (L >= 0) seen[L] = 1;
            for (let L = 0; L < levels.length; L++) if (seen[L]) c[L] += w;
        }
        return c;
    });
    return { fam: fam.map((xs) => Array.from(xs, round3)), counts };
}

/** 按水平收缩：θ = (c θ_own + k θ_target) / (c + k)，c 为该水平有观测的范围权重和。 */
function shrinkLevels(own, counts, target, k) {
    if (!own) return target ?? null;
    if (!target || !(k > 0)) return own;
    return own.map((x, L) => round3((counts[L] * x + k * target[L]) / (counts[L] + k)));
}

// ─── 残差与 sigma ─────────────────────────────────────────────────────────

function residualsFor(pre, finals, cumOf, o) {
    const { grid } = pre;
    const maxGapMs = o.maxGapHours * HOUR_MS;
    const out = new Map();
    for (const [rank, r] of pre.ranks) {
        const final = finals.get(rank)?.score;
        if (!(final > 0) || !r.earlyStart) continue;
        const cum = cumOf(rank);
        out.set(rank, o.sigmaGrid.map((p) => {
            const t = grid.startAt + p * (grid.endAt - grid.startAt);
            const y = valueAt(r.pts, t, maxGapMs);
            if (y == null || !(y > 0)) return null;
            const m = cum ? shareAt(grid, cum, t) : p;
            return m > 0 ? Math.log(y / final / m) : null;
        }));
    }
    return out;
}

function newSigmaAcc(o) {
    return o.anchors.map(() => o.sigmaGrid.map(() => ({ sum: 0, w: 0 })));
}

function addResiduals(acc, residuals, w, o) {
    o.anchors.forEach((anchor, a) => {
        const e = residuals.get(anchor);
        if (!e) return;
        e.forEach((x, g) => {
            if (x == null) return;
            acc[a][g].sum += w * x * x;
            acc[a][g].w += w;
        });
    });
}

/** σ² = (Σ w e² + k σ²_fallback) / (Σ w + k)；没有自身残差的档位直接用 fallback。 */
function finishSigma(acc, fallback, k) {
    return acc.map((row, a) => {
        const fb = fallback ? fallback[a] : null;
        if (row.every((c) => c.w === 0)) return fb ?? null;
        const vals = row.map((c, g) => {
            const prior = fb ? fb[g] : null;
            if (prior == null) return c.w > 0 ? Math.sqrt(c.sum / c.w) : null;
            return Math.sqrt((c.sum + k * prior * prior) / (c.w + k));
        });
        const firstKnown = vals.find((x) => x != null) ?? 0;
        return vals.map((x) => round3(x ?? firstKnown));
    });
}

// ─── 章节位置修正 ─────────────────────────────────────────────────────────

const ZERO_RHYTHM = new Array(24).fill(0);

/** 各观测格在速率剖面 p 下的对数速率（参照水平记 0）。 */
function logRateOffsets(obs, p) {
    const off = new Float64Array(obs.z.length);
    for (let j = 0; j < off.length; j++) {
        const L0 = obs.lev[0][j];
        const L1 = obs.lev[1][j];
        off[j] = (L0 >= 0 ? p.open[L0] : 0) + (L1 >= 0 ? p.end[L1] : 0) + p.rhythm[obs.lev[2][j]] + p.trend[obs.lev[3][j]];
    }
    return off;
}

/**
 * 章节位置修正：以每个章节范围在最终单元格表里查到的章节单元格为偏移，只拟合距结束小时段；
 * 单届键（区服|组别|期数|位置）向跨届合并键（期数 = *）收缩，国服向日服同键收缩。
 * 没有观测的小时段取最近有观测的段（旧数据缺最后一小时的点，记 0 会在结束前造成假的凹陷）。
 */
function fitChapterPositionCells(scopes, cells, o) {
    const lookup = { cells, cnFromJp: o.cnFromJp, crossTurn: o.crossTurn, cnFinaleFromJp: o.cnFinaleFromJp };
    const wanted = new Set(o.chapterPositions);
    const members = new Map();
    for (const sc of scopes) {
        if (!sc.positionKey || !wanted.has(sc.positionKey.split("|")[3])) continue;
        const base = resolveCurveCell(sc.ctx, lookup, "profiles");
        if (!base) continue;
        for (const key of [sc.positionKey, o.crossTurn ? curveTurnPooledKey(sc.positionKey) : null]) {
            if (!key) continue;
            let list = members.get(key);
            if (!list) members.set(key, (list = []));
            list.push({ sc, base });
        }
    }
    const out = {};
    for (const key of processingOrder(members.keys())) {
        const list = members.get(key);
        const target = chapterPositionLookupChain(key, o).slice(1).find((k) => out[k]) ?? null;
        const tgt = target ? out[target] : null;
        const k = !tgt ? 0 : target.startsWith("jp|") && key.startsWith("cn|") ? o.regionShrink : o.positionShrink;
        const end = o.anchors.map((anchor, a) => {
            if (anchor < o.positionMinRank) return new Array(o.endEdgesHours.length).fill(0);
            const items = list.flatMap(({ sc, base }) => {
                const r = sc.pre.ranks.get(anchor);
                const p = r?.obs ? profileAtRank(base, o, anchor) : null;
                return p ? [{ obs: r.obs, w: sc.w, offset: logRateOffsets(r.obs, p) }] : [];
            });
            const t = tgt ? tgt.end[a] : null;
            if (items.length === 0 || (t && !Number.isFinite(k))) return t;
            const own = fitFactors(items, o, ZERO_RHYTHM, [1]);
            const levels = own.fam[1];
            const seen = own.counts[1];
            for (let L = 0; L < levels.length; L++) {
                if (seen[L] > 0) continue;
                const near = [...levels.keys()].filter((M) => seen[M] > 0).sort((x, y) => Math.abs(x - L) - Math.abs(y - L) || y - x)[0];
                if (near !== undefined) levels[L] = levels[near];
            }
            return shrinkLevels(levels, seen, t, k);
        });
        if (end.some((e, a) => e && o.anchors[a] >= o.positionMinRank)) out[key] = { scopes: list.length, shrunkToward: k > 0 ? target : null, shrinkWeight: k, end };
    }
    return Object.fromEntries(Object.keys(out).sort().map((key) => [key, out[key]]));
}

// ─── fitCurve ─────────────────────────────────────────────────────────────

/**
 * 只影响输出体积：成员与合并单元格完全相同的变体删去（查找链会落到合并单元格，结果相同）；
 * 所有可能变体都在的合并单元格不会再被查到，也删去。
 */
function pruneCells(cells, members) {
    const sameMembers = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    for (const key of Object.keys(cells)) {
        const parent = curveParentKey(key);
        if (parent && cells[parent] && sameMembers(members.get(key), members.get(parent))) delete cells[key];
    }
    for (const key of Object.keys(cells)) {
        if (key.split("|").length !== 3) continue;
        const variants = VARIANTS[key.split("|")[1]];
        if (variants && variants.every((v) => cells[`${key}|${v}`])) delete cells[key];
    }
}

/** 处理顺序：日服在前；同区服内跨届合并在单届之前，合并单元格（3 段键）在变体（4 段键）之前，使收缩目标先定稿。 */
function processingOrder(keys) {
    const rankOf = (k) => {
        const parts = k.split("|");
        return (parts[0] === "jp" ? 0 : 100) + (parts[2] === "*" ? 0 : 10) + parts.length;
    };
    return [...keys].sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b));
}

/** 收缩强度：按目标相对自身的关系（跨区服、跨届、变体 → 合并）。 */
function shrinkStrength(key, target, o) {
    if (target.startsWith("jp|") && key.startsWith("cn|")) return o.regionShrink;
    if (target.split("|")[2] === "*" && key.split("|")[2] !== "*") return o.turnShrink;
    return o.variantShrink;
}

/**
 * fitCurve(train, opts?) → CurveSection。train = { events, series, finals }（loadDataset / rollingBacktest 的训练集）。
 * 只用至少有一个档位终榜的范围（进行中的活动不参与）；同步返回。章节位置表只含 opts.contextOf 给出了 eventEndAt 的范围。
 */
export function fitCurve(train, opts = {}) {
    const o = { ...CURVE_FIT_DEFAULTS, ...opts };
    const index = indexDataset(train);
    const scopes = [];
    let tRef = -Infinity;
    for (const ev of train.events) {
        for (const scope of scopesOf(ev)) {
            const finals = actualFinals(index, ev, scope);
            if (finals.size === 0) continue;
            const seriesByRank = index.seriesOf(ev.region, ev.eventId, scope);
            if (seriesByRank.size === 0) continue;
            const pre = scopePre(ev, scope, seriesByRank, o);
            if (![...pre.ranks.values()].some((r) => r.obs)) continue;
            const ctx = o.contextOf(ev, scope);
            scopes.push({ ev, pre, finals, ctx, key: curveCellKey(ctx), positionKey: chapterPositionKey(ctx) });
            tRef = Math.max(tRef, ev.aggregateAt);
        }
    }
    for (const sc of scopes) {
        sc.w = Number.isFinite(o.halfLifeYears) ? 0.5 ** ((tRef - sc.ev.aggregateAt) / (o.halfLifeYears * YEAR_MS)) : 1;
    }
    // 疲劳槽单元格只代表各区服最新的休息时间组（日服 #197 为第 1 组，#198 起为第 2 组）；旧组的普通活动只进合并单元格。
    const latestBreakSet = {};
    const latestBreakAt = {};
    for (const { ev } of scopes) {
        if (ev.group !== "normal" || ev.breakTimeId == null) continue;
        if (latestBreakAt[ev.region] === undefined || ev.aggregateAt > latestBreakAt[ev.region]) {
            latestBreakAt[ev.region] = ev.aggregateAt;
            latestBreakSet[ev.region] = ev.breakTimeId;
        }
    }
    for (const sc of scopes) {
        const { ev } = sc;
        sc.ownKey = ev.group === "normal" && ev.breakTimeId != null && ev.breakTimeId !== latestBreakSet[ev.region] ? null : sc.key;
    }

    // 每个范围计入自身单元格与其合并单元格。
    const members = new Map();
    const addMember = (key, sc) => {
        let list = members.get(key);
        if (!list) members.set(key, (list = []));
        list.push(sc);
    };
    for (const sc of scopes) {
        const pooled = o.crossTurn ? curveTurnPooledKey(sc.key) : null;
        for (const key of [sc.ownKey, curveParentKey(sc.key), pooled, pooled && curveParentKey(pooled)]) {
            if (key) addMember(key, sc);
        }
    }

    const bandCount = o.rhythmBands.length + 1;
    const fitted = new Map();
    const uniformAcc = newSigmaAcc(o);
    for (const sc of scopes) addResiduals(uniformAcc, residualsFor(sc.pre, sc.finals, () => null, o), sc.w, o);
    for (const key of processingOrder(members.keys())) {
        const list = members.get(key);
        const target = curveLookupChain(key, o).slice(1).find((k) => fitted.has(k)) ?? null;
        const targetCell = target ? fitted.get(target).cell : null;
        const k = targetCell ? shrinkStrength(key, target, o) : 0;

        const itemsOf = (pred) => list.flatMap((sc) => [...sc.pre.ranks]
            .filter(([rank, r]) => r.obs && pred(rank))
            .map(([, r]) => ({ obs: r.obs, w: sc.w })));

        const rhythm = Array.from({ length: bandCount }, (_, b) => {
            const items = itemsOf((rank) => rhythmBandOf(o.rhythmBands, rank) === b);
            const own = items.length > 0 ? fitFactors(items, o) : null;
            const tgt = targetCell ? targetCell.rhythm[b] : null;
            return own ? shrinkLevels(own.fam[2], own.counts[2], tgt, k) : tgt;
        });
        const profiles = o.anchors.map((anchor, a) => {
            const tgt = targetCell ? targetCell.profiles[a] : null;
            const items = itemsOf((rank) => rank === anchor);
            const bandR = rhythm[rhythmBandOf(o.rhythmBands, anchor)];
            if (items.length === 0 || !bandR) return tgt;
            const own = fitFactors(items, o, bandR);
            return {
                open: shrinkLevels(own.fam[0], own.counts[0], tgt?.open, k),
                end: shrinkLevels(own.fam[1], own.counts[1], tgt?.end, k),
                trend: shrinkLevels(own.fam[3], own.counts[3], tgt?.trend, k),
            };
        });
        const cell = {
            scopes: list.length,
            events: new Set(list.map((sc) => `${sc.ev.region}-${sc.ev.eventId}`)).size,
            shrunkToward: k > 0 ? target : null,
            shrinkWeight: k,
            rhythm,
            profiles,
            sigma: [],
        };
        const acc = newSigmaAcc(o);
        for (const sc of list) {
            const cumOf = (rank) => {
                const p = profileAtRank(cell, o, rank);
                return p ? cumulativeShare(sc.pre.grid, p) : null;
            };
            addResiduals(acc, residualsFor(sc.pre, sc.finals, cumOf, o), sc.w, o);
        }
        fitted.set(key, { cell, acc, target });
    }

    const uniformSigma = finishSigma(uniformAcc, null, 0);
    const cells = {};
    for (const key of processingOrder(fitted.keys())) {
        const { cell, acc, target } = fitted.get(key);
        const fallback = target && cells[target] ? cells[target].sigma : uniformSigma;
        cell.sigma = finishSigma(acc, fallback, o.sigmaPrior);
        cells[key] = cell;
    }
    pruneCells(cells, members);
    const chapterPosition = fitChapterPositionCells(scopes, cells, o);
    return {
        version: 1,
        anchors: [...o.anchors],
        rhythmBands: [...o.rhythmBands],
        openEdgesHours: [...o.openEdgesHours],
        endEdgesHours: [...o.endEdgesHours],
        trendBins: o.trendBins,
        sigmaGrid: [...o.sigmaGrid],
        cnFromJp: o.cnFromJp,
        cnFinaleFromJp: o.cnFinaleFromJp,
        crossTurn: o.crossTurn,
        cells: Object.fromEntries(Object.keys(cells).sort().map((key) => [key, cells[key]])),
        chapterPosition,
        uniformSigma,
        fit: {
            halfLifeYears: Number.isFinite(o.halfLifeYears) ? o.halfLifeYears : "none",
            iterations: o.iterations,
            factorPrior: o.factorPrior,
            maxGapHours: o.maxGapHours,
            variantShrink: o.variantShrink,
            regionShrink: o.regionShrink,
            turnShrink: o.turnShrink,
            sigmaPrior: o.sigmaPrior,
            chapterPositions: o.chapterPositions.join(",") || "none",
            positionShrink: o.positionShrink,
            positionMinRank: o.positionMinRank,
            scopes: scopes.length,
            positionScopes: scopes.filter((sc) => sc.positionKey).length,
        },
    };
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = { data: DEFAULT_DATA_DIR, out: DEFAULT_FIT_DIR };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a !== "--data" && a !== "--out") throw new Error(`未知参数：${a}`);
        const v = argv[i + 1];
        if (v == null) throw new Error(`${a} 缺少取值`);
        args[a.slice(2)] = v;
        i += 1;
    }
    return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = parseArgs(process.argv.slice(2));
    const started = Date.now();
    const data = loadDataset(args.data, { log: () => {} });
    const section = fitCurve(data);
    fs.mkdirSync(args.out, { recursive: true });
    const file = path.join(args.out, "curve.json");
    fs.writeFileSync(file, JSON.stringify(section) + "\n");
    console.log(`fit-curve：${section.fit.scopes} 个范围，${Object.keys(section.cells).length} 个单元格，`
        + `用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒 → ${file}`);
}
