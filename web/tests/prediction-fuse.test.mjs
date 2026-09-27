/**
 * 融合与区间（src/lib/prediction/model/fuse.ts、predict.ts）与拟合脚本（scripts/prediction-backtest/fit-fuse.mjs）的单元测试。
 * 合成记录按已知误差尺度生成；最后一组在回测工作目录（PREDICTION_WORKDIR）有真实数据时检查“模拟 = 回测同一路径”与无未来泄漏。
 * 运行：node --test --experimental-strip-types tests/prediction-fuse.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
    DEFAULT_FUSE_KNOT,
    calibrationAt,
    clampQuantiles,
    fuseCellKey,
    fuseEstimates,
    fuseLog,
    fuseLookupChain,
    fusionWeight,
    physicalCeiling,
} from "../src/lib/prediction/model/fuse.ts";
import { predictFromSections } from "../src/lib/prediction/model/predict.ts";
import {
    DEFAULT_FUSE_OPTIONS,
    EVALUATE_CANDIDATES,
    PRIORS_MAX_BYTES,
    addSelectionNote,
    componentRecords,
    decideFallback,
    fitCeiling,
    fitComponents,
    fitFuse,
    fitFuseFromRecords,
    maxHourlyGain,
    pendingBorrowedLevels,
    renderFallbackSection,
    selectionNote,
    simulateRolling,
} from "../scripts/prediction-backtest/fit-fuse.mjs";
import { DEFAULT_DATA_DIR, cellOf, loadDataset, subsetDataset } from "../scripts/prediction-backtest/dataset.mjs";
import { rollingBacktest } from "../scripts/prediction-backtest/harness.mjs";

const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 6, 6, 0, 0);

function ctxOf(over = {}) {
    return {
        region: "jp", eventId: 1, group: "normal", wlTurn: null, chapterCharacterId: null, chapterNo: null,
        autoSpecialMeasure: false, scopeStartAt: T0, scopeEndAt: T0 + 100 * H, breakGauge: false,
        unit: null, bannerCharacterId: null, jpSameIdFinal: null, otherTiers: [], ...over,
    };
}

function sectionOf(over = {}) {
    return {
        version: 1, knots: [0.1, 0.5, 0.9], cells: {}, biasCorrection: false, gaugeSet: {}, vsEditions: [],
        ceilingMargin: 1, ceiling: {}, fallback: {}, fit: {}, ...over,
    };
}

function event(eventId, over = {}) {
    return {
        region: "jp", eventId, name: `E${eventId}`, eventType: "marathon", startAt: T0 + eventId * 200 * H,
        aggregateAt: T0 + eventId * 200 * H + 100 * H, days: 100 / 24, group: "normal", wlTurn: null, isFinale: false,
        chapters: [], unit: "idol", bannerCharacterId: null, breakTimeId: null, autoSpecialMeasure: false, bonusRatio: null, ...over,
    };
}

// 可复现的正态随机数（Box–Muller + mulberry32）。
function rng(seed) {
    let a = seed >>> 0;
    const uniform = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return () => Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform());
}

test("fusionWeight: inverse variance without covariance, minimum variance with it, clipped to [0, 1]", () => {
    assert.equal(fusionWeight(4, 1, 0), 0.8);
    assert.equal(fusionWeight(1, 1, 0), 0.5);
    // (Vp - C) / (Vp + Vo - 2C)
    assert.ok(Math.abs(fusionWeight(4, 1, 0.5) - 3.5 / 4) < 1e-12);
    assert.equal(fusionWeight(1, 4, 1.5), 0);
    assert.equal(fusionWeight(1, 1, 1), 1);
});

test("fuseLog: prior only, observed only, both, and the fade-out before the first knot", () => {
    const cal = { ...DEFAULT_FUSE_KNOT, priorScale: 2, observedScale: 1 };
    const prior = { median: 100, logSigma: 0.1 };
    const obs = { median: 200, logSigma: 0.1 };
    assert.deepEqual(fuseLog(null, null, 0.5, cal, 0.1), null);
    const po = fuseLog(prior, null, 0.5, cal, 0.1);
    assert.ok(Math.abs(po.mu - Math.log(100)) < 1e-12 && Math.abs(po.sd - 0.2) < 1e-12 && po.weight === 0);
    const oo = fuseLog(null, obs, 0.5, cal, 0.1);
    assert.ok(Math.abs(oo.mu - Math.log(200)) < 1e-12 && Math.abs(oo.sd - 0.1) < 1e-12);
    const both = fuseLog(prior, obs, 0.5, cal, 0.1);
    assert.ok(Math.abs(both.weight - 0.8) < 1e-12);
    assert.ok(Math.abs(both.mu - (0.8 * Math.log(200) + 0.2 * Math.log(100))) < 1e-12);
    assert.ok(Math.abs(both.sd - Math.sqrt(0.64 * 0.01 + 0.04 * 0.04)) < 1e-12);
    const early = fuseLog(prior, obs, 0.05, cal, 0.1);
    assert.ok(Math.abs(early.weight - 0.4) < 1e-12);
    assert.equal(fuseLog(prior, obs, 0, cal, 0.1).weight, 0);
});

test("fuseEstimates: calibrated quantiles, bias shift, floor at the current score, physical ceiling", () => {
    const s = sectionOf({
        cells: { "*": { n: 10, knots: [0, 1, 2].map(() => ({ priorScale: 1, observedScale: 1, corr: 0, q10: -1, q50: 0.5, q90: 2 })) } },
    });
    const ctx = ctxOf();
    const q = fuseEstimates(ctx, 100, { median: 1000, logSigma: 0.2 }, null, 0.5, 0, s);
    assert.ok(Math.abs(q.p10 - 1000 * Math.exp(-0.2)) < 1e-6);
    assert.ok(Math.abs(q.p50 - 1000) < 1e-9);
    assert.ok(Math.abs(q.p90 - 1000 * Math.exp(0.4)) < 1e-6);
    const biased = fuseEstimates(ctx, 100, { median: 1000, logSigma: 0.2 }, null, 0.5, 0, { ...s, biasCorrection: true });
    assert.ok(Math.abs(biased.p50 - 1000 * Math.exp(0.1)) < 1e-6);
    const floored = fuseEstimates(ctx, 100, { median: 1000, logSigma: 0.2 }, null, 0.5, 1100, s);
    assert.equal(floored.p10, 1100);
    assert.equal(floored.p50, 1100);
    assert.ok(floored.p90 > 1100);
    // 剩余 50 小时 × 每小时 2 → 上限 1100 + 100 = 1200。
    const capped = fuseEstimates(ctx, 100, { median: 1000, logSigma: 0.2 }, null, 0.5, 1100, { ...s, ceiling: { jp: { ranks: [1, 100], perHour: [5, 2] } } });
    assert.equal(capped.p90, 1200);
    assert.ok(capped.p10 <= capped.p50 && capped.p50 <= capped.p90);
    const none = fuseEstimates(ctx, 100, null, null, 0.5, 700, s);
    assert.deepEqual(none, { p10: 700, p50: 700, p90: 700 });
});

test("physicalCeiling: unknown rank or score gives Infinity; ranks between entries use the better rank", () => {
    const s = sectionOf({ ceiling: { jp: { ranks: [10, 100, 1000], perHour: [300, 200, 100] } }, ceilingMargin: 1.5 });
    assert.equal(physicalCeiling({ region: "jp" }, 1, 5000, 10, s), Infinity);
    assert.equal(physicalCeiling({ region: "cn" }, 100, 5000, 10, s), Infinity);
    assert.equal(physicalCeiling({ region: "jp" }, 100, 0, 10, s), Infinity);
    assert.equal(physicalCeiling({ region: "jp" }, 100, 5000, 10, s), 5000 + 200 * 1.5 * 10);
    assert.equal(physicalCeiling({ region: "jp" }, 500, 5000, 10, s), 5000 + 200 * 1.5 * 10);
    assert.equal(physicalCeiling({ region: "jp" }, 50000, 5000, 10, s), 5000 + 100 * 1.5 * 10);
    assert.deepEqual(clampQuantiles({ p10: 1, p50: 5, p90: 9 }, 3, 7), { p10: 3, p50: 5, p90: 7 });
});

test("fitCeiling / maxHourlyGain: one-hour windows only, suffix max over worse ranks, CN also takes JP speeds, running events skipped", () => {
    const pts = [[0, 0], [0.5 * H, 10], [1 * H, 100], [1.5 * H, 130], [5 * H, 1000]];
    // [0,1h] 100, [0.5h,1.5h] 120, [1h,5h] is a 4 h gap and ignored.
    assert.equal(maxHourlyGain(pts), 120);
    const evJp = event(1);
    const evCn = event(2, { region: "cn" });
    // Running: series recorded so far, no finals yet.
    const evRunning = event(3, { region: "cn" });
    const series = [
        { region: "jp", eventId: 1, scope: { kind: "overall" }, rank: 10, points: [[0, 0], [H, 50]] },
        { region: "jp", eventId: 1, scope: { kind: "overall" }, rank: 100, points: [[0, 0], [H, 80]] },
        { region: "cn", eventId: 2, scope: { kind: "overall" }, rank: 10, points: [[0, 0], [H, 20]] },
        { region: "cn", eventId: 3, scope: { kind: "overall" }, rank: 10, points: [[0, 0], [H, 500]] },
        { region: "cn", eventId: 3, scope: { kind: "overall" }, rank: 200, points: [[0, 0], [H, 40]] },
    ];
    const finals = [
        { region: "jp", eventId: 1, scope: { kind: "overall" }, rank: 10, score: 1000, source: "test" },
        { region: "cn", eventId: 2, scope: { kind: "overall" }, rank: 10, score: 500, source: "test" },
    ];
    const c = fitCeiling({ events: [evJp, evCn, evRunning], series, finals });
    assert.deepEqual(c.jp, { ranks: [10, 100], perHour: [80, 80] });
    assert.deepEqual(c.cn, { ranks: [10, 100], perHour: [80, 80] });
    // Once the running event has finals its speeds count.
    const ended = fitCeiling({ events: [evJp, evCn, evRunning], series, finals: [...finals, { ...finals[1], eventId: 3 }] });
    assert.deepEqual(ended.cn, { ranks: [10, 100, 200], perHour: [500, 80, 40] });
});

test("fuseCellKey reproduces the backtest cells (dataset.mjs cellOf) from a context", () => {
    const s = { gaugeSet: { jp: 2 }, vsEditions: ["jp|1", "jp|2"] };
    const cases = [
        [event(10), { kind: "overall" }],
        [event(198, { breakTimeId: 2 }), { kind: "overall" }],
        [event(140, { eventType: "world_bloom", group: "wl_overall", wlTurn: 1, unit: null,
            chapters: [21, 22, 23, 24, 25, 26].map((c, i) => ({ chapterNo: i + 1, gameCharacterId: c, startAt: T0 + i * 48 * H, aggregateAt: T0 + (i + 1) * 48 * H })) }), { kind: "chapter", gameCharacterId: 22 }],
        [event(112, { eventType: "world_bloom", group: "wl_overall", wlTurn: 1, unit: "school_refusal",
            chapters: [18, 20, 19, 17].map((c, i) => ({ chapterNo: i + 1, gameCharacterId: c, startAt: T0 + i * 72 * H, aggregateAt: T0 + (i + 1) * 72 * H })) }), { kind: "overall" }],
        [event(205, { eventType: "world_bloom", group: "wl_overall", wlTurn: 3, unit: null,
            chapters: [5, 22, 4, 10, 23, 13].map((c, i) => ({ chapterNo: i + 1, gameCharacterId: c, startAt: T0 + i * 48 * H, aggregateAt: T0 + (i + 1) * 48 * H })) }), { kind: "chapter", gameCharacterId: 22 }],
        [event(180, { eventType: "world_bloom", group: "wl_finale", wlTurn: 2, isFinale: true, unit: null }), { kind: "overall" }],
    ];
    for (const [ev, scope] of cases) {
        const chapter = scope.kind === "chapter" ? ev.chapters.find((c) => c.gameCharacterId === scope.gameCharacterId) : null;
        const ctx = ctxOf({
            eventId: ev.eventId, group: cellOf(ev, scope).group, wlTurn: ev.wlTurn, unit: ev.unit, breakGauge: ev.breakTimeId != null,
            chapterCharacterId: chapter?.gameCharacterId ?? null, chapterNo: chapter?.chapterNo ?? null,
        });
        assert.equal(fuseCellKey(ctx, s), cellOf(ev, scope).key, `#${ev.eventId}`);
    }
    // A gauge event before any gauge event was fitted has no cell of its own.
    assert.equal(fuseCellKey(ctxOf({ breakGauge: true }), { gaugeSet: {}, vsEditions: [] }), "jp|normal|-|bt?");
});

test("fuseLookupChain: JP pools by group, CN borrows the same JP cell, finales never pool", () => {
    assert.deepEqual(fuseLookupChain("jp|normal|-|bt2"), ["jp|normal|-|bt2", "jp|normal", "*"]);
    assert.deepEqual(fuseLookupChain("cn|wl_overall|2|vs"), ["cn|wl_overall|2|vs", "jp|wl_overall|2|vs", "jp|wl_overall", "*"]);
    assert.deepEqual(fuseLookupChain("jp|wl_finale|3|#218"), ["jp|wl_finale|3|#218", "*"]);
    assert.deepEqual(fuseLookupChain("cn|wl_finale|2|#180"), ["cn|wl_finale|2|#180", "*"]);
    const s = sectionOf({ cells: { "jp|wl_finale|2|#180": { n: 1, knots: [0, 1, 2].map(() => ({ ...DEFAULT_FUSE_KNOT, priorScale: 9 })) } } });
    assert.equal(calibrationAt(ctxOf({ group: "wl_finale", wlTurn: 3, eventId: 218 }), 0.5, s).priorScale, 1);
    assert.equal(calibrationAt(ctxOf({ group: "wl_finale", wlTurn: 2, eventId: 180 }), 0.5, s).priorScale, 9);
});

/** 合成记录：先验误差 ~ N(0, (a σp)^2)，进度估计误差 ~ N(0, (b σo)^2)，相关 rho。 */
function syntheticRecords(ev, n, { a, b, rho, seed, progress = 0.5, cell = cellOf(ev, { kind: "overall" }).key }) {
    const z = rng(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
        const tiers = [];
        for (const rank of [100, 1000]) {
            const actual = 1e6 * (rank === 100 ? 3 : 1);
            const u = z();
            const v = rho * u + Math.sqrt(1 - rho * rho) * z();
            const sp = 0.2;
            const so = 0.1;
            tiers.push({ rank, current: actual * 0.4, prior: [actual * Math.exp(a * sp * u), sp], obs: [actual * Math.exp(b * so * v), so], actual, actualSource: "final" });
        }
        out.push({
            ev, cell, group: "normal", wlTurn: null, scope: "overall", chapterNo: null, cuts: ["p50"],
            ctx: ctxOf({ eventId: ev.eventId, scopeStartAt: ev.startAt, scopeEndAt: ev.aggregateAt }),
            atMs: ev.startAt + progress * (ev.aggregateAt - ev.startAt), progress, tiers,
        });
    }
    return out;
}

test("fitFuseFromRecords recovers the error scales and correlation, and its P10-P90 covers about 80%", () => {
    const ev = event(5);
    const records = syntheticRecords(ev, 1500, { a: 1.5, b: 0.8, rho: 0.4, seed: 7 });
    const s = fitFuseFromRecords(records, { events: [ev], series: [], finals: [] }, { knots: [0.1, 0.5, 0.9] });
    const k = s.cells["jp|normal|-|bt0"].knots[1];
    assert.ok(Math.abs(k.priorScale - 1.5) < 0.08, `priorScale ${k.priorScale}`);
    assert.ok(Math.abs(k.observedScale - 0.8) < 0.05, `observedScale ${k.observedScale}`);
    assert.ok(Math.abs(k.corr - 0.4) < 0.06, `corr ${k.corr}`);
    // Fresh draws from the same process.
    const test = syntheticRecords(ev, 1500, { a: 1.5, b: 0.8, rho: 0.4, seed: 99 });
    let covered = 0;
    let total = 0;
    for (const rec of test) {
        for (const t of rec.tiers) {
            const q = fuseEstimates(rec.ctx, t.rank, { median: t.prior[0], logSigma: t.prior[1] }, { median: t.obs[0], logSigma: t.obs[1] }, rec.progress, 0, s);
            total += 1;
            if (t.actual >= q.p10 && t.actual <= q.p90) covered += 1;
        }
    }
    assert.ok(Math.abs(covered / total - 0.8) < 0.03, `coverage ${covered / total}`);
});

test("fitFuseFromRecords shrinks a small cell toward its pool and keeps finales out of pools", () => {
    const big = event(5);
    const small = event(6, { breakTimeId: 2 });
    const fin = event(180, { eventType: "world_bloom", group: "wl_finale", wlTurn: 2, isFinale: true, unit: null });
    const records = [
        ...syntheticRecords(big, 800, { a: 1, b: 1, rho: 0, seed: 1 }),
        ...syntheticRecords(small, 3, { a: 3, b: 1, rho: 0, seed: 2 }),
        ...syntheticRecords(fin, 40, { a: 3, b: 3, rho: 0, seed: 3, cell: "jp|wl_finale|2|#180" }),
    ];
    const s = fitFuseFromRecords(records, { events: [big, small, fin], series: [], finals: [] }, { knots: [0.5], shrinkK: 5 });
    const pooled = s.cells["jp|normal"].knots[0].priorScale;
    const smallScale = s.cells["jp|normal|-|bt2"].knots[0].priorScale;
    assert.ok(smallScale > pooled && smallScale < 2.2, `small ${smallScale} pooled ${pooled}`);
    assert.equal(s.cells["jp|wl_finale"], undefined);
    assert.ok(s.cells["jp|wl_finale|2|#180"].knots[0].observedScale > 2);
    // The finale's large errors reach normal events only through the root, never through the normal pool.
    assert.ok(Math.abs(s.cells["jp|normal"].knots[0].observedScale - 1) < 0.12);
    assert.deepEqual(s.gaugeSet, { jp: 2 });
});

test("predictFromSections: fallback cells return null unless a legacy path is given; tiers stay monotone and floored", () => {
    const empty = { version: 1, cells: {}, families: {}, progressKnots: [0.5] };
    const curve = {
        version: 1, anchors: [1], rhythmBands: [], openEdgesHours: [], endEdgesHours: [], trendBins: 1, sigmaGrid: [0.5],
        cnFromJp: false, crossTurn: false, cells: {}, uniformSigma: [[0.1]], fit: {},
    };
    const prior = { version: 1, epochMs: 0, hoursRef: 192, maxExtrapolationYears: 1, cnBlend: false, features: {}, regions: {}, cnRatio: null };
    const fuse = sectionOf();
    const sections = { prior, curve, tiers: empty, fuse };
    const ctx = ctxOf();
    const at = T0 + 50 * H;
    // Linear share at 50%: final = 2 x current; T200 above T100 must be pulled down.
    const out = predictFromSections(sections, ctx, at, [{ rank: 100, score: 1000, at }, { rank: 200, score: 1100, at }]);
    assert.ok(out.get(100).p50 >= out.get(200).p50);
    for (const [rank, q] of out) {
        assert.ok(q.p10 <= q.p50 && q.p50 <= q.p90);
        assert.ok(q.p10 >= (rank === 100 ? 1000 : 1100));
    }
    const withFallback = { ...sections, fuse: sectionOf({ fallback: { "jp|normal|-|bt0": { events: 1, points: 1, mape: 0.2, baselineMape: 0.1 } } }) };
    assert.equal(predictFromSections(withFallback, ctx, at, [{ rank: 100, score: 1000, at }]), null);
    const legacy = new Map([[100, { p10: 1, p50: 2, p90: 3 }]]);
    assert.deepEqual(predictFromSections(withFallback, ctx, at, [{ rank: 100, score: 1000, at }], { legacy: () => legacy }), legacy);

    // 上限按当前分的观测时刻算剩余小时：3 小时前的分数多出 3 小时的上限。
    const capped = { ...sections, fuse: sectionOf({ ceiling: { jp: { ranks: [100], perHour: [1] } } }) };
    const fresh = predictFromSections(capped, ctx, at, [{ rank: 100, score: 1000, at }]).get(100);
    const stale = predictFromSections(capped, ctx, at, [{ rank: 100, score: 1000, at: at - 3 * H }]).get(100);
    const left = (ctx.scopeEndAt - at) / H;
    assert.equal(fresh.p90, 1000 + left);
    assert.equal(stale.p90, 1000 + left + 3);
});

test("predictFromSections: a stale lower tier whose ceiling passes a fresher higher tier's stays below it (D4)", () => {
    const empty = { version: 1, cells: {}, families: {}, progressKnots: [0.5] };
    const curve = {
        version: 1, anchors: [1], rhythmBands: [], openEdgesHours: [], endEdgesHours: [], trendBins: 1, sigmaGrid: [0.5],
        cnFromJp: false, crossTurn: false, cells: {}, uniformSigma: [[0.1]], fit: {},
    };
    const prior = { version: 1, epochMs: 0, hoursRef: 192, maxExtrapolationYears: 1, cnBlend: false, features: {}, regions: {}, cnRatio: null };
    const fuse = sectionOf({ ceiling: { jp: { ranks: [50, 100], perHour: [5, 5] } } });
    const ctx = ctxOf();
    const at = T0 + 99 * H;
    // T50 seen now (1 h left), T100 seen 3 h earlier (4 h left): ceilings 1000 + 5 = 1005 and 990 + 20 = 1010, both
    // below the monotone fused quantiles (about 1008-1014), so clamping alone leaves T100 at 1008-1010 above T50.
    const observed = [{ rank: 50, score: 1000, at }, { rank: 100, score: 990, at: at - 3 * H }];
    const sections = { prior, curve, tiers: empty, fuse };
    const unclamped = predictFromSections({ ...sections, fuse: sectionOf() }, ctx, at, observed);
    assert.ok(unclamped.get(100).p10 > 1005 && unclamped.get(100).p90 < 1020);
    const out = predictFromSections(sections, ctx, at, observed);
    assert.deepEqual(out.get(50), { p10: 1005, p50: 1005, p90: 1005 });
    // Held at T50's ceiling, still above T100's own floor.
    assert.deepEqual(out.get(100), { p10: 1005, p50: 1005, p90: 1005 });
});

test("decideFallback marks exactly the cells where the model's paired MAPE is higher", () => {
    const row = (model, cell, rank, p50) => ({ model, region: "jp", eventId: 1, scope: "overall", cell, rank, cut: "p50", actual: 100, p10: p50, p50, p90: p50 });
    const model = [row("model", "a", 1, 110), row("model", "b", 1, 130)];
    const base = [row("tori-v2", "a", 1, 120), row("tori-v2", "b", 1, 120)];
    const { fallback } = decideFallback(model, base);
    assert.deepEqual(Object.keys(fallback), ["b"]);
    assert.ok(Math.abs(fallback.b.mape - 0.3) < 1e-9 && Math.abs(fallback.b.baselineMape - 0.2) < 1e-9);
});

test("selectionNote / addSelectionNote: the method list says the defaults were tuned on the same points, once", () => {
    const row = (inside) => ({ model: "m", region: "jp", eventId: 1, scope: "overall", cell: "a", rank: 1, cut: "p50", actual: 100, p10: inside ? 90 : 101, p50: 100, p90: 110, ceiling: null });
    const results = EVALUATE_CANDIDATES.map((c) => ({ name: c.name, rows: [row(true), row(!c.alternative)] }));
    const note = selectionNote(results);
    assert.ok(note.includes(`k=${DEFAULT_FUSE_OPTIONS.shrinkK}`) && note.includes(DEFAULT_FUSE_OPTIONS.levels.join("/")));
    assert.ok(note.includes("默认覆盖率 100.0%") && note.includes("分位水平 0.1/0.9 50.0%"));
    assert.ok(!selectionNote(null).includes("默认覆盖率"));
    // R13r3-E1: with or without ablation results, the note says the calibration pools ranks within a cell, and why.
    for (const text of [note, selectionNote(null), selectionNote(results.slice(0, 1))]) {
        assert.ok(text.includes("各档合并估计，不分档位段") && text.includes("来自各期之间的差异"), text);
    }
    const md = ["# R", "", "## 方法", "", "- a", "- b", "", "## 数据", "", "- c", ""].join("\n");
    const once = addSelectionNote(md, note);
    assert.deepEqual(once.split("\n").slice(2, 8), ["## 方法", "", "- a", "- b", note, ""]);
    assert.equal(addSelectionNote(once, note), once);
});

test("pendingBorrowedLevels keeps only scopes settling after the region's last settled event", () => {
    const events = [
        event(1), event(2, { group: "wl_overall" }), event(3), event(4, { group: "wl_finale", isFinale: true }),
        event(1, { region: "cn" }), event(2, { region: "cn", group: "wl_finale", isFinale: true }),
    ];
    const finals = [[ "jp", 1 ], [ "jp", 3 ], [ "cn", 1 ]].map(([region, eventId]) => ({ region, eventId, scope: { kind: "overall" }, rank: 1, score: 10 }));
    const rows = [["jp", 2], ["jp", 4], ["cn", 2], ["jp", 99]].map(([region, eventId]) => ({ region, eventId, scope: "overall" }));
    const kept = pendingBorrowedLevels(rows, { events, finals, series: [] }).map((b) => `${b.region}${b.eventId}`);
    // jp 2 ended before jp 3 settled but has no finals: not a live prediction, so not listed.
    assert.deepEqual(kept, ["jp4", "cn2"]);
});

test("renderFallbackSection: finale verdicts stay per finale, and borrowed prior levels are listed with their source", () => {
    const table = [
        { cell: "jp|wl_finale|2|#180", events: 1, points: 10, mape: 0.14, baselineMape: 0.12, fallback: true },
        { cell: "jp|normal|-|bt0", events: 5, points: 50, mape: 0.04, baselineMape: 0.2, fallback: false },
    ];
    const untested = [{ cell: "jp|wl_finale|3|#218", ids: [218], borrowed: "*" }, { cell: "cn|normal|-|bt2", ids: [198, 199], borrowed: "jp|normal|-|bt2" }];
    const tiers = (sigma, group) => [1, 1000].map((rank) => ({ rank, median: 1e6 * (2000 - rank), logSigma: sigma, groupSigma: group }));
    const borrowed = [
        { region: "jp", eventId: 218, scope: "overall", cell: "jp|wl_finale|3|#218", group: "wl_finale", kind: "group", source: "jp", nEvents: 1, sourceEvents: [180], tiers: tiers(0.158, 0.1) },
        { region: "cn", eventId: 180, scope: "overall", cell: "cn|wl_finale|2|#180", group: "wl_finale", kind: "anchor", source: null, nEvents: null, sourceEvents: [], tiers: tiers(0.3, null) },
    ];
    const priorsPath = path.resolve(import.meta.dirname, "../src/lib/prediction/priors.json");
    const md = renderFallbackSection(table, { priorsPath, untested, borrowed });
    assert.ok(md.includes("回退判断不在终章之间共享：JP #180 在上表回退，这一判断不外推到 JP #218。"), md);
    assert.ok(md.includes("| JP #218 overall | `jp\\|wl_finale\\|3\\|#218` | 组偏移 wl_finale（来自 1 期：JP #180） | 1,999,000,000（σ 0.158，组 σ ×1.58） | 1,000,000,000（σ 0.158，组 σ ×1.58） |"), md);
    assert.ok(md.includes("| CN #180 overall | `cn\\|wl_finale\\|2\\|#180` | 日服同 id 终榜 × 国服/日服比例 | 1,999,000,000（σ 0.300） |"), md);
    const plain = renderFallbackSection(table.slice(1), { priorsPath, untested: untested.slice(1) });
    assert.ok(!plain.includes("终章") && !plain.includes("先验水平借自"), plain);
    const pendingOnly = renderFallbackSection(table.slice(1), { priorsPath, untested });
    assert.ok(pendingOnly.includes("没有回测证据的终章 JP #218 直接使用新模型。"), pendingOnly);
});

const PRIORS_FILE = path.resolve(import.meta.dirname, "../src/lib/prediction/priors.json");

test("priors.json: all four sections, small, fuse knots ordered", { skip: !fs.existsSync(PRIORS_FILE) }, () => {
    const bytes = fs.statSync(PRIORS_FILE).size;
    assert.ok(bytes < PRIORS_MAX_BYTES, `${bytes} bytes`);
    const p = JSON.parse(fs.readFileSync(PRIORS_FILE, "utf8"));
    assert.equal(p.version, 1);
    for (const k of ["prior", "curve", "tiers", "fuse"]) assert.ok(p[k] && p[k].version === 1, k);
    for (const [key, cell] of Object.entries(p.fuse.cells)) {
        assert.equal(cell.knots.length, p.fuse.knots.length, key);
        for (const k of cell.knots) assert.ok(k.q10 <= k.q50 && k.q50 <= k.q90 && k.priorScale > 0 && k.observedScale > 0, key);
    }
});

const HAS_DATA = fs.existsSync(path.join(DEFAULT_DATA_DIR, "series", "jp-30.json"));

test("real data: the fit-fuse simulation equals the harness running predictFromSections; no future data in the records", { skip: !HAS_DATA }, () => {
    const full = loadDataset(DEFAULT_DATA_DIR, { log: () => {} });
    const data = subsetDataset(full, full.events.filter((e) => e.region === "jp" && e.eventId <= 22));
    const harnessRows = rollingBacktest({
        data,
        model: "model",
        fit: (train) => {
            const comps = fitComponents(train);
            return { ...comps, fuse: fitFuse(train, comps) };
        },
        predict: (sections, ctx, atMs, observed) => predictFromSections(sections, ctx, atMs, observed),
    });
    const simRows = simulateRolling(data, componentRecords(data));
    const key = (r) => `${r.eventId}/${r.scope}/${r.rank}/${r.cut}`;
    assert.equal(simRows.length, harnessRows.length);
    const byKey = new Map(harnessRows.map((r) => [key(r), r]));
    for (const r of simRows) {
        const h = byKey.get(key(r));
        assert.ok(h, key(r));
        for (const q of ["p10", "p50", "p90"]) assert.ok(Math.abs(r[q] - h[q]) <= 1e-9 * h[q], `${key(r)} ${q}`);
    }
    // Perturbing the last-ended event's finals changes only that event's own records.
    const last = [...data.events].sort((a, b) => b.aggregateAt - a.aggregateAt)[0];
    const clone = (ev) => ({ ...ev });
    const events2 = data.events.map(clone);
    const last2 = events2.find((e) => e.eventId === last.eventId);
    const data2 = {
        events: events2,
        series: data.series.map((s) => (s.eventId === last.eventId ? { ...s, points: s.points.map(([t, y]) => [t, y * 2]) } : s)),
        finals: data.finals.map((f) => (f.eventId === last.eventId ? { ...f, score: f.score * 2 } : f)),
    };
    const a = componentRecords(data);
    const b = componentRecords(data2);
    const strip = (recs, id) => recs.filter((r) => r.ev.eventId !== id).map((r) => JSON.stringify([r.ev.eventId, r.scope, r.atMs, r.tiers]));
    assert.deepEqual(strip(b, last2.eventId), strip(a, last.eventId));
    assert.equal(DEFAULT_FUSE_OPTIONS.mode, "fused");
});
