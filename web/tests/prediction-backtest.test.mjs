/**
 * 回测框架（scripts/prediction-backtest）单元测试，全部基于小型合成数据集。
 * 运行：node --test --experimental-strip-types tests/prediction-backtest.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { contextFromDataset, scopeGroup } from "../src/lib/prediction/model/dataset-context.ts";
import { DEFAULT_DATA_DIR, actualFinals, cellOf, indexDataset, loadDataset, scoreAt } from "../scripts/prediction-backtest/dataset.mjs";
import { DEFAULT_CUTS, cutTime, observedAt, rollingBacktest } from "../scripts/prediction-backtest/harness.mjs";
import { aggregate, median, pairRows, summarize, tierBand } from "../scripts/prediction-backtest/metrics.mjs";
import { cellLabel, renderReport } from "../scripts/prediction-backtest/report.mjs";
import { DEFAULT_FIT_DIR, SHIPPED_PRIORS_PATH, parseArgs, priorsPathFor, runAll } from "../scripts/prediction-backtest/run-all.mjs";
import { currentEngineBaseline, linearBaseline, previousEventBaseline } from "../scripts/prediction-backtest/baselines/index.mjs";

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2025, 0, 1, 3, 0, 0);
const RANKS = [10, 100, 1000];
const BASE_FINAL = { 10: 30_000_000, 100: 10_000_000, 1000: 3_000_000 };

// 合成进度曲线：单调，0 → 1。
const share = (p) => 1.3 * p - 0.3 * p * p;

function makeEvent({ region = "jp", eventId, start, hours, eventType = "marathon", isFinale = false, wlTurn = null, chapters = [], breakTimeId = null, autoSpecialMeasure = false }) {
    let group = "normal";
    if (isFinale) group = "wl_finale";
    else if (eventType === "world_bloom") group = "wl_overall";
    return {
        region, eventId, name: `E${eventId}`, eventType,
        startAt: start, aggregateAt: start + hours * H, days: hours / 24,
        group, wlTurn, isFinale, chapters,
        unit: null, bannerCharacterId: null, breakTimeId, autoSpecialMeasure, bonusRatio: null,
    };
}

function wlChapters(start, characters, hours) {
    return characters.map((gameCharacterId, i) => ({
        chapterNo: i + 1,
        gameCharacterId,
        startAt: start + i * hours * H,
        aggregateAt: start + (i + 1) * hours * H,
    }));
}

function makeSeries(ev, scope, rank, final, { startAt, endAt }, { gap = null } = {}) {
    const points = [];
    for (let t = startAt + H; t <= endAt; t += H) {
        if (gap && t > gap[0] && t < gap[1]) continue;
        points.push([t, Math.round(final * share((t - startAt) / (endAt - startAt)))]);
    }
    return { region: ev.region, eventId: ev.eventId, scope, rank, points, source: "synthetic" };
}

function scopeWindowOf(ev, scope) {
    if (scope.kind === "chapter") {
        const c = ev.chapters.find((x) => x.gameCharacterId === scope.gameCharacterId);
        return { startAt: c.startAt, endAt: c.aggregateAt };
    }
    return { startAt: ev.startAt, endAt: ev.aggregateAt };
}

/** 事件、序列、终榜；T1000 不写终榜表，靠序列末点兜底。 */
function buildDataset() {
    const wlStart = T0 + 10 * D;
    const events = [
        makeEvent({ eventId: 1, start: T0, hours: 72 }),
        makeEvent({ eventId: 2, start: T0 + 4 * D, hours: 72 }),
        // #3 在 #2 结算前开始：#2 不得进入 #3 的训练集。
        makeEvent({ eventId: 3, start: T0 + 6.5 * D, hours: 72 }),
        makeEvent({ eventId: 4, start: wlStart, hours: 96, eventType: "world_bloom", wlTurn: 3, breakTimeId: 2, chapters: wlChapters(wlStart, [1, 2], 48) }),
        makeEvent({ eventId: 5, start: T0 + 16 * D, hours: 72, eventType: "world_bloom", isFinale: true, wlTurn: 3, breakTimeId: 2, chapters: [{ chapterNo: 1, gameCharacterId: null, startAt: T0 + 16 * D, aggregateAt: T0 + 19 * D }] }),
        makeEvent({ region: "cn", eventId: 1, start: T0 + 30 * D, hours: 72 }),
    ];
    const series = [];
    const finals = [];
    const scale = { "jp-1": 1, "jp-2": 1.1, "jp-3": 1.2, "jp-4": 2, "jp-5": 1.5, "cn-1": 0.5 };
    for (const ev of events) {
        const scopes = [{ kind: "overall" }];
        if (ev.eventType === "world_bloom" && !ev.isFinale) for (const c of ev.chapters) scopes.push({ kind: "chapter", gameCharacterId: c.gameCharacterId });
        for (const scope of scopes) {
            for (const rank of RANKS) {
                const final = Math.round(BASE_FINAL[rank] * scale[`${ev.region}-${ev.eventId}`]);
                series.push(makeSeries(ev, scope, rank, final, scopeWindowOf(ev, scope)));
                if (rank !== 1000) finals.push({ region: ev.region, eventId: ev.eventId, scope, rank, score: final, source: "synthetic" });
            }
        }
    }
    return { events, series, finals };
}

test("rolling origin: every fit set ends before the test event starts", () => {
    const data = buildDataset();
    const fitCalls = [];
    const folds = [];
    const rows = rollingBacktest({
        data,
        fit(train) {
            fitCalls.push(train);
            return { trainKeys: new Set(train.events.map((e) => `${e.region}-${e.eventId}`)) };
        },
        predict(sections, ctx, atMs, observed, info) {
            for (const e of info.train.events) assert.ok(e.aggregateAt < info.event.startAt, "future event in the fit set");
            assert.ok(!sections.trainKeys.has(`${ctx.region}-${ctx.eventId}`), "test event in its own fit set");
            for (const o of observed) for (const [t] of o.points) assert.ok(t <= atMs, "observation after the cut");
            return new Map(observed.map((o) => [o.rank, { p10: o.score, p50: o.score * 2, p90: o.score * 3 }]));
        },
        onFold: (f) => folds.push(f),
    });
    assert.ok(rows.length > 0);

    for (const { event, train } of folds) {
        const keys = new Set(train.events.map((e) => `${e.region}-${e.eventId}`));
        for (const e of train.events) assert.ok(e.aggregateAt < event.startAt);
        for (const s of train.series) assert.ok(keys.has(`${s.region}-${s.eventId}`), "series of a non-train event");
        for (const f of train.finals) assert.ok(keys.has(`${f.region}-${f.eventId}`), "final of a non-train event");
    }
    const trainOf = (region, id) => folds.find((f) => f.event.region === region && f.event.eventId === id).train;
    assert.deepEqual(trainOf("jp", 1).events, []);
    assert.deepEqual(trainOf("jp", 2).events.map((e) => e.eventId), [1]);
    // #2 overlaps #3, so #3 trains on #1 only and reuses #2's fit.
    assert.equal(trainOf("jp", 3), trainOf("jp", 2));
    assert.deepEqual(trainOf("jp", 5).events.map((e) => e.eventId), [1, 2, 3, 4]);
    assert.deepEqual(trainOf("cn", 1).events.map((e) => `${e.region}-${e.eventId}`), ["jp-1", "jp-2", "jp-3", "jp-4", "jp-5"]);
    assert.equal(fitCalls.length, 5);
    for (const r of rows) {
        const f = folds.find((x) => x.event.region === r.region && x.event.eventId === r.eventId);
        assert.equal(r.trainSize, f.train.events.length);
    }
});

test("cut placement: progress cuts, hours-before-end cuts, skipped cuts", () => {
    const start = T0;
    const end = T0 + 72 * H;
    const at = Object.fromEntries(DEFAULT_CUTS.map((c) => [c.id, cutTime(c, start, end)]));
    assert.equal(at.p10, start + 7.2 * H);
    assert.equal(at.p25, start + 18 * H);
    assert.equal(at.p50, start + 36 * H);
    assert.equal(at.p75, start + 54 * H);
    assert.equal(at.p90, start + 64.8 * H);
    assert.equal(at.h24, end - 24 * H);
    assert.equal(at.h12, end - 12 * H);
    assert.equal(at.h6, end - 6 * H);
    const h24 = DEFAULT_CUTS.find((c) => c.id === "h24");
    assert.equal(cutTime(h24, start, start + 20 * H), null);
    assert.equal(cutTime(h24, start, start + 24 * H), null);

    const data = buildDataset();
    const rows = rollingBacktest({ data, ...linearBaseline, model: "linear" });
    const jp1 = rows.filter((r) => r.region === "jp" && r.eventId === 1 && r.rank === 100);
    assert.deepEqual(jp1.map((r) => r.cut), DEFAULT_CUTS.map((c) => c.id));
    for (const r of jp1) {
        assert.equal(r.atMs, at[r.cut]);
        // hourly points: observation = last whole hour at or before the cut.
        const obsT = start + Math.floor((r.atMs - start) / H) * H;
        assert.equal(r.observedAt, obsT);
        assert.equal(r.currentScore, Math.round(BASE_FINAL[100] * share((obsT - start) / (end - start))));
    }
    // 48 h chapter: the 24 h cut sits at 50 % progress, both are kept.
    const ch = rows.filter((r) => r.eventId === 4 && r.scope === "ch1" && r.rank === 10);
    assert.deepEqual(ch.map((r) => r.cut), DEFAULT_CUTS.map((c) => c.id));
    assert.equal(ch.find((r) => r.cut === "h24").atMs, ch.find((r) => r.cut === "p50").atMs);
});

test("observations older than the staleness limit are dropped", () => {
    const ev = makeEvent({ eventId: 9, start: T0, hours: 72 });
    const scope = { kind: "overall" };
    const win = { startAt: T0, endAt: T0 + 72 * H };
    const fresh = makeSeries(ev, scope, 10, 1000, win);
    const gappy = makeSeries(ev, scope, 100, 500, win, { gap: [T0 + 30 * H, T0 + 40 * H] });
    const obs = observedAt(new Map([[10, fresh], [100, gappy]]), T0 + 36 * H);
    assert.deepEqual(obs.map((o) => o.rank), [10]);
    assert.equal(obs[0].at, T0 + 36 * H);
    assert.equal(obs[0].points.at(-1)[0], T0 + 36 * H);
    const late = observedAt(new Map([[100, gappy]]), T0 + 32 * H);
    assert.deepEqual(late.map((o) => [o.rank, o.at]), [[100, T0 + 30 * H]]);
});

test("finals come from the finals table, else from a series ending at aggregation", () => {
    const data = buildDataset();
    const index = indexDataset(data);
    const ev = data.events.find((e) => e.eventId === 2);
    const finals = actualFinals(index, ev, { kind: "overall" });
    assert.deepEqual(finals.get(100), { score: 11_000_000, source: "final" });
    assert.deepEqual(finals.get(1000), { score: 3_300_000, source: "series" });

    const truncated = { ...data, series: data.series.map((s) => (s.eventId === 2 && s.region === "jp" ? { ...s, points: s.points.slice(0, -2) } : s)) };
    const f2 = actualFinals(indexDataset(truncated), ev, { kind: "overall" });
    assert.equal(f2.has(1000), false);
});

test("metric arithmetic", () => {
    const base = { region: "jp", eventId: 1, scope: "overall", cut: "p50", model: "m" };
    const rows = [
        { ...base, rank: 10, actual: 100, p10: 90, p50: 110, p90: 120 },
        { ...base, rank: 20, actual: 100, p10: 95, p50: 90, p90: 99 },
        { ...base, rank: 30, actual: 100, p10: 80, p50: 100, p90: 100 },
        { ...base, eventId: 2, rank: 10, actual: 200, p10: 260, p50: 260, p90: 280 },
    ];
    const s = summarize(rows);
    assert.equal(s.n, 4);
    assert.equal(s.events, 2);
    assert.ok(Math.abs(s.mape - (0.1 + 0.1 + 0 + 0.3) / 4) < 1e-12);
    assert.ok(Math.abs(s.medianApe - 0.1) < 1e-12);
    assert.ok(Math.abs(s.bias - (0.1 - 0.1 + 0 + 0.3) / 4) < 1e-12);
    assert.equal(s.intervalN, 4);
    assert.equal(s.coverage, 0.5);
    assert.equal(s.aboveP90, 0.25);
    assert.equal(s.belowP10, 0.25);
    assert.ok(Math.abs(s.widthPct - (0.3 + 0.04 + 0.2 + 0.1) / 4) < 1e-12);

    const point = summarize([{ ...base, rank: 10, actual: 100, p10: null, p50: 105, p90: null }]);
    assert.equal(point.coverage, null);
    assert.equal(point.widthPct, null);
    assert.equal(point.intervalN, 0);

    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(median([]), null);

    assert.deepEqual([1, 10, 11, 100, 101, 1000, 1500, 10000, 20000, 300000].map(tierBand),
        ["T1-10", "T1-10", "T20-100", "T20-100", "T200-1000", "T200-1000", "T2000-10000", "T2000-10000", "T20000+", "T20000+"]);

    const agg = aggregate(rows.map((r) => ({ ...r, band: tierBand(r.rank) })), ["eventId", "band"]);
    assert.deepEqual(agg.map((a) => [a.eventId, a.band, a.n]), [[1, "T1-10", 1], [1, "T20-100", 2], [2, "T1-10", 1]]);

    const other = rows.slice(0, 2).map((r) => ({ ...r, model: "x", p50: r.actual }));
    const { a, b } = pairRows([...rows, ...other], "m", "x");
    assert.equal(a.length, 2);
    assert.deepEqual(a.map((r) => r.rank), b.map((r) => r.rank));
});

test("contextFromDataset: groups, scope windows, JP same-id finals", () => {
    const data = buildDataset();
    const wl = data.events.find((e) => e.eventId === 4);
    const ch2 = contextFromDataset(wl, { kind: "chapter", gameCharacterId: 2 }, wl.startAt + 60 * H, [{ rank: 100, score: 5 }, { rank: 10, score: 9 }], null);
    assert.equal(ch2.group, "wl_chapter_48h");
    assert.equal(ch2.chapterNo, 2);
    assert.equal(ch2.chapterCharacterId, 2);
    assert.equal(ch2.scopeStartAt, wl.startAt + 48 * H);
    assert.equal(ch2.scopeEndAt, wl.startAt + 96 * H);
    // 章节 context 也带整期活动的结算时刻（R13-1：据此判断是否为最后一章）；第 2 章即最后一章。
    assert.equal(ch2.eventEndAt, wl.aggregateAt);
    assert.equal(ch2.scopeEndAt, ch2.eventEndAt);
    const ch1 = contextFromDataset(wl, { kind: "chapter", gameCharacterId: 1 }, wl.startAt, [], null);
    assert.deepEqual([ch1.scopeEndAt, ch1.eventEndAt], [wl.startAt + 48 * H, wl.aggregateAt]);
    assert.equal(ch2.breakGauge, true);
    assert.equal(ch2.wlTurn, 3);
    assert.deepEqual(ch2.otherTiers, [{ rank: 10, score: 9 }, { rank: 100, score: 5 }]);

    const overall = contextFromDataset(wl, { kind: "overall" }, wl.startAt, [], null);
    assert.equal(overall.group, "wl_overall");
    assert.equal(overall.chapterNo, null);
    assert.equal(overall.scopeEndAt, wl.aggregateAt);
    assert.equal(overall.eventEndAt, wl.aggregateAt);

    const long = makeEvent({ eventId: 7, start: T0, hours: 288, eventType: "world_bloom", wlTurn: 1, chapters: wlChapters(T0, [17, 18, 19, 20], 72) });
    assert.equal(scopeGroup(long, { kind: "chapter", gameCharacterId: 19 }), "wl_chapter_72h");

    const finale = data.events.find((e) => e.eventId === 5);
    const fc = contextFromDataset(finale, { kind: "overall" }, finale.startAt, [], { 10: 1 });
    assert.equal(fc.group, "wl_finale");
    assert.equal(fc.chapterNo, null);
    assert.equal(fc.jpSameIdFinal, null);

    const cn = data.events.find((e) => e.region === "cn");
    assert.deepEqual(contextFromDataset(cn, { kind: "overall" }, cn.startAt, [], { 10: 30_000_000 }).jpSameIdFinal, { 10: 30_000_000 });
    assert.equal(contextFromDataset(cn, { kind: "overall" }, cn.startAt, [], null).group, "normal");

    let seen = null;
    rollingBacktest({
        data,
        fit: () => null,
        predict(_s, ctx) {
            if (ctx.region === "cn") seen = ctx.jpSameIdFinal;
            return null;
        },
    });
    assert.deepEqual(seen, { 10: 30_000_000, 100: 10_000_000, 1000: 3_000_000 });
});

test("cells keep editions apart", () => {
    const data = buildDataset();
    const byId = (id) => data.events.find((e) => e.region === "jp" && e.eventId === id);
    assert.equal(cellOf(byId(1), { kind: "overall" }).key, "jp|normal|-|bt0");
    assert.equal(cellOf(byId(4), { kind: "chapter", gameCharacterId: 1 }).key, "jp|wl_chapter_48h|3|");
    assert.equal(cellOf(byId(4), { kind: "overall" }).key, "jp|wl_overall|3|");
    assert.equal(cellOf(byId(5), { kind: "overall" }).key, "jp|wl_finale|3|#5");
    const vs = makeEvent({ region: "cn", eventId: 140, start: T0, hours: 288, eventType: "world_bloom", wlTurn: 1, chapters: wlChapters(T0, [24, 22, 25, 23, 26, 21], 48) });
    const unit = makeEvent({ region: "cn", eventId: 124, start: T0, hours: 192, eventType: "world_bloom", wlTurn: 1, chapters: wlChapters(T0, [16, 15, 14, 13], 48) });
    assert.equal(cellOf(vs, { kind: "chapter", gameCharacterId: 21 }).key, "cn|wl_chapter_48h|1|vs");
    assert.equal(cellOf(unit, { kind: "chapter", gameCharacterId: 16 }).key, "cn|wl_chapter_48h|1|");
    const bt1 = makeEvent({ eventId: 197, start: T0, hours: 72, breakTimeId: 1 });
    assert.equal(cellOf(bt1, { kind: "overall" }).key, "jp|normal|-|bt1");
    assert.equal(cellLabel("jp|wl_finale|3|#218"), "日服 · WL3 终章 #218");
    assert.equal(cellLabel("cn|wl_chapter_48h|1|vs"), "国服 · WL1 章节 48h · VS 期");
    assert.equal(cellLabel("jp|normal|-|bt2"), "日服 · 普通活动 · 疲劳槽参数套 2");
});

test("baselines: linear, previous same-group event, frozen current engine", () => {
    const ctx = { region: "jp", group: "normal", scopeStartAt: T0, scopeEndAt: T0 + 100 * H, chapterCharacterId: null };
    const lin = linearBaseline.predict(null, ctx, T0 + 25 * H, [{ rank: 10, score: 500, at: T0 + 25 * H, points: [] }]);
    assert.deepEqual(lin.get(10), { p10: 2000, p50: 2000, p90: 2000 });

    assert.equal(scoreAt([[T0 + 2 * H, 200], [T0 + 4 * H, 400]], T0 + 3 * H, T0, 3 * H), 300);
    assert.equal(scoreAt([[T0 + 2 * H, 200]], T0 + H, T0, 3 * H), 100);
    assert.equal(scoreAt([[T0 + 2 * H, 200]], T0 + 6 * H, T0, 3 * H), null);

    const data = buildDataset();
    const rows = rollingBacktest({ data, ...previousEventBaseline, model: "prev-same-group" });
    // jp #1 has no earlier normal event; jp #2 and #3 use #1, cn #1 has no CN predecessor, WL / finale have none.
    assert.deepEqual([...new Set(rows.map((r) => `${r.region}-${r.eventId}`))], ["jp-2", "jp-3"]);
    for (const r of rows) {
        const s = share((r.observedAt - T0 - (r.eventId === 2 ? 4 * D : 6.5 * D)) / (72 * H));
        const prevFinal = BASE_FINAL[r.rank];
        const prevAt = Math.round(prevFinal * s);
        assert.ok(Math.abs(r.p50 - r.currentScore / (prevAt / prevFinal)) / r.p50 < 1e-3);
        assert.equal(r.p10, null);
        assert.ok(Math.abs(r.p50 - r.actual) / r.actual < 0.01, "same curve shape: near-exact");
    }

    const tori = rollingBacktest({ data, ...currentEngineBaseline, model: "tori-v2" });
    assert.ok(tori.length > 0);
    for (const r of tori) {
        assert.ok(r.p10 <= r.p50 && r.p50 <= r.p90);
        assert.ok(r.p50 >= r.currentScore);
    }
    assert.ok(tori.some((r) => r.group === "wl_chapter_48h") && tori.some((r) => r.group === "wl_finale"));
});

test("report rendering: before/after table, sample sizes, small-group flag", () => {
    const rows = [];
    const add = (model, cell, group, eventId, p50) => rows.push({
        model, region: "jp", eventId, group, wlTurn: null, cell, scope: "overall", rank: 100, band: "T20-100",
        cut: "p50", actual: 100, actualSource: "final", p10: model === "linear" ? null : p50 - 10, p50, p90: model === "linear" ? null : p50 + 10,
    });
    for (let id = 1; id <= 6; id++) {
        add("tori-v2", "jp|normal|-|bt0", "normal", id, 120);
        add("model", "jp|normal|-|bt0", "normal", id, 105);
        add("linear", "jp|normal|-|bt0", "normal", id, 130);
    }
    add("tori-v2", "jp|wl_finale|3|#218", "wl_finale", 218, 101);
    add("model", "jp|wl_finale|3|#218", "wl_finale", 218, 110);
    const md = renderReport(rows, { generatedAt: "2026-09-27T00:00:00Z", notes: ["跳过 fit-prior.mjs：文件不存在"], dataSummary: { events: { jp: 7, cn: 0 }, series: 3, finals: 3, missingSeries: 1 } });
    assert.match(md, /^# 活动预测回测报告/);
    assert.match(md, /## 1\. 改前 \/ 改后/);
    assert.match(md, /\| 日服 · 普通活动 · 无疲劳槽 \| 6 \| 6 \| 20\.0% \| 5\.0% \| −15\.0 \|/);
    assert.match(md, /日服 · WL3 终章 #218 \| 1 \| 1 \| 1\.0% \| 10\.0% \| \+9\.0 \|.*【样本少：1 期，统计力有限】新模型更差：该组保留旧算法/);
    assert.match(md, /新模型不差于现引擎/);
    assert.match(md, /跳过 fit-prior\.mjs：文件不存在/);
    assert.match(md, /活动 日服 7 期 \/ 国服 0 期/);
    assert.match(md, /\| 日服 · 普通活动 · 无疲劳槽 \| 线性外推 \| 6 \| 6 \| 30\.0% \| 30\.0% \| \+30\.0% \| — \| — \|/);
    assert.match(md, /## 3\. 按截点/);
    assert.match(md, /进度 50%/);
    assert.match(md, /## 4\. 按档位段/);
    assert.match(md, /<details>/);

    const noNew = renderReport(rows.filter((r) => r.model !== "model"));
    assert.match(noNew, /新模型没有回测结果（见运行记录），本节从略。/);
});

test("loadDataset reads committed JSON and tolerates missing series", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prediction-backtest-"));
    try {
        const data = buildDataset();
        const committed = path.join(root, "committed");
        const dataDir = path.join(root, "data");
        fs.mkdirSync(path.join(committed, "cn"), { recursive: true });
        fs.mkdirSync(path.join(dataDir, "series"), { recursive: true });
        fs.writeFileSync(path.join(committed, "events.json"), JSON.stringify([...data.events].reverse()));
        fs.writeFileSync(path.join(committed, "finals-jp.json"), JSON.stringify(data.finals.filter((f) => f.region === "jp")));
        fs.writeFileSync(path.join(committed, "cn", "finals.json"), JSON.stringify(data.finals.filter((f) => f.region === "cn")));
        const jp1 = data.series.filter((s) => s.region === "jp" && s.eventId === 1);
        fs.writeFileSync(path.join(dataDir, "series", "jp-1.json"), JSON.stringify(jp1));

        const loaded = loadDataset(dataDir, { committedDir: committed, log: () => {} });
        assert.equal(loaded.events.length, data.events.length);
        assert.deepEqual(loaded.events.map((e) => e.startAt), [...data.events].map((e) => e.startAt).sort((a, b) => a - b));
        assert.equal(loaded.series.length, jp1.length);
        assert.equal(loaded.finals.length, data.finals.length);
        assert.deepEqual(loaded.missingSeries, ["jp-2", "jp-3", "jp-4", "jp-5", "cn-1"]);

        fs.writeFileSync(path.join(dataDir, "series", "jp-2.json"), JSON.stringify(jp1));
        assert.throws(() => loadDataset(dataDir, { committedDir: committed, log: () => {} }), /其他活动的序列/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("runAll skips missing fit scripts, runs the baselines and writes the report", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prediction-backtest-"));
    try {
        const scriptsDir = path.join(root, "no-fit-scripts");
        fs.mkdirSync(scriptsDir);
        const out = path.join(root, "out");
        const reportPath = path.join(root, "report.md");
        const logs = [];
        const { rows, notes, failed } = await runAll({
            dataset: buildDataset(),
            out,
            reportPath,
            scriptsDir,
            predictModule: path.join(root, "predict.ts"),
            log: (m) => logs.push(m),
        });
        assert.equal(failed, false);
        for (const s of ["fit-prior.mjs", "fit-curve.mjs", "fit-tiers.mjs", "fit-fuse.mjs"]) {
            assert.ok(notes.some((n) => n.startsWith(`跳过 ${s}：文件不存在`)), s);
        }
        assert.ok(notes.some((n) => n.startsWith("新模型缺少 fit-prior.mjs、fit-curve.mjs、fit-tiers.mjs、fit-fuse.mjs、predict.ts")));
        assert.ok(notes.includes("跳过新模型回测，只跑三条基线"));
        assert.deepEqual([...new Set(rows.map((r) => r.model))].sort(), ["linear", "prev-same-group", "tori-v2"]);
        const md = fs.readFileSync(reportPath, "utf8");
        assert.match(md, /新模型没有回测结果/);
        assert.equal(fs.readFileSync(path.join(out, "rows.jsonl"), "utf8").trim().split("\n").length, rows.length);
        const metrics = JSON.parse(fs.readFileSync(path.join(out, "metrics.json"), "utf8"));
        assert.ok(metrics.full.length > 0 && metrics.byCell.length > 0);

        const only = await runAll({ dataset: buildDataset(), out, reportPath, scriptsDir, predictModule: path.join(root, "predict.ts"), only: "wl_finale", runFits: false, log: () => {} });
        assert.ok(only.rows.length > 0);
        assert.ok(only.rows.every((r) => r.group === "wl_finale"));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

const STUB_PREDICT = `export function predictFromSections(sections: { version: number }, ctx: { scopeStartAt: number; scopeEndAt: number }, atMs: number, observed: { rank: number; score: number; at: number }[]) {
    const out = new Map<number, { p10: number; p50: number; p90: number }>();
    for (const o of observed) out.set(o.rank, { p10: o.score, p50: o.score, p90: o.score });
    return out;
}
`;

/** 桩拟合脚本：导出拟合函数（failFit 时抛错）；作为 CLI 运行时写 <out>/<section>.json，failCli 时以退出码 3 结束。 */
function writeStubFitScripts(scriptsDir, { failCli = null, failFit = null } = {}) {
    for (const [section, fn] of [["prior", "fitPrior"], ["curve", "fitCurve"], ["tiers", "fitTiers"], ["fuse", "fitFuse"]]) {
        fs.writeFileSync(path.join(scriptsDir, `fit-${section}.mjs`), `export function ${fn}() {
    ${section === failFit ? `throw new Error("stub ${section} failed");` : `return { section: "${section}" };`}
}
if (process.argv[1] && process.argv[1].endsWith("fit-${section}.mjs")) {
    ${section === failCli ? "process.exit(3);" : ""}
    const fs = await import("node:fs");
    const a = process.argv;
    const out = a[a.indexOf("--out") + 1];
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(out + "/${section}.json", "{}");
    if (a.includes("--priors")) fs.writeFileSync(a[a.indexOf("--priors") + 1], "{}");
}
`);
    }
}

test("runAll stops at a failed fit CLI: later fits (and priors.json) are not written, the report stays as it was", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prediction-backtest-"));
    try {
        const scriptsDir = path.join(root, "scripts");
        const fitOut = path.join(root, "fit");
        const out = path.join(root, "out");
        fs.mkdirSync(scriptsDir);
        writeStubFitScripts(scriptsDir, { failCli: "curve" });
        const predictModule = path.join(root, "predict.ts");
        fs.writeFileSync(predictModule, STUB_PREDICT);
        const reportPath = path.join(root, "report.md");
        fs.writeFileSync(reportPath, "committed report\n");
        const { rows, notes, failed } = await runAll({ dataDir: path.join(root, "data-dir"), dataset: buildDataset(), out, reportPath, fitOut, scriptsDir, predictModule, log: () => {} });
        assert.equal(failed, true);
        assert.deepEqual(rows, []);
        assert.ok(notes.includes("fit-curve.mjs 退出码 3，全量拟合失败；未运行 fit-tiers.mjs、fit-fuse.mjs"), notes.join("\n"));
        assert.deepEqual(fs.readdirSync(fitOut), ["prior.json"]);
        assert.equal(fs.readFileSync(reportPath, "utf8"), "committed report\n");
        assert.equal(fs.existsSync(out), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("runAll: a fit that fails inside the backtest writes report.failed.md and leaves the report as it was", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prediction-backtest-"));
    try {
        const scriptsDir = path.join(root, "scripts");
        const out = path.join(root, "out");
        fs.mkdirSync(scriptsDir);
        writeStubFitScripts(scriptsDir, { failFit: "tiers" });
        const predictModule = path.join(root, "predict.ts");
        fs.writeFileSync(predictModule, STUB_PREDICT);
        const reportPath = path.join(root, "report.md");
        fs.writeFileSync(reportPath, "committed report\n");
        const { rows, notes, failed } = await runAll({ dataset: buildDataset(), out, reportPath, scriptsDir, predictModule, runFits: false, log: () => {} });
        assert.equal(failed, true);
        assert.ok(notes.some((n) => n.startsWith("model 回测失败：stub tiers failed")), notes.join("\n"));
        assert.ok(rows.length > 0 && rows.every((r) => r.model !== "model"));
        assert.equal(fs.readFileSync(reportPath, "utf8"), "committed report\n");
        assert.match(fs.readFileSync(path.join(out, "report.failed.md"), "utf8"), /model 回测失败/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("run-all writes the shipped priors.json only from the default full run", () => {
    assert.equal(priorsPathFor({}), SHIPPED_PRIORS_PATH);
    assert.equal(priorsPathFor({ dataDir: DEFAULT_DATA_DIR }), SHIPPED_PRIORS_PATH);
    assert.equal(priorsPathFor({ dataDir: "/x/data", fitOut: "/x/fit" }), path.join("/x/fit", "priors.json"));
    assert.equal(priorsPathFor({ fitOut: "/x/fit" }), path.join("/x/fit", "priors.json"));
    assert.equal(priorsPathFor({ dataDir: "/x/data" }), path.join(DEFAULT_FIT_DIR, "priors.json"));
    assert.equal(priorsPathFor({ dataDir: "/x/data", fitOut: "/x/fit", priors: "/y/p.json" }), "/y/p.json");
    assert.equal(priorsPathFor({ priors: SHIPPED_PRIORS_PATH, fitOut: "/x/fit" }), SHIPPED_PRIORS_PATH);
    assert.equal(parseArgs(["--priors", "/y/p.json"]).priors, "/y/p.json");
    assert.equal(parseArgs([]).priors, null);
    assert.equal(SHIPPED_PRIORS_PATH, path.resolve(import.meta.dirname, "../src/lib/prediction/priors.json"));
});

test("runAll wires the fit scripts and predictFromSections into the new-model backtest", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prediction-backtest-"));
    try {
        const scriptsDir = path.join(root, "scripts");
        const fitOut = path.join(root, "fit");
        fs.mkdirSync(scriptsDir);
        const cli = (section) => `
if (process.argv[1] && process.argv[1].endsWith("fit-${section}.mjs")) {
    const fs = await import("node:fs");
    const a = process.argv;
    fs.mkdirSync(a[a.indexOf("--out") + 1], { recursive: true });
    fs.writeFileSync(a[a.indexOf("--out") + 1] + "/${section}.json", JSON.stringify({ data: a[a.indexOf("--data") + 1] }));
    fs.writeFileSync(a[a.indexOf("--out") + 1] + "/${section}.argv.json", JSON.stringify(a.slice(2)));
}`;
        for (const [section, fn] of [["prior", "fitPrior"], ["curve", "fitCurve"], ["tiers", "fitTiers"]]) {
            fs.writeFileSync(path.join(scriptsDir, `fit-${section}.mjs`), `export function ${fn}(train) { return { section: "${section}", n: train.events.length }; }\n${cli(section)}`);
        }
        fs.writeFileSync(path.join(scriptsDir, "fit-fuse.mjs"), `export function fitFuse(train, s) {
    if (s.prior.section !== "prior" || s.curve.section !== "curve" || s.tiers.section !== "tiers") throw new Error("bad sections");
    return { section: "fuse", n: train.events.length };
}\n${cli("fuse")}`);
        const predictModule = path.join(root, "predict.ts");
        fs.writeFileSync(predictModule, `export function predictFromSections(sections: { version: number; prior: { n: number }; fuse: { n: number }; dataThrough: Record<string, number> }, ctx: { scopeStartAt: number; scopeEndAt: number }, atMs: number, observed: { rank: number; score: number; at: number }[]) {
    if (sections.version !== 1 || sections.prior.n !== sections.fuse.n) throw new Error("bad sections");
    const out = new Map<number, { p10: number; p50: number; p90: number }>();
    for (const o of observed) {
        const p = (o.at - ctx.scopeStartAt) / (ctx.scopeEndAt - ctx.scopeStartAt);
        const p50 = o.score / (1.3 * p - 0.3 * p * p);
        out.set(o.rank, { p10: p50 * 0.95, p50, p90: p50 * 1.05 });
    }
    return out;
}
`);
        const reportPath = path.join(root, "report.md");
        const { rows, notes, failed } = await runAll({
            dataDir: path.join(root, "data-dir"),
            dataset: buildDataset(),
            out: path.join(root, "out"),
            reportPath,
            fitOut,
            scriptsDir,
            predictModule,
            log: () => {},
        });
        assert.equal(failed, false, notes.join("\n"));
        for (const s of ["prior", "curve", "tiers", "fuse"]) {
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fitOut, `${s}.json`), "utf8")), { data: path.join(root, "data-dir") });
            const argv = JSON.parse(fs.readFileSync(path.join(fitOut, `${s}.argv.json`), "utf8"));
            // fit-curve rejects unknown flags, so only fit-fuse may receive --priors.
            if (s === "fuse") assert.equal(argv[argv.indexOf("--priors") + 1], path.join(fitOut, "priors.json"));
            else assert.equal(argv.includes("--priors"), false, s);
        }
        const model = rows.filter((r) => r.model === "model");
        assert.ok(model.length > 0);
        assert.ok(model.every((r) => Math.abs(r.p50 - r.actual) / r.actual < 0.01));
        const md = fs.readFileSync(reportPath, "utf8");
        assert.match(md, /\| 日服 · 普通活动 · 无疲劳槽 \| 3 \| \d+ \| [\d.]+% \| [\d.]+% \|/);
        assert.equal(/新模型没有回测结果/.test(md), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
