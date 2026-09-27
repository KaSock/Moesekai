// 基线一：现有引擎（冻结副本 tori-v2.ts），入参按站点现在的调用方式构造：
// WL（章节、总榜、终章）加成写死 990，章节传 characterId 不传 eventType；普通活动传 masterdata eventType，加成写死 475。
import { calculateEventPrediction } from "./tori-v2.ts";

export const currentEngineBaseline = {
    name: "tori-v2",
    interval: true,
    fit: () => null,
    predict(_sections, ctx, _atMs, observed, info) {
        const isWl = ctx.group !== "normal";
        const out = new Map();
        for (const o of observed) {
            const input = {
                server: ctx.region,
                rank: o.rank,
                startAt: ctx.scopeStartAt,
                endAt: ctx.scopeEndAt,
                historyPoints: o.points.map(([t, y]) => ({ t, y })),
                bonusPercent: isWl ? 990 : 475,
            };
            if (ctx.chapterCharacterId != null) input.characterId = ctx.chapterCharacterId;
            else input.eventType = isWl ? "world_bloom" : info.event.eventType;
            const r = calculateEventPrediction(input);
            out.set(o.rank, { p10: r.predictedScoreP10, p50: r.predictedScore, p90: r.predictedScoreP90 });
        }
        return out;
    },
};
