#!/usr/bin/env node
// 终榜先验拟合（F1）：逐档 log(终榜) = 普通活动的时间趋势（带惩罚的分段线性）+ 时长项 + 可选的疲劳槽 / 团 / 封面角色效应，
// 非普通组在其上加组偏移、单元格偏移（向组收缩）和可选的章节角色效应；国服有日服同 id 终榜时用「日服终榜 × 国服/日服比例」。
// 用法：node --experimental-strip-types scripts/prediction-backtest/fit-prior.mjs [--data <dir>] [--out <dir>] [--evaluate]
//   默认写 <out>/prior.json；--evaluate 另跑滚动回测（先验单独预测，对照 tori-v2 先验与各特征的消融），写 <out>/prior-backtest.{md,json}。
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { contextFromDataset, scopeWindow } from "../../src/lib/prediction/model/dataset-context.ts";
import { MIXED_UNIT, YEAR_MS, finalPrior, priorCellKey, ratioCellKeys } from "../../src/lib/prediction/model/prior.ts";
import { DEFAULT_DATA_DIR, SESSIONS_MODEL_DIR, actualFinals, eventKey, indexDataset, loadDataset, scopeKey, scopesOf } from "./dataset.mjs";
import { rollingBacktest } from "./harness.mjs";
import { summarize } from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOUR_MS = 3_600_000;
const Z90 = 1.2815515655446004;

export const DEFAULT_FIT_DIR = path.join(SESSIONS_MODEL_DIR, "fit");
export const PRIOR_EPOCH_MS = Date.UTC(2020, 8, 30);
export const HOURS_REF = 192;
const SIGMA_FLOOR = 0.03;

/** 默认选项 = 滚动回测选定的配置（逐项消融见 --evaluate 报告第 3 节）。 */
export const DEFAULT_PRIOR_OPTIONS = Object.freeze({
    // 普通活动趋势：分段线性，节点间隔（年）与斜率变化的岭惩罚；halfLifeYears 为时间衰减权重（null = 不衰减）。
    knotYears: 0.5,
    splineLambda: 2,
    halfLifeYears: null,
    // 时长：off / fit（逐档拟合 log 小时系数）/ fixed（系数固定为 1，即日均不随天数变）。
    days: "fit",
    breakGauge: false,
    gaugeLambda: 2,
    unit: true,
    unitLambda: 5,
    banner: true,
    bannerLambda: 5,
    // 非普通组：组偏移的时间衰减；单元格向组收缩的 k（null = 不设单元格偏移）；章节角色效应。
    groupHalfLifeYears: null,
    cellK: 2,
    chapterCharacter: true,
    characterLambda: 0.5,
    // 国服/日服比例：逐档截距 + 时间趋势；WL 按期（edition）再按组收缩。
    ratio: true,
    ratioTrend: true,
    // WL 比例是否也沿普通活动的比例趋势外推；false = WL 各期取自身比例（向当前普通比例收缩）。
    ratioWlTrend: true,
    ratioHours: false,
    ratioHalfLifeYears: null,
    ratioK: 2,
    cnBlend: false,
    maxExtrapolationYears: 1,
    minTierEvents: 6,
    minTrendEvents: 10,
    minFullEvents: 25,
    minRatioEvents: 3,
});

// ---------------------------------------------------------------------------
// 样本

function years(ms) {
    return (ms - PRIOR_EPOCH_MS) / YEAR_MS;
}

// 已知不是结算值的「终榜」，拟合与先验回测都跳过。上游数据修正后应删去对应条目。
export const EXCLUDED_FINALS = Object.freeze([
    {
        region: "cn",
        eventId: 176,
        scope: "overall",
        reason: "rk timeline 的 is_final 快照采集于 2026-08-12 15:19 UTC，比 CN #176（12 天）的结算早 188.7 小时",
    },
]);

function isExcluded(ev, scope) {
    const key = scopeKey(scope);
    return EXCLUDED_FINALS.some((x) => x.region === ev.region && x.eventId === ev.eventId && x.scope === key);
}

/** 训练集里每个 (区服, 活动, 范围, 档位) 终榜一行；终榜来源与回测一致（终榜表，缺失时取贴近结算的序列末点）。 */
export function collectSamples(train) {
    const index = indexDataset(train);
    const out = [];
    for (const ev of train.events) {
        for (const scope of scopesOf(ev)) {
            if (isExcluded(ev, scope)) continue;
            const finals = actualFinals(index, ev, scope);
            if (finals.size === 0) continue;
            const ctx = contextFromDataset(ev, scope, ev.startAt, [], null);
            const hours = (ctx.scopeEndAt - ctx.scopeStartAt) / HOUR_MS;
            const base = {
                region: ev.region,
                eventId: ev.eventId,
                scope: scopeKey(scope),
                group: ctx.group,
                wlTurn: ctx.wlTurn,
                cell: priorCellKey(ctx),
                ratioKeys: ratioCellKeys(ctx),
                x: years(ctx.scopeStartAt),
                hours,
                lh: Math.log(hours / HOURS_REF),
                gauge: ctx.breakGauge,
                unit: ctx.unit ?? MIXED_UNIT,
                banner: ctx.bannerCharacterId,
                character: ctx.chapterCharacterId,
            };
            for (const [rank, f] of finals) out.push({ ...base, rank, y: Math.log(f.score) });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// 数值工具

function decay(x, xRef, halfLife) {
    return halfLife == null ? 1 : Math.pow(0.5, Math.max(0, xRef - x) / halfLife);
}

function groupBy(rows, keyFn) {
    const m = new Map();
    for (const r of rows) {
        const k = keyFn(r);
        let b = m.get(k);
        if (!b) m.set(k, (b = []));
        b.push(r);
    }
    return m;
}

/** 对称正定矩阵求逆（Gauss–Jordan，部分主元）。 */
function invert(A) {
    const n = A.length;
    const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-12) throw new Error("fit-prior：正规方程奇异");
        [M[c], M[p]] = [M[p], M[c]];
        const piv = M[c][c];
        for (let k = 0; k < 2 * n; k++) M[c][k] /= piv;
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = M[r][c];
            if (f === 0) continue;
            for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k];
        }
    }
    return M.map((row) => row.slice(n));
}

/**
 * 带岭惩罚的加权最小二乘。cols[j] = { f(row) → 特征值, lambda?（缺省时只加 1e-8 保数值稳定） }。
 * 返回 { beta, resid, loo, ws }；loo 为留一残差 e_i / (1 − h_i)（岭回归在固定 λ 下的精确留一公式）。
 */
function ridgeWls(rows, cols, yOf, wOf) {
    const p = cols.length;
    const A = Array.from({ length: p }, () => new Array(p).fill(0));
    const b = new Array(p).fill(0);
    const feats = rows.map((r) => cols.map((c) => c.f(r)));
    const ws = rows.map(wOf);
    const ys = rows.map(yOf);
    feats.forEach((f, i) => {
        const w = ws[i];
        for (let j = 0; j < p; j++) {
            if (f[j] === 0) continue;
            b[j] += w * f[j] * ys[i];
            for (let k = 0; k < p; k++) A[j][k] += w * f[j] * f[k];
        }
    });
    for (let j = 0; j < p; j++) A[j][j] += cols[j].lambda ?? 1e-8;
    const Ainv = invert(A);
    const beta = Ainv.map((row) => row.reduce((acc, v, k) => acc + v * b[k], 0));
    const resid = feats.map((f, i) => ys[i] - f.reduce((acc, v, j) => acc + v * beta[j], 0));
    const loo = feats.map((f, i) => {
        let h = 0;
        for (let j = 0; j < p; j++) {
            if (f[j] === 0) continue;
            let t = 0;
            for (let k = 0; k < p; k++) t += Ainv[j][k] * f[k];
            h += f[j] * t;
        }
        return resid[i] / Math.max(0.05, 1 - ws[i] * h);
    });
    return { beta, resid, loo, ws };
}

/** 加权均方根。 */
function rms(values, ws) {
    const sw = ws.reduce((a, w) => a + w, 0);
    return Math.sqrt(values.reduce((a, v, i) => a + ws[i] * v * v, 0) / sw);
}

// ---------------------------------------------------------------------------
// 普通活动基线（逐区服逐档）

function knotsFor(rows, xRef, knotYears) {
    if (!knotYears) return [];
    const xMin = Math.min(...rows.map((r) => r.x));
    const out = [];
    // 最后一段至少半个节点间隔，外推斜率才稳定。
    for (let k = xMin + knotYears; k < xRef - knotYears / 2; k += knotYears) out.push(k);
    return out;
}

function fitBaseTier(rank, rows, o, xRef) {
    const n = new Set(rows.map((r) => r.eventId)).size;
    const useTrend = n >= o.minTrendEvents;
    const full = n >= o.minFullEvents;
    const cols = [{ key: "a", f: () => 1 }];
    if (useTrend) cols.push({ key: "b", f: (r) => r.x - xRef });
    // 节点项取 min(0, x − κ)：最后一个节点之后（含外推）只由 xRef 处的水平 a 与最后一段斜率 b 决定；更早的活动再加各节点项。
    const knots = full ? knotsFor(rows, xRef, o.knotYears) : [];
    for (const k of knots) cols.push({ key: "knot", id: k, f: (r) => Math.min(0, r.x - k), lambda: o.splineLambda });
    const fixedHours = o.days === "fixed";
    if (full && o.days === "fit") cols.push({ key: "c", f: (r) => r.lh });
    if (full && o.breakGauge && rows.some((r) => r.gauge) && rows.some((r) => !r.gauge)) {
        cols.push({ key: "g", f: (r) => (r.gauge ? 1 : 0), lambda: o.gaugeLambda });
    }
    if (full && o.unit) {
        for (const u of [...new Set(rows.map((r) => r.unit))].sort()) {
            cols.push({ key: "unit", id: u, f: (r) => (r.unit === u ? 1 : 0), lambda: o.unitLambda });
        }
    }
    if (full && o.banner) {
        for (const ch of [...new Set(rows.filter((r) => r.banner != null).map((r) => r.banner))].sort((a, b) => a - b)) {
            cols.push({ key: "banner", id: String(ch), f: (r) => (r.banner === ch ? 1 : 0), lambda: o.bannerLambda });
        }
    }
    const yOf = (r) => r.y - (fixedHours ? r.lh : 0);
    const fit = ridgeWls(rows, cols, yOf, (r) => decay(r.x, xRef, o.halfLifeYears));
    const knotCoef = [];
    const tier = { rank, n, a: 0, b: 0, knots: knotCoef, c: fixedHours ? 1 : 0, g: 0, unit: {}, banner: {}, sigma: 0 };
    cols.forEach((c, j) => {
        const v = fit.beta[j];
        if (c.key === "a" || c.key === "b" || c.key === "c" || c.key === "g") tier[c.key] = v;
        else if (c.key === "unit") tier.unit[c.id] = v;
        else if (c.key === "banner") tier.banner[c.id] = v;
        else if (c.key === "knot") knotCoef.push([c.id, v]);
    });
    // 留一残差的均方根：已含系数估计误差，作为新活动的预测 σ。
    tier.sigma = Math.max(SIGMA_FLOOR, rms(fit.loo, fit.ws));
    return { tier, history: (s) => basePredict(tier, s, xRef) };
}

function basePredict(t, s, xRef) {
    let mu = t.a + t.b * (s.x - xRef) + t.c * s.lh + (s.gauge ? t.g : 0);
    for (const [k, v] of t.knots) mu += v * Math.min(0, s.x - k);
    if (s.group === "normal") {
        mu += t.unit[s.unit] ?? 0;
        if (s.banner != null) mu += t.banner[String(s.banner)] ?? 0;
    }
    return mu;
}

/** 逐档拟合普通活动基线；返回 { tiers: Map<rank, tier>, history: Map<rank, (sample) → 基线值> }。 */
function fitBase(normal, o, xRef) {
    const tiers = new Map();
    const history = new Map();
    for (const [rank, rows] of groupBy(normal, (s) => s.rank)) {
        if (new Set(rows.map((r) => r.eventId)).size < o.minTierEvents) continue;
        const fit = fitBaseTier(rank, rows, o, xRef);
        tiers.set(rank, fit.tier);
        history.set(rank, fit.history);
    }
    return { tiers, history };
}

// ---------------------------------------------------------------------------
// 非普通组：组偏移、单元格偏移（向组收缩）、章节角色效应

function eventNormalizedWeights(rows, xRef, halfLife) {
    const perEvent = new Map();
    for (const r of rows) perEvent.set(r.eventId, (perEvent.get(r.eventId) ?? 0) + 1);
    return rows.map((r) => decay(r.x, xRef, halfLife) / perEvent.get(r.eventId));
}

function wmean(values, ws) {
    const sw = ws.reduce((a, b) => a + b, 0);
    return sw > 0 ? values.reduce((a, v, i) => a + v * ws[i], 0) / sw : 0;
}

function sumBy(rows, keyFn, valFn) {
    const m = new Map();
    for (const r of rows) m.set(keyFn(r), (m.get(keyFn(r)) ?? 0) + valFn(r));
    return m;
}

/**
 * 组偏移 = 组内残差（相对普通活动基线）的事件加权均值；单元格偏移 = n/(n+k) × 单元格均值（相对组偏移）；
 * 章节角色效应 = 剩余残差按角色的岭均值。σ 用按活动留一的预测残差估计（留出的活动不参与三项偏移）。
 */
function fitGroups(wl, o, xRef) {
    const groups = {};
    const cells = {};
    const parts = [];
    for (const [g, gs] of groupBy(wl, (s) => s.group)) {
        const tiers = [];
        for (const [rank, rows] of [...groupBy(gs, (s) => s.rank)].sort((a, b) => a[0] - b[0])) {
            const ws = eventNormalizedWeights(rows, xRef, o.groupHalfLifeYears);
            const offset = wmean(rows.map((r) => r.e), ws);
            const sw = ws.reduce((a, w) => a + w, 0);
            const swe = rows.reduce((a, r, i) => a + ws[i] * r.e, 0);
            const evSw = sumBy(rows.map((r, i) => ({ id: r.eventId, w: ws[i] })), (x) => x.id, (x) => x.w);
            const evSwe = sumBy(rows.map((r, i) => ({ id: r.eventId, v: ws[i] * r.e })), (x) => x.id, (x) => x.v);
            const offsetWithout = (id) => (sw - evSw.get(id) > 1e-12 ? (swe - evSwe.get(id)) / (sw - evSw.get(id)) : null);
            const cellOff = new Map();
            const cellOffWithout = new Map();
            if (o.cellK != null) {
                for (const [key, cr] of groupBy(rows.filter((r) => r.cell != null), (r) => r.cell)) {
                    const evMean = new Map();
                    for (const [id, er] of groupBy(cr, (r) => r.eventId)) evMean.set(id, er.reduce((a, r) => a + r.e, 0) / er.length);
                    const n = evMean.size;
                    const total = [...evMean.values()].reduce((a, v) => a + v, 0);
                    const off = (n / (n + o.cellK)) * (total / n - offset);
                    cellOff.set(key, off);
                    for (const [id, m] of evMean) {
                        const d = offsetWithout(id);
                        const n1 = n - 1;
                        cellOffWithout.set(`${key}|${id}`, n1 > 0 && d != null ? (n1 / (n1 + o.cellK)) * ((total - m) / n1 - d) : 0);
                    }
                    let c = cells[key];
                    if (!c) cells[key] = c = { nEvents: 0, weight: 0, tiers: [] };
                    c.nEvents = Math.max(c.nEvents, n);
                    c.weight = c.nEvents / (c.nEvents + o.cellK);
                    c.tiers.push({ rank, offset: off });
                }
            }
            const annotated = rows.map((r) => ({ ...r, r2: r.e - offset - (cellOff.get(r.cell) ?? 0) }));
            const evDecay = new Map(rows.map((r) => [r.eventId, decay(r.x, xRef, o.groupHalfLifeYears)]));
            const w = [...evDecay.values()];
            const nEff = w.reduce((a, b) => a + b, 0) ** 2 / w.reduce((a, b) => a + b * b, 0);
            const tier = { rank, offset, sigma: 0, se: 0, nEvents: evDecay.size, nEff };
            tiers.push(tier);
            parts.push({ g, rank, tier, rows: annotated, ws, offsetWithout, cellOffWithout });
        }
        groups[g] = { source: gs[0].region, nEvents: new Set(gs.map((s) => s.eventId)).size, tiers };
    }

    // 章节角色效应（两种章节组、各期合并，逐档岭均值）
    const chapterCharacter = [];
    const charSums = new Map();
    if (o.chapterCharacter) {
        const ch = parts
            .filter((p) => p.g === "wl_chapter_72h" || p.g === "wl_chapter_48h")
            .flatMap((p) => p.rows.filter((r) => r.character != null));
        for (const [rank, rows] of [...groupBy(ch, (r) => r.rank)].sort((a, b) => a[0] - b[0])) {
            const effects = {};
            const sums = new Map();
            for (const [c, cr] of groupBy(rows, (r) => r.character)) {
                const total = cr.reduce((a, r) => a + r.r2, 0);
                effects[String(c)] = total / (cr.length + o.characterLambda);
                const byEvent = new Map();
                for (const [id, er] of groupBy(cr, (r) => r.eventId)) byEvent.set(id, [er.reduce((a, r) => a + r.r2, 0), er.length]);
                sums.set(c, { total, n: cr.length, byEvent });
            }
            chapterCharacter.push({ rank, effects });
            charSums.set(rank, sums);
        }
    }
    const charWithout = (rank, c, id) => {
        const s = charSums.get(rank)?.get(c);
        if (!s) return 0;
        const [se, ne] = s.byEvent.get(id) ?? [0, 0];
        return (s.total - se) / (s.n - ne + o.characterLambda);
    };

    // 留一预测残差的均方根；不足 3 期的组（如只有一期的终章）取同区服其他组同档的均方根。
    for (const p of parts) {
        if (p.tier.nEvents < 3) continue;
        const pred = p.rows.map((r) => {
            const d = p.offsetWithout(r.eventId);
            const cell = r.cell != null ? p.cellOffWithout.get(`${r.cell}|${r.eventId}`) ?? 0 : 0;
            const chr = r.character != null && o.chapterCharacter ? charWithout(p.rank, r.character, r.eventId) : 0;
            return r.e - d - cell - chr;
        });
        p.tier.sigma = Math.max(SIGMA_FLOOR, rms(pred, p.ws));
    }
    for (const [g, grp] of Object.entries(groups)) {
        for (const t of grp.tiers) {
            if (t.sigma === 0) {
                const others = Object.entries(groups)
                    .filter(([h]) => h !== g)
                    .map(([, og]) => og.tiers.find((x) => x.rank === t.rank && x.nEvents >= 3))
                    .filter(Boolean);
                t.sigma = others.length > 0 ? Math.sqrt(others.reduce((a, x) => a + x.sigma * x.sigma, 0) / others.length) : 0.5;
            }
            t.se = t.sigma / Math.sqrt(t.nEff);
        }
    }
    for (const grp of Object.values(groups)) {
        grp.tiers = grp.tiers.map((t) => ({ rank: t.rank, offset: t.offset, sigma: t.sigma, se: t.se }));
    }
    return { groups, cells, chapterCharacter };
}

// ---------------------------------------------------------------------------
// 国服/日服同 id 比例

function fitRatio(samples, o) {
    const jp = new Map();
    for (const s of samples) if (s.region === "jp") jp.set(`${s.eventId}|${s.scope}|${s.rank}`, s);
    const pairs = [];
    for (const s of samples) {
        if (s.region !== "cn") continue;
        const j = jp.get(`${s.eventId}|${s.scope}|${s.rank}`);
        if (j) pairs.push({ ...s, z: s.y - j.y, lhr: Math.log(s.hours / j.hours) });
    }
    if (pairs.length === 0) return null;
    const cnX = samples.filter((s) => s.region === "cn").map((s) => s.x);
    const xRef = Math.max(...cnX);
    const base = [];
    const baseByRank = new Map();
    for (const [rank, rows] of [...groupBy(pairs.filter((p) => p.group === "normal"), (p) => p.rank)].sort((a, b) => a[0] - b[0])) {
        const n = new Set(rows.map((r) => r.eventId)).size;
        if (n < o.minRatioEvents) continue;
        const cols = [{ key: "rho", f: () => 1 }];
        if (o.ratioTrend && n >= o.minTrendEvents) cols.push({ key: "eta", f: (r) => r.x - xRef });
        if (o.ratioHours && n >= o.minFullEvents) cols.push({ key: "kappa", f: (r) => r.lhr });
        const fit = ridgeWls(rows, cols, (r) => r.z, (r) => decay(r.x, xRef, o.ratioHalfLifeYears));
        const t = { rank, n, rho: 0, eta: 0, kappa: 0, sigma: 0 };
        cols.forEach((c, j) => (t[c.key] = fit.beta[j]));
        t.sigma = Math.max(SIGMA_FLOOR, rms(fit.loo, fit.ws));
        base.push(t);
        baseByRank.set(rank, t);
    }
    const offsets = {};
    if (o.ratioK != null) {
        const wl = pairs
            .filter((p) => p.ratioKeys && baseByRank.has(p.rank))
            .map((p) => {
                const t = baseByRank.get(p.rank);
                return { ...p, e: p.z - (t.rho + (o.ratioWlTrend ? t.eta * (p.x - xRef) : 0) + t.kappa * p.lhr) };
            });
        const put = (key, rank, nEv, offset) => {
            let c = offsets[key];
            if (!c) offsets[key] = c = { nEvents: 0, weight: 0, tiers: [] };
            c.nEvents = Math.max(c.nEvents, nEv);
            c.weight = c.nEvents / (c.nEvents + o.ratioK);
            c.tiers.push({ rank, offset });
        };
        for (const [rank, rows] of [...groupBy(wl, (p) => p.rank)].sort((a, b) => a[0] - b[0])) {
            for (const [edition, er] of groupBy(rows, (p) => p.ratioKeys.edition)) {
                const nEd = new Set(er.map((r) => r.eventId)).size;
                const edOff = (nEd / (nEd + o.ratioK)) * wmean(er.map((r) => r.e), eventNormalizedWeights(er, xRef, null));
                put(edition, rank, nEd, edOff);
                for (const [cell, cr] of groupBy(er, (p) => p.ratioKeys.cell)) {
                    const nC = new Set(cr.map((r) => r.eventId)).size;
                    const m = wmean(cr.map((r) => r.e - edOff), eventNormalizedWeights(cr, xRef, null));
                    put(cell, rank, nC, (nC / (nC + o.ratioK)) * m);
                }
            }
        }
    }
    const jpHours = {};
    if (o.ratioHours) {
        for (const s of samples) {
            if (s.region !== "jp") continue;
            jpHours[`${s.eventId}|${s.scope === "overall" ? "overall" : "chapter"}`] = s.hours;
        }
    }
    return { xRef, base, offsets, k: o.ratioK, wlTrend: o.ratioWlTrend, jpHours };
}

// ---------------------------------------------------------------------------
// 主拟合

function roundDeep(v) {
    if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 1e5) / 1e5 : v;
    if (Array.isArray(v)) return v.map(roundDeep);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundDeep(x)]));
    return v;
}

/**
 * fitPrior(train, opts?) → PriorSection（同步）。train = { events, series, finals }（loadDataset / 回测训练子集）。
 */
export function fitPrior(train, opts = {}) {
    const o = { ...DEFAULT_PRIOR_OPTIONS, ...opts };
    const samples = collectSamples(train);
    const regions = {};
    for (const region of ["jp", "cn"]) {
        const rs = samples.filter((s) => s.region === region);
        const evs = train.events.filter((e) => e.region === region);
        if (rs.length === 0 || evs.length === 0) continue;
        const xRef = Math.max(...evs.map((e) => years(e.startAt)));
        const { tiers, history } = fitBase(rs.filter((s) => s.group === "normal"), o, xRef);
        if (tiers.size === 0) continue;
        const wl = rs
            .filter((s) => s.group !== "normal" && history.has(s.rank))
            .map((s) => ({ ...s, e: s.y - history.get(s.rank)(s) }));
        const { groups, cells, chapterCharacter } = fitGroups(wl, o, xRef);
        regions[region] = {
            xRef,
            base: [...tiers.values()].sort((a, b) => a.rank - b.rank),
            groups,
            cells,
            cellK: o.cellK,
            chapterCharacter,
        };
    }
    // 国服没有样本的组（章节、终章）以日服同组为父级。
    if (regions.cn && regions.jp) {
        for (const [g, grp] of Object.entries(regions.jp.groups)) {
            if (!regions.cn.groups[g]) regions.cn.groups[g] = grp;
        }
        if (regions.cn.chapterCharacter.length === 0) regions.cn.chapterCharacter = regions.jp.chapterCharacter;
    }
    const features = Object.fromEntries(Object.entries(o).filter(([, v]) => v == null || ["number", "boolean", "string"].includes(typeof v)));
    return roundDeep({
        version: 1,
        epochMs: PRIOR_EPOCH_MS,
        hoursRef: HOURS_REF,
        maxExtrapolationYears: o.maxExtrapolationYears,
        cnBlend: o.cnBlend,
        features,
        regions,
        cnRatio: o.ratio ? fitRatio(samples, o) : null,
    });
}

// ---------------------------------------------------------------------------
// 先验水平的来源（报告用）

/** 训练集里各「区服|组」贡献了终榜的非普通活动 id（升序）。 */
export function groupEventIds(samples) {
    const sets = new Map();
    for (const s of samples) {
        if (s.group === "normal") continue;
        const key = `${s.region}|${s.group}`;
        let set = sets.get(key);
        if (!set) sets.set(key, (set = new Set()));
        set.add(s.eventId);
    }
    return new Map([...sets].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
}

/**
 * 与 prior.ts 的 priorCurve 同一判定：anchor = 国服用日服同 id 终榜 × 比例；cell = 自身单元格有数据；
 * group = 单元格没有数据，只用组偏移（水平来自该组已结算的其他期，方差另加 se² 与 σ²/k）；normal；none = 没有先验。
 * source / nEvents 为组偏移的来源区服与期数。
 */
export function priorLevelSource(section, ctx) {
    const jp = ctx.jpSameIdFinal ? Object.values(ctx.jpSameIdFinal).some((v) => Number.isFinite(v) && v > 0) : false;
    if (ctx.region === "cn" && jp && section.cnRatio && section.cnRatio.base.length > 0) return { kind: "anchor" };
    const reg = section.regions[ctx.region];
    if (!reg) return { kind: "none" };
    if (ctx.group === "normal") return { kind: "normal" };
    const grp = reg.groups[ctx.group];
    if (!grp) return { kind: "none" };
    const key = priorCellKey(ctx);
    const kind = reg.cellK != null && key && reg.cells[key] ? "cell" : "group";
    return { kind, source: grp.source, nEvents: grp.nEvents };
}

/** 与回测一致：国服范围取结算早于其开始的日服同 id 同范围终榜。 */
function jpSameIdFinal(index, ev, scope) {
    if (ev.region !== "cn") return null;
    const jp = index.events.get(eventKey("jp", ev.eventId));
    if (!jp || jp.aggregateAt >= ev.startAt) return null;
    const finals = actualFinals(index, jp, scope);
    return finals.size > 0 ? Object.fromEntries([...finals].map(([rank, f]) => [rank, f.score])) : null;
}

export const LEVEL_RANKS = [1, 10, 100, 1000, 10000];

/**
 * 结算晚于 nowMs 的非普通活动范围里，先验水平不来自自身单元格的（kind = group 或 anchor），
 * 附组偏移的来源活动与各档先验；用于在报告里写明哪些上线预测借用了别的期（如新一期终章借已结算终章的水平）。
 */
export function borrowedLevels(section, data, nowMs) {
    const index = indexDataset(data);
    const sources = groupEventIds(collectSamples(data));
    const out = [];
    for (const ev of [...data.events].sort((a, b) => a.startAt - b.startAt || a.eventId - b.eventId)) {
        if (!(ev.aggregateAt > nowMs)) continue;
        for (const scope of scopesOf(ev)) {
            const ctx = contextFromDataset(ev, scope, ev.startAt, [], jpSameIdFinal(index, ev, scope));
            if (ctx.group === "normal") continue;
            const level = priorLevelSource(section, ctx);
            if (level.kind !== "group" && level.kind !== "anchor") continue;
            const grp = level.kind === "group" ? section.regions[ctx.region].groups[ctx.group] : null;
            const tiers = LEVEL_RANKS.map((rank) => {
                const est = finalPrior(ctx, rank, section);
                return { rank, median: est?.median ?? null, logSigma: est?.logSigma ?? null, groupSigma: grp?.tiers.find((t) => t.rank === rank)?.sigma ?? null };
            });
            out.push({
                region: ev.region,
                eventId: ev.eventId,
                scope: scopeKey(scope),
                cell: priorCellKey(ctx),
                group: ctx.group,
                kind: level.kind,
                source: level.source ?? null,
                nEvents: level.nEvents ?? null,
                sourceEvents: level.kind === "group" ? sources.get(`${level.source}|${ctx.group}`) ?? [] : [],
                tiers,
            });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// 回测：先验单独预测（与截点无关），对照 tori-v2 先验

/** 回测用数据：终榜全部物化（终榜表 + 序列末点），每档一条只含范围起点的合成序列，使只有终榜的活动（国服、日服 #87–#123）也进入回测。 */
export function materializeFinals(data) {
    const index = indexDataset(data);
    const finals = [];
    const series = [];
    for (const ev of data.events) {
        for (const scope of scopesOf(ev)) {
            if (isExcluded(ev, scope)) continue;
            const { startAt } = scopeWindow(ev, scope);
            for (const [rank, f] of actualFinals(index, ev, scope)) {
                finals.push({ region: ev.region, eventId: ev.eventId, scope, rank, score: f.score, source: f.source });
                series.push({ region: ev.region, eventId: ev.eventId, scope, rank, points: [[startAt, 0]], source: "prior-eval" });
            }
        }
    }
    return { events: data.events, series, finals };
}

export const PRIOR_CUTS = [{ id: "prior", kind: "progress", value: 0 }];

export function logNormalQuantiles(est) {
    return { p10: est.median * Math.exp(-Z90 * est.logSigma), p50: est.median, p90: est.median * Math.exp(Z90 * est.logSigma) };
}

export function priorModel(name, opts = {}) {
    return {
        name,
        fit: (train) => fitPrior(train, opts),
        predict(sections, ctx, _atMs, observed) {
            const out = new Map();
            for (const o of observed) {
                const est = finalPrior(ctx, o.rank, sections);
                if (est) out.set(o.rank, logNormalQuantiles(est));
            }
            return out;
        },
    };
}

/** tori-v2 第 1 层先验（priorTotalFinalScore）。直接载入冻结副本并补一行导出，不复制其参数表。 */
export async function loadToriPrior(file = path.join(HERE, "baselines", "tori-v2.ts")) {
    const src = `${fs.readFileSync(file, "utf8")}\nexport { getTierParameters, BONUS_SCALE_MAP };\n`;
    const mod = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(src)).toString("base64")}`);
    // 入参与 baselines/current-engine.mjs 相同：WL 加成 990、章节传 characterId、普通活动 475、不传 unit。
    const estimate = (ctx, rank, eventType) => {
        const isWl = ctx.group !== "normal";
        const bonusPercent = isWl ? 990 : 475;
        const characterId = ctx.chapterCharacterId ?? undefined;
        const eventTypeIn = characterId != null ? undefined : isWl ? "world_bloom" : eventType;
        const totalHours = Math.max(1, (ctx.scopeEndAt - ctx.scopeStartAt) / HOUR_MS);
        const isWlEvent = eventTypeIn === "world_bloom" || bonusPercent >= 600;
        const isWlChapter = isWlEvent ? totalHours <= 72 || characterId != null : totalHours <= 72;
        const isWlOverall = isWlEvent && !isWlChapter;
        const mode = isWlChapter ? "wl_chapter" : isWlOverall ? "wl_overall" : "standard";
        const tp = mod.getTierParameters(rank, ctx.region === "jp", mode);
        const charHeat = (characterId ? mod.CHARACTER_HEAT_MAP[characterId] : undefined) ?? 1.0;
        const bonus = isWlChapter || isWlOverall ? 1.0 : mod.BONUS_SCALE_MAP[bonusPercent] ?? (100 + bonusPercent) / 485;
        const p50 = tp.baseDailyMedian * charHeat * bonus * (totalHours / 24);
        // 进度 0 时引擎的区间半宽 = 1.28 × sigmaRatio × (P50 + 100000)
        const half = 1.28 * tp.sigmaRatio * (p50 + 100_000);
        return { p10: Math.max(0, p50 - half), p50, p90: p50 + half };
    };
    return {
        name: "tori-v2-prior",
        fit: () => null,
        predict(_s, ctx, _atMs, observed, info) {
            return new Map(observed.map((o) => [o.rank, estimate(ctx, o.rank, info.event.eventType)]));
        },
    };
}

/** 消融与超参候选：每项只改默认配置的一处。 */
export const CANDIDATES = [
    { name: "days=off", opts: { days: "off" } },
    { name: "days=fixed", opts: { days: "fixed" } },
    { name: "breakGauge=on", opts: { breakGauge: true } },
    { name: "unit=off", opts: { unit: false } },
    { name: "banner=off", opts: { banner: false } },
    { name: "unit+banner=off", opts: { unit: false, banner: false } },
    { name: "chapterCharacter=off", opts: { chapterCharacter: false } },
    { name: "characterLambda=2", opts: { characterLambda: 2 } },
    { name: "trend=line", opts: { knotYears: 0 } },
    { name: "trend=line+halfLife1y", opts: { knotYears: 0, halfLifeYears: 1 } },
    { name: "knotYears=1", opts: { knotYears: 1 } },
    { name: "splineLambda=0.5", opts: { splineLambda: 0.5 } },
    { name: "splineLambda=8", opts: { splineLambda: 8 } },
    { name: "halfLife=2y", opts: { halfLifeYears: 2 } },
    { name: "cellK=null(pool editions)", opts: { cellK: null } },
    { name: "cellK=0.5", opts: { cellK: 0.5 } },
    { name: "cellK=8", opts: { cellK: 8 } },
    { name: "groupHalfLife=1y", opts: { groupHalfLifeYears: 1 } },
    { name: "ratio=off", opts: { ratio: false } },
    { name: "ratioTrend=off", opts: { ratioTrend: false } },
    { name: "ratioWlTrend=off", opts: { ratioWlTrend: false } },
    { name: "ratioHours=on", opts: { ratioHours: true } },
    { name: "ratioHalfLife=1y", opts: { ratioHalfLifeYears: 1 } },
    { name: "ratioK=null(no WL ratio offsets)", opts: { ratioK: null } },
    { name: "ratioK=8", opts: { ratioK: 8 } },
    { name: "cnBlend=on", opts: { cnBlend: true } },
];

function logErr(r) {
    return Math.abs(Math.log(r.p50 / r.actual));
}

function summarizeRows(rows) {
    const s = summarize(rows);
    return { ...s, male: rows.length ? rows.reduce((a, r) => a + logErr(r), 0) / rows.length : null };
}

/** 回测行与 levels 共用的范围键。 */
export function scopeRowKey(region, eventId, scope) {
    return `${region}-${eventId}/${scope}`;
}

/**
 * 先验回测：跑默认配置、tori-v2 先验和各候选，返回 { rows: Map<model, rows>, mat, levels }（mat = materializeFinals(data)；
 * levels = 默认配置在各测试范围拟合时的 priorLevelSource，键为 scopeRowKey）。
 */
export async function evaluatePrior({ data, opts = {}, candidates = CANDIDATES, log = console.log } = {}) {
    const mat = materializeFinals(data);
    const levels = new Map();
    const base = priorModel("prior", opts);
    const tracked = {
        ...base,
        predict(sections, ctx, atMs, observed, info) {
            levels.set(scopeRowKey(ctx.region, ctx.eventId, scopeKey(info.scope)), priorLevelSource(sections, ctx));
            return base.predict(sections, ctx, atMs, observed, info);
        },
    };
    const models = [tracked, await loadToriPrior(), ...candidates.map((c) => priorModel(c.name, { ...opts, ...c.opts }))];
    const rows = new Map();
    for (const m of models) {
        const t0 = Date.now();
        const r = rollingBacktest({ data: mat, fit: m.fit, predict: m.predict, cuts: PRIOR_CUTS, model: m.name, maxStaleMs: Infinity });
        rows.set(m.name, r);
        log(`${m.name}: ${r.length} 行，${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
    }
    return { rows, mat, levels };
}

function keyOf(r) {
    return `${r.region}-${r.eventId}/${r.scope}/${r.rank}`;
}

/** 只保留两组都有预测的点。 */
export function pairOn(a, b) {
    const kb = new Map(b.map((r) => [keyOf(r), r]));
    const pa = [];
    const pb = [];
    for (const r of a) {
        const o = kb.get(keyOf(r));
        if (o) {
            pa.push(r);
            pb.push(o);
        }
    }
    return { a: pa, b: pb };
}

function pct(v, digits = 1) {
    return v == null ? "—" : `${(v * 100).toFixed(digits)}%`;
}

function num(v, digits = 3) {
    return v == null ? "—" : v.toFixed(digits);
}

const groupOfRow = (r) => {
    const [, group, turn] = r.cell.split("|");
    return `${r.region}|${group}${group === "normal" || group === "wl_finale" ? "" : `|${turn}`}`;
};

/** 回测前后两半的分界：用于检查特征的增益是否在两段测试活动上都成立。 */
export const SPLIT_AT = Date.UTC(2025, 0, 1);

/** markdown 表格单元格里的竖线要转义（单元格键本身含 |）。 */
function md(text) {
    return String(text).replaceAll("|", "\\|");
}

function summaryRow(label, sa, sb) {
    return `| ${label} | ${sa.events} | ${sa.n} | ${pct(sa.mape)} | ${pct(sb.mape)} | ${pct(sa.medianApe)} | ${pct(sb.medianApe)} | ${pct(sa.bias)} | ${pct(sb.bias)} | ${num(sa.male)} | ${num(sb.male)} | ${pct(sa.coverage, 0)} | ${pct(sb.coverage, 0)} | ${sa.male < sb.male ? "是" : "否"} |`;
}

/**
 * 渲染先验回测报告（markdown）。rows: Map<模型名, 回测行>；events 用于按开始时间切两半；
 * data（全量数据集）与 levels（evaluatePrior 返回）用于第 6 节借用父级水平的说明，缺省时略去对应部分。
 */
export function renderPriorReport({ rows, section, generatedAt, events, data = null, levels = null }) {
    const startOf = new Map(events.map((e) => [`${e.region}-${e.eventId}`, e.startAt]));
    const early = (r) => startOf.get(`${r.region}-${r.eventId}`) < SPLIT_AT;
    const prior = rows.get("prior");
    const tori = rows.get("tori-v2-prior");
    const lines = [];
    lines.push("# 终榜先验回测（F1）", "", `生成时间：${generatedAt}`, "");
    lines.push("滚动原点（H1 rollingBacktest）：预测某期时只用结算早于该期开始的活动拟合。先验与截点无关，每个 (区服, 活动, 范围, 档位) 只算一次；");
    lines.push("终榜取自终榜表或贴近结算的序列末点，只有终榜、没有逐时序列的活动（国服全部、日服 #87–#123）也计入。");
    lines.push("MALE = 平均 |log(预测/终榜)|；覆盖率 = 终榜落在 P10–P90 内的比例（新先验取 median·exp(±1.2816σ)，tori 取引擎进度 0 时的区间）。");
    lines.push(`已排除的坏终榜：${EXCLUDED_FINALS.map((x) => `${x.region} #${x.eventId} ${x.scope}（${x.reason}）`).join("；")}。`, "");

    const { a, b } = pairOn(prior, tori);
    lines.push("## 1. 按单元格：新先验 vs tori-v2 先验（配对点）", "");
    lines.push("| 单元格 | 活动数 | 点数 | 新 MAPE | tori MAPE | 新中位 APE | tori 中位 APE | 新偏差 | tori 偏差 | 新 MALE | tori MALE | 新覆盖 | tori 覆盖 | 新先验更好 |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    const cellsB = groupBy(b, (r) => r.cell);
    for (const [cell, ra] of [...groupBy(a, (r) => r.cell)].sort((x, y) => x[0].localeCompare(y[0]))) {
        const sa = summarizeRows(ra);
        lines.push(summaryRow(`${md(cell)}${sa.events < 5 ? " ⚠" : ""}`, sa, summarizeRows(cellsB.get(cell))));
    }
    lines.push(summaryRow("**全部**", summarizeRows(a), summarizeRows(b)), "");
    lines.push("⚠ = 测试活动少于 5 期，统计力有限。", "");
    const pairedKeys = new Set(b.map(keyOf));
    const missing = groupBy(tori.filter((r) => !pairedKeys.has(keyOf(r))), (r) => r.cell);
    if (missing.size > 0) {
        lines.push("新先验返回 null 的点（训练集里该组还没有样本、该区服普通活动不足 minTierEvents 期，或该档位在普通活动里不足 minTierEvents 期；上线时由观测单独预测）：", "");
        for (const [cell, rs] of [...missing].sort((x, y) => x[0].localeCompare(y[0]))) {
            const byEvent = groupBy(rs, (r) => `${r.region} #${r.eventId}`);
            const evs = [...byEvent].map(([ev, er]) => {
                const ranks = [...new Set(er.map((r) => r.rank))].sort((x, y) => x - y);
                return ranks.length <= 3 ? `${ev}（T${ranks.join("/T")}）` : ev;
            });
            lines.push(`- ${cell}：${rs.length} 点，${evs.join("、")}`);
        }
        lines.push("");
    }

    lines.push("## 2. 按区服 × 档位段（配对点）", "");
    lines.push("| 区服 | 档位段 | 点数 | 新 MAPE | tori MAPE | 新 MALE | tori MALE | 新覆盖 | tori 覆盖 |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    const bandB = groupBy(b, (r) => `${r.region}|${r.band}`);
    for (const [k, ra] of [...groupBy(a, (r) => `${r.region}|${r.band}`)].sort((x, y) => x[0].localeCompare(y[0]))) {
        const [region, band] = k.split("|");
        const s1 = summarizeRows(ra);
        const s2 = summarizeRows(bandB.get(k));
        lines.push(`| ${region} | ${band} | ${s1.n} | ${pct(s1.mape)} | ${pct(s2.mape)} | ${num(s1.male)} | ${num(s2.male)} | ${pct(s1.coverage, 0)} | ${pct(s2.coverage, 0)} |`);
    }
    lines.push("");

    lines.push("## 3. 特征与超参：相对默认配置的 MALE 变化 ×1000（配对点；正数 = 这项改动让误差变大，即默认的取舍是对的）", "");
    const groups = [...groupBy(prior, groupOfRow).keys()].sort();
    lines.push(`| 改动 | ${groups.map(md).join(" | ")} | 全部 | 2025 年前开始 | 2025 年起 |`);
    lines.push(`|---|${groups.map(() => "---").join("|")}|---|---|---|`);
    lines.push(`| 默认配置的 MALE | ${groups.map((g) => num(summarizeRows(groupBy(prior, groupOfRow).get(g)).male)).join(" | ")} | ${num(summarizeRows(prior).male)} | ${num(summarizeRows(prior.filter(early)).male)} | ${num(summarizeRows(prior.filter((r) => !early(r))).male)} |`);
    const delta = (xa, xb) => (xa.length && xb.length ? ((summarizeRows(xb).male - summarizeRows(xa).male) * 1000).toFixed(1) : "—");
    for (const [name, cr] of rows) {
        if (name === "prior" || name === "tori-v2-prior") continue;
        const { a: pa, b: pc } = pairOn(prior, cr);
        const byA = groupBy(pa, groupOfRow);
        const byC = groupBy(pc, groupOfRow);
        const cellsTxt = groups.map((g) => (byA.has(g) && byC.has(g) ? delta(byA.get(g), byC.get(g)) : "—"));
        const ea = pa.filter(early);
        const ec = pc.filter(early);
        const la = pa.filter((r) => !early(r));
        const lc = pc.filter((r) => !early(r));
        const extra = cr.length - pc.length;
        lines.push(`| ${name}${extra > 0 ? `（另有 ${extra} 点默认配置无预测）` : ""} | ${cellsTxt.join(" | ")} | ${delta(pa, pc)} | ${delta(ea, ec)} | ${delta(la, lc)} |`);
    }
    lines.push("");

    lines.push("## 4. 全量拟合的收缩（偏移 = n/(n+k) × 单元格自身均值，其余 (1 − n/(n+k)) 留给父级）", "");
    lines.push("父级：WL 单元格 → 同区服同组的组偏移；终章单元格（按活动 id）→ 终章组；国服没有样本的组 → 日服同组；国服/日服比例的 WL 单元格 → 同期（edition）→ 普通活动比例。", "");
    lines.push("| 区服 | 单元格 | 活动数 n | k | 自身权重 | 父级权重 |");
    lines.push("|---|---|---|---|---|---|");
    const sourceIds = data ? groupEventIds(collectSamples(data)) : new Map();
    const idsOf = (region, g) => {
        const ids = sourceIds.get(`${region}|${g}`);
        return ids && ids.length > 0 ? `（#${ids.join("、#")}）` : "";
    };
    for (const [region, reg] of Object.entries(section.regions)) {
        for (const [key, c] of Object.entries(reg.cells).sort()) {
            lines.push(`| ${region} | ${md(key)} | ${c.nEvents} | ${reg.cellK} | ${num(c.weight, 2)} | ${num(1 - c.weight, 2)} |`);
        }
        for (const [g, grp] of Object.entries(reg.groups)) {
            if (grp.source !== region) lines.push(`| ${region} | 组 ${g}（本区无样本） | 0 | — | 0.00 | 1.00（日服同组，${grp.nEvents} 期） |`);
            else if (grp.nEvents < 3) lines.push(`| ${region} | 组 ${g} | ${grp.nEvents} | — | 组偏移只来自 ${grp.nEvents} 期${idsOf(region, g)} | σ 借用同区服其他组，另加偏移标准误；本组没有数据的新单元格整份沿用该水平，见第 6 节 |`);
        }
    }
    if (section.cnRatio) {
        for (const [key, c] of Object.entries(section.cnRatio.offsets).sort()) {
            lines.push(`| cn 比例 | ${md(key)} | ${c.nEvents} | ${section.cnRatio.k} | ${num(c.weight, 2)} | ${num(1 - c.weight, 2)} |`);
        }
    }
    lines.push("");

    lines.push("## 5. 全量拟合的主要系数（节选）", "");
    lines.push("| 区服 | 档位 | 普通活动 n | xRef 处中位（8 天） | 末段趋势 / 年 | log 小时系数 | σ |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const [region, reg] of Object.entries(section.regions)) {
        for (const t of reg.base.filter((x) => [1, 10, 100, 1000, 10000, 100000].includes(x.rank))) {
            lines.push(`| ${region} | T${t.rank} | ${t.n} | ${Math.round(Math.exp(t.a)).toLocaleString("en-US")} | ${pct(Math.exp(t.b) - 1)} | ${num(t.c, 2)} | ${num(t.sigma, 3)} |`);
        }
    }
    lines.push("");
    if (section.cnRatio) {
        lines.push("| 国服/日服比例 档位 | n | xRef 处比例 | 趋势 / 年（log） | σ |");
        lines.push("|---|---|---|---|---|");
        for (const t of section.cnRatio.base.filter((x) => [50, 100, 1000, 10000, 100000].includes(x.rank))) {
            lines.push(`| T${t.rank} | ${t.n} | ${num(Math.exp(t.rho), 3)} | ${num(t.eta, 3)} | ${num(t.sigma, 3)} |`);
        }
        lines.push("");
    }
    lines.push(...renderBorrowedSection({ section, generatedAt, data, levels, prior }));
    return lines.join("\n");
}

function levelClass(level, region) {
    if (!level) return null;
    if (level.kind !== "group") return level.kind;
    if (level.source !== region) return "group-other-region";
    return level.nEvents < 3 ? "group-sparse" : "group";
}

const LEVEL_CLASS_LABELS = {
    cell: "自身单元格有数据",
    "group-sparse": "单元格无数据，组偏移只来自 1–2 期（新一期终章即此类）",
    group: "单元格无数据，组偏移来自 3 期以上",
    "group-other-region": "单元格无数据，组偏移借日服同组",
    anchor: "日服同 id 终榜 × 国服/日服比例",
    normal: "普通活动",
};

function calibration(rows) {
    let se = 0;
    let sz = 0;
    let sig = 0;
    let cov = 0;
    for (const r of rows) {
        const e = Math.log(r.actual / r.p50);
        const s = Math.log(r.p90 / r.p50) / Z90;
        se += Math.abs(e);
        sz += (e / s) ** 2;
        sig += s;
        cov += r.actual >= r.p10 && r.actual <= r.p90 ? 1 : 0;
    }
    const n = rows.length;
    return { n, events: new Set(rows.map((r) => `${r.region}-${r.eventId}`)).size, male: se / n, sigma: sig / n, zRms: Math.sqrt(sz / n), coverage: cov / n };
}

function calibrationRow(label, c) {
    return `| ${label} | ${c.events} | ${c.n} | ${num(c.male)} | ${num(c.sigma)} | ${num(c.zRms, 2)} | ${pct(c.coverage, 0)} |`;
}

/** 第 6 节：借用父级水平的上线范围，以及回测里各水平来源的校准。 */
function renderBorrowedSection({ section, generatedAt, data, levels, prior }) {
    const lines = ["## 6. 借用父级水平的先验", ""];
    const k = Object.values(section.regions).find((r) => r.cellK != null)?.cellK ?? null;
    lines.push(`单元格没有数据的范围只用组偏移：水平 = 普通活动基线 + 组偏移，方差 = σ_组² + se² + σ_组²/k（k = ${k ?? "—"}）。终章按（区服，活动 id）单列，`);
    lines.push("所以新一期终章的水平整份取自已结算的终章（终章组只有一期时就是那一期相对普通活动基线的偏移，se = σ_组，σ 放宽约 √(2 + 1/k) 倍）。");
    lines.push("这是跨期借用：终章之间无法直接回测，6.2 用回测里的同类情形（新一期、单元格无数据、组偏移只来自 1–2 期）检验这条路径的校准。", "");
    if (data) {
        const nowMs = Date.parse(generatedAt);
        const borrowed = borrowedLevels(section, data, Number.isFinite(nowMs) ? nowMs : Date.now());
        lines.push(`### 6.1 结算晚于 ${generatedAt} 的非普通活动范围中，先验水平不来自自身单元格的`, "");
        if (borrowed.length === 0) {
            lines.push("没有。", "");
        } else {
            lines.push(`| 范围 | 单元格 | 水平来源 | ${LEVEL_RANKS.map((r) => `T${r} 中位（σ，σ/σ_组）`).join(" | ")} |`);
            lines.push(`|---|---|---|${LEVEL_RANKS.map(() => "---").join("|")}|`);
            for (const b of borrowed) {
                const src = b.kind === "anchor"
                    ? LEVEL_CLASS_LABELS.anchor
                    : `组 ${b.group}（${b.source === b.region ? "" : "日服，"}${b.nEvents} 期：#${b.sourceEvents.join("、#")}）`;
                const cells = b.tiers.map((t) => (t.median == null
                    ? "—"
                    : `${Math.round(t.median).toLocaleString("en-US")}（${num(t.logSigma)}${t.groupSigma ? `，×${num(t.logSigma / t.groupSigma, 2)}` : ""}）`));
                lines.push(`| ${b.region} #${b.eventId} ${b.scope} | ${md(b.cell ?? "—")} | ${src} | ${cells.join(" | ")} |`);
            }
            lines.push("");
        }
    }
    if (levels && prior) {
        const classOf = (r) => levelClass(levels.get(scopeRowKey(r.region, r.eventId, r.scope)), r.region);
        const byClass = groupBy(prior.filter((r) => classOf(r) != null), classOf);
        lines.push("### 6.2 回测校准（默认配置，按拟合时的水平来源；z = log(终榜/中位)/σ，校准良好时 z RMS ≈ 1、覆盖率 ≈ 80%）", "");
        lines.push("| 水平来源 | 活动数 | 点数 | MALE | 平均 σ | z RMS | 覆盖率 |");
        lines.push("|---|---|---|---|---|---|---|");
        for (const key of Object.keys(LEVEL_CLASS_LABELS)) {
            if (byClass.has(key)) lines.push(calibrationRow(LEVEL_CLASS_LABELS[key], calibration(byClass.get(key))));
        }
        lines.push("");
        const sparse = byClass.get("group-sparse") ?? [];
        if (sparse.length > 0) {
            lines.push("组偏移只来自 1–2 期的点，按活动与单元格：", "");
            lines.push("| 活动 · 单元格 | 活动数 | 点数 | MALE | 平均 σ | z RMS | 覆盖率 |");
            lines.push("|---|---|---|---|---|---|---|");
            for (const [key, rs] of [...groupBy(sparse, (r) => `${r.region} #${r.eventId} · ${r.cell}`)].sort((a, b) => a[0].localeCompare(b[0]))) {
                lines.push(calibrationRow(md(key), calibration(rs)));
            }
            lines.push("");
        }
    }
    return lines;
}

// ---------------------------------------------------------------------------
// CLI

export function parseArgs(argv) {
    const args = { data: DEFAULT_DATA_DIR, out: DEFAULT_FIT_DIR, evaluate: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v == null) throw new Error(`${a} 缺少取值`);
            return v;
        };
        if (a === "--data") args.data = value();
        else if (a === "--out") args.out = value();
        else if (a === "--evaluate") args.evaluate = true;
        else throw new Error(`未知参数：${a}`);
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const data = loadDataset(args.data, { log: () => {} });
    const section = fitPrior(data);
    fs.mkdirSync(args.out, { recursive: true });
    const file = path.join(args.out, "prior.json");
    fs.writeFileSync(file, `${JSON.stringify(section)}\n`);
    console.log(`prior.json：${file}（${(fs.statSync(file).size / 1024).toFixed(1)} KB）`);
    if (args.evaluate) {
        const generatedAt = new Date().toISOString();
        const { rows, levels } = await evaluatePrior({ data });
        const md = renderPriorReport({ rows, section, generatedAt, events: data.events, data, levels });
        fs.writeFileSync(path.join(args.out, "prior-backtest.md"), `${md}\n`);
        const metrics = {};
        for (const [name, r] of rows) metrics[name] = { all: summarizeRows(r), byCell: Object.fromEntries([...groupBy(r, (x) => x.cell)].map(([k, v]) => [k, summarizeRows(v)])) };
        fs.writeFileSync(path.join(args.out, "prior-backtest.json"), `${JSON.stringify({ generatedAt, metrics }, null, 1)}\n`);
        console.log(`回测报告：${path.join(args.out, "prior-backtest.md")}`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
