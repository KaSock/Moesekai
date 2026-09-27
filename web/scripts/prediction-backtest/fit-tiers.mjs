#!/usr/bin/env node
// F3 跨档位关系：按单元格（tiersCellKey）拟合阶梯上相邻两档的终榜 log 比值（按时间加权的均值与预测 SD），
// 以及同一时刻两档比值相对终榜比值的漂移 SD（按进度节点），输出 TiersSection（src/lib/prediction/model/tiers.ts）。
// 跨单元格只通过显式收缩共享：单元格自身 n 个范围时权重 n / (n + shrinkK)，其余取同区服同组别的合并值（另加单元格间方差）；
// 终章按 (区服, 活动) 单列，不参与任何合并。普通活动的疲劳槽单元格只用训练集里最新一套疲劳槽参数（breakTimeId）的活动，
// 旧参数套只进合并组。按单元格的开关：adjustCells（开启跨档调整，默认无）与 unsharedCells（不向合并组收缩）。
// --backtest：在上线的完整链路（curve → tiers → prior → fuse，每折重拟合，与 fit-fuse 的滚动模拟同一路径）上比较
// 跨档调整全关 / 全开 / 嵌套开关（每期活动的开关只看结算早于其开始的活动），并做终榜留一的缺档补齐检验，据此给出开关建议。
// 用法：node --experimental-strip-types scripts/prediction-backtest/fit-tiers.mjs [--data <dir>] [--out <dir>]
//        [--backtest] [--backtest-out <dir>] [--report <md>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { contextFromDataset } from "../../src/lib/prediction/model/dataset-context.ts";
import {
    DEFAULT_PROGRESS_KNOTS,
    adjustAcrossTiers,
    logNormalQuantiles,
    lookupTiersCell,
    tiersCellKey,
    tiersFamilyKey,
} from "../../src/lib/prediction/model/tiers.ts";
import {
    DEFAULT_DATA_DIR,
    MODEL_WORK_DIR,
    actualFinals,
    cellOf,
    indexDataset,
    loadDataset,
    scopeKey,
    scopeWindow,
    scopesOf,
    scoreAt,
    subsetDataset,
} from "./dataset.mjs";
import { DEFAULT_CUTS, cutTime, rollingBacktest } from "./harness.mjs";
import { aggregate, pairRows, summarize, tierBand } from "./metrics.mjs";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_FIT_OUT = path.join(MODEL_WORK_DIR, "fit");
export const DEFAULT_TIERS_BACKTEST_DIR = path.join(MODEL_WORK_DIR, "backtest", "tiers");

export const DEFAULT_TIERS_OPTIONS = Object.freeze({
    // 收缩强度 K：0 = 只用单元格自身数据（不跨单元格共享，也不给无数据的单元格合并值）。
    shrinkK: 5,
    // 终榜比值的时间加权半衰期（天）；A1 第 5 节：比值有逐年趋势，应以近期为准。
    halfLifeDays: 120,
    // 档位进入阶梯所需的最少范围数（收缩时按同组合并计数）。
    minScopes: 3,
    // 误差相关所需的最少范围数（两档都有序列）。
    minSeriesScopes: 5,
    // 序列插值允许的最大间隔。
    maxGapMs: 3 * HOUR_MS,
    knots: DEFAULT_PROGRESS_KNOTS,
    // 开启跨档调整的单元格（tiersCellKey；"all" = 所有可调整的单元格与合并组）；其余只补缺档。完整链路的嵌套滚动回测里
    // 开关没有降低误差（--backtest 报告第 0 节，wf/F3-R1.md），所以默认一个也不开。没有自身数据的单元格退回合并组，合并组只在 "all" 时调整。
    adjustCells: Object.freeze([]),
    // 终榜留一（滚动原点）里收缩不优于只用单元格自身数据的单元格：不向合并组收缩（--backtest 的建议；
    // jp|normal|base 自身有约 180 期，两者补齐 MAPE 相差不到 0.001 个百分点）。
    unsharedCells: Object.freeze(["jp|normal|base"]),
});

/**
 * --backtest 的开关规则。单元格开启调整 = 完整链路里该单元格至少 minEvents 期、开启后配对 MAPE 低于关闭；
 * 这条规则逐折嵌套地用（只看结算早于测试活动开始的活动）时，总 MAPE 须比全关低至少 minRelativeGain（相对值），
 * 否则不开任何单元格。
 */
export const GATE_RULE = Object.freeze({ minEvents: 3, minRelativeGain: 0.01 });

function round(x) {
    return Math.round(x * 1e5) / 1e5;
}

function groupBy(items, keyOf) {
    const out = new Map();
    for (const it of items) {
        const k = keyOf(it);
        if (k == null) continue;
        let list = out.get(k);
        if (!list) out.set(k, (list = []));
        list.push(it);
    }
    return out;
}

/** 训练集里每个有终榜的范围：单元格键、窗口、各档终榜与序列；按结算时间升序。 */
export function scopeRecords(data) {
    const index = indexDataset(data);
    const records = [];
    for (const ev of data.events) {
        for (const scope of scopesOf(ev)) {
            const finals = actualFinals(index, ev, scope);
            if (finals.size === 0) continue;
            const ctx = contextFromDataset(ev, scope, ev.startAt, [], null);
            records.push({
                ev,
                scope,
                ctx,
                breakTimeId: ev.breakTimeId ?? null,
                key: tiersCellKey(ctx),
                family: tiersFamilyKey(ctx),
                startAt: ctx.scopeStartAt,
                endAt: ctx.scopeEndAt,
                finals: new Map([...finals].map(([rank, f]) => [rank, f.score])),
                series: index.seriesOf(ev.region, ev.eventId, scope),
            });
        }
    }
    return records.sort((a, b) => a.endAt - b.endAt || a.ev.eventId - b.ev.eventId);
}

/** 范围在各进度节点的 log(当前 / 终榜)（单档估计误差的来源）；缺数据的节点为 null。按档位缓存在记录上。 */
function logShares(rec, rank, o) {
    rec.logShares ??= new Map();
    if (!rec.logShares.has(rank)) {
        const s = rec.series.get(rank);
        const final = rec.finals.get(rank);
        rec.logShares.set(rank, s && final > 0
            ? o.knots.map((p) => {
                const y = scoreAt(s.points, rec.startAt + p * (rec.endAt - rec.startAt), rec.startAt, o.maxGapMs);
                return y > 0 ? Math.log(y / final) : null;
            })
            : null);
    }
    return rec.logShares.get(rank);
}

function pearson(xs, ys) {
    const n = xs.length;
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
        mx += xs[i];
        my += ys[i];
    }
    mx /= n;
    my /= n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (ys[i] - my) ** 2;
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** 两档 log(当前 / 终榜) 在各节点上跨范围的相关系数；样本不足的节点取最近的有效节点；全无则 null。 */
function shareCorrelation(records, a, b, o) {
    let nSeries = 0;
    const xs = o.knots.map(() => []);
    const ys = o.knots.map(() => []);
    for (const rec of records) {
        const la = logShares(rec, a, o);
        const lb = logShares(rec, b, o);
        if (!la || !lb) continue;
        nSeries += 1;
        o.knots.forEach((_, k) => {
            if (la[k] != null && lb[k] != null) {
                xs[k].push(la[k]);
                ys[k].push(lb[k]);
            }
        });
    }
    if (nSeries < o.minSeriesScopes) return { nSeries, corr: null };
    const corr = o.knots.map((_, k) => (xs[k].length >= o.minSeriesScopes ? pearson(xs[k], ys[k]) : null));
    if (corr.every((c) => c == null)) return { nSeries, corr: null };
    return { nSeries, corr: corr.map((c, i) => c ?? nearest(corr, i)) };
}

function nearest(values, i) {
    for (let k = 1; k < values.length; k++) {
        if (values[i - k] != null) return values[i - k];
        if (values[i + k] != null) return values[i + k];
    }
    return null;
}

/** 一组范围在档对 (a, b) 上的终榜 log 比值（按结算时间升序）。 */
function pairRatios(records, a, b) {
    const ratios = [];
    for (const rec of records) {
        const fa = rec.finals.get(a);
        const fb = rec.finals.get(b);
        if (fa > 0 && fb > 0) ratios.push({ r: Math.log(fb / fa), endAt: rec.endAt, eventStartAt: rec.ev.startAt, eventEndAt: rec.ev.aggregateAt });
    }
    return ratios;
}

/**
 * 时间加权均值，以及对新范围的预测方差：优先用一步前向误差（每个范围只和结算早于其活动开始的范围的加权均值比较，
 * 与上线时的可用信息一致）的加权均方；误差不足 MIN_ONE_STEP_ERRORS 个时用加权样本方差 × (1 + 1/有效样本数)。
 * 有效样本数 ≤ 1 且没有一步误差时方差为 null。
 */
const MIN_ONE_STEP_ERRORS = 3;

function weightedRatioStats(ratios, halfLifeMs) {
    const n = ratios.length;
    if (n === 0) return { n: 0, mean: null, predVar: null };
    const t0 = ratios[0].endAt;
    const weightOf = (x) => 2 ** ((x.endAt - t0) / halfLifeMs);
    let sw = 0;
    let sw2 = 0;
    let swr = 0;
    for (const x of ratios) {
        const w = weightOf(x);
        sw += w;
        sw2 += w * w;
        swr += w * x.r;
    }
    const mean = swr / sw;

    // 按活动结算时间排序后的前缀和：结算早于某活动开始的范围恰为一个前缀。
    const byEventEnd = [...ratios].sort((a, b) => a.eventEndAt - b.eventEndAt);
    const prefW = [0];
    const prefWr = [0];
    const prefN = [0];
    for (const x of byEventEnd) {
        const w = weightOf(x);
        prefW.push(prefW[prefW.length - 1] + w);
        prefWr.push(prefWr[prefWr.length - 1] + w * x.r);
        prefN.push(prefN[prefN.length - 1] + 1);
    }
    let se = 0;
    let swe = 0;
    let errors = 0;
    for (const x of ratios) {
        let lo = 0;
        let hi = byEventEnd.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (byEventEnd[mid].eventEndAt < x.eventStartAt) lo = mid + 1;
            else hi = mid;
        }
        if (prefN[lo] < 2) continue;
        const e = x.r - prefWr[lo] / prefW[lo];
        const w = weightOf(x);
        se += w * e * e;
        swe += w;
        errors += 1;
    }
    if (errors >= MIN_ONE_STEP_ERRORS) return { n, mean, predVar: se / swe };

    const nEff = (sw * sw) / sw2;
    if (!(nEff > 1 + 1e-9)) return { n, mean, predVar: null };
    let sv = 0;
    for (const x of ratios) sv += weightOf(x) * (x.r - mean) ** 2;
    return { n, mean, predVar: (((sv / sw) * nEff) / (nEff - 1)) * (1 + 1 / nEff) };
}

function pairStats(records, a, b, o) {
    return {
        ...weightedRatioStats(pairRatios(records, a, b), o.halfLifeDays * DAY_MS),
        ...shareCorrelation(records, a, b, o),
    };
}

/** 同组各单元格均值的离散度减去各自抽样方差（矩估计，下限 0）；少于两个单元格时取合并预测方差。 */
function betweenCellVariance(cellStats, pooled) {
    const usable = cellStats.filter((c) => c.n >= 2 && c.predVar != null);
    if (usable.length < 2) return pooled.predVar ?? 0;
    const m = usable.reduce((s, c) => s + c.mean, 0) / usable.length;
    const spread = usable.reduce((s, c) => s + (c.mean - m) ** 2, 0) / (usable.length - 1);
    const sampling = usable.reduce((s, c) => s + c.predVar / c.n, 0) / usable.length;
    return Math.max(0, spread - sampling);
}

function blend(own, pooled, w) {
    if (own && pooled) return own.map((v, i) => w * v + (1 - w) * pooled[i]);
    return own ?? pooled;
}

function makePair(mean, variance, corr, n, nSeries) {
    return {
        logRatio: round(mean),
        logRatioSigma: round(Math.sqrt(variance)),
        errorCorr: corr ? corr.map(round) : null,
        n,
        nSeries,
    };
}

/** 单元格自身统计与同组合并统计的收缩组合；pooled 为 null 时只用自身数据。 */
function combinePair(own, pooled, o) {
    if (!pooled) {
        if (own.n < 2 || own.predVar == null) return null;
        return makePair(own.mean, own.predVar, own.corr, own.n, own.nSeries);
    }
    if (pooled.n < 2 || pooled.predVar == null) return null;
    const pooledVar = pooled.predVar + pooled.between;
    const w = own.n / (own.n + o.shrinkK);
    const mean = own.n > 0 ? w * own.mean + (1 - w) * pooled.mean : pooled.mean;
    const variance = w * (own.predVar ?? pooledVar) + (1 - w) * pooledVar;
    const corr = blend(own.corr, pooled.corr, own.nSeries / (own.nSeries + o.shrinkK));
    return makePair(mean, variance, corr, own.n, own.nSeries);
}

function ladderRanks(records, minScopes) {
    const counts = new Map();
    for (const rec of records) for (const rank of rec.finals.keys()) counts.set(rank, (counts.get(rank) ?? 0) + 1);
    return [...counts].filter(([, n]) => n >= minScopes).map(([rank]) => rank).sort((a, b) => a - b);
}

const COMMON_CORR_GRID = Array.from({ length: 19 }, (_, i) => i * 0.05);

/**
 * 各节点的共同误差相关 c：让模型相关 c + (1 − c)·∏ρ'_k（ρ'_k = (ρ_k − c)/(1 − c)，ρ_k 为相邻档相关）
 * 在所有相隔 ≥ 2 档的档对上最接近经验相关（最小二乘，网格 0–0.9）。没有可用档对时为 null。
 */
function commonCorrelation(records, ranks, o) {
    const adjacent = ranks.slice(0, -1).map((a, i) => shareCorrelation(records, a, ranks[i + 1], o).corr);
    const empirical = [];
    for (let i = 0; i < ranks.length; i++) {
        for (let j = i + 2; j < ranks.length; j++) {
            if (adjacent.slice(i, j).some((c) => !c)) continue;
            const { corr } = shareCorrelation(records, ranks[i], ranks[j], o);
            if (corr) empirical.push({ i, j, corr });
        }
    }
    if (empirical.length === 0) return null;
    return o.knots.map((_, k) => {
        let best = 0;
        let bestErr = Infinity;
        for (const c of COMMON_CORR_GRID) {
            let err = 0;
            for (const e of empirical) {
                let chain = 1;
                for (let s = e.i; s < e.j; s++) chain *= Math.min(Math.max((adjacent[s][k] - c) / (1 - c), 0), 0.98);
                err += (c + (1 - c) * chain - e.corr[k]) ** 2;
            }
            if (err < bestErr) {
                bestErr = err;
                best = c;
            }
        }
        return best;
    });
}

/** 阶梯上相邻两步的标准化终榜比值残差的相关（截断到 [0, 0.9]）；样本不足时为 null。 */
function ratioCorrelation(records, ranks, pairs) {
    const xs = [];
    const ys = [];
    for (const rec of records) {
        for (let k = 0; k + 2 < ranks.length; k++) {
            const p = pairs[k];
            const q = pairs[k + 1];
            if (!p || !q) continue;
            const f0 = rec.finals.get(ranks[k]);
            const f1 = rec.finals.get(ranks[k + 1]);
            const f2 = rec.finals.get(ranks[k + 2]);
            if (!(f0 > 0 && f1 > 0 && f2 > 0)) continue;
            xs.push((Math.log(f1 / f0) - p.logRatio) / p.logRatioSigma);
            ys.push((Math.log(f2 / f1) - q.logRatio) / q.logRatioSigma);
        }
    }
    if (xs.length < 10) return null;
    const c = pearson(xs, ys);
    return c == null ? null : Math.min(Math.max(c, 0), 0.9);
}

/** 每个区服最新结算的疲劳槽普通活动所用的疲劳槽参数套。 */
function newestBreakSets(records) {
    const out = new Map();
    for (const r of records) if (r.ctx.group === "normal" && r.breakTimeId != null) out.set(r.ev.region, r.breakTimeId);
    return out;
}

/** 疲劳槽单元格只收最新参数套；其余范围都进自己的单元格。 */
function inOwnCell(rec, newestSet) {
    if (rec.ctx.group !== "normal" || rec.breakTimeId == null) return true;
    return rec.breakTimeId === newestSet.get(rec.ev.region);
}

/**
 * fitTiers(train, opts?) → TiersSection。
 * train = { events, series, finals }（dataset.mjs 的格式）；opts 见 DEFAULT_TIERS_OPTIONS。同步、纯函数。
 */
export function fitTiers(train, opts = {}) {
    const o = { ...DEFAULT_TIERS_OPTIONS, ...opts };
    const records = scopeRecords(train);
    const newestSet = newestBreakSets(records);
    const byCell = groupBy(records, (r) => (inOwnCell(r, newestSet) ? r.key : null));
    const byFamily = o.shrinkK > 0 ? groupBy(records, (r) => r.family) : new Map();
    const familyOfCell = new Map(records.map((r) => [r.key, r.family]));
    const adjustAll = o.adjustCells === "all";
    const adjustSet = new Set(adjustAll ? [] : o.adjustCells);
    const unshared = new Set(o.unsharedCells);

    // 同组合并统计按档对缓存：合并统计 + 单元格间方差。
    const pooledCache = new Map();
    const pooledStats = (family, a, b) => {
        const k = `${family}|${a}|${b}`;
        if (!pooledCache.has(k)) {
            const recs = byFamily.get(family);
            const pooled = pairStats(recs, a, b, o);
            const cellStats = [...groupBy(recs, (r) => r.key).values()].map((rs) => weightedRatioStats(pairRatios(rs, a, b), o.halfLifeDays * DAY_MS));
            pooledCache.set(k, { ...pooled, between: betweenCellVariance(cellStats, pooled) });
        }
        return pooledCache.get(k);
    };
    const familyCells = new Map();

    const buildCell = (own, family, key = null) => {
        const pooledRecords = family ? byFamily.get(family) : null;
        const ranks = ladderRanks(pooledRecords ?? own, o.minScopes);
        const pairs = [];
        for (let i = 0; i + 1 < ranks.length; i++) {
            const ownStats = pairStats(own, ranks[i], ranks[i + 1], o);
            pairs.push(combinePair(ownStats, pooledRecords ? pooledStats(family, ranks[i], ranks[i + 1]) : null, o));
        }
        const nOwn = own.length;
        const pooledCell = family && own.length > 0 ? familyCells.get(family) : null;
        const w = nOwn / (nOwn + o.shrinkK);
        const ownRatioCorr = ratioCorrelation(own, ranks, pairs);
        const ratioCorr = pooledCell
            ? (ownRatioCorr == null ? pooledCell.ratioCorr : w * ownRatioCorr + (1 - w) * pooledCell.ratioCorr)
            : ownRatioCorr ?? 0;
        const ownSeries = own.filter((r) => r.series.size > 0).length;
        const ownCommon = commonCorrelation(own, ranks, o);
        const commonCorr = pooledCell ? blend(ownCommon, pooledCell.commonCorr, ownSeries / (ownSeries + o.shrinkK)) : ownCommon;
        return {
            ranks,
            pairs,
            ratioCorr: round(ratioCorr),
            commonCorr: commonCorr ? commonCorr.map(round) : null,
            adjust: (adjustAll || adjustSet.has(key)) && commonCorr != null && pairs.some((p) => p?.errorCorr),
        };
    };

    // 先建合并组（供单元格收缩），再建各单元格。
    const families = {};
    for (const family of [...byFamily.keys()].sort()) {
        const cell = buildCell(byFamily.get(family), null);
        const pooled = buildCell([], family);
        familyCells.set(family, cell);
        if (pooled.pairs.some(Boolean)) families[family] = { ...pooled, ratioCorr: cell.ratioCorr, commonCorr: cell.commonCorr, adjust: cell.adjust };
    }
    const cells = {};
    for (const [key, own] of [...byCell].sort(([x], [y]) => x.localeCompare(y))) {
        const family = !unshared.has(key) && byFamily.has(familyOfCell.get(key)) ? familyOfCell.get(key) : null;
        const cell = buildCell(own, family, key);
        if (cell.pairs.some(Boolean)) cells[key] = cell;
    }
    // 不共享的单元格没有自身数据时也不得退回合并组：记为空阶梯（原样透传）。
    for (const key of [...unshared].sort()) {
        if (cells[key] || key.split("|")[1] === "wl_finale") continue;
        cells[key] = { ranks: [], pairs: [], ratioCorr: 0, commonCorr: null, adjust: false };
    }
    return { version: 1, progressKnots: [...o.knots], cells, families };
}

// ---------------------------------------------------------------------------------------------
// 回测：上线的完整链路（与 fit-fuse 的滚动模拟同一路径）与终榜留一。

export const EVAL_MODELS = {
    chainOff: "chain-tiers-off",
    chainOn: "chain-tiers-on",
    chainNested: "chain-tiers-nested",
    finalsFill: "finals-fill",
    finalsFillCell: "finals-fill-cell",
    finalsLogLog: "finals-loglog",
};

const CHAIN_MODELS = [EVAL_MODELS.chainOff, EVAL_MODELS.chainOn, EVAL_MODELS.chainNested];

/** 同一 TiersSection，所有单元格与合并组只补缺档。 */
export function withoutAdjust(section) {
    const off = (cells) => Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, { ...c, adjust: false }]));
    return { ...section, cells: off(section.cells), families: off(section.families) };
}

function estimatePair(e) {
    return e ? [e.median, e.logSigma] : null;
}

/**
 * harness 的 predict：每个 (活动, 范围, 截点时刻) 记一条 fit-fuse 格式的组件记录（simulateRolling 的输入），
 * 跨档调整开、关各一份，顺序一致。sections = { prior, curve, tiersOn, tiersOff }。
 */
function chainRecorder(index, componentEstimates, arms) {
    const seen = new Set();
    return (sections, ctx, atMs, observed, info) => {
        const ev = info.event;
        const scope = scopeKey(info.scope);
        const id = `${ev.region}|${ev.eventId}|${scope}|${atMs}`;
        if (seen.has(id)) return null;
        seen.add(id);
        const { startAt, endAt } = scopeWindow(ev, info.scope);
        const actuals = actualFinals(index, ev, info.scope);
        const base = {
            ev,
            cell: info.cell.key,
            group: info.cell.group,
            wlTurn: info.cell.wlTurn,
            scope,
            chapterNo: ctx.chapterNo,
            tiersCell: tiersCellKey(ctx),
            cuts: DEFAULT_CUTS.filter((c) => cutTime(c, startAt, endAt) === atMs).map((c) => c.id),
            ctx,
            atMs,
            progress: (atMs - startAt) / (endAt - startAt),
        };
        for (const [arm, tiers] of [["on", sections.tiersOn], ["off", sections.tiersOff]]) {
            const comps = componentEstimates({ prior: sections.prior, curve: sections.curve, tiers }, ctx, atMs, observed);
            arms[arm].push({
                ...base,
                tiers: [...comps.values()].map((c) => ({
                    rank: c.rank,
                    current: c.currentScore,
                    currentAt: c.currentAt,
                    prior: estimatePair(c.prior),
                    obs: estimatePair(c.observed),
                    actual: actuals.get(c.rank)?.score ?? null,
                    actualSource: actuals.get(c.rank)?.source ?? null,
                })),
            });
        }
        return null;
    };
}

/** 一组完整链路行上跨档调整的证据：全关 vs 全开的配对汇总；期数至少 rule.minEvents 且开启后 MAPE 更低时 helps。 */
export function adjustEvidence(rows, rule = GATE_RULE) {
    const { a, b } = pairRows(rows, EVAL_MODELS.chainOff, EVAL_MODELS.chainOn);
    if (a.length === 0) return { off: null, on: null, helps: false };
    const off = summarize(a);
    const on = summarize(b);
    return { off, on, helps: off.events >= rule.minEvents && on.mape < off.mape };
}

/**
 * 嵌套开关：records[i]（测试活动 E、tiers 单元格 c）是否调整，只由 c 里结算早于 E 开始的活动的全关 / 全开行
 * 按 adjustEvidence 决定，与上线时能看到的信息一致。rows 含两组模型的行，cellOfRow 把行映射到 tiersCellKey。
 */
export function nestedAdjustFlags(data, records, rows, cellOfRow, rule = GATE_RULE) {
    const aggregateAt = new Map(data.events.map((e) => [`${e.region}|${e.eventId}`, e.aggregateAt]));
    const byCell = groupBy(rows, cellOfRow);
    const decided = new Map();
    return records.map((rec) => {
        const key = `${rec.tiersCell}|${rec.ev.startAt}`;
        if (!decided.has(key)) {
            const earlier = (byCell.get(rec.tiersCell) ?? []).filter((r) => aggregateAt.get(`${r.region}|${r.eventId}`) < rec.ev.startAt);
            decided.set(key, adjustEvidence(earlier, rule).helps);
        }
        return decided.get(key);
    });
}

/** 缺档的朴素补法：上下最近两档估计在 log(名次) 上的 log 线性插值；只补内部档。 */
function logLogFill(estimates, rank) {
    const ranks = [...estimates.keys()].filter((r) => r !== rank).sort((a, b) => a - b);
    const above = ranks.filter((r) => r < rank).pop();
    const below = ranks.find((r) => r > rank);
    if (above == null || below == null) return null;
    const f = Math.log(rank / above) / Math.log(below / above);
    const ya = Math.log(estimates.get(above).median);
    const yb = Math.log(estimates.get(below).median);
    return Math.exp(ya + f * (yb - ya));
}

/** 终榜留一时其余档的 logSigma（视为已知）。 */
const KNOWN_FINAL_SIGMA = 1e-3;

/**
 * 终榜留一（按滚动原点）：每个有终榜的范围只用结算早于其开始的活动拟合，其余档终榜视为已知，由阶梯补出去掉的一档。
 * 不需要序列，所以也覆盖 CN 与没有逐时数据的 JP 活动；检验的是比值先验本身（均值与区间）。
 */
function finalsLeaveOneOut(data, fitByLength) {
    const index = indexDataset(data);
    const byAggregate = [...data.events].sort((a, b) => a.aggregateAt - b.aggregateAt);
    const rows = [];
    for (const ev of data.events) {
        let len = 0;
        while (len < byAggregate.length && byAggregate[len].aggregateAt < ev.startAt) len += 1;
        if (len === 0) continue;
        for (const scope of scopesOf(ev)) {
            const cell = cellOf(ev, scope);
            const finals = actualFinals(index, ev, scope);
            if (finals.size < 2) continue;
            const f = fitByLength(len, byAggregate);
            const ctx = contextFromDataset(ev, scope, ev.aggregateAt, [], null);
            const known = new Map([...finals].filter(([, x]) => x.score > 0).map(([rank, x]) => [rank, { median: x.score, logSigma: KNOWN_FINAL_SIGMA }]));
            const base = { region: ev.region, eventId: ev.eventId, group: ctx.group, wlTurn: ctx.wlTurn, cell: cell.key, scope: scopeKey(scope), cut: "final", trainSize: len };
            const push = (model, rank, q) => rows.push({ ...base, model, rank, band: tierBand(rank), ...q, actual: finals.get(rank).score });
            for (const [model, section] of [[EVAL_MODELS.finalsFill, f.shrink], [EVAL_MODELS.finalsFillCell, f.cellOnly]]) {
                const tc = lookupTiersCell(ctx, section);
                if (!tc) continue;
                for (const rank of known.keys()) {
                    if (!tc.ranks.includes(rank)) continue;
                    const rest = new Map([...known].filter(([r]) => r !== rank));
                    const filled = adjustAcrossTiers(ctx, rest, section).get(rank);
                    if (filled) push(model, rank, logNormalQuantiles(filled));
                    if (model === EVAL_MODELS.finalsFill) {
                        const y = logLogFill(known, rank);
                        if (y != null) push(EVAL_MODELS.finalsLogLog, rank, { p10: null, p50: y, p90: null });
                    }
                }
            }
        }
    }
    return rows;
}

function seconds(started) {
    return ((Date.now() - started) / 1000).toFixed(1);
}

/**
 * --backtest 的回测行（model 字段区分）。完整链路：每折重拟合 prior / curve / tiers（调整全开），每个截点记下开、关两份
 * 组件记录，由 fit-fuse 的 simulateRolling 逐折拟合融合层，得到全关、全开、嵌套开关（nestedAdjustFlags）三组行；
 * 另加终榜留一。异步只因为按需载入 fit-prior / fit-curve / fit-fuse / predict（fit-fuse 静态载入本文件）。
 */
export async function evaluateTiers(data, { tiersOptions = {}, rule = GATE_RULE, log = () => {} } = {}) {
    const [{ fitPrior }, { fitCurve }, { simulateRolling }, { componentEstimates }] = await Promise.all([
        import("./fit-prior.mjs"),
        import("./fit-curve.mjs"),
        import("./fit-fuse.mjs"),
        import("../../src/lib/prediction/model/predict.ts"),
    ]);
    const index = indexDataset(data);
    const arms = { on: [], off: [] };
    let folds = 0;
    let started = Date.now();
    rollingBacktest({
        data,
        model: "tiers-chain-records",
        fit(train) {
            folds += 1;
            if (folds % 25 === 0) log(`  完整链路拟合 ${folds} 折…`);
            const tiersOn = fitTiers(train, { ...tiersOptions, adjustCells: "all" });
            return { prior: fitPrior(train), curve: fitCurve(train), tiersOn, tiersOff: withoutAdjust(tiersOn) };
        },
        predict: chainRecorder(index, componentEstimates, arms),
    });
    log(`完整链路组件记录：${arms.on.length} 条（${folds} 折），用时 ${seconds(started)} 秒`);

    started = Date.now();
    const off = simulateRolling(data, arms.off, {}, EVAL_MODELS.chainOff);
    const on = simulateRolling(data, arms.on, {}, EVAL_MODELS.chainOn);
    const flags = nestedAdjustFlags(data, arms.on, [...off, ...on], tiersCellOfRows(data), rule);
    const nested = simulateRolling(data, flags.map((f, i) => (f ? arms.on[i] : arms.off[i])), {}, EVAL_MODELS.chainNested);
    log(`完整链路：每组 ${off.length} 个预测点，嵌套开关开启 ${flags.filter(Boolean).length}/${flags.length} 条记录，用时 ${seconds(started)} 秒`);

    started = Date.now();
    const fits = new Map();
    const fitByLength = (len, byAggregate) => {
        if (!fits.has(len)) {
            const train = subsetDataset(data, byAggregate.slice(0, len));
            fits.set(len, {
                shrink: fitTiers(train, { ...tiersOptions, unsharedCells: [] }),
                cellOnly: fitTiers(train, { ...tiersOptions, shrinkK: 0 }),
            });
        }
        return fits.get(len);
    };
    const loo = finalsLeaveOneOut(data, fitByLength);
    log(`终榜留一：${loo.length} 行，用时 ${seconds(started)} 秒`);
    return [...off, ...on, ...nested, ...loo];
}

/** 回测行 → tiersCellKey（按事件与范围重建上下文）。 */
export function tiersCellOfRows(data) {
    const byScope = new Map();
    for (const ev of data.events) {
        for (const scope of scopesOf(ev)) {
            byScope.set(`${ev.region}|${ev.eventId}|${scopeKey(scope)}`, tiersCellKey(contextFromDataset(ev, scope, ev.startAt, [], null)));
        }
    }
    return (row) => byScope.get(`${row.region}|${row.eventId}|${row.scope}`) ?? null;
}

function pairedSummary(rows, a, b) {
    const p = pairRows(rows, a, b);
    return p.a.length ? { a: summarize(p.a), b: summarize(p.b) } : null;
}

/**
 * 逐 tiersCellKey 的开关建议。调整：嵌套开关的总 MAPE 比全关低至少 rule.minRelativeGain 时，开启全量数据上
 * adjustEvidence 成立的单元格，否则一个也不开。共享：终榜留一里收缩补齐的 MAPE 不高于只用单元格自身数据时共享。
 */
export function suggestGates(rows, cellOfRow, rule = GATE_RULE) {
    const chain = rows.filter((r) => CHAIN_MODELS.includes(r.model));
    const on = pairedSummary(chain, EVAL_MODELS.chainOff, EVAL_MODELS.chainOn);
    const nested = pairedSummary(chain, EVAL_MODELS.chainOff, EVAL_MODELS.chainNested);
    const keep = nested != null && nested.b.mape <= nested.a.mape * (1 - rule.minRelativeGain);
    const table = [];
    const adjustCells = [];
    const unsharedCells = [];
    for (const [cell, rs] of [...groupBy(rows, cellOfRow)].sort(([x], [y]) => x.localeCompare(y))) {
        const evidence = adjustEvidence(rs, rule);
        const fill = pairedSummary(rs, EVAL_MODELS.finalsFillCell, EVAL_MODELS.finalsFill);
        if (!evidence.off && !fill) continue;
        const adjust = keep && evidence.helps;
        const share = !fill || fill.b.mape <= fill.a.mape;
        if (adjust) adjustCells.push(cell);
        if (!share) unsharedCells.push(cell);
        table.push({ cell, evidence, nested: pairedSummary(rs, EVAL_MODELS.chainOff, EVAL_MODELS.chainNested), fill, adjust, share });
    }
    return { adjustCells, unsharedCells, table, overall: { on, nested, keep } };
}

// ---------------------------------------------------------------------------------------------
// 报告

function pct(x, digits = 1) {
    return x == null ? "—" : `${(x * 100).toFixed(digits)}%`;
}

function pairedTable(rows, base, others, by) {
    const out = [];
    const baseRows = rows.filter((r) => r.model === base);
    const keys = [...new Set(baseRows.map(by))].sort();
    for (const key of keys) {
        const line = { key, base: null, others: [] };
        for (const other of others) {
            const { a, b } = pairRows(rows.filter((r) => by(r) === key), base, other);
            line.base ??= a.length ? summarize(a) : null;
            line.others.push(b.length ? { a: summarize(a), b: summarize(b) } : null);
        }
        out.push(line);
    }
    return out;
}

const CUT_ORDER = ["p10", "p25", "p50", "p75", "p90", "h24", "h12", "h6"];

function chainTable(lines, rows, title, by, sortKeys = (a, b) => a.key.localeCompare(b.key)) {
    lines.push(title, "");
    lines.push("| 键 | 期数 | 点数 | MAPE 全关 | MAPE 全开 | MAPE 嵌套 | 中位 APE 全关 / 全开 / 嵌套 | 覆盖率 全关 / 全开 / 嵌套 | 区间宽 全关 / 全开 / 嵌套 |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    const tableRows = pairedTable(rows, EVAL_MODELS.chainOff, [EVAL_MODELS.chainOn, EVAL_MODELS.chainNested], by).sort(sortKeys);
    const all = { key: "合计", others: [EVAL_MODELS.chainOn, EVAL_MODELS.chainNested].map((m) => pairedSummary(rows, EVAL_MODELS.chainOff, m)) };
    for (const line of [...tableRows, all]) {
        const [on, nested] = line.others;
        if (!on || !nested) continue;
        const off = on.a;
        lines.push(`| ${line.key} | ${off.events} | ${off.n} | ${pct(off.mape, 2)} | ${pct(on.b.mape, 2)} | ${pct(nested.b.mape, 2)} | ${pct(off.medianApe, 2)} / ${pct(on.b.medianApe, 2)} / ${pct(nested.b.medianApe, 2)} | ${pct(off.coverage)} / ${pct(on.b.coverage)} / ${pct(nested.b.coverage)} | ${pct(off.widthPct)} / ${pct(on.b.widthPct)} / ${pct(nested.b.widthPct)} |`);
    }
    lines.push("");
}

/** Markdown：开关建议、完整链路（逐回测单元格 / 截点 / 档位段）、终榜留一。gates = suggestGates 的结果。 */
export function renderTiersReport(rows, { generatedAt, notes = [], gates = null, shippedGates = null, rule = GATE_RULE } = {}) {
    const lines = [];
    lines.push("# F3 跨档位关系：完整链路滚动回测", "");
    lines.push(`生成时间：${generatedAt}`, "");
    for (const n of notes) lines.push(`- ${n}`);
    if (notes.length) lines.push("");
    lines.push("三组都走上线的完整链路（curve → tiers → prior → fuse），每折重拟合，融合层由 fit-fuse 的 simulateRolling 逐折拟合。全关 = 所有单元格只补缺档；全开 = 所有可调整的单元格与合并组都做跨档调整；嵌套 = 每期活动的各单元格开关只看结算早于其开始的活动（规则见第 0 节）。", "");

    if (gates) {
        const o = gates.overall;
        lines.push("## 0. 开关建议（按 tiersCellKey，同一批预测点配对）", "");
        lines.push(`调整：单元格至少 ${rule.minEvents} 期、全开的配对 MAPE 低于全关才算有效；这条规则嵌套使用时总 MAPE 须比全关低至少 ${pct(rule.minRelativeGain)}（相对值），才开启全量数据上有效的单元格，否则一个也不开。共享：终榜留一里收缩补齐的 MAPE 不高于只用单元格自身数据才共享。期数 < 5 的单元格证据弱。`, "");
        if (o.nested) {
            const onText = o.on ? pct(o.on.b.mape, 3) : "—";
            lines.push(`总计（${o.nested.a.events} 期、${o.nested.a.n} 个预测点）：全关 MAPE ${pct(o.nested.a.mape, 3)}，全开 ${onText}，嵌套 ${pct(o.nested.b.mape, 3)}。嵌套开关${o.keep ? "达到" : "没有达到"}门槛 → adjustCells = ${JSON.stringify(gates.adjustCells)}。`, "");
        }
        lines.push("| tiers 单元格 | 期数 | 点数 | MAPE 全关 | MAPE 全开 | MAPE 嵌套 | 全量有效 | 调整 | 期数（终榜） | 补齐 MAPE 收缩 | 补齐 MAPE 单元格 | 共享 |");
        lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
        for (const t of gates.table) {
            const e = t.evidence;
            lines.push(`| ${t.cell} | ${e.off?.events ?? 0} | ${e.off?.n ?? 0} | ${pct(e.off?.mape, 2)} | ${pct(e.on?.mape, 2)} | ${pct(t.nested?.b.mape, 2)} | ${e.off ? (e.helps ? "是" : "否") : "—"} | ${t.adjust ? "是" : "否"} | ${t.fill?.a.events ?? 0} | ${pct(t.fill?.b.mape, 2)} | ${pct(t.fill?.a.mape, 2)} | ${t.share ? "是" : "否"} |`);
        }
        lines.push("");
        if (shippedGates) {
            const same = (a, b) => [...a].sort().join(",") === [...b].sort().join(",");
            const ok = same(gates.adjustCells, shippedGates.adjustCells) && same(gates.unsharedCells, shippedGates.unsharedCells);
            lines.push(`上线配置：adjustCells = ${JSON.stringify(shippedGates.adjustCells)}，unsharedCells = ${JSON.stringify(shippedGates.unsharedCells)}${ok ? "（与本次回测建议一致）" : "（与本次回测建议不一致，需更新 DEFAULT_TIERS_OPTIONS）"}。`, "");
        }
    }

    const chain = rows.filter((r) => CHAIN_MODELS.includes(r.model));
    chainTable(lines, chain, "## 1. 完整链路，逐回测单元格", (r) => r.cell);
    chainTable(lines, chain, "## 2. 完整链路，按截点", (r) => r.cut, (a, b) => CUT_ORDER.indexOf(a.key) - CUT_ORDER.indexOf(b.key));
    chainTable(lines, chain, "## 3. 完整链路，按档位段", (r) => r.band);

    lines.push("## 4. 终榜留一（其余档终榜已知，由阶梯补出一档；滚动原点，含 CN）", "");
    lines.push("| 单元格 | 期数 | 点数（内部档） | MAPE 阶梯 | MAPE log-log | 期数（全部） | 点数（全部） | MAPE 阶梯（收缩） | MAPE 阶梯（单元格） | 覆盖率 | 区间宽 |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
    const looAll = new Map(aggregate(rows.filter((r) => r.model === EVAL_MODELS.finalsFill), ["cell"]).map((x) => [x.cell, x]));
    for (const line of pairedTable(rows, EVAL_MODELS.finalsFill, [EVAL_MODELS.finalsLogLog, EVAL_MODELS.finalsFillCell], (r) => r.cell)) {
        const [ll, cellOnly] = line.others;
        const all = looAll.get(line.key);
        if (!all) continue;
        lines.push(`| ${line.key} | ${ll ? ll.a.events : 0} | ${ll ? ll.a.n : 0} | ${ll ? pct(ll.a.mape, 2) : "—"} | ${ll ? pct(ll.b.mape, 2) : "—"} | ${all.events} | ${all.n} | ${cellOnly ? pct(cellOnly.a.mape, 2) : pct(all.mape, 2)} | ${cellOnly ? pct(cellOnly.b.mape, 2) : "—"} | ${pct(all.coverage)} | ${pct(all.widthPct)} |`);
    }
    lines.push("");
    return lines.join("\n");
}

export function parseArgs(argv) {
    const args = { data: DEFAULT_DATA_DIR, out: DEFAULT_FIT_OUT, backtest: false, backtestOut: DEFAULT_TIERS_BACKTEST_DIR, report: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v == null) throw new Error(`${a} 缺少取值`);
            return v;
        };
        if (a === "--data") args.data = value();
        else if (a === "--out") args.out = value();
        else if (a === "--backtest") args.backtest = true;
        else if (a === "--backtest-out") args.backtestOut = value();
        else if (a === "--report") args.report = value();
        else throw new Error(`未知参数：${a}`);
    }
    return args;
}

async function main(argv) {
    const args = parseArgs(argv);
    const data = loadDataset(args.data, { log: () => {} });
    const section = fitTiers(data);
    fs.mkdirSync(args.out, { recursive: true });
    const file = path.join(args.out, "tiers.json");
    fs.writeFileSync(file, JSON.stringify(section) + "\n");
    console.log(`tiers：${Object.keys(section.cells).length} 个单元格、${Object.keys(section.families).length} 个合并组 → ${file}`);
    if (!args.backtest) return;
    const rows = await evaluateTiers(data, { log: console.log });
    fs.mkdirSync(args.backtestOut, { recursive: true });
    fs.writeFileSync(path.join(args.backtestOut, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const gates = suggestGates(rows, tiersCellOfRows(data));
    console.log(`单元格开关建议：adjustCells = ${JSON.stringify(gates.adjustCells)}，unsharedCells = ${JSON.stringify(gates.unsharedCells)}`);
    const shippedGates = { adjustCells: DEFAULT_TIERS_OPTIONS.adjustCells, unsharedCells: DEFAULT_TIERS_OPTIONS.unsharedCells };
    const report = renderTiersReport(rows, { generatedAt: new Date().toISOString(), gates, shippedGates });
    const reportFile = args.report ?? path.join(args.backtestOut, "report.md");
    fs.writeFileSync(reportFile, report);
    console.log(`回测：${rows.length} 行 → ${args.backtestOut}；报告：${reportFile}`);
}

// 不用顶层 await：--backtest 按需载入的 fit-fuse 会静态载入本文件，本文件须先求值完。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}
