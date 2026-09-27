#!/usr/bin/env node
// 一键流程：fit-prior → fit-curve → fit-tiers → fit-fuse（全量拟合，各脚本自行写出 section，fit-fuse 另写 priors.json）
// → 滚动回测（新模型逐折重拟合 + 三条基线）→ report.md。缺少的拟合脚本跳过并在报告的运行记录里写明。
// 任一拟合 CLI 失败即停：后面的拟合（含写 priors.json 的 fit-fuse）不再运行，也不回测、不写 report.md；
// 回测阶段失败（拟合脚本载入失败、某个模型回测抛错）时报告改写到 --out 下的 report.failed.md，--report 指向的文件保持原样。
// 用法：node --experimental-strip-types scripts/prediction-backtest/run-all.mjs
//        [--data <dir>] [--out <回测输出目录>] [--only <group>] [--report <report.md>] [--fit-out <dir>] [--priors <priors.json>]
// priors.json 去向见 priorsPathFor：只有不带 --data / --fit-out / --priors 的默认全量运行才覆盖上线的 src/lib/prediction/priors.json。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BASELINES } from "./baselines/index.mjs";
import { DEFAULT_DATA_DIR, SESSIONS_MODEL_DIR, loadDataset } from "./dataset.mjs";
import { rollingBacktest } from "./harness.mjs";
import { DEFAULT_GROUP_BY, aggregate } from "./metrics.mjs";
import { DEFAULT_BACKTEST_DIR, DEFAULT_REPORT_PATH, NEW_MODEL, renderReport } from "./report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FIT_STEPS = [
    { script: "fit-prior.mjs", exportName: "fitPrior", section: "prior" },
    { script: "fit-curve.mjs", exportName: "fitCurve", section: "curve" },
    { script: "fit-tiers.mjs", exportName: "fitTiers", section: "tiers" },
    { script: "fit-fuse.mjs", exportName: "fitFuse", section: "fuse" },
];

export const PREDICT_MODULE = path.resolve(HERE, "../../src/lib/prediction/model/predict.ts");
/** 上线模型；与 fit-fuse.mjs 的 DEFAULT_PRIORS_PATH 相同。 */
export const SHIPPED_PRIORS_PATH = path.resolve(HERE, "../../src/lib/prediction/priors.json");
/** 四个拟合脚本共同的默认 --out。 */
export const DEFAULT_FIT_DIR = path.join(SESSIONS_MODEL_DIR, "fit");

export const GROUPS = ["normal", "wl_chapter_72h", "wl_chapter_48h", "wl_overall", "wl_finale"];

export function parseArgs(argv) {
    const args = { data: DEFAULT_DATA_DIR, out: DEFAULT_BACKTEST_DIR, only: null, report: DEFAULT_REPORT_PATH, fitOut: null, priors: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v == null) throw new Error(`${a} 缺少取值`);
            return v;
        };
        if (a === "--data") args.data = value();
        else if (a === "--out") args.out = value();
        else if (a === "--only") args.only = value();
        else if (a === "--report") args.report = value();
        else if (a === "--fit-out") args.fitOut = value();
        else if (a === "--priors") args.priors = value();
        else throw new Error(`未知参数：${a}`);
    }
    if (args.only && !GROUPS.includes(args.only)) throw new Error(`--only 只接受 ${GROUPS.join(" / ")}`);
    return args;
}

/**
 * fit-fuse 写 priors.json 的位置：显式 --priors 优先；给了 --fit-out 就放在那里；
 * 换了 --data 但没给 --fit-out 时放进默认拟合目录；只有默认数据、默认拟合目录才写上线文件。
 */
export function priorsPathFor({ dataDir = DEFAULT_DATA_DIR, fitOut = null, priors = null } = {}) {
    if (priors) return priors;
    if (fitOut) return path.join(fitOut, "priors.json");
    if (path.resolve(dataDir) !== path.resolve(DEFAULT_DATA_DIR)) return path.join(DEFAULT_FIT_DIR, "priors.json");
    return SHIPPED_PRIORS_PATH;
}

function dataThrough(train) {
    const out = { jp: 0, cn: 0 };
    const lastAt = { jp: -Infinity, cn: -Infinity };
    for (const ev of train.events) {
        if (ev.aggregateAt > lastAt[ev.region]) {
            lastAt[ev.region] = ev.aggregateAt;
            out[ev.region] = ev.eventId;
        }
    }
    return out;
}

/**
 * 新模型：四个拟合函数 + predictFromSections；缺任何一个就返回 spec: null。
 * 文件存在但载入失败或缺导出时 failed = true。拟合脚本被 import 时不得执行其 CLI 主体。
 * sections 按 priors.json 的结构组装，predict 直接调用上线用的 predictFromSections。
 */
export async function loadNewModel({ scriptsDir = HERE, predictModule = PREDICT_MODULE } = {}) {
    const notes = [];
    const missing = [];
    const fitFns = {};
    let failed = false;
    const load = async (file, exportName) => {
        if (!fs.existsSync(file)) {
            missing.push(path.basename(file));
            return null;
        }
        try {
            const fn = (await import(pathToFileURL(file).href))[exportName];
            if (typeof fn === "function") return fn;
            notes.push(`${path.basename(file)} 没有导出 ${exportName}`);
        } catch (err) {
            notes.push(`载入 ${path.basename(file)} 失败：${err.message}`);
        }
        failed = true;
        return null;
    };
    for (const step of FIT_STEPS) {
        const fn = await load(path.join(scriptsDir, step.script), step.exportName);
        if (fn) fitFns[step.section] = fn;
    }
    const predictFromSections = await load(predictModule, "predictFromSections");
    if (missing.length > 0) notes.push(`新模型缺少 ${missing.join("、")}`);
    if (Object.keys(fitFns).length < FIT_STEPS.length || !predictFromSections) {
        notes.push("跳过新模型回测，只跑三条基线");
        return { spec: null, notes, failed };
    }
    const spec = {
        name: NEW_MODEL,
        interval: true,
        fit(train) {
            const prior = fitFns.prior(train);
            const curve = fitFns.curve(train);
            const tiers = fitFns.tiers(train);
            const fuse = fitFns.fuse(train, { prior, curve, tiers });
            return { version: 1, generatedAt: "backtest", dataThrough: dataThrough(train), prior, curve, tiers, fuse };
        },
        predict: (sections, ctx, atMs, observed) => predictFromSections(sections, ctx, atMs, observed),
    };
    return { spec, notes, failed };
}

function runFitClis({ scriptsDir, dataDir, fitOut, priorsPath, log }) {
    const notes = [];
    let failed = false;
    for (const step of FIT_STEPS) {
        const file = path.join(scriptsDir, step.script);
        if (!fs.existsSync(file)) {
            const msg = `跳过 ${step.script}：文件不存在（尚未由拟合写者提供）`;
            log(msg);
            notes.push(msg);
            continue;
        }
        const args = [
            "--experimental-strip-types", file, "--data", dataDir,
            ...(fitOut ? ["--out", fitOut] : []),
            ...(step.section === "fuse" ? ["--priors", priorsPath] : []),
        ];
        log(step.section === "fuse" ? `运行 ${step.script}（priors.json → ${priorsPath}）…` : `运行 ${step.script} …`);
        const res = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
        if (res.status !== 0) {
            failed = true;
            const rest = FIT_STEPS.slice(FIT_STEPS.indexOf(step) + 1).map((s) => s.script);
            const msg = `${step.script} 退出码 ${res.status ?? res.signal}，全量拟合失败${rest.length ? `；未运行 ${rest.join("、")}` : ""}`;
            log(msg);
            notes.push(msg);
            break;
        }
    }
    return { notes, failed };
}

/**
 * runAll({ dataDir?, dataset?, out?, only?, reportPath?, fitOut?, priors?, scriptsDir?, predictModule?, runFits?, log? })
 * dataset 给定时不再从磁盘读取（测试用）。返回 { rows, notes, failed }。
 */
export async function runAll({
    dataDir = DEFAULT_DATA_DIR,
    dataset,
    out = DEFAULT_BACKTEST_DIR,
    only = null,
    reportPath = DEFAULT_REPORT_PATH,
    fitOut = null,
    priors = null,
    scriptsDir = HERE,
    predictModule = PREDICT_MODULE,
    runFits = true,
    log = console.log,
} = {}) {
    const notes = [];
    let failed = false;

    if (runFits) {
        const fits = runFitClis({ scriptsDir, dataDir, fitOut, priorsPath: priorsPathFor({ dataDir, fitOut, priors }), log });
        notes.push(...fits.notes);
        if (fits.failed) {
            log(`拟合失败，未回测；${reportPath} 保持原样`);
            return { rows: [], notes, failed: true };
        }
    }

    const data = dataset ?? loadDataset(dataDir);
    const dataSummary = {
        events: {
            jp: data.events.filter((e) => e.region === "jp").length,
            cn: data.events.filter((e) => e.region === "cn").length,
        },
        series: data.series.length,
        finals: data.finals.length,
        missingSeries: data.missingSeries?.length ?? 0,
    };

    const { spec: newModel, notes: modelNotes, failed: modelFailed } = await loadNewModel({ scriptsDir, predictModule });
    for (const n of modelNotes) log(n);
    notes.push(...modelNotes);
    failed ||= modelFailed;

    const filter = only ? (_ev, _scope, cell) => cell.group === only : undefined;
    if (only) notes.push(`只回测组别 ${only}（训练集不受影响）`);

    const rows = [];
    for (const spec of [newModel, ...BASELINES].filter(Boolean)) {
        const started = Date.now();
        try {
            const modelRows = rollingBacktest({ data, fit: spec.fit, predict: spec.predict, model: spec.name, interval: spec.interval, filter });
            rows.push(...modelRows);
            log(`${spec.name}：${modelRows.length} 条预测点，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
        } catch (err) {
            failed = true;
            const msg = `${spec.name} 回测失败：${err.message}`;
            log(msg);
            notes.push(msg);
        }
    }

    const generatedAt = new Date().toISOString();
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    fs.writeFileSync(path.join(out, "metrics.json"), JSON.stringify({
        generatedAt,
        notes,
        dataSummary,
        groupBy: DEFAULT_GROUP_BY,
        byCell: aggregate(rows, ["model", "cell"]),
        full: aggregate(rows, DEFAULT_GROUP_BY),
    }, null, 1));
    const reportOut = failed ? path.join(out, "report.failed.md") : reportPath;
    fs.writeFileSync(reportOut, renderReport(rows, { generatedAt, notes, dataSummary }));
    log(`回测输出：${out}；报告：${reportOut}${failed ? `（运行有失败，${reportPath} 保持原样）` : ""}`);
    return { rows, notes, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = parseArgs(process.argv.slice(2));
    const { failed } = await runAll({ dataDir: args.data, out: args.out, only: args.only, reportPath: args.report, fitOut: args.fitOut, priors: args.priors });
    if (failed) process.exitCode = 1;
}
