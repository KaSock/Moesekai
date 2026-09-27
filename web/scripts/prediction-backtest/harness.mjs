// 滚动原点回测：预测某期时，只用结算时间早于该期开始时间的活动拟合（fit），再在各截点用该期序列里截点前的观测做预测（predict）。
import { contextFromDataset, scopeWindow } from "../../src/lib/prediction/model/dataset-context.ts";
import {
    actualFinals,
    cellOf,
    eventKey,
    indexDataset,
    lastIndexAtOrBefore,
    scopeKey,
    scopesOf,
    subsetDataset,
} from "./dataset.mjs";
import { tierBand } from "./metrics.mjs";

const HOUR_MS = 3_600_000;

export const DEFAULT_CUTS = [
    { id: "p10", kind: "progress", value: 0.1 },
    { id: "p25", kind: "progress", value: 0.25 },
    { id: "p50", kind: "progress", value: 0.5 },
    { id: "p75", kind: "progress", value: 0.75 },
    { id: "p90", kind: "progress", value: 0.9 },
    { id: "h24", kind: "hoursBeforeEnd", value: 24 },
    { id: "h12", kind: "hoursBeforeEnd", value: 12 },
    { id: "h6", kind: "hoursBeforeEnd", value: 6 },
];

// 截点前最后一个观测点早于截点超过该值时，视为该档在截点无观测。
export const DEFAULT_MAX_STALE_MS = 3 * HOUR_MS;

/** 截点时刻；结束前 N 小时的截点落在范围开始之前（或恰为开始）时返回 null。 */
export function cutTime(cut, startAt, endAt) {
    if (cut.kind === "progress") return Math.round(startAt + cut.value * (endAt - startAt));
    if (cut.kind === "hoursBeforeEnd") {
        const t = endAt - cut.value * HOUR_MS;
        return t > startAt ? t : null;
    }
    throw new Error(`未知截点类型：${cut.kind}`);
}

/**
 * 截点观测：每档取 t ≤ atMs 的最后一个点（不早于 atMs − maxStaleMs）。
 * 返回 [{ rank, score, at, points }]（points 为截至截点的序列），按档位升序。
 */
export function observedAt(seriesByRank, atMs, maxStaleMs = DEFAULT_MAX_STALE_MS) {
    const out = [];
    for (const [rank, s] of seriesByRank) {
        const i = lastIndexAtOrBefore(s.points, atMs);
        if (i < 0) continue;
        const [at, score] = s.points[i];
        if (atMs - at > maxStaleMs) continue;
        out.push({ rank, score, at, points: s.points.slice(0, i + 1) });
    }
    return out.sort((a, b) => a.rank - b.rank);
}

/** 国服活动的日服同 id 终榜（同一范围），只在日服该期早于测试活动开始就已结算时提供。 */
function jpSameIdFinalFor(index, ev, scope) {
    if (ev.region !== "cn") return null;
    const jp = index.events.get(eventKey("jp", ev.eventId));
    if (!jp || jp.aggregateAt >= ev.startAt) return null;
    const finals = actualFinals(index, jp, scope);
    if (finals.size === 0) return null;
    return Object.fromEntries([...finals].map(([rank, f]) => [rank, f.score]));
}

function assertQuantile(q, where) {
    const ok = q && [q.p10, q.p50, q.p90].every(Number.isFinite) && q.p10 <= q.p50 && q.p50 <= q.p90;
    if (!ok) throw new Error(`${where}：预测不是有效的 {p10 ≤ p50 ≤ p90}：${JSON.stringify(q)}`);
}

/**
 * rollingBacktest({ data, fit, predict, cuts?, filter?, model?, interval?, maxStaleMs?, onFold? }) → rows
 * - fit(train) → sections（同步）；train = { events, series, finals }，只含 aggregateAt < 测试活动 startAt 的活动。
 *   训练集相同的测试活动共用一次 fit。
 * - predict(sections, ctx, atMs, observed, info) → Map<rank, QuantileEstimate> | null；
 *   observed 见 observedAt；info = { event, scope, cell, train }。
 * - filter(event, scope, cell) → boolean：限定测试范围（不影响训练集）。
 * - interval = false：点预测模型，行里的 p10 / p90 记为 null，不参与区间指标。
 * 每行 = 一个 (模型, 区服, 活动, 范围, 档位, 截点)，只含有终榜的档位。
 */
export function rollingBacktest({
    data,
    fit,
    predict,
    cuts = DEFAULT_CUTS,
    filter,
    model = "model",
    interval = true,
    maxStaleMs = DEFAULT_MAX_STALE_MS,
    onFold,
}) {
    const index = indexDataset(data);
    const byAggregate = [...data.events].sort((a, b) => a.aggregateAt - b.aggregateAt);
    const tests = [...data.events].sort((a, b) => a.startAt - b.startAt || a.eventId - b.eventId);
    const rows = [];
    let trainLen = -1;
    let train = null;
    let sections = null;

    let len = 0;
    for (const ev of tests) {
        const scopes = scopesOf(ev)
            .map((scope) => ({ scope, cell: cellOf(ev, scope), actuals: actualFinals(index, ev, scope) }))
            .filter(({ scope, cell, actuals }) => actuals.size > 0 && (!filter || filter(ev, scope, cell)));
        if (scopes.length === 0) continue;

        while (len < byAggregate.length && byAggregate[len].aggregateAt < ev.startAt) len += 1;
        if (len !== trainLen) {
            train = subsetDataset(data, byAggregate.slice(0, len));
            sections = fit(train);
            if (sections && typeof sections.then === "function") throw new Error("fit 必须同步返回 sections");
            trainLen = len;
        }
        onFold?.({ event: ev, train });

        for (const { scope, cell, actuals } of scopes) {
            const { startAt, endAt } = scopeWindow(ev, scope);
            const seriesByRank = index.seriesOf(ev.region, ev.eventId, scope);
            const jpFinal = jpSameIdFinalFor(index, ev, scope);
            const chapter = scope.kind === "chapter" ? ev.chapters.find((c) => c.gameCharacterId === scope.gameCharacterId) : null;

            for (const cut of cuts) {
                const atMs = cutTime(cut, startAt, endAt);
                if (atMs == null) continue;
                const observed = observedAt(seriesByRank, atMs, maxStaleMs);
                if (observed.length === 0) continue;
                const ctx = contextFromDataset(ev, scope, atMs, observed.map(({ rank, score }) => ({ rank, score })), jpFinal);
                const estimates = predict(sections, ctx, atMs, observed, { event: ev, scope, cell, train });
                if (!estimates) continue;
                const obsByRank = new Map(observed.map((o) => [o.rank, o]));

                for (const [rank, q] of estimates) {
                    const actual = actuals.get(rank);
                    if (!actual) continue;
                    const where = `${model} ${ev.region} #${ev.eventId} ${scopeKey(scope)} T${rank} ${cut.id}`;
                    assertQuantile(q, where);
                    const obs = obsByRank.get(rank);
                    rows.push({
                        model,
                        region: ev.region,
                        eventId: ev.eventId,
                        group: cell.group,
                        wlTurn: cell.wlTurn,
                        cell: cell.key,
                        scope: scopeKey(scope),
                        chapterNo: chapter ? chapter.chapterNo : null,
                        rank,
                        band: tierBand(rank),
                        cut: cut.id,
                        atMs,
                        progress: (atMs - startAt) / (endAt - startAt),
                        remainingHours: (endAt - atMs) / HOUR_MS,
                        currentScore: obs ? obs.score : null,
                        observedAt: obs ? obs.at : null,
                        actual: actual.score,
                        actualSource: actual.source,
                        p10: interval ? q.p10 : null,
                        p50: q.p50,
                        p90: interval ? q.p90 : null,
                        trainSize: train.events.length,
                    });
                }
            }
        }
    }
    return rows;
}
