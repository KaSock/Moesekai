#!/usr/bin/env node
// 回测报告：把回测行渲染成中文 Markdown（改前 / 改后对比、各模型总表、按截点与档位段拆分、全表附录）。
// 用法：node --experimental-strip-types scripts/prediction-backtest/report.mjs [--in <回测输出目录>] [--out <report.md>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODEL_WORK_DIR } from "./dataset.mjs";
import { TIER_BANDS, aggregate, pairRows, summarize } from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_BACKTEST_DIR = path.join(MODEL_WORK_DIR, "backtest");
export const DEFAULT_REPORT_PATH = path.join(HERE, "report.md");

export const NEW_MODEL = "model";
export const BASE_MODEL = "tori-v2";
// 测试期数少于该值的单元格在报告里标注统计力有限。
export const SMALL_GROUP_EVENTS = 5;

export const MODEL_LABELS = {
    model: "新模型",
    "tori-v2": "现引擎 v2.0.0-Tori",
    linear: "线性外推",
    "prev-same-group": "上一期同类同进度",
};

export const CUT_LABELS = {
    p10: "进度 10%",
    p25: "进度 25%",
    p50: "进度 50%",
    p75: "进度 75%",
    p90: "进度 90%",
    h24: "结束前 24 小时",
    h12: "结束前 12 小时",
    h6: "结束前 6 小时",
};
const CUT_ORDER = Object.keys(CUT_LABELS);

const GROUP_ORDER = ["normal", "wl_chapter_72h", "wl_chapter_48h", "wl_overall", "wl_finale"];
const GROUP_LABELS = {
    normal: "普通活动",
    wl_chapter_72h: "章节 72h",
    wl_chapter_48h: "章节 48h",
    wl_overall: "总榜",
    wl_finale: "终章",
};
const REGION_LABELS = { jp: "日服", cn: "国服" };
const BAND_LABELS = Object.fromEntries(TIER_BANDS.map((b) => [b.id, b.label]));

function parseCell(key) {
    const [region, group, turn, variant] = key.split("|");
    return { region, group, turn, variant };
}

export function cellLabel(key) {
    const { region, group, turn, variant } = parseCell(key);
    const parts = [REGION_LABELS[region] ?? region];
    if (group === "normal") {
        parts.push("普通活动");
        parts.push(variant === "bt0" ? "无疲劳槽" : `疲劳槽参数套 ${variant.slice(2)}`);
    } else {
        const edition = turn === "-" ? "WL 未知期" : `WL${turn}`;
        parts.push(group === "wl_finale" ? `${edition} 终章 ${variant}` : `${edition} ${GROUP_LABELS[group] ?? group}`);
        if (variant === "vs") parts.push("VS 期");
    }
    return parts.join(" · ");
}

function cellSortKey(key) {
    const { region, group, turn, variant } = parseCell(key);
    return [region === "jp" ? 0 : 1, GROUP_ORDER.indexOf(group), turn, variant];
}

function compareCells(a, b) {
    const x = cellSortKey(a);
    const y = cellSortKey(b);
    for (let i = 0; i < x.length; i++) {
        if (x[i] === y[i]) continue;
        return typeof x[i] === "number" ? x[i] - y[i] : String(x[i]).localeCompare(String(y[i]));
    }
    return 0;
}

function pct(x) {
    return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

function signedPct(x) {
    if (x == null) return "—";
    const v = x * 100;
    return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)}%`;
}

function signedPoints(x) {
    if (x == null) return "—";
    const v = x * 100;
    return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)}`;
}

function table(header, body) {
    const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
    for (const row of body) lines.push(`| ${row.join(" | ")} |`);
    return lines.join("\n");
}

function smallFlag(events) {
    return events < SMALL_GROUP_EVENTS ? `【样本少：${events} 期，统计力有限】` : "";
}

function groupBy(rows, keyFn) {
    const out = new Map();
    for (const r of rows) {
        const k = keyFn(r);
        let list = out.get(k);
        if (!list) out.set(k, (list = []));
        list.push(r);
    }
    return out;
}

function modelsIn(rows, baseModel, newModel) {
    const present = new Set(rows.map((r) => r.model));
    const order = [newModel, baseModel, ...Object.keys(MODEL_LABELS), ...[...present].sort()];
    return [...new Set(order)].filter((m) => present.has(m));
}

function modelLabel(m) {
    return MODEL_LABELS[m] ?? m;
}

/**
 * renderReport(rows, { generatedAt?, notes?, dataSummary?, baseModel?, newModel? }) → Markdown 字符串。
 * notes：运行记录（跳过的拟合步骤、失败的模型等），原样列出。
 * dataSummary：{ events: { jp, cn }, series, finals, missingSeries } 等，用于“数据”一节。
 */
export function renderReport(rows, {
    generatedAt = new Date().toISOString(),
    notes = [],
    dataSummary = null,
    baseModel = BASE_MODEL,
    newModel = NEW_MODEL,
} = {}) {
    const models = modelsIn(rows, baseModel, newModel);
    const intervalModels = models.filter((m) => rows.some((r) => r.model === m && r.p10 != null));
    const cells = [...new Set(rows.map((r) => r.cell))].sort(compareCells);
    const byCell = groupBy(rows, (r) => r.cell);
    const out = [];

    out.push("# 活动预测回测报告", "");
    out.push(`> 由 \`scripts/prediction-backtest/run-all.mjs\` 生成，请勿手改。生成时间：${generatedAt}。`, "");

    out.push("## 方法", "");
    out.push("- **滚动原点**：预测某一期时，只用结算时间早于该期开始时间的活动拟合，测试活动自身及之后的数据不进入训练集。");
    out.push("- **截点**：进度 10% / 25% / 50% / 75% / 90%，以及结束前 24 / 12 / 6 小时（早于范围开始的截点跳过）；各档的当前分取截点前 3 小时内的最后一个观测点。");
    out.push("- **单元格**：组别 × WL 期数 × 区服；普通活动按疲劳槽参数套分开，WL 的 VS 期单列，终章按（区服，活动）单列，不同期之间不合并。");
    out.push("- **指标**：MAPE 与中位 APE（P50 相对终榜的绝对误差）；偏差为带符号误差的均值（正 = 高估）；覆盖率为终榜落在 P10–P90 内的比例（目标约 80%）；区间宽度为 (P90 − P10) / 终榜 的均值。线性外推与上一期同类只给点预测，没有区间指标。");
    out.push(`- **样本少**：测试期数少于 ${SMALL_GROUP_EVENTS} 的单元格标注【样本少】，其结论统计力有限。`, "");

    out.push("## 数据与运行记录", "");
    const all = summarize(rows);
    out.push(`- 回测预测点共 ${rows.length} 条，覆盖 ${all.events} 期活动、${all.scopes} 个统计范围；模型：${models.map(modelLabel).join("、") || "无"}。`);
    if (dataSummary) {
        const ev = dataSummary.events ?? {};
        out.push(`- 数据集：活动 日服 ${ev.jp ?? 0} 期 / 国服 ${ev.cn ?? 0} 期；序列 ${dataSummary.series ?? 0} 条；终榜 ${dataSummary.finals ?? 0} 条；缺少序列文件的活动 ${dataSummary.missingSeries ?? 0} 期。`);
    }
    const fromSeries = rows.filter((r) => r.actualSource === "series").length;
    if (fromSeries > 0) out.push(`- 其中 ${fromSeries} 条的终榜取自序列末点（终榜表缺该档）。`);
    for (const note of notes) out.push(`- ${note}`);
    out.push("");

    out.push("## 1. 改前 / 改后（配对：同一预测点两个模型都有预测）", "");
    const hasNew = models.includes(newModel);
    const hasBase = models.includes(baseModel);
    if (!hasNew || !hasBase) {
        out.push(`${!hasNew ? modelLabel(newModel) : modelLabel(baseModel)}没有回测结果（见运行记录），本节从略。`, "");
    } else {
        const body = [];
        for (const cell of cells) {
            const { a, b } = pairRows(byCell.get(cell), newModel, baseModel);
            const sNew = summarize(a);
            const sBase = summarize(b);
            let verdict;
            if (a.length === 0) verdict = "无配对样本";
            else if (sNew.mape <= sBase.mape) verdict = "新模型不差于现引擎";
            else verdict = "新模型更差：该组保留旧算法";
            body.push([
                cellLabel(cell),
                String(sNew.events),
                String(a.length),
                pct(sBase.mape),
                pct(sNew.mape),
                a.length ? signedPoints(sNew.mape - sBase.mape) : "—",
                pct(sBase.coverage),
                pct(sNew.coverage),
                pct(sNew.widthPct),
                `${smallFlag(sNew.events)}${verdict}`,
            ]);
        }
        out.push(table(
            ["单元格", "测试期数", "配对样本", "现引擎 MAPE", "新模型 MAPE", "变化（百分点）", "现引擎 覆盖率", "新模型 覆盖率", "新模型 区间宽度", "结论"],
            body,
        ), "");
    }

    out.push("## 2. 各模型总表（各自的全部预测点）", "");
    {
        const body = [];
        for (const cell of cells) {
            const perModel = groupBy(byCell.get(cell), (r) => r.model);
            for (const m of models) {
                const list = perModel.get(m);
                if (!list) continue;
                const s = summarize(list);
                body.push([cellLabel(cell), modelLabel(m), `${s.events}${s.events < SMALL_GROUP_EVENTS ? "（少）" : ""}`, String(s.n), pct(s.mape), pct(s.medianApe), signedPct(s.bias), pct(s.coverage), pct(s.widthPct)]);
            }
        }
        out.push(table(["单元格", "模型", "测试期数", "样本", "MAPE", "中位 APE", "偏差", "覆盖率", "区间宽度"], body), "");
    }

    const splitTable = (title, field, order, labels) => {
        out.push(title, "");
        const header = ["单元格", field === "cut" ? "截点" : "档位段", ...models.map((m) => `${modelLabel(m)} MAPE（样本）`), ...intervalModels.map((m) => `${modelLabel(m)} 覆盖率`)];
        const body = [];
        for (const cell of cells) {
            const parts = groupBy(byCell.get(cell), (r) => r[field]);
            const keys = [...parts.keys()].sort((x, y) => order.indexOf(x) - order.indexOf(y));
            for (const k of keys) {
                const perModel = groupBy(parts.get(k), (r) => r.model);
                const stats = new Map([...perModel].map(([m, list]) => [m, summarize(list)]));
                body.push([
                    cellLabel(cell),
                    labels[k] ?? k,
                    ...models.map((m) => (stats.has(m) ? `${pct(stats.get(m).mape)}（${stats.get(m).n}）` : "—")),
                    ...intervalModels.map((m) => pct(stats.get(m)?.coverage ?? null)),
                ]);
            }
        }
        out.push(table(header, body), "");
    };
    splitTable("## 3. 按截点", "cut", CUT_ORDER, CUT_LABELS);
    splitTable("## 4. 按档位段", "band", TIER_BANDS.map((b) => b.id), BAND_LABELS);

    out.push("## 附录：组别 × WL 期数 × 区服 × 档位段 × 截点 全表", "");
    out.push("<details><summary>展开全表</summary>", "");
    {
        const full = aggregate(rows, ["cell", "band", "cut", "model"]);
        const bandOrder = TIER_BANDS.map((b) => b.id);
        full.sort((x, y) => compareCells(x.cell, y.cell)
            || bandOrder.indexOf(x.band) - bandOrder.indexOf(y.band)
            || CUT_ORDER.indexOf(x.cut) - CUT_ORDER.indexOf(y.cut)
            || models.indexOf(x.model) - models.indexOf(y.model));
        const body = full.map((s) => [cellLabel(s.cell), BAND_LABELS[s.band] ?? s.band, CUT_LABELS[s.cut] ?? s.cut, modelLabel(s.model), String(s.n), pct(s.mape), pct(s.medianApe), signedPct(s.bias), pct(s.coverage), pct(s.widthPct)]);
        out.push(table(["单元格", "档位段", "截点", "模型", "样本", "MAPE", "中位 APE", "偏差", "覆盖率", "区间宽度"], body), "");
    }
    out.push("</details>", "");
    return out.join("\n");
}

export function readRowsJsonl(file) {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function parseArgs(argv) {
    const args = { in: DEFAULT_BACKTEST_DIR, out: DEFAULT_REPORT_PATH };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--in") args.in = argv[++i];
        else if (a === "--out") args.out = argv[++i];
        else throw new Error(`未知参数：${a}`);
    }
    return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = parseArgs(process.argv.slice(2));
    const rows = readRowsJsonl(path.join(args.in, "rows.jsonl"));
    const metricsFile = path.join(args.in, "metrics.json");
    const meta = fs.existsSync(metricsFile) ? JSON.parse(fs.readFileSync(metricsFile, "utf8")) : {};
    const md = renderReport(rows, { generatedAt: meta.generatedAt, notes: meta.notes ?? [], dataSummary: meta.dataSummary ?? null });
    fs.writeFileSync(args.out, md);
    console.log(`报告已写入 ${args.out}（${rows.length} 条预测点）`);
}
