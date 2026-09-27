/**
 * 进度曲线（src/lib/prediction/model/curve.ts）与拟合脚本（scripts/prediction-backtest/fit-curve.mjs）的单元测试。
 * 合成数据按已知速率生成；最后一组在本机有 sessions 数据时用真实数据做冒烟检查。
 * 运行：node --test --experimental-strip-types tests/prediction-curve.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
    buildHourGrid,
    chapterPosition,
    chapterPositionKey,
    chapterPositionLookupChain,
    curveCellKey,
    curveLookupChain,
    expectedShare,
    projectPath,
    shareLogSigma,
} from "../src/lib/prediction/model/curve.ts";
import { contextFromDataset } from "../src/lib/prediction/model/dataset-context.ts";
import { CURVE_FIT_DEFAULTS, fitCurve } from "../scripts/prediction-backtest/fit-curve.mjs";
import { DEFAULT_DATA_DIR, loadDataset } from "../scripts/prediction-backtest/dataset.mjs";

const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 6, 6, 0, 0); // JST 15:00

function ctxOf(over = {}) {
    return {
        region: "jp", eventId: 1, group: "normal", wlTurn: null, chapterCharacterId: null, chapterNo: null,
        autoSpecialMeasure: false, scopeStartAt: T0, scopeEndAt: T0 + 150 * H, eventEndAt: null, breakGauge: false,
        unit: null, bannerCharacterId: null, jpSameIdFinal: null, otherTiers: [], ...over,
    };
}

// 已知速率：开活冲量 + 结束冲刺（强度随档位不同）+ 当地钟点节律。
function trueRate(t, startAt, endAt, sprint) {
    const hs = (t - startAt) / H;
    const he = (endAt - t) / H;
    const localHour = ((t / H + 9) % 24 + 24) % 24;
    const rhythm = 1 + 0.6 * Math.sin((2 * Math.PI * (localHour - 16)) / 24);
    return (1 + 3 * Math.exp(-hs / 3) + sprint * Math.exp(-he / 8)) * rhythm;
}

function trueShareFn(startAt, endAt, sprint) {
    const step = 60_000;
    const n = Math.round((endAt - startAt) / step);
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + trueRate(startAt + (i + 0.5) * step, startAt, endAt, sprint);
    return (t) => cum[Math.max(0, Math.min(n, Math.round((t - startAt) / step)))] / cum[n];
}

const SPRINT = { 100: 1, 1000: 6 };

function makeEvent(eventId, startAt, hours, over = {}) {
    return {
        region: "jp", eventId, name: `E${eventId}`, eventType: "marathon", startAt, aggregateAt: startAt + hours * H,
        days: hours / 24, group: "normal", wlTurn: null, isFinale: false, chapters: [], unit: null,
        bannerCharacterId: null, breakTimeId: null, autoSpecialMeasure: false, bonusRatio: null, ...over,
    };
}

function syntheticDataset({ events = 8, ongoing = false } = {}) {
    const evs = [];
    const series = [];
    const finals = [];
    for (let i = 0; i < events; i++) {
        const hours = [150, 174, 198][i % 3];
        const ev = makeEvent(100 + i, T0 + i * 14 * 24 * H, hours);
        evs.push(ev);
        for (const rank of [100, 1000]) {
            const share = trueShareFn(ev.startAt, ev.aggregateAt, SPRINT[rank]);
            const final = rank === 100 ? 20_000_000 : 5_000_000;
            const points = [];
            // ongoing：活动进行到 60%，既无终榜行也无结算后的点。
            const lastAt = ongoing ? ev.startAt + 0.6 * hours * H : ev.aggregateAt;
            for (let t = ev.startAt + 20 * 60_000; t <= lastAt; t += 30 * 60_000) points.push([t, Math.round(final * share(t))]);
            if (!ongoing) points.push([ev.aggregateAt + 15 * 60_000, final]);
            series.push({ region: "jp", eventId: ev.eventId, scope: { kind: "overall" }, rank, points, source: "test" });
            if (!ongoing) finals.push({ region: "jp", eventId: ev.eventId, scope: { kind: "overall" }, rank, score: final, source: "test" });
        }
    }
    return { events: evs, series, finals };
}

// WL 章节：每期 3 章 × 48 小时；与活动同时结束的最后一章在 T5000 另有一段总榜冲刺，T100 没有。
const LAST_SPRINT = { 100: 0, 5000: 10 };

function lastChapterRate(t, startAt, endAt, rank, last) {
    const he = (endAt - t) / H;
    return trueRate(t, startAt, endAt, 1) + (last ? LAST_SPRINT[rank] * Math.exp(-he / 10) : 0);
}

function chapterShareFn(startAt, endAt, rank, last) {
    const step = 60_000;
    const n = Math.round((endAt - startAt) / step);
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + lastChapterRate(startAt + (i + 0.5) * step, startAt, endAt, rank, last);
    return (t) => cum[Math.max(0, Math.min(n, Math.round((t - startAt) / step)))] / cum[n];
}

/** lastPointBeforeEndMin：最后一章的序列在结束前这么多分钟停止（旧数据缺最后一小时的点）。 */
function wlChapterDataset({ events = 6, lastPointBeforeEndMin = null } = {}) {
    const evs = [];
    const series = [];
    const finals = [];
    for (let i = 0; i < events; i++) {
        const startAt = T0 + i * 21 * 24 * H;
        const chapters = [0, 1, 2].map((c) => ({ chapterNo: c + 1, gameCharacterId: c + 1, startAt: startAt + c * 48 * H, aggregateAt: startAt + (c + 1) * 48 * H }));
        const ev = makeEvent(300 + i, startAt, 144, { eventType: "world_bloom", group: "wl_overall", wlTurn: 3, chapters });
        evs.push(ev);
        for (const ch of chapters) {
            const scope = { kind: "chapter", gameCharacterId: ch.gameCharacterId };
            const last = ch.aggregateAt === ev.aggregateAt;
            for (const rank of [100, 5000]) {
                const share = chapterShareFn(ch.startAt, ch.aggregateAt, rank, last);
                const final = rank === 100 ? 8_000_000 : 1_000_000;
                const stopAt = last && lastPointBeforeEndMin != null ? ch.aggregateAt - lastPointBeforeEndMin * 60_000 : ch.aggregateAt;
                const points = [];
                for (let t = ch.startAt + 20 * 60_000; t <= stopAt; t += 30 * 60_000) points.push([t, Math.round(final * share(t))]);
                if (lastPointBeforeEndMin == null || !last) points.push([ch.aggregateAt + 15 * 60_000, final]);
                series.push({ region: "jp", eventId: ev.eventId, scope, rank, points, source: "test" });
                finals.push({ region: "jp", eventId: ev.eventId, scope, rank, score: final, source: "test" });
            }
        }
    }
    return { events: evs, series, finals };
}

/** 回测 context（带活动结束时间）；withEventEnd = false 时去掉结束时间，模拟位置未知（如线上回退 context 的章节）。 */
function wlChapterCtx(ev, chapterNo, withEventEnd) {
    const ch = ev.chapters[chapterNo - 1];
    const ctx = contextFromDataset(ev, { kind: "chapter", gameCharacterId: ch.gameCharacterId }, ch.startAt, [], null);
    assert.equal(ctx.eventEndAt, ev.aggregateAt);
    return withEventEnd ? ctx : { ...ctx, eventEndAt: null };
}

// 不带活动结束时间的拟合 context 构造函数（位置未知）。
const contextWithoutEventEnd = (ev, scope) => ({ ...contextFromDataset(ev, scope, ev.aggregateAt, [], null), eventEndAt: null });

test("curveCellKey: groups, break gauge, VS chapters and finales stay apart", () => {
    assert.equal(curveCellKey(ctxOf()), "jp|normal|-|nogauge");
    assert.equal(curveCellKey(ctxOf({ breakGauge: true })), "jp|normal|-|gauge");
    assert.equal(curveCellKey(ctxOf({ group: "wl_chapter_48h", wlTurn: 1, chapterCharacterId: 21 })), "jp|wl_chapter_48h|1|vs");
    assert.equal(curveCellKey(ctxOf({ region: "cn", group: "wl_chapter_48h", wlTurn: 1, chapterCharacterId: 14 })), "cn|wl_chapter_48h|1|unit");
    assert.equal(curveCellKey(ctxOf({ group: "wl_overall", wlTurn: 3 })), "jp|wl_overall|3");
    assert.equal(curveCellKey(ctxOf({ group: "wl_finale", wlTurn: 2, eventId: 180 })), "jp|wl_finale|2|#180");
    assert.equal(curveCellKey(ctxOf({ group: "wl_finale", wlTurn: 3, eventId: 218, breakGauge: true })), "jp|wl_finale|3|#218");
    assert.equal(curveCellKey(ctxOf({ region: "cn", group: "wl_finale", wlTurn: 2, eventId: 180 })), "cn|wl_finale|2|#180");
});

test("curveLookupChain: finales never share; CN borrows JP and cross-turn pooling only when enabled", () => {
    const on = { cnFromJp: true, crossTurn: true };
    const off = { cnFromJp: false, crossTurn: false };
    assert.deepEqual(curveLookupChain("cn|wl_finale|2|#180", on), ["cn|wl_finale|2|#180"]);
    assert.deepEqual(curveLookupChain("jp|wl_finale|3|#218", on), ["jp|wl_finale|3|#218"]);
    assert.deepEqual(curveLookupChain("cn|normal|-|gauge", on), ["cn|normal|-|gauge", "cn|normal|-", "jp|normal|-|gauge", "jp|normal|-"]);
    assert.deepEqual(curveLookupChain("cn|normal|-|gauge", off), ["cn|normal|-|gauge", "cn|normal|-"]);
    assert.deepEqual(curveLookupChain("jp|wl_chapter_48h|2|vs", on), ["jp|wl_chapter_48h|2|vs", "jp|wl_chapter_48h|2", "jp|wl_chapter_48h|*|vs", "jp|wl_chapter_48h|*"]);
    assert.deepEqual(curveLookupChain("jp|wl_overall|3", off), ["jp|wl_overall|3"]);
});

test("chapterPosition: known only for chapter scopes with an event end; keys and lookup keep editions apart", () => {
    const chapter = ctxOf({ group: "wl_chapter_48h", wlTurn: 3, chapterCharacterId: 14, scopeEndAt: T0 + 48 * H });
    assert.equal(chapterPosition(chapter), null);
    assert.equal(chapterPositionKey(chapter), null);
    assert.equal(chapterPosition({ ...chapter, eventEndAt: T0 + 48 * H }), "last");
    assert.equal(chapterPosition({ ...chapter, eventEndAt: T0 + 96 * H }), "other");
    assert.equal(chapterPosition({ ...chapter, eventEndAt: null }), null);
    assert.equal(chapterPositionKey({ ...chapter, eventEndAt: T0 + 48 * H }), "jp|wl_chapter_48h|3|last");
    assert.equal(chapterPositionKey({ ...chapter, wlTurn: null, region: "cn", eventEndAt: T0 + 48 * H }), "cn|wl_chapter_48h|-|last");
    assert.equal(chapterPosition(ctxOf({ group: "wl_overall", wlTurn: 3, eventEndAt: T0 + 150 * H })), null);
    assert.equal(chapterPosition(ctxOf({ eventEndAt: T0 + 150 * H })), null);
    const on = { cnFromJp: true, crossTurn: true };
    assert.deepEqual(chapterPositionLookupChain("cn|wl_chapter_72h|2|last", on),
        ["cn|wl_chapter_72h|2|last", "jp|wl_chapter_72h|2|last", "cn|wl_chapter_72h|*|last", "jp|wl_chapter_72h|*|last"]);
    assert.deepEqual(chapterPositionLookupChain("jp|wl_chapter_48h|3|last", { cnFromJp: false, crossTurn: false }), ["jp|wl_chapter_48h|3|last"]);
});

test("fitCurve: the chapter that ends with the event gets its own end sprint; without the event end nothing changes", () => {
    const data = wlChapterDataset();
    const section = fitCurve(data, { halfLifeYears: Infinity });
    assert.deepEqual(Object.keys(section.chapterPosition), ["jp|wl_chapter_48h|*|last", "jp|wl_chapter_48h|3|last"]);
    assert.equal(section.chapterPosition["jp|wl_chapter_48h|3|last"].shrunkToward, "jp|wl_chapter_48h|*|last");
    assert.equal(section.fit.positionScopes, 18);
    const plain = fitCurve(data, { halfLifeYears: Infinity, chapterPositions: [] });
    assert.deepEqual(plain.chapterPosition, {});
    assert.deepEqual(plain.cells, section.cells);

    const ev = data.events.at(-1);
    const maxErr = (ctx, rank, s) => {
        const truth = chapterShareFn(ctx.scopeStartAt, ctx.scopeEndAt, rank, ctx.scopeEndAt === ev.aggregateAt);
        let worst = 0;
        for (const h of [2, 12, 24, 36, 42, 46, 47.5]) {
            const t = ctx.scopeStartAt + h * H;
            worst = Math.max(worst, Math.abs(expectedShare(ctx, t, s, rank) - truth(t)));
        }
        return worst;
    };
    const last = wlChapterCtx(ev, 3, true);
    const lastUnknown = wlChapterCtx(ev, 3, false);
    // End bins are coarse far from the end (24-48 h is one bin), so the recovered sprint is not exact there.
    assert.ok(maxErr(last, 5000, section) < 0.03, `last chapter T5000 with event end: ${maxErr(last, 5000, section)}`);
    assert.ok(maxErr(lastUnknown, 5000, section) > 0.15, `last chapter T5000 without event end: ${maxErr(lastUnknown, 5000, section)}`);
    assert.ok(maxErr(last, 100, section) < 0.015, `last chapter T100: ${maxErr(last, 100, section)}`);
    for (const rank of [100, 5000]) {
        // Unknown position, or a chapter that is not last: the chapter cell alone, as before.
        for (const t of [6, 30, 45].map((h) => last.scopeStartAt + h * H)) {
            assert.equal(expectedShare(lastUnknown, t, section, rank), expectedShare(lastUnknown, t, plain, rank));
        }
        const other = wlChapterCtx(ev, 2, true);
        const t = other.scopeStartAt + 30 * H;
        assert.equal(expectedShare(other, t, section, rank), expectedShare(wlChapterCtx(ev, 2, false), t, section, rank));
    }
    let prev = 0;
    for (let t = last.scopeStartAt + 7 * 60_000; t < last.scopeEndAt; t += 13 * 60_000) {
        const x = expectedShare(last, t, section, 5000);
        assert.ok(x > prev && x < 1);
        prev = x;
    }
    assert.equal(expectedShare(last, last.scopeEndAt, section, 5000), 1);
    const path1 = projectPath(last, last.scopeStartAt + 30 * H, 400_000, 1_000_000, H, section, 5000);
    assert.equal(path1.at(-1).y, 1_000_000);
});

test("fitCurve: the position table follows the prediction context; without the event end none is fitted or shipped", () => {
    const data = wlChapterDataset();
    // The backtest builder (field for field the live one) carries the event end, so the default fit has the table (R13-1).
    const byBuilder = fitCurve(data, { halfLifeYears: Infinity });
    const unknown = fitCurve(data, { halfLifeYears: Infinity, contextOf: contextWithoutEventEnd });
    assert.deepEqual(byBuilder.cells, unknown.cells);
    assert.ok(Object.keys(byBuilder.chapterPosition).length > 0);
    assert.equal(byBuilder.fit.positionScopes, 18);
    // R9-4: contexts without eventEndAt never reach the table, so it must not be fitted or shipped.
    assert.deepEqual(unknown.chapterPosition, {});
    assert.equal(unknown.fit.positionScopes, 0);
    const ev = data.events.at(-1);
    const ctx = wlChapterCtx(ev, 3, false);
    for (const h of [6, 30, 45, 47.5]) {
        const t = ctx.scopeStartAt + h * H;
        assert.equal(expectedShare(ctx, t, byBuilder, 5000), expectedShare(ctx, t, unknown, 5000));
    }
});

test("fitCurve: anchors below positionMinRank carry no position term", () => {
    const data = wlChapterDataset();
    const section = fitCurve(data, { halfLifeYears: Infinity });
    assert.equal(CURVE_FIT_DEFAULTS.positionMinRank, 2000);
    const cell = section.chapterPosition["jp|wl_chapter_48h|*|last"];
    section.anchors.forEach((anchor, a) => {
        if (anchor < 2000) assert.deepEqual(cell.end[a], new Array(section.endEdgesHours.length).fill(0), `anchor ${anchor}`);
    });
    assert.ok(cell.end[section.anchors.indexOf(5000)].some((x) => x !== 0));
    const ev = data.events.at(-1);
    const last = wlChapterCtx(ev, 3, true);
    const unknown = wlChapterCtx(ev, 3, false);
    // Above every data rank: T5000 gets no term and the share equals the position-free one.
    const high = fitCurve(data, { halfLifeYears: Infinity, positionMinRank: 10000 });
    for (const h of [6, 30, 45]) {
        const t = last.scopeStartAt + h * H;
        assert.equal(expectedShare(last, t, high, 5000), expectedShare(unknown, t, high, 5000));
        assert.equal(expectedShare(last, t, section, 100), expectedShare(unknown, t, section, 100));
    }
    // No anchor at or above the minimum: nothing is shipped.
    assert.deepEqual(fitCurve(data, { halfLifeYears: Infinity, positionMinRank: 1e9 }).chapterPosition, {});
});

test("fitCurve: an end bin the last chapters never observe takes the nearest observed bin, not 0", () => {
    const section = fitCurve(wlChapterDataset({ lastPointBeforeEndMin: 3 }), { halfLifeYears: Infinity });
    const end = section.chapterPosition["jp|wl_chapter_48h|*|last"].end[section.anchors.indexOf(5000)];
    assert.ok(end[1] > 0.2, `sprint bin: ${end[1]}`);
    assert.equal(end[0], end[1]);
});

test("expectedShare: exactly 0 at the scope start, 1 at the end, monotone in between (fitted and fallback)", () => {
    const section = fitCurve(syntheticDataset());
    for (const s of [section, { ...section, cells: {} }]) {
        for (const rank of [1, 100, 500, 1000, 100000]) {
            const ctx = ctxOf({ scopeStartAt: T0 + 0.5 * H, scopeEndAt: T0 + 160.25 * H });
            assert.equal(expectedShare(ctx, ctx.scopeStartAt, s, rank), 0);
            assert.equal(expectedShare(ctx, ctx.scopeStartAt - H, s, rank), 0);
            assert.equal(expectedShare(ctx, ctx.scopeEndAt, s, rank), 1);
            assert.equal(expectedShare(ctx, ctx.scopeEndAt + H, s, rank), 1);
            let prev = 0;
            for (let t = ctx.scopeStartAt + 7 * 60_000; t < ctx.scopeEndAt; t += 13 * 60_000) {
                const x = expectedShare(ctx, t, s, rank);
                assert.ok(x > prev && x < 1, `rank ${rank} at +${(t - ctx.scopeStartAt) / H}h: ${x} after ${prev}`);
                prev = x;
            }
        }
    }
});

test("expectedShare: a cell without data falls back to a share linear in time", () => {
    const section = fitCurve(syntheticDataset());
    const ctx = ctxOf({ group: "wl_finale", wlTurn: 3, eventId: 218, scopeEndAt: T0 + 72 * H });
    for (const h of [1, 12, 36, 60]) assert.ok(Math.abs(expectedShare(ctx, T0 + h * H, section, 1000) - h / 72) < 1e-12);
});

test("fitCurve: recovers a known share curve per rank (reward-border sprint kept separate)", () => {
    const section = fitCurve(syntheticDataset({ events: 9 }), { halfLifeYears: Infinity });
    const ctx = ctxOf({ scopeEndAt: T0 + 174 * H });
    for (const rank of [100, 1000]) {
        const truth = trueShareFn(ctx.scopeStartAt, ctx.scopeEndAt, SPRINT[rank]);
        for (const h of [1, 6, 24, 60, 100, 150, 168, 173]) {
            const t = ctx.scopeStartAt + h * H;
            const got = expectedShare(ctx, t, section, rank);
            assert.ok(Math.abs(got - truth(t)) < 0.012, `T${rank} +${h}h: fitted ${got.toFixed(4)} vs true ${truth(t).toFixed(4)}`);
        }
    }
    const last24 = (rank) => 1 - expectedShare(ctx, ctx.scopeEndAt - 24 * H, section, rank);
    assert.ok(last24(1000) > last24(100) + 0.05, "T1000 sprint must stay stronger than T100");
});

test("fitCurve: running scopes without a final are skipped, output is deterministic and JSON-safe", () => {
    const noFinals = fitCurve(syntheticDataset({ ongoing: true }));
    assert.deepEqual(noFinals.cells, {});
    const data = syntheticDataset();
    const a = fitCurve(data);
    const b = fitCurve(data);
    assert.deepEqual(a, b);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
    assert.equal(a.fit.scopes, 8);
    // 所有范围都无疲劳槽：变体与合并单元格成员相同，只保留合并单元格，查找结果不变。
    assert.deepEqual(Object.keys(a.cells), ["jp|normal|-"]);
    const viaParent = expectedShare(ctxOf(), T0 + 40 * H, a, 1000);
    assert.ok(viaParent > 0 && viaParent < 1);
});

test("fitCurve: the gauge cell holds only the latest break-time set; older sets feed the pooled cell", () => {
    const data = syntheticDataset({ events: 9 });
    // 前 3 场无疲劳槽，第 4 场休息时间组 1（相当于日服 #197），其后组 2。
    data.events.forEach((ev, i) => { ev.breakTimeId = i < 3 ? null : i === 3 ? 1 : 2; });
    const section = fitCurve(data);
    assert.equal(section.cells["jp|normal|-|gauge"].events, 5);
    assert.equal(section.cells["jp|normal|-|nogauge"].events, 3);
    // 合并单元格（含组 1 那场）只作收缩目标；两个变体都在，查找不会再落到它，输出里删去。
    assert.equal(section.cells["jp|normal|-|gauge"].shrunkToward, "jp|normal|-");
    assert.ok(!("jp|normal|-" in section.cells));
});

test("shareLogSigma: positive before the end, 0 at the end, shrinking late in the scope", () => {
    const section = fitCurve(syntheticDataset());
    const ctx = ctxOf();
    const at = (p) => shareLogSigma(ctx, T0 + p * 150 * H, section, 1000);
    assert.equal(at(1), 0);
    assert.ok(at(0.5) > 0 && Number.isFinite(at(0.5)));
    assert.ok(at(0.99) < at(0.9));
    const empty = fitCurve({ events: [], series: [], finals: [] });
    assert.equal(shareLogSigma(ctx, T0 + 10 * H, empty, 1000), 1);
});

test("projectPath: starts at the current score, ends at the median on the scope end, never decreases", () => {
    const section = fitCurve(syntheticDataset());
    const ctx = ctxOf();
    const from = T0 + 50.5 * H;
    const path1 = projectPath(ctx, from, 1_000_000, 3_000_000, 2 * H, section, 1000);
    assert.equal(path1[0].t, from);
    assert.equal(path1[0].y, 1_000_000);
    assert.equal(path1.at(-1).t, ctx.scopeEndAt);
    assert.equal(path1.at(-1).y, 3_000_000);
    for (let i = 1; i < path1.length; i++) {
        assert.ok(path1[i].y >= path1[i - 1].y);
        assert.ok(path1[i].t > path1[i - 1].t && path1[i].t - path1[i - 1].t <= 2 * H);
    }
    const flat = projectPath(ctx, from, 1_000_000, 900_000, 6 * H, section, 1000);
    assert.ok(flat.every((p) => p.y === 1_000_000));
    assert.deepEqual(projectPath(ctx, ctx.scopeEndAt + H, 5, 9, H, section), [{ t: ctx.scopeEndAt + H, y: 5 }]);
});

test("buildHourGrid: bins follow hours since start, hours to end and local clock", () => {
    const grid = buildHourGrid("cn", T0, T0 + 50 * H, CURVE_FIT_DEFAULTS);
    assert.equal(grid.len.length, 50);
    assert.equal(grid.openBin[0], 0);
    assert.equal(grid.endBin[49], 0);
    assert.equal(grid.localHour[0], 14); // 06:30 UTC = 14:30 CST
    assert.equal(grid.trendBin[49], CURVE_FIT_DEFAULTS.trendBins - 1);
});

const REAL_DATA = fs.existsSync(path.join(DEFAULT_DATA_DIR, "series", "jp-216.json"));

test("real data: cells keep editions apart and every event's curve is a valid share", { skip: !REAL_DATA && "sessions data not present" }, () => {
    const data = loadDataset(DEFAULT_DATA_DIR, { log: () => {} });
    const section = fitCurve(data);
    const jp214 = data.events.find((e) => e.region === "jp" && e.eventId === 214);
    const keys = Object.keys(section.cells);
    assert.ok(keys.includes("jp|normal|-|gauge") && keys.includes("jp|normal|-|nogauge"));
    assert.ok(keys.includes("jp|wl_finale|2|#180"));
    assert.ok(!keys.some((k) => k.startsWith("jp|wl_finale|3")), "no #218 cell before it has a final");
    assert.equal(section.cells["jp|wl_finale|2|#180"].shrunkToward, null);
    // The prediction contexts carry the event end, so the shipped table is fitted and reachable (R13-1, R9-4).
    for (const key of ["jp|wl_chapter_48h|3|last", "jp|wl_chapter_72h|2|last", "jp|wl_chapter_48h|*|last", "jp|wl_chapter_72h|*|last"]) {
        assert.ok(key in section.chapterPosition, key);
    }
    // JP #214 chapter 5 ends with the event: below the title border more of the final comes late (R13-1).
    const lastCh = jp214.chapters.find((c) => c.aggregateAt === jp214.aggregateAt);
    const ctxLast = contextFromDataset(jp214, { kind: "chapter", gameCharacterId: lastCh.gameCharacterId }, jp214.startAt, [], null);
    assert.equal(ctxLast.eventEndAt, jp214.aggregateAt);
    const mid = (ctxLast.scopeStartAt + ctxLast.scopeEndAt) / 2;
    assert.ok(expectedShare(ctxLast, mid, section, 5000) < expectedShare({ ...ctxLast, eventEndAt: null }, mid, section, 5000) - 0.03);
    for (const [region, id] of [["jp", 216], ["jp", 214], ["jp", 218], ["cn", 179], ["cn", 180]]) {
        const ev = data.events.find((e) => e.region === region && e.eventId === id);
        const scopes = [{ kind: "overall" }, ...(ev.isFinale ? [] : ev.chapters.filter((_c, i, a) => i === 0 || i === a.length - 1).map((c) => ({ kind: "chapter", gameCharacterId: c.gameCharacterId })))];
        for (const scope of scopes) {
            const ctx = contextFromDataset(ev, scope, ev.startAt, [], null);
            for (const rank of [1, 100, 1000, 10000]) {
                let prev = 0;
                for (let t = ctx.scopeStartAt; t <= ctx.scopeEndAt; t += H) {
                    const x = expectedShare(ctx, t, section, rank);
                    assert.ok(x >= prev);
                    prev = x;
                }
                assert.equal(expectedShare(ctx, ctx.scopeEndAt, section, rank), 1);
            }
        }
    }
    // JP #218 and CN #180 have no data of their own: linear share, not JP #180's curve.
    const jp218 = data.events.find((e) => e.region === "jp" && e.eventId === 218);
    const ctx218 = contextFromDataset(jp218, { kind: "overall" }, jp218.startAt, [], null);
    const t36 = jp218.startAt + 36 * H;
    const linear = (t36 - ctx218.scopeStartAt) / (ctx218.scopeEndAt - ctx218.scopeStartAt);
    assert.ok(Math.abs(expectedShare(ctx218, t36, section, 1000) - linear) < 1e-12);
});
