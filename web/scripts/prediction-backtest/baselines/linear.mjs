// 基线二：线性外推。按开始以来的平均时速推到结算：终榜 = 当前分 × 范围时长 / 已进行时长。点预测，无区间。
export const linearBaseline = {
    name: "linear",
    interval: false,
    fit: () => null,
    predict(_sections, ctx, _atMs, observed) {
        const duration = ctx.scopeEndAt - ctx.scopeStartAt;
        const out = new Map();
        for (const o of observed) {
            const elapsed = o.at - ctx.scopeStartAt;
            if (elapsed <= 0 || o.score <= 0) continue;
            const p50 = (o.score * duration) / elapsed;
            out.set(o.rank, { p10: p50, p50, p90: p50 });
        }
        return out;
    },
};
