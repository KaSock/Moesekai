#!/usr/bin/env node
// F4 融合与区间：拟合 FuseSection（src/lib/prediction/model/fuse.ts），并把四个 section 组装成 src/lib/prediction/priors.json。
// - 融合权重：先验与“当前分 ÷ 预期占比”两种估计的标准化误差（误差 ÷ 各模块自身 logSigma）的方差与相关，
//   按单元格 × 进度节点估计，得到最小方差权重；
// - P10/P50/P90：标准化融合残差的经验分位数，同样按单元格 × 进度节点；
// - 以上统计全部来自“内层滚动”：训练集里每期活动都用只含其开始前已结算活动的 prior/curve/tiers 预测，
//   从不使用测试活动本身；单元格向父级（区服 × 组别合并、国服借日服同键、根）按 n / (n + k) 收缩，终章不参与合并；
// - 物理上限：训练集里已有终榜的活动各档历史最高的一小时增量（该档及更低名次的最大值）× 倍数 × 剩余小时
//   （从当前分的观测时刻算起）。
// CLI 另做全量滚动模拟：新模型每个单元格与 tori-v2 配对比较，更差的单元格记入 fuse.fallback（上线回退旧算法）。
// 用法：node --experimental-strip-types scripts/prediction-backtest/fit-fuse.mjs
//        [--data <dir>] [--committed <dir>] [--out <fit 目录>] [--priors <priors.json>] [--evaluate] [--annotate-report <report.md>]
// --committed：events.json / finals 所在目录（默认 scripts/prediction-backtest/data），用于在数据快照上复现 priors.json。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    DEFAULT_FUSE_KNOT,
    calibrationForCell,
    fuseLog,
    fuseLookupChain,
    physicalCeiling,
} from "../../src/lib/prediction/model/fuse.ts";
import { componentEstimates, fuseComponents } from "../../src/lib/prediction/model/predict.ts";
import { currentEngineBaseline } from "./baselines/current-engine.mjs";
import {
    DEFAULT_DATA_DIR,
    SESSIONS_MODEL_DIR,
    actualFinals,
    cellOf,
    eventKey,
    indexDataset,
    loadDataset,
    scopeKey,
    scopeWindow,
    subsetDataset,
} from "./dataset.mjs";
import { fitCurve } from "./fit-curve.mjs";
import { borrowedLevels, fitPrior } from "./fit-prior.mjs";
import { fitTiers } from "./fit-tiers.mjs";
import { DEFAULT_CUTS, cutTime, rollingBacktest } from "./harness.mjs";
import { pairRows, summarize, tierBand } from "./metrics.mjs";
import { cellLabel } from "./report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOUR_MS = 3_600_000;
const YEAR_MS = 365.25 * 24 * HOUR_MS;
const MIN_LOG_SIGMA = 1e-4;

export const DEFAULT_FIT_DIR = path.join(SESSIONS_MODEL_DIR, "fit");
export const DEFAULT_PRIORS_PATH = path.resolve(HERE, "../../src/lib/prediction/priors.json");
// 防止意外膨胀（例如给每期普通活动单列单元格）的上限，不是预算：priors.json 只进预测页与规划器按需加载的模型 chunk
// （299 KB 时 gzip 约 70 KB），每新增一期终章约多 8 KB。
export const PRIORS_MAX_BYTES = 400 * 1024;

export const DEFAULT_FUSE_OPTIONS = Object.freeze({
    // 与回测截点对齐：10/25/50/75/90% 以及结束前 24/12/6 小时常落在的 0.95、0.98。
    knots: Object.freeze([0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.98]),
    // 向父级收缩的伪样本数（单位：范围 × 截点）；5 / 10 / 20 中 20 的覆盖率最接近 80%，MAPE 不变。
    shrinkK: 20,
    // 中位数按单元格 × 节点的标准化残差中位数平移：滚动回测偏差 +0.9% → +0.2%，进度 10% 的 MAPE 11.4% → 10.8%。
    biasCorrection: true,
    correlation: true,
    calibrate: true,
    // 近期活动加权的半衰期（年）；Infinity = 不加权。
    halfLifeYears: Infinity,
    ceiling: true,
    // 历史最高时速的倍数。首个有序列的 WL 章节（日服 #124）和 JP #180 终章的实际速度达到此前全历史最高值的
    // 1.9 倍 / 1.5 倍；取 2 时滚动回测里没有终榜超出上限。
    ceilingMargin: 2,
    // 取作 P10 / P90 的标准化残差分位水平。只用过去数据估计的分位数在样本外偏窄（0.1 / 0.9 时覆盖率约 78%），
    // 0.09 / 0.91 使滚动回测覆盖率约 80%。
    levels: Object.freeze([0.09, 0.91]),
    // 只在模拟 / 消融里使用：只用先验（"prior"）、只用进度估计（"observed"）或两者融合（"fused"）。
    mode: "fused",
});

/** 标准正态分位函数（Acklam 近似，相对误差约 1e-9）。 */
export function probit(p) {
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const lo = 0.02425;
    if (p < lo) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - lo) return -probit(1 - p);
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const ROUND = 1e5;
function round(x) {
    return Math.round(x * ROUND) / ROUND;
}

// ─── 组件记录（内层滚动）───────────────────────────────────────────────────

// 每期活动的组件记录只取决于它开始前已结算的活动与它自己的数据，在同一数据集的任何训练子集里都相同，按活动对象缓存。
const recordCache = new WeakMap();
// 前缀训练集的 prior/curve/tiers，按数据集（最早结算活动的对象）与前缀长度缓存，只影响速度。
const componentCache = new WeakMap();
const COMPONENT_CACHE_SIZE = 24;

function trainKey(train) {
    let last = null;
    for (const ev of train.events) if (!last || ev.aggregateAt > last.aggregateAt) last = ev;
    return last ? `${train.events.length}|${eventKey(last.region, last.eventId)}|${last.aggregateAt}` : "0";
}

function anchorOf(train) {
    let first = null;
    for (const ev of train.events) if (!first || ev.aggregateAt < first.aggregateAt) first = ev;
    return first;
}

function rememberComponents(train, sections) {
    const anchor = anchorOf(train);
    if (!anchor) return;
    let m = componentCache.get(anchor);
    if (!m) componentCache.set(anchor, (m = new Map()));
    const key = trainKey(train);
    m.delete(key);
    m.set(key, sections);
    while (m.size > COMPONENT_CACHE_SIZE) m.delete(m.keys().next().value);
}

/** 训练集上的 prior / curve / tiers（默认参数）。 */
export function fitComponents(train) {
    const anchor = anchorOf(train);
    const hit = anchor ? componentCache.get(anchor)?.get(trainKey(train)) : null;
    if (hit) return hit;
    const sections = { prior: fitPrior(train), curve: fitCurve(train), tiers: fitTiers(train) };
    rememberComponents(train, sections);
    return sections;
}

function estimatePair(e) {
    return e ? [e.median, e.logSigma] : null;
}

function recorder(index, sink) {
    const seen = new Set();
    return (sections, ctx, atMs, observed, info) => {
        const ev = info.event;
        const scope = scopeKey(info.scope);
        const id = `${eventKey(ev.region, ev.eventId)}/${scope}@${atMs}`;
        if (seen.has(id)) return null;
        seen.add(id);
        const { startAt, endAt } = scopeWindow(ev, info.scope);
        const actuals = actualFinals(index, ev, info.scope);
        const comps = componentEstimates(sections, ctx, atMs, observed);
        const tiers = [...comps.values()].map((c) => ({
            rank: c.rank,
            current: c.currentScore,
            currentAt: c.currentAt,
            prior: estimatePair(c.prior),
            obs: estimatePair(c.observed),
            actual: actuals.get(c.rank)?.score ?? null,
            actualSource: actuals.get(c.rank)?.source ?? null,
        }));
        let list = sink.get(ev);
        if (!list) sink.set(ev, (list = []));
        list.push({
            ev,
            cell: info.cell.key,
            group: info.cell.group,
            wlTurn: info.cell.wlTurn,
            scope,
            chapterNo: ctx.chapterNo,
            cuts: DEFAULT_CUTS.filter((c) => cutTime(c, startAt, endAt) === atMs).map((c) => c.id),
            ctx,
            atMs,
            progress: (atMs - startAt) / (endAt - startAt),
            tiers,
        });
        return null;
    };
}

/**
 * 训练集每期活动的组件记录（每期只用其开始前已结算的活动拟合 prior/curve/tiers）；缺的才计算。
 * hint：在 train 本身上拟合好的 sections，供之后以 train 为前缀的活动复用。
 */
export function componentRecords(train, { hint = null, log = () => {} } = {}) {
    if (hint) rememberComponents(train, hint);
    const missing = new Set(train.events.filter((ev) => !recordCache.has(ev)));
    if (missing.size > 0) {
        const index = indexDataset(train);
        const sink = new Map();
        let folds = 0;
        rollingBacktest({
            data: train,
            fit: (t) => {
                folds += 1;
                if (folds % 25 === 0) log(`  组件拟合 ${folds} 折…`);
                return fitComponents(t);
            },
            predict: recorder(index, sink),
            filter: (ev) => missing.has(ev),
            model: "fuse-inner",
        });
        for (const ev of missing) recordCache.set(ev, sink.get(ev) ?? []);
    }
    return train.events.flatMap((ev) => recordCache.get(ev));
}

// ─── 统计工具 ─────────────────────────────────────────────────────────────

function nearestKnot(knots, progress) {
    let best = 0;
    for (let i = 1; i < knots.length; i++) if (Math.abs(knots[i] - progress) < Math.abs(knots[best] - progress)) best = i;
    return best;
}

function weightedQuantile(items, q) {
    const total = items.reduce((s, x) => s + x.w, 0);
    if (!(total > 0)) return null;
    const target = q * total;
    let cum = 0;
    for (const x of items) {
        cum += x.w;
        if (cum >= target) return x.z;
    }
    return items[items.length - 1].z;
}

function caseWeight(rec, tRef, o) {
    return Number.isFinite(o.halfLifeYears) ? 0.5 ** ((tRef - rec.ev.aggregateAt) / (o.halfLifeYears * YEAR_MS)) : 1;
}

/** 一条记录的数据进入哪些键：链上与其同区服的键，加上根。 */
function contributionKeys(cell) {
    const region = cell.split("|")[0];
    return fuseLookupChain(cell).filter((k) => k === "*" || k.startsWith(`${region}|`));
}

function newScaleStats(nKnots) {
    return Array.from({ length: nKnots }, () => ({ np: 0, sp: 0, no: 0, so: 0, nc: 0, cpp: 0, coo: 0, cpo: 0 }));
}

function shrink(n, own, k, parent) {
    return n > 0 ? (n * own + k * parent) / (n + k) : parent;
}

/** 沿查找链自根向下解析一个键在某节点的取值。 */
function resolveDown(key, stats, knot, evaluate, rootDefault, k) {
    const chain = fuseLookupChain(key).reverse();
    let v = rootDefault;
    for (const kk of chain) {
        const st = stats.get(kk)?.[knot];
        if (st) v = evaluate(st, v, k);
    }
    return v;
}

// ─── 物理上限 ─────────────────────────────────────────────────────────────

const speedCache = new WeakMap();

/** 一条序列的最高一小时增量（窗口 1–1.5 小时，跨更长空档的不计）。 */
export function maxHourlyGain(points) {
    let best = 0;
    let j = 0;
    for (let i = 0; i < points.length; i++) {
        if (j <= i) j = i + 1;
        while (j < points.length && points[j][0] - points[i][0] < HOUR_MS) j++;
        if (j >= points.length) break;
        const dt = points[j][0] - points[i][0];
        if (dt > 1.5 * HOUR_MS) continue;
        best = Math.max(best, (points[j][1] - points[i][1]) / (dt / HOUR_MS));
    }
    return best;
}

/** 已有终榜（已结算）的活动键。 */
function settledKeys(data) {
    return new Set(data.finals.map((f) => eventKey(f.region, f.eventId)));
}

function eventSpeeds(train) {
    // 进行中的活动只有半截序列：缺终盘冲刺，拟合结果还会随录制增长而变，所以不计。
    const settled = settledKeys(train);
    const byEvent = new Map();
    for (const s of train.series) {
        const k = eventKey(s.region, s.eventId);
        let list = byEvent.get(k);
        if (!list) byEvent.set(k, (list = []));
        list.push(s);
    }
    const out = [];
    for (const ev of train.events) {
        if (!settled.has(eventKey(ev.region, ev.eventId))) continue;
        let speeds = speedCache.get(ev);
        if (!speeds) {
            speeds = new Map();
            for (const s of byEvent.get(eventKey(ev.region, ev.eventId)) ?? []) {
                speeds.set(s.rank, Math.max(speeds.get(s.rank) ?? 0, maxHourlyGain(s.points)));
            }
            speedCache.set(ev, speeds);
        }
        out.push({ region: ev.region, speeds });
    }
    return out;
}

/** 各区服的上限表（只用已有终榜的活动）；国服序列太少，同一名次也取日服的速度（日服更快，上限只会更宽）。 */
export function fitCeiling(train) {
    const raw = { jp: new Map(), cn: new Map() };
    for (const { region, speeds } of eventSpeeds(train)) {
        for (const [rank, v] of speeds) if (v > 0) raw[region].set(rank, Math.max(raw[region].get(rank) ?? 0, v));
    }
    const merged = { jp: raw.jp, cn: new Map(raw.cn) };
    for (const [rank, v] of raw.jp) merged.cn.set(rank, Math.max(merged.cn.get(rank) ?? 0, v));
    const out = {};
    for (const region of ["jp", "cn"]) {
        const ranks = [...merged[region].keys()].sort((a, b) => a - b);
        if (ranks.length === 0) continue;
        const perHour = ranks.map((r) => merged[region].get(r));
        for (let i = perHour.length - 2; i >= 0; i--) perHour[i] = Math.max(perHour[i], perHour[i + 1]);
        out[region] = { ranks, perHour: perHour.map((v) => Math.ceil(v)) };
    }
    return out;
}

// ─── 拟合 ────────────────────────────────────────────────────────────────

function gaugeSets(events) {
    const out = {};
    const at = {};
    for (const ev of events) {
        if (ev.group !== "normal" || ev.breakTimeId == null) continue;
        if (at[ev.region] == null || ev.startAt > at[ev.region]) {
            at[ev.region] = ev.startAt;
            out[ev.region] = ev.breakTimeId;
        }
    }
    return out;
}

function vsEditions(events) {
    const out = new Set();
    for (const ev of events) {
        if (ev.eventType !== "world_bloom" || ev.isFinale || ev.chapters.length === 0) continue;
        if (cellOf(ev, { kind: "overall" }).variant === "vs") out.add(`${ev.region}|${ev.wlTurn ?? "-"}`);
    }
    return [...out].sort();
}

function logResidual(est, actual) {
    return Math.log(est[0] / actual) / Math.max(est[1], MIN_LOG_SIGMA);
}

/**
 * 由组件记录拟合 FuseSection（fallback 为空）。records：componentRecords 的结果，只应含 train 里的活动。
 */
export function fitFuseFromRecords(records, train, opts = {}) {
    const o = { ...DEFAULT_FUSE_OPTIONS, ...opts };
    const knots = [...o.knots];
    const K = o.shrinkK;
    const tRef = Math.max(...train.events.map((e) => e.aggregateAt), -Infinity);
    const base = {
        version: 1,
        knots,
        cells: {},
        biasCorrection: o.biasCorrection,
        gaugeSet: gaugeSets(train.events),
        vsEditions: vsEditions(train.events),
        ceilingMargin: o.ceilingMargin,
        ceiling: o.ceiling ? fitCeiling(train) : {},
        fallback: {},
        fit: {
            shrinkK: K,
            correlation: o.correlation,
            calibrate: o.calibrate,
            halfLifeYears: Number.isFinite(o.halfLifeYears) ? o.halfLifeYears : "none",
            levels: o.levels.join("/"),
            records: records.length,
        },
    };
    if (!o.calibrate) return base;

    // 第一步：标准化误差的尺度与相关。
    const cases = records.map((rec) => {
        const rows = rec.tiers.filter((t) => t.actual > 0);
        return { rec, rows, knot: nearestKnot(knots, rec.progress), w: rows.length > 0 ? caseWeight(rec, tRef, o) : 0 };
    }).filter((c) => c.w > 0);
    const scaleStats = new Map();
    const statsOf = (map, key, make) => {
        let st = map.get(key);
        if (!st) map.set(key, (st = make()));
        return st;
    };
    for (const c of cases) {
        const withPrior = c.rows.filter((t) => t.prior);
        const withObs = c.rows.filter((t) => t.obs && t.obs[1] > 0);
        const both = c.rows.filter((t) => t.prior && t.obs && t.obs[1] > 0);
        for (const key of contributionKeys(c.rec.cell)) {
            const st = statsOf(scaleStats, key, () => newScaleStats(knots.length))[c.knot];
            if (withPrior.length) {
                st.np += c.w;
                st.sp += (c.w / withPrior.length) * withPrior.reduce((s, t) => s + logResidual(t.prior, t.actual) ** 2, 0);
            }
            if (withObs.length) {
                st.no += c.w;
                st.so += (c.w / withObs.length) * withObs.reduce((s, t) => s + logResidual(t.obs, t.actual) ** 2, 0);
            }
            if (both.length) {
                st.nc += c.w;
                const f = c.w / both.length;
                for (const t of both) {
                    const zp = logResidual(t.prior, t.actual);
                    const zo = logResidual(t.obs, t.actual);
                    st.cpp += f * zp * zp;
                    st.coo += f * zo * zo;
                    st.cpo += f * zp * zo;
                }
            }
        }
    }
    const root = DEFAULT_FUSE_KNOT;
    const scaleAt = (key, knot) => ({
        priorVar: resolveDown(key, scaleStats, knot, (st, v, k) => (st.np > 0 ? shrink(st.np, st.sp / st.np, k, v) : v), root.priorScale ** 2, K),
        obsVar: resolveDown(key, scaleStats, knot, (st, v, k) => (st.no > 0 ? shrink(st.no, st.so / st.no, k, v) : v), root.observedScale ** 2, K),
        corr: o.correlation
            ? resolveDown(key, scaleStats, knot, (st, v, k) => (st.nc > 0 && st.cpp > 0 && st.coo > 0 ? shrink(st.nc, st.cpo / Math.sqrt(st.cpp * st.coo), k, v) : v), root.corr, K)
            : 0,
    });
    const keys = [...scaleStats.keys()].sort();
    const scales = new Map(keys.map((key) => [key, knots.map((_, i) => scaleAt(key, i))]));
    const scaleSection = {
        ...base,
        cells: Object.fromEntries(keys.map((key) => [key, {
            n: 0,
            knots: scales.get(key).map((sc) => ({
                ...root,
                priorScale: Math.sqrt(sc.priorVar),
                observedScale: Math.sqrt(sc.obsVar),
                corr: Math.max(-0.99, Math.min(0.99, sc.corr)),
            })),
        }])),
    };

    // 第二步：标准化融合残差的分位数（用实际运行时的插值校准计算融合结果）。
    // 各档合并估计，不分档位段：WL 章节格按 ≤T1000 / T2000 起分段估计时，滚动回测里两段覆盖率都更低
    // （79.4% → 76.8%、76.3% → 74.8%），每格只有约 5 期，靠前档位覆盖率偏低来自各期之间的差异。
    const qStats = new Map();
    for (const c of cases) {
        const cal = calibrationForCell(c.rec.cell, c.rec.progress, scaleSection);
        const zs = [];
        for (const t of c.rows) {
            const f = fuseLog(toEstimate(t.prior, o, "prior"), toEstimate(t.obs, o, "observed"), c.rec.progress, cal, knots[0]);
            if (!f || !(f.sd > 0)) continue;
            zs.push((Math.log(t.actual) - f.mu) / f.sd);
        }
        if (zs.length === 0) continue;
        for (const key of contributionKeys(c.rec.cell)) {
            const perKnot = statsOf(qStats, key, () => Array.from({ length: knots.length }, () => ({ n: 0, items: [] })));
            const st = perKnot[c.knot];
            st.n += c.w;
            for (const z of zs) st.items.push({ z, w: c.w / zs.length });
        }
    }
    for (const perKnot of qStats.values()) for (const st of perKnot) st.items.sort((a, b) => a.z - b.z);
    const quantileAt = (key, knot, q, rootValue) => resolveDown(key, qStats, knot, (st, v, k) => {
        const emp = weightedQuantile(st.items, q);
        return emp == null ? v : shrink(st.n, emp, k, v);
    }, rootValue, K);

    const cells = {};
    for (const key of [...new Set([...keys, ...qStats.keys()])].sort()) {
        const n = (qStats.get(key) ?? []).reduce((s, st) => s + st.n, 0);
        cells[key] = {
            n: round(n),
            knots: knots.map((_, i) => {
                const sc = scales.get(key)?.[i] ?? scaleAt(key, i);
                const q10 = quantileAt(key, i, o.levels[0], probit(o.levels[0]));
                const q50 = quantileAt(key, i, 0.5, root.q50);
                const q90 = quantileAt(key, i, o.levels[1], probit(o.levels[1]));
                return {
                    priorScale: round(Math.sqrt(sc.priorVar)),
                    observedScale: round(Math.sqrt(sc.obsVar)),
                    corr: round(Math.max(-0.99, Math.min(0.99, sc.corr))),
                    q10: round(Math.min(q10, q50)),
                    q50: round(q50),
                    q90: round(Math.max(q90, q50)),
                };
            }),
        };
    }
    return { ...base, cells };
}

function toEstimate(pair, o, kind) {
    if (!pair) return null;
    if (o.mode !== "fused" && o.mode !== kind) return null;
    return { median: pair[0], logSigma: pair[1] };
}

/**
 * fitFuse(train, { prior, curve, tiers }, opts?) → FuseSection（同步）。
 * 权重与分位数只来自 train 的内层滚动；传入的 sections（在 train 上拟合）只用来免去重复拟合。fallback 为空：
 * 回退单元格只由 CLI 的全量滚动比较写入上线的 priors.json。
 */
export function fitFuse(train, sections = null, opts = {}) {
    const hint = sections && sections.prior && sections.curve && sections.tiers ? { prior: sections.prior, curve: sections.curve, tiers: sections.tiers } : null;
    const records = componentRecords(train, { hint });
    return fitFuseFromRecords(records, train, opts);
}

// ─── 全量滚动模拟（与 run-all 的新模型回测同一条路径）───────────────────────

function componentsOfRecord(rec, o) {
    const out = new Map();
    for (const t of rec.tiers) {
        out.set(t.rank, {
            rank: t.rank,
            currentScore: t.current,
            currentAt: t.currentAt,
            prior: toEstimate(t.prior, o, "prior"),
            observed: toEstimate(t.obs, o, "observed"),
        });
    }
    return out;
}

/**
 * 按滚动原点模拟新模型：测试活动 E 的融合参数只由结算早于 E 开始的活动的组件记录拟合，再对 E 的组件记录融合。
 * 返回与 harness 相同格式的行（model = name）。records 需覆盖 data 的全部活动（componentRecords(data)）。
 */
export function simulateRolling(data, records, opts = {}, name = "model") {
    const o = { ...DEFAULT_FUSE_OPTIONS, ...opts };
    const byEvent = new Map();
    for (const rec of records) {
        let list = byEvent.get(rec.ev);
        if (!list) byEvent.set(rec.ev, (list = []));
        list.push(rec);
    }
    const byAggregate = [...data.events].sort((a, b) => a.aggregateAt - b.aggregateAt);
    const tests = [...data.events].sort((a, b) => a.startAt - b.startAt || a.eventId - b.eventId);
    const rows = [];
    let len = 0;
    let fittedLen = -1;
    let fuse = null;
    for (const ev of tests) {
        const recs = byEvent.get(ev);
        if (!recs || !recs.some((r) => r.tiers.some((t) => t.actual > 0))) continue;
        while (len < byAggregate.length && byAggregate[len].aggregateAt < ev.startAt) len += 1;
        if (len !== fittedLen) {
            const trainEvents = byAggregate.slice(0, len);
            const train = subsetDataset(data, trainEvents);
            const trainRecords = trainEvents.flatMap((e) => byEvent.get(e) ?? []);
            fuse = fitFuseFromRecords(trainRecords, train, o);
            fittedLen = len;
        }
        for (const rec of recs) {
            const q = fuseComponents(rec.ctx, rec.atMs, componentsOfRecord(rec, o), fuse);
            const remainingHours = (rec.ctx.scopeEndAt - rec.atMs) / HOUR_MS;
            for (const t of rec.tiers) {
                const est = q.get(t.rank);
                if (!est || !(t.actual > 0)) continue;
                for (const cut of rec.cuts) {
                    rows.push({
                        model: name,
                        region: ev.region,
                        eventId: ev.eventId,
                        group: rec.group,
                        wlTurn: rec.wlTurn,
                        cell: rec.cell,
                        scope: rec.scope,
                        chapterNo: rec.chapterNo,
                        rank: t.rank,
                        band: tierBand(t.rank),
                        cut,
                        atMs: rec.atMs,
                        progress: rec.progress,
                        remainingHours,
                        currentScore: t.current,
                        actual: t.actual,
                        actualSource: t.actualSource,
                        p10: est.p10,
                        p50: est.p50,
                        p90: est.p90,
                        ceiling: t.current > 0 ? physicalCeiling(rec.ctx, t.rank, t.current, (rec.ctx.scopeEndAt - Math.min(t.currentAt ?? rec.atMs, rec.atMs)) / HOUR_MS, fuse) : null,
                        trainSize: len,
                    });
                }
            }
        }
    }
    return rows;
}

/** 按回测单元格配对比较新模型与基线：新模型 MAPE 更高的单元格记为回退。 */
export function decideFallback(modelRows, baselineRows, baseline = "tori-v2") {
    const cells = [...new Set(modelRows.map((r) => r.cell))].sort();
    const all = [...modelRows, ...baselineRows];
    const out = {};
    const table = [];
    for (const cell of cells) {
        const { a, b } = pairRows(all.filter((r) => r.cell === cell), modelRows[0]?.model ?? "model", baseline);
        if (a.length === 0) continue;
        const sa = summarize(a);
        const sb = summarize(b);
        const worse = sa.mape > sb.mape;
        table.push({ cell, events: sa.events, points: a.length, mape: sa.mape, baselineMape: sb.mape, coverage: sa.coverage, baselineCoverage: sb.coverage, fallback: worse });
        if (worse) out[cell] = { events: sa.events, points: a.length, mape: round(sa.mape), baselineMape: round(sb.mape) };
    }
    return { fallback: out, table };
}

// ─── priors.json ─────────────────────────────────────────────────────────

/** 每区服最后一期（按结算时间）有终榜的活动及其结算时间。 */
function lastSettled(data) {
    const withFinal = settledKeys(data);
    const out = { jp: { eventId: 0, at: -Infinity }, cn: { eventId: 0, at: -Infinity } };
    for (const ev of data.events) {
        if (!withFinal.has(eventKey(ev.region, ev.eventId))) continue;
        if (ev.aggregateAt > out[ev.region].at) out[ev.region] = { eventId: ev.eventId, at: ev.aggregateAt };
    }
    return out;
}

/** 每区服最后一期（按结算时间）有终榜的活动。 */
export function dataThrough(data) {
    const last = lastSettled(data);
    return { jp: last.jp.eventId, cn: last.cn.eventId };
}

/**
 * fit-prior.mjs borrowedLevels 的行中，结算晚于本区服最后一期已结算活动的（进行中 / 未开始，上线预测正在用这些先验）；
 * 已结束但数据集里没有终榜的活动（如被排除的 CN #176）不列。
 */
export function pendingBorrowedLevels(rows, data) {
    const last = lastSettled(data);
    const byKey = new Map(data.events.map((ev) => [eventKey(ev.region, ev.eventId), ev]));
    return rows.filter((b) => {
        const ev = byKey.get(eventKey(b.region, b.eventId));
        return ev != null && ev.aggregateAt > last[b.region].at;
    });
}

function readSection(dir, name) {
    const file = path.join(dir, `${name}.json`);
    if (!fs.existsSync(file)) throw new Error(`缺少 ${file}：先运行 fit-${name}.mjs（run-all.mjs 会按顺序运行）`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function assemblePriors({ fitDir, fuse, data, generatedAt = new Date().toISOString() }) {
    return {
        version: 1,
        generatedAt,
        dataThrough: dataThrough(data),
        prior: readSection(fitDir, "prior"),
        curve: readSection(fitDir, "curve"),
        tiers: readSection(fitDir, "tiers"),
        fuse,
    };
}

// ─── 报告片段 ────────────────────────────────────────────────────────────

function pct(x) {
    return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

/** 表格里的单元格：report.mjs 的中文名 + priors.json 里的键（竖线转义，免得拆开表格列）。 */
function cellName(key) {
    const code = `\`${key.replaceAll("|", "\\|")}\``;
    if (key === "*") return `全局根（${code}）`;
    const parts = key.split("|");
    if (parts.length < 4) return `${parts[0] === "cn" ? "国服" : "日服"} · ${parts[1]} 各期合并（${code}）`;
    return `${cellLabel(key)}（${code}）`;
}

// alternative：上线默认某个取值的备选（默认就是在本表里和它们比较后选定的）。
export const EVALUATE_CANDIDATES = [
    { name: "默认（融合 + 校准 + 中位数校正 + 收缩 k=20，分位 0.09/0.91，上限 ×2）", opts: {} },
    { name: "只用先验", opts: { mode: "prior" } },
    { name: "只用进度估计", opts: { mode: "observed" } },
    { name: "不校准（模块 sigma 原样、正态分位）", opts: { calibrate: false } },
    { name: "不计相关", opts: { correlation: false } },
    { name: "不做中位数偏差校正", opts: { biasCorrection: false } },
    { name: "不收缩（k=0）", opts: { shrinkK: 0 }, alternative: true },
    { name: "收缩 k=2", opts: { shrinkK: 2 }, alternative: true },
    { name: "收缩 k=5", opts: { shrinkK: 5 }, alternative: true },
    { name: "分位水平 0.1/0.9", opts: { levels: [0.1, 0.9] }, alternative: true },
    { name: "物理上限 ×1（历史最高时速原值）", opts: { ceilingMargin: 1 }, alternative: true },
    { name: "近期加权（半衰期 2 年）", opts: { halfLifeYears: 2 }, alternative: true },
    { name: "不设物理上限", opts: { ceiling: false } },
];

function ceilingViolations(rows) {
    return rows.filter((r) => r.ceiling != null && r.actual > r.ceiling).length;
}

function overallTable(results) {
    const lines = ["| 方案 | 点数 | MAPE | 中位 APE | 偏差 | P10–P90 覆盖率 | 区间宽度 | 终榜超出物理上限 |", "|---|---|---|---|---|---|---|---|"];
    for (const { name, rows } of results) {
        const s = summarize(rows);
        lines.push(`| ${name} | ${s.n} | ${pct(s.mape)} | ${pct(s.medianApe)} | ${pct(s.bias)} | ${pct(s.coverage)} | ${pct(s.widthPct)} | ${ceilingViolations(rows)} |`);
    }
    return lines;
}

function byCutTable(results) {
    const cuts = DEFAULT_CUTS.map((c) => c.id).filter((id) => results[0].rows.some((r) => r.cut === id));
    const lines = [`| 方案 | ${cuts.join(" | ")} |`, `|---|${cuts.map(() => "---").join("|")}|`];
    for (const { name, rows } of results) {
        lines.push(`| ${name} | ${cuts.map((id) => pct(summarize(rows.filter((r) => r.cut === id)).mape)).join(" | ")} |`);
    }
    return lines;
}

const SELECTION_TEXT = "上线默认的分位水平、收缩 k、上限倍数和各开关都是在这批滚动预测点上比较这些方案后选定的，"
    + "所以默认一行（以及回测报告第 1 节）的覆盖率与“终榜超出物理上限”的计数对这些设置是样本内结果，略偏乐观。";

export function renderEvaluate(results) {
    const lines = ["# 融合层消融（滚动模拟，同一批组件记录）", "", `> ${SELECTION_TEXT}`, "", ...overallTable(results), ""];
    lines.push("## 按截点的 MAPE", "", ...byCutTable(results), "");
    const groups = [...new Set(results[0].rows.map((r) => r.cell))].sort();
    lines.push("## 按单元格的 MAPE / 覆盖率", "");
    lines.push(`| 单元格 | ${results.map((r) => r.name).join(" | ")} |`);
    lines.push(`|---|${results.map(() => "---").join("|")}|`);
    for (const g of groups) {
        const cells = results.map(({ rows }) => {
            const s = summarize(rows.filter((r) => r.cell === g));
            return s.n ? `${pct(s.mape)} / ${pct(s.coverage)}` : "—";
        });
        lines.push(`| ${cellName(g)} | ${cells.join(" | ")} |`);
    }
    return `${lines.join("\n")}\n`;
}

/** report.md 的融合层一节：总表与按截点表（完整的按单元格表在 fuse-evaluate.md）。 */
export function renderAblationSection(results, { evaluatePath }) {
    const lines = ["## 附：融合层消融（fit-fuse.mjs --evaluate）", ""];
    lines.push("同一批内层滚动组件记录上，只改融合层设置的滚动模拟；第一行是上线默认。“终榜超出物理上限”是终榜高于该点物理上限的配对点数。"
        + `按单元格的完整表见 \`${evaluatePath}\`。`, "");
    lines.push(`${SELECTION_TEXT}各方案对点预测的影响见 MAPE 列，对区间的影响见覆盖率列；样本外的覆盖率要等之后新结算的活动来检验。`, "");
    lines.push(...overallTable(results), "", "按截点的 MAPE：", "", ...byCutTable(results.filter((r) => /默认|只用|tori-v2/.test(r.name))), "");
    return lines.join("\n");
}

const SELECTION_BULLET = "- **融合层超参数**：";
const RANK_POOLING_NOTE = "融合校准在单元格内各档合并估计，不分档位段：WL 章节格按 ≤T1000 / T2000 起分段估计时，"
    + "同一批滚动点上两段的覆盖率都更低，所以不拆分；第 4 节里章节格靠前档位的覆盖率低于 80%，来自各期之间的差异（每个章节格只有约 5 期），"
    + "不是档位合并造成的。";

/** 回测报告“方法”一节的超参数选择说明；results 是 --evaluate 的消融结果（没有时只给出处）。 */
export function selectionNote(results) {
    const o = DEFAULT_FUSE_OPTIONS;
    let text = `${SELECTION_BULLET}上线默认的融合层设置（P10/P90 取的标准化残差分位水平 ${o.levels.join("/")}、`
        + `向父级收缩的伪样本数 k=${o.shrinkK}、物理上限倍数 ×${o.ceilingMargin} 等）是在本报告同一批滚动预测点上比较消融方案后选定的`
        + "（见文末“附：融合层消融”），所以新模型的覆盖率与“终榜超出物理上限”的计数对这些设置是样本内结果，略偏乐观。";
    if (!results) return `${text}${RANK_POOLING_NOTE}`;
    const byName = new Map(results.map((r) => [r.name, r.rows]));
    const def = byName.get(EVALUATE_CANDIDATES[0].name);
    const alts = EVALUATE_CANDIDATES.filter((c) => c.alternative && byName.has(c.name));
    if (!def || alts.length === 0) return `${text}${RANK_POOLING_NOTE}`;
    const parts = alts.map((c) => {
        const rows = byName.get(c.name);
        const v = ceilingViolations(rows);
        return `${c.name} ${pct(summarize(rows).coverage)}${v > 0 ? `（${v} 个终榜超出上限）` : ""}`;
    });
    const mapes = [def, ...alts.map((c) => byName.get(c.name))].map((rows) => summarize(rows).mape);
    text += `默认覆盖率 ${pct(summarize(def).coverage)}；备选取值下为：${parts.join("、")}。`
        + `点预测对这些设置不敏感（MAPE ${pct(Math.min(...mapes))}–${pct(Math.max(...mapes))}）。`;
    return `${text}${RANK_POOLING_NOTE}`;
}

/** 把 note 放在“## 方法”列表末尾（先去掉旧的一条）。 */
export function addSelectionNote(md, note) {
    const lines = md.split("\n").filter((l) => !l.startsWith(SELECTION_BULLET));
    const start = lines.indexOf("## 方法");
    if (start < 0) return lines.join("\n");
    let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    if (end < 0) end = lines.length;
    while (end > start + 1 && lines[end - 1] === "") end -= 1;
    lines.splice(end, 0, note);
    return lines.join("\n");
}

/**
 * 数据集里没有配对回测点的单元格（进行中 / 未开始的活动、没有序列的国服活动）：上线直接用新模型，
 * 融合校准沿查找链借用 fuse.cells 里最近的一格。
 */
export function cellsWithoutEvidence(data, table, fuse) {
    const tested = new Set(table.map((r) => r.cell));
    const out = new Map();
    for (const ev of data.events) {
        const scopes = [{ kind: "overall" }, ...(ev.isFinale ? [] : ev.chapters.map((c) => ({ kind: "chapter", gameCharacterId: c.gameCharacterId })))];
        for (const scope of scopes) {
            const key = cellOf(ev, scope).key;
            if (tested.has(key)) continue;
            let e = out.get(key);
            if (!e) out.set(key, (e = { cell: key, ids: new Set(), borrowed: fuseLookupChain(key).find((k) => fuse.cells[k]) ?? "（默认）" }));
            e.ids.add(ev.eventId);
        }
    }
    return [...out.values()].sort((a, b) => a.cell.localeCompare(b.cell)).map((e) => ({ ...e, ids: [...e.ids].sort((x, y) => x - y) }));
}

function idRanges(ids) {
    const parts = [];
    for (let i = 0; i < ids.length; i++) {
        let j = i;
        while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;
        parts.push(i === j ? `#${ids[i]}` : `#${ids[i]}–#${ids[j]}`);
        i = j;
    }
    return parts.join("、");
}

function finaleOf(cell) {
    const parts = cell.split("|");
    return parts[1] === "wl_finale" ? `${parts[0].toUpperCase()} ${parts[3]}` : null;
}

/** 终章的回退判断各自独立：有回测证据的终章给出判断，没有证据的终章不沿用。 */
function finaleSentence(table, untested) {
    const tested = table.filter((r) => finaleOf(r.cell)).map((r) => `${finaleOf(r.cell)} ${r.fallback ? "在上表回退" : "不回退（新模型更好）"}`);
    const pending = untested.map((e) => finaleOf(e.cell)).filter(Boolean);
    if (tested.length === 0 && pending.length === 0) return "";
    const head = "终章按（区服，活动）单列，回退判断不在终章之间共享";
    if (tested.length === 0) return `${head}，没有回测证据的终章 ${pending.join(" / ")} 直接使用新模型。`;
    return `${head}：${tested.join("、")}${pending.length > 0 ? `，这一判断不外推到 ${pending.join(" / ")}` : ""}。`;
}

function borrowedSource(b) {
    if (b.kind === "anchor") return "日服同 id 终榜 × 国服/日服比例";
    const from = b.sourceEvents.map((id) => `${(b.source ?? b.region).toUpperCase()} #${id}`).join("、");
    return `组偏移 ${b.group}（来自 ${b.nEvents} 期：${from}）`;
}

function borrowedTier(t) {
    if (t.median == null) return "—";
    const ratio = t.groupSigma > 0 ? `，组 σ ×${(t.logSigma / t.groupSigma).toFixed(2)}` : "";
    return `${Math.round(t.median).toLocaleString("en-US")}（σ ${t.logSigma.toFixed(3)}${ratio}）`;
}

/** 回退判断不共享，但先验水平可以借自别的期；列出上线预测正在用的这类先验（pendingBorrowedLevels）。 */
function borrowedLines(borrowed) {
    if (borrowed.length === 0) return [];
    const ranks = borrowed[0].tiers.map((t) => t.rank);
    const lines = ["### 先验水平借自其他期的范围", ""];
    lines.push("回退判断之外，先验水平会跨期借用：以下尚未结算的范围自身单元格没有终榜数据，先验中位数取自别的期，"
        + "早期预测主要依赖它，此后随观测权重上升而减弱。只用组偏移时方差另加组偏移标准误的平方与 σ_组²/k，“组 σ ×”是相对组 σ 放宽的倍数；"
        + "国服有日服同 id 终榜时取该终榜 × 国服/日服比例。借用路径的回测校准见 `fit-prior.mjs --evaluate` 生成的 prior-backtest.md 第 6 节。", "");
    lines.push(`| 范围 | 先验单元格 | 水平来源 | ${ranks.map((r) => `T${r} 中位`).join(" | ")} |`);
    lines.push(`|---|---|---|${ranks.map(() => "---").join("|")}|`);
    for (const b of borrowed) {
        const cell = b.cell ? `\`${b.cell.replaceAll("|", "\\|")}\`` : "—";
        lines.push(`| ${b.region.toUpperCase()} #${b.eventId} ${b.scope} | ${cell} | ${borrowedSource(b)} | ${b.tiers.map(borrowedTier).join(" | ")} |`);
    }
    lines.push("");
    return lines;
}

export function renderFallbackSection(table, { priorsPath, untested = [], borrowed = [] }) {
    const lines = ["## 附：上线回退（fit-fuse.mjs 写入 priors.json 的 fuse.fallback）", ""];
    lines.push("由 `fit-fuse.mjs` 的全量滚动模拟（与本报告第 1 节同一批配对点）逐单元格比较新模型与现引擎：新模型 MAPE 更高的单元格记入 "
        + `\`${path.relative(path.resolve(HERE, "../.."), priorsPath)}\` 的 \`fuse.fallback\`，上线时 \`predictFromSections\` 对这些单元格返回 null，由调用方改用 tori-v2。`, "");
    const worse = table.filter((r) => r.fallback);
    if (worse.length === 0) lines.push("没有单元格需要回退。", "");
    else {
        lines.push("| 单元格 | 测试期数 | 配对样本 | 新模型 MAPE | 现引擎 MAPE | 上线行为 |", "|---|---|---|---|---|---|");
        for (const r of worse) lines.push(`| ${cellName(r.cell)} | ${r.events} | ${r.points} | ${pct(r.mape)} | ${pct(r.baselineMape)} | 回退 tori-v2 |`);
        lines.push("");
    }
    if (untested.length > 0) {
        lines.push("### 没有回测证据的单元格", "");
        lines.push("以下单元格在数据集中没有任何配对回测点（活动进行中或未开始；国服已结束的活动只有 #179 有逐时序列，其余在截点没有当前分，现引擎与新模型都无法给出预测），"
            + `因此无法判断新模型是否更差，上线使用新模型；融合校准借用查找链上最近的已拟合单元格。${finaleSentence(table, untested)}`, "");
        lines.push("| 单元格 | 活动 | 融合校准借用 |", "|---|---|---|");
        for (const e of untested) lines.push(`| ${cellName(e.cell)} | ${idRanges(e.ids)} | ${e.borrowed === "（默认）" ? e.borrowed : cellName(e.borrowed)} |`);
        lines.push("");
    }
    lines.push(...borrowedLines(borrowed));
    return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
    const args = { data: DEFAULT_DATA_DIR, committed: null, out: DEFAULT_FIT_DIR, priors: DEFAULT_PRIORS_PATH, evaluate: false, annotateReport: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v == null) throw new Error(`${a} 缺少取值`);
            return v;
        };
        if (a === "--data") args.data = value();
        else if (a === "--committed") args.committed = value();
        else if (a === "--out") args.out = value();
        else if (a === "--priors") args.priors = value();
        else if (a === "--evaluate") args.evaluate = true;
        else if (a === "--annotate-report") args.annotateReport = value();
        else throw new Error(`未知参数：${a}`);
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const started = Date.now();
    const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)} 秒`;
    const data = loadDataset(args.data, { log: () => {}, ...(args.committed ? { committedDir: args.committed } : {}) });
    console.log(`fit-fuse：内层滚动组件记录（每期活动只用其开始前已结算的活动拟合 prior/curve/tiers）…`);
    const records = componentRecords(data, { log: console.log });
    console.log(`  ${records.length} 个（范围 × 截点）记录，用时 ${elapsed()}`);

    const modelRows = simulateRolling(data, records);
    const baselineRows = rollingBacktest({ data, fit: currentEngineBaseline.fit, predict: currentEngineBaseline.predict, model: currentEngineBaseline.name, interval: true });
    const { fallback, table } = decideFallback(modelRows, baselineRows, currentEngineBaseline.name);
    console.log(`  滚动模拟：新模型 ${modelRows.length} 行，tori-v2 ${baselineRows.length} 行；回退单元格 ${Object.keys(fallback).length} 个：${Object.keys(fallback).join("、") || "无"}（${elapsed()}）`);

    const fuse = { ...fitFuseFromRecords(records, data), fallback };
    const priors = assemblePriors({ fitDir: args.out, fuse, data });
    const text = `${JSON.stringify(priors)}\n`;
    const bytes = Buffer.byteLength(text);
    // 超限时在写任何文件之前退出，fuse.json 与 priors.json 保持同一版本。
    if (bytes >= PRIORS_MAX_BYTES) throw new Error(`priors.json ${bytes} 字节，超过 ${PRIORS_MAX_BYTES}`);
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(path.join(args.out, "fuse.json"), `${JSON.stringify(fuse)}\n`);
    fs.writeFileSync(path.join(args.out, "fuse-fallback.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), table }, null, 1)}\n`);
    fs.writeFileSync(args.priors, text);
    console.log(`fuse.json → ${path.join(args.out, "fuse.json")}；priors.json ${(bytes / 1024).toFixed(1)} KB → ${args.priors}（${elapsed()}）`);

    let results = null;
    if (args.evaluate) {
        results = EVALUATE_CANDIDATES.map(({ name, opts }) => ({ name, rows: simulateRolling(data, records, opts, name) }));
        results.push({ name: "现引擎 tori-v2（参照）", rows: baselineRows.map((r) => ({ ...r, ceiling: null })) });
        const file = path.join(args.out, "fuse-evaluate.md");
        fs.writeFileSync(file, renderEvaluate(results));
        console.log(`消融 → ${file}（${elapsed()}）`);
    }
    if (args.annotateReport) {
        const md = addSelectionNote(
            fs.readFileSync(args.annotateReport, "utf8").replace(/\n## 附：(上线回退|融合层消融)[\s\S]*$/, "\n"),
            selectionNote(results),
        );
        const untested = cellsWithoutEvidence(data, table, fuse);
        const borrowed = pendingBorrowedLevels(borrowedLevels(priors.prior, data, -Infinity), data);
        const parts = [md.trimEnd(), renderFallbackSection(table, { priorsPath: args.priors, untested, borrowed })];
        if (results) parts.push(renderAblationSection(results, { evaluatePath: path.join(args.out, "fuse-evaluate.md") }));
        fs.writeFileSync(args.annotateReport, `${parts.join("\n\n").trimEnd()}\n`);
        console.log(`已在 ${args.annotateReport} 末尾写入回退${results ? "与消融" : ""}一节`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
