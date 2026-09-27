// 基线三：上一期同类活动同进度。取训练集中同一单元格（见 dataset.mjs cellOf）最近结算、且有该档序列与终榜的范围，
// 读它在相同进度时的完成比例 r，终榜 = 当前分 / r。点预测，无区间；没有同类前例时不出预测（不跨单元格借用）。
import { actualFinals, cellOf, indexDataset, scopeKey, scopeRef, scopeWindow, scopesOf, scoreAt } from "../dataset.mjs";

export const PREVIOUS_EVENT_MAX_GAP_MS = 3 * 3_600_000;

/** 训练集索引：单元格 → 各范围（按结算时间从新到旧），每个范围带各档 { points, final }。 */
export function buildPreviousIndex(train) {
    const index = indexDataset(train);
    const byCell = new Map();
    for (const ev of train.events) {
        for (const scope of scopesOf(ev)) {
            const finals = actualFinals(index, ev, scope);
            if (finals.size === 0) continue;
            const series = index.seriesOf(ev.region, ev.eventId, scope);
            const ranks = new Map();
            for (const [rank, s] of series) {
                const f = finals.get(rank);
                if (f && s.points.length > 0) ranks.set(rank, { points: s.points, final: f.score });
            }
            if (ranks.size === 0) continue;
            const { startAt, endAt } = scopeWindow(ev, scope);
            const key = cellOf(ev, scope).key;
            let list = byCell.get(key);
            if (!list) byCell.set(key, (list = []));
            list.push({ ref: scopeRef(ev.region, ev.eventId, scope), eventId: ev.eventId, scope: scopeKey(scope), startAt, endAt, ranks });
        }
    }
    for (const list of byCell.values()) list.sort((a, b) => b.endAt - a.endAt);
    return byCell;
}

export const previousEventBaseline = {
    name: "prev-same-group",
    interval: false,
    fit: buildPreviousIndex,
    predict(byCell, ctx, _atMs, observed, info) {
        const candidates = byCell.get(info.cell.key) ?? [];
        const duration = ctx.scopeEndAt - ctx.scopeStartAt;
        const out = new Map();
        for (const o of observed) {
            if (o.score <= 0) continue;
            const progress = (o.at - ctx.scopeStartAt) / duration;
            for (const c of candidates) {
                const prev = c.ranks.get(o.rank);
                if (!prev) continue;
                const y = scoreAt(prev.points, c.startAt + progress * (c.endAt - c.startAt), c.startAt, PREVIOUS_EVENT_MAX_GAP_MS);
                if (y == null || y <= 0) continue;
                const p50 = o.score / (y / prev.final);
                out.set(o.rank, { p10: p50, p50, p90: p50 });
                break;
            }
        }
        return out;
    },
};
