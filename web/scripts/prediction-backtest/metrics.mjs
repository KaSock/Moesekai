// 回测指标：MAPE、中位 APE、偏差、P10–P90 覆盖率与区间宽度，按任意维度聚合。比率均以小数保存（0.05 = 5%）。

export const TIER_BANDS = [
    { id: "T1-10", label: "T1–T10", maxRank: 10 },
    { id: "T20-100", label: "T20–T100", maxRank: 100 },
    { id: "T200-1000", label: "T200–T1000", maxRank: 1000 },
    { id: "T2000-10000", label: "T2000–T10000", maxRank: 10000 },
    { id: "T20000+", label: "T20000 以后", maxRank: Infinity },
];

export function tierBand(rank) {
    return TIER_BANDS.find((b) => rank <= b.maxRank).id;
}

export const DEFAULT_GROUP_BY = ["model", "region", "group", "wlTurn", "cell", "band", "cut"];

function mean(xs) {
    return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs) {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 一组回测行的指标。
 * ape = |p50 − 终榜| / 终榜，bias = (p50 − 终榜) / 终榜 的均值（正 = 高估）；
 * 区间指标只统计带区间的行（p10、p90 非 null）：coverage = P10 ≤ 终榜 ≤ P90 的比例，widthPct = (P90 − P10) / 终榜 的均值。
 */
export function summarize(rows) {
    const ape = [];
    const pe = [];
    let intervalN = 0;
    let covered = 0;
    let below = 0;
    let above = 0;
    const widths = [];
    const events = new Set();
    const scopes = new Set();
    for (const r of rows) {
        const e = (r.p50 - r.actual) / r.actual;
        pe.push(e);
        ape.push(Math.abs(e));
        events.add(`${r.region}-${r.eventId}`);
        scopes.add(`${r.region}-${r.eventId}/${r.scope}`);
        if (r.p10 != null && r.p90 != null) {
            intervalN += 1;
            if (r.actual < r.p10) below += 1;
            else if (r.actual > r.p90) above += 1;
            else covered += 1;
            widths.push((r.p90 - r.p10) / r.actual);
        }
    }
    return {
        n: rows.length,
        events: events.size,
        scopes: scopes.size,
        mape: mean(ape),
        medianApe: median(ape),
        bias: mean(pe),
        intervalN,
        coverage: intervalN > 0 ? covered / intervalN : null,
        belowP10: intervalN > 0 ? below / intervalN : null,
        aboveP90: intervalN > 0 ? above / intervalN : null,
        widthPct: mean(widths),
    };
}

/** 按 by 中的字段分组汇总；返回 [{ ...分组字段, ...summarize }]，按分组字段排序。 */
export function aggregate(rows, by = DEFAULT_GROUP_BY) {
    const buckets = new Map();
    for (const r of rows) {
        const key = JSON.stringify(by.map((k) => r[k] ?? null));
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = []));
        b.push(r);
    }
    const out = [];
    for (const [key, bucket] of buckets) {
        const values = JSON.parse(key);
        const head = Object.fromEntries(by.map((k, i) => [k, values[i]]));
        out.push({ ...head, ...summarize(bucket) });
    }
    out.sort((a, b) => {
        for (const k of by) {
            const x = a[k];
            const y = b[k];
            if (x === y) continue;
            if (x == null) return -1;
            if (y == null) return 1;
            return typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        }
        return 0;
    });
    return out;
}

/** 同一预测点（区服、活动、范围、档位、截点）的唯一键，用于两个模型的配对比较。 */
export function predictionKey(r) {
    return `${r.region}-${r.eventId}/${r.scope}/${r.rank}/${r.cut}`;
}

/** 只保留两个模型都给出预测的点，返回 { a: rows, b: rows }（顺序一致）。 */
export function pairRows(rows, modelA, modelB) {
    const byKeyB = new Map();
    for (const r of rows) if (r.model === modelB) byKeyB.set(predictionKey(r), r);
    const a = [];
    const b = [];
    for (const r of rows) {
        if (r.model !== modelA) continue;
        const other = byKeyB.get(predictionKey(r));
        if (other) {
            a.push(r);
            b.push(other);
        }
    }
    return { a, b };
}
