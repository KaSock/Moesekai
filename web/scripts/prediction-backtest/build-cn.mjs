#!/usr/bin/env node
/**
 * 国服数据构建：rk 终榜、国服逐时序列、国服/日服同 id 终榜比例。
 *
 * 用法（在 web/ 下）:
 *   node scripts/prediction-backtest/build-cn.mjs [--data <dir>] [--out <dir>] [--offline]
 *     [--raw <dir>] [--live <dir>] [--charts <dir>] [--masterdata <dir>]
 *     [--events <events.json>] [--jp-finals <finals-jp.json>] [--jp-borders <json>] [--now <ISO>]
 *     [--ratios-out <file>]
 *
 * 输出:
 *   <out>/finals.json           DatasetFinal[]：已结束的国服活动终榜（rk timeline 终榜；#180 结束后优先用 v2 结算榜）；
 *                               采集时间早于结算前 10 分钟的项不当作终榜（rk 的 CN #176 全部档位、#148 T20000+ 是活动中途的快照）
 *   <data>/series/cn-<id>.json  DatasetSeries[]：本机图表存档与现场录制的国服逐时序列
 *   --ratios-out <file>         可选：国服/日服同 id 终榜比例（逐期样本 + 分组 × 档位汇总与时间趋势）。
 *                               没有代码读它（F1 每折自行重拟），不给时只在终端打印汇总
 *
 * rk 原始响应缓存在 <raw>/rk-timeline/<id>.json（默认 <data>/../raw/cn），已缓存的终榜不再请求；
 * 请求串行、间隔 ≥ 1.1 秒。活动分组优先读 D2 的 data/events.json，缺失时按契约第 1 节的规则从 masterdata 快照推出。
 * 日服同 id 终榜优先级：data/finals-jp.json（D2）> 本机终榜表（按活动名 + 开始日期对齐游戏 id）> D1 逐时序列末点。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { WORK_ROOT } from "./workdir.mjs";

/** @typedef {import("../../src/lib/prediction/model/types.ts").DatasetFinal} DatasetFinal */
/** @typedef {import("../../src/lib/prediction/model/types.ts").DatasetSeries} DatasetSeries */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const UA = "Moesekai-prediction-model/1.0 (+https://pjsk.moe)";
const RK = "https://rk.exmeaning.com/public";
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const YEAR = 365.25 * DAY;
const REF_EPOCH = Date.UTC(2025, 0, 1);
// 活动结束后留给 rk 落终榜的时间
const FINAL_GRACE_MS = 2 * HOUR;
// 终榜须在结算前 10 分钟之后采集；正常的 rk 国服终榜最多比结算早 1.3 分钟（rk end_at 比 aggregateAt 早 59 秒），其余在结算之后
const FINAL_MAX_EARLY_MS = 10 * 60e3;
const SERIES_BUCKET_MS = 5 * 60e3;
const MIN_SERIES_POINTS = 10;
// JP 序列末点离结算不超过该值才当作终榜
const JP_SERIES_FINAL_TOLERANCE_MS = 30 * 60e3;
const TREND_MIN_N = 6;
const DURATION_TREND_MIN_N = 10;
const TREND_MIN_SPAN_YEARS = 0.25;
const RECENT_WINDOW = 25;

export function parseArgs(argv) {
    const opts = { offline: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--offline") opts.offline = true;
        else if (a.startsWith("--")) opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    }
    const data = path.resolve(opts.data ?? path.join(WORK_ROOT, "prediction-model/data"));
    const committed = path.resolve(SCRIPT_DIR, "data");
    return {
        offline: opts.offline,
        now: opts.now ? Date.parse(opts.now) : Date.now(),
        data,
        out: path.resolve(opts.out ?? path.join(committed, "cn")),
        raw: path.resolve(opts.raw ?? path.join(data, "../raw/cn")),
        live: path.resolve(opts.live ?? path.join(data, "../live/data")),
        charts: path.resolve(opts.charts ?? path.join(WORK_ROOT, "jp-border-data/metrics/charts")),
        masterdata: path.resolve(opts.masterdata ?? path.join(WORK_ROOT, "wlrules")),
        events: path.resolve(opts.events ?? path.join(committed, "events.json")),
        jpFinals: path.resolve(opts.jpFinals ?? path.join(committed, "finals-jp.json")),
        jpBorders: path.resolve(opts.jpBorders ?? path.join(WORK_ROOT, "jp-border-data/jp_event_borders_all.json")),
        ratiosOut: opts.ratiosOut ? path.resolve(opts.ratiosOut) : null,
    };
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readJsonMaybeGz = (p) => JSON.parse((p.endsWith(".gz") ? gunzipSync(readFileSync(p)) : readFileSync(p)).toString("utf8"));
const scopeKey = (scope) => (scope.kind === "overall" ? "overall" : `chapter:${scope.gameCharacterId}`);
const OVERALL = Object.freeze({ kind: "overall" });

// ---------------------------------------------------------------------------
// 活动表

/** 契约第 1 节：finale 行 → wl_finale；有 worldBlooms 行的 world_bloom → WL（按 120 天间隔分期）；其余 normal。 */
export function deriveEvents(region, events, worldBlooms) {
    const wbByEvent = new Map();
    for (const row of worldBlooms) {
        if (!wbByEvent.has(row.eventId)) wbByEvent.set(row.eventId, []);
        wbByEvent.get(row.eventId).push(row);
    }
    const turnOf = new Map();
    const wl = events.filter((e) => e.eventType === "world_bloom" && wbByEvent.has(e.id)).sort((a, b) => a.startAt - b.startAt);
    let turn = 0;
    let prevAggregate = -Infinity;
    for (const e of wl) {
        if (e.startAt - prevAggregate > 120 * DAY) turn++;
        turnOf.set(e.id, turn <= 3 ? turn : null);
        prevAggregate = e.aggregateAt;
    }
    return events.map((e) => {
        const rows = (wbByEvent.get(e.id) ?? []).slice().sort((a, b) => a.chapterNo - b.chapterNo);
        const isFinale = rows.some((r) => r.worldBloomChapterType === "finale");
        return {
            region,
            eventId: e.id,
            name: e.name,
            eventType: e.eventType,
            startAt: e.startAt,
            aggregateAt: e.aggregateAt,
            group: isFinale ? "wl_finale" : rows.length > 0 && e.eventType === "world_bloom" ? "wl_overall" : "normal",
            wlTurn: turnOf.get(e.id) ?? null,
            isFinale,
            chapters: rows.map((r) => ({ chapterNo: r.chapterNo, gameCharacterId: r.gameCharacterId ?? null, startAt: r.chapterStartAt, aggregateAt: r.aggregateAt })),
            breakTimeId: e.eventBreakTimeId ?? null,
        };
    });
}

function loadEvents(region, cfg) {
    if (existsSync(cfg.events)) {
        const rows = readJson(cfg.events).filter((e) => e.region === region);
        if (rows.length > 0) {
            return {
                source: path.basename(cfg.events),
                rows: rows.map((e) => ({
                    ...e,
                    group: e.isFinale ? "wl_finale" : e.chapters?.length > 0 ? "wl_overall" : "normal",
                })),
            };
        }
    }
    const md = (t) => readJson(path.join(cfg.masterdata, `${region}_${t}.json`));
    return { source: `masterdata-snapshot:${region}_events.json`, rows: deriveEvents(region, md("events"), md("worldBlooms")) };
}

/** 章节形状，如 4x48h；普通活动按疲劳槽配置区分；终章按活动单独成格。 */
export function eventShape(ev) {
    if (ev.group === "wl_finale") return `finale#${ev.eventId}`;
    if (ev.group === "normal") return `bt${ev.breakTimeId ?? 0}`;
    const hours = ev.chapters.map((c) => Math.round((c.aggregateAt - c.startAt) / HOUR));
    return hours.every((h) => h === hours[0]) ? `${hours.length}x${hours[0]}h` : `${hours.join("+")}h`;
}

export function cellKey(cn, jp) {
    const turn = cn.group === "normal" ? "" : `|turn=${cn.wlTurn ?? "unknown"}`;
    if (cn.group === "wl_finale") return `wl_finale|event=${cn.eventId}`;
    return `${cn.group}${turn}|cn=${eventShape(cn)}|jp=${jp ? eventShape(jp) : "?"}`;
}

// ---------------------------------------------------------------------------
// rk 抓取与缓存

let lastFetchAt = 0;
async function politeGet(url) {
    const wait = lastFetchAt + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFetchAt = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    return { status: res.status, text: await res.text() };
}

async function rkEventList(cfg, endedEvents, log) {
    const file = path.join(cfg.raw, "rk-events.json");
    const cachedAt = existsSync(file) ? statSync(file).mtimeMs : -Infinity;
    const newestEnded = Math.max(-Infinity, ...endedEvents.map((e) => e.aggregateAt + FINAL_GRACE_MS));
    if (!cfg.offline && cachedAt < newestEnded) {
        const url = `${RK}/events?region=cn`;
        const { status, text } = await politeGet(url);
        if (status === 200) {
            writeFileSync(file, text);
            log.push(`fetched ${url}`);
        } else log.push(`WARN ${url} -> HTTP ${status}; using cached list`);
    }
    return existsSync(file) ? readJson(file) : [];
}

function parseRkFinal(body) {
    if (body?.status !== "finished" || !Array.isArray(body.items)) return null;
    const items = body.items.filter((x) => x.is_final === true && Number.isFinite(x.rank) && Number.isFinite(x.score));
    return items.length > 0 ? items : null;
}

/** rk 的 is_final 只说明响应已定稿（重抓也不变），不保证每项都是结算时的榜：只收结算前 10 分钟之后采集的项。 */
export function splitRkFinalItems(items, aggregateAt) {
    const kept = [];
    const early = [];
    for (const x of items) (Date.parse(x.collect_time) >= aggregateAt - FINAL_MAX_EARLY_MS ? kept : early).push(x);
    return { kept, early };
}

async function loadRkFinals(cfg, cnEvents, log) {
    mkdirSync(path.join(cfg.raw, "rk-timeline"), { recursive: true });
    const ended = cnEvents.filter((e) => e.aggregateAt + FINAL_GRACE_MS < cfg.now);
    const list = await rkEventList(cfg, ended, log);
    const finalized = new Set(list.filter((x) => x.status === "finished" && x.has_finalized_data).map((x) => x.event_id));
    const out = new Map();
    const dropped = [];
    let fetched = 0;
    for (const ev of ended) {
        const file = path.join(cfg.raw, "rk-timeline", `${ev.eventId}.json`);
        if (!existsSync(file)) {
            if (cfg.offline || !finalized.has(ev.eventId)) continue;
            const url = `${RK}/event/${ev.eventId}/timeline?region=cn`;
            const { status, text } = await politeGet(url);
            fetched++;
            if (status !== 200) {
                log.push(`WARN ${url} -> HTTP ${status}`);
                continue;
            }
            let body;
            try {
                body = JSON.parse(text);
            } catch {
                log.push(`WARN ${url} -> invalid JSON`);
                continue;
            }
            if (!parseRkFinal(body)) {
                // 未落终榜的响应另存，不当作终榜缓存
                writeFileSync(path.join(cfg.raw, "rk-timeline", `${ev.eventId}.unfinished-${new Date().toISOString().replace(/[:.]/g, "")}.json`), text);
                log.push(`WARN ${url} -> not final yet (status ${body?.status})`);
                continue;
            }
            writeFileSync(file, text);
        }
        const items = parseRkFinal(readJson(file));
        if (!items) continue;
        const { kept, early } = splitRkFinalItems(items, ev.aggregateAt);
        if (early.length > 0) {
            const hours = [...new Set(early.map((x) => ((ev.aggregateAt - Date.parse(x.collect_time)) / HOUR).toFixed(1)))].join("/");
            dropped.push(`#${ev.eventId} ${early.length === items.length ? "all tiers" : early.map((x) => `T${x.rank}`).join(",")} (${hours} h before aggregateAt)`);
        }
        if (kept.length > 0) out.set(ev.eventId, kept);
    }
    log.push(`rk timeline: ${fetched} fetched, ${out.size} finals available`);
    if (dropped.length > 0) log.push(`rk timeline: dropped is_final items collected more than 10 min before aggregateAt: ${dropped.join("; ")}`);
    return out;
}

// ---------------------------------------------------------------------------
// 本机图表存档（metrics/charts/cn_event_*.json）

function loadCnCharts(cfg) {
    if (!existsSync(cfg.charts)) return [];
    return readdirSync(cfg.charts)
        .filter((f) => /^cn_event_\d+_.*\.json$/.test(f))
        .sort()
        .map((f) => ({ file: f, body: readJson(path.join(cfg.charts, f)) }));
}

// ---------------------------------------------------------------------------
// 现场录制（live/data/cn_*）

function listGz(dir) {
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json.gz")).sort().map((f) => path.join(dir, f)) : [];
}

/** 读录制目录，按活动返回 { rank -> [[t, s, src]] } 与 v2 结算榜。 */
export function loadLiveRecordings(liveDir) {
    const byEvent = new Map();
    const bucket = (eventId) => {
        if (!byEvent.has(eventId)) byEvent.set(eventId, { points: new Map(), aggregate: null, files: 0 });
        return byEvent.get(eventId);
    };
    const add = (b, rank, t, s, src) => {
        if (!Number.isFinite(rank) || !Number.isFinite(t) || !Number.isFinite(s)) return;
        if (!b.points.has(rank)) b.points.set(rank, []);
        b.points.get(rank).push([t, s, src]);
    };
    for (const f of listGz(path.join(liveDir, "cn_v2_tier_series"))) {
        const d = readJsonMaybeGz(f);
        const b = bucket(d.event_id);
        b.files++;
        for (const [rank, pts] of Object.entries(d.tiers ?? {})) for (const p of pts) add(b, Number(rank), p.t, p.s, "v2-tier-series");
    }
    for (const f of listGz(path.join(liveDir, "cn_v2_latest"))) {
        const d = readJsonMaybeGz(f);
        const b = bucket(d.event_id);
        b.files++;
        if (d.is_event_aggregate) {
            if (!b.aggregate || d.updated_at >= b.aggregate.updatedAt) b.aggregate = { updatedAt: d.updated_at, rankings: d.rankings, file: path.basename(f) };
            continue;
        }
        for (const r of d.rankings ?? []) add(b, r.rank, d.updated_at, r.score, "v2-latest");
    }
    const rkItems = (b, items) => {
        for (const x of items ?? []) add(b, x.rank, Date.parse(x.collect_time), x.score, "rk");
    };
    for (const f of listGz(path.join(liveDir, "cn_rk_timeline"))) {
        const d = readJsonMaybeGz(f);
        const b = bucket(d.event_id);
        b.files++;
        for (const e of d.timeline ?? []) rkItems(b, e.items);
    }
    for (const f of listGz(path.join(liveDir, "cn_rk_latest"))) {
        const d = readJsonMaybeGz(f);
        const b = bucket(d.event_id);
        b.files++;
        if (d.status === "active") rkItems(b, d.items);
    }
    return byEvent;
}

/**
 * 同档位多来源合并：按时间排序，丢掉低于此前最大值的点（榜线只增不减，低值来自滞后的采样），
 * 再按 5 分钟分桶保留每桶最后一个点。
 */
export function cleanSeries(raw, startAt, aggregateAt) {
    const pts = raw.filter(([t, s]) => t >= startAt && t <= aggregateAt && s > 0).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const kept = [];
    let max = -Infinity;
    for (const p of pts) {
        if (p[1] >= max) {
            kept.push(p);
            max = p[1];
        }
    }
    const thinned = [];
    for (const p of kept) {
        const last = thinned[thinned.length - 1];
        if (last && Math.floor(last[0] / SERIES_BUCKET_MS) === Math.floor(p[0] / SERIES_BUCKET_MS)) thinned[thinned.length - 1] = p;
        else thinned.push(p);
    }
    return { points: thinned, dropped: pts.length - kept.length, total: pts.length };
}

// ---------------------------------------------------------------------------
// 日服同 id 终榜

// 只比字母与数字：表里的全角/半角符号、♪♡、〜～ 与 masterdata 不一致
const normName = (s) => String(s ?? "").normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
const jstDate = (ms) => new Date(ms + 9 * HOUR).toISOString().slice(0, 10);

function nameSimilarity(a, b) {
    const m = a.length;
    const n = b.length;
    if (!m || !n) return 0;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
}

/**
 * 本机终榜表的行 id 不是游戏 id：按开始日期（JST）+ 活动名对齐。
 * 表里有错字（Aweakening Beat）和错年份（Find the dream view 记成 2024），
 * 所以依次尝试：同日同名 → 同日唯一且名字相近（≥ 0.6）→ 全表唯一同名。
 */
export function alignJpBorders(rows, jpEvents) {
    const byDate = new Map();
    const byName = new Map();
    for (const ev of jpEvents) {
        const k = jstDate(ev.startAt);
        if (!byDate.has(k)) byDate.set(k, []);
        byDate.get(k).push(ev);
        const nk = normName(ev.name);
        if (!byName.has(nk)) byName.set(nk, []);
        byName.get(nk).push(ev);
    }
    const matched = new Map();
    const loose = [];
    const unmatched = [];
    for (const row of rows) {
        const name = normName(row.name);
        const cands = byDate.get(row.start_date) ?? [];
        let hit = cands.find((ev) => normName(ev.name) === name);
        let how = "exact";
        if (!hit && cands.length === 1 && nameSimilarity(normName(cands[0].name), name) >= 0.6) [hit, how] = [cands[0], "sameDate"];
        if (!hit && byName.get(name)?.length === 1) [hit, how] = [byName.get(name)[0], "sameName"];
        if (!hit || matched.has(hit.eventId)) {
            unmatched.push(`${row.id}:${row.start_date}:${row.name}`);
            continue;
        }
        matched.set(hit.eventId, row);
        if (how !== "exact") loose.push(`row ${row.id} "${row.name}" ${row.start_date} -> #${hit.eventId} "${hit.name}" (${how})`);
    }
    return { matched, loose, unmatched };
}

function loadJpFinals(cfg, jpEvents, log) {
    const finals = new Map();
    const put = (eventId, scope, rank, score, source) => {
        const k = `${eventId}|${scopeKey(scope)}|${rank}`;
        if (!finals.has(k) && Number.isFinite(score) && score > 0) finals.set(k, { score, source });
    };
    if (existsSync(cfg.jpFinals)) {
        let n = 0;
        for (const f of readJson(cfg.jpFinals)) {
            if (f.region === "jp") {
                put(f.eventId, f.scope, f.rank, f.score, `finals-jp.json:${f.source}`);
                n++;
            }
        }
        log.push(`jp finals: ${n} rows from ${path.basename(cfg.jpFinals)}`);
    } else log.push(`jp finals: ${path.basename(cfg.jpFinals)} not present`);
    if (existsSync(cfg.jpBorders)) {
        const { matched, loose, unmatched } = alignJpBorders(readJson(cfg.jpBorders), jpEvents);
        let n = 0;
        for (const [eventId, row] of matched) {
            if (!row.borders || typeof row.borders !== "object") continue;
            for (const [label, score] of Object.entries(row.borders)) {
                const rank = Number.parseInt(label, 10);
                if (Number.isFinite(rank)) {
                    put(eventId, OVERALL, rank, score, "jp_event_borders_all.json");
                    n++;
                }
            }
        }
        log.push(`jp borders table: ${matched.size} rows aligned to game ids (${n} tier values), ${unmatched.length} unmatched${unmatched.length ? ` [${unmatched.join("; ")}]` : ""}`);
        for (const l of loose) log.push(`  loose match: ${l}`);
    }
    const seriesDir = path.join(cfg.data, "series");
    const jpById = new Map(jpEvents.map((e) => [e.eventId, e]));
    let fromSeries = 0;
    let seriesFiles = 0;
    if (existsSync(seriesDir)) {
        for (const f of readdirSync(seriesDir).filter((x) => /^jp-\d+\.json$/.test(x))) {
            seriesFiles++;
            for (const s of readJson(path.join(seriesDir, f))) {
                const ev = jpById.get(s.eventId);
                const last = s.points?.[s.points.length - 1];
                if (!ev || !last) continue;
                const end = s.scope.kind === "overall" ? ev.aggregateAt : ev.chapters.find((c) => c.gameCharacterId === s.scope.gameCharacterId)?.aggregateAt;
                if (end && last[0] >= end - JP_SERIES_FINAL_TOLERANCE_MS) {
                    const before = finals.size;
                    put(s.eventId, s.scope, s.rank, last[1], `series-last:${s.source}`);
                    if (finals.size > before) fromSeries++;
                }
            }
        }
    }
    log.push(`jp series: ${seriesFiles} files in ${seriesDir}, ${fromSeries} extra final values from series end points`);
    return finals;
}

// ---------------------------------------------------------------------------
// 比例与趋势

/** 最小二乘：返回系数、残差标准差与系数标准误；奇异或自由度 < 1 时返回 null。 */
export function fitLinear(X, y) {
    const n = X.length;
    const k = X[0]?.length ?? 0;
    if (n - k < 1) return null;
    // [XtX | I] Gauss-Jordan 求逆
    const A = Array.from({ length: k }, (_, a) => [...Array.from({ length: k }, (_, b) => X.reduce((s, r) => s + r[a] * r[b], 0)), ...Array.from({ length: k }, (_, j) => (j === a ? 1 : 0))]);
    for (let c = 0; c < k; c++) {
        let p = c;
        for (let q = c + 1; q < k; q++) if (Math.abs(A[q][c]) > Math.abs(A[p][c])) p = q;
        if (Math.abs(A[p][c]) < 1e-12) return null;
        [A[c], A[p]] = [A[p], A[c]];
        const piv = A[c][c];
        for (let j = 0; j < 2 * k; j++) A[c][j] /= piv;
        for (let q = 0; q < k; q++) {
            if (q === c) continue;
            const f = A[q][c];
            for (let j = 0; j < 2 * k; j++) A[q][j] -= f * A[c][j];
        }
    }
    const inv = A.map((r) => r.slice(k));
    const xty = Array.from({ length: k }, (_, a) => X.reduce((s, r, i) => s + r[a] * y[i], 0));
    const beta = inv.map((r) => r.reduce((s, v, j) => s + v * xty[j], 0));
    const rss = X.reduce((s, r, i) => s + (y[i] - r.reduce((t, v, j) => t + v * beta[j], 0)) ** 2, 0);
    const sigma2 = rss / (n - k);
    return { beta, residualSd: Math.sqrt(sigma2), se: inv.map((r, j) => Math.sqrt(sigma2 * r[j])) };
}

const round = (v, d = 5) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const median = (xs) => {
    const s = xs.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const logDuration = (s) => Math.log(s.cnHours / s.jpHours);

function trendOf(samples) {
    if (samples.length < TREND_MIN_N) return null;
    const xs = samples.map((s) => s.x);
    if (Math.max(...xs) - Math.min(...xs) < TREND_MIN_SPAN_YEARS) return null;
    const fit = fitLinear(samples.map((s) => [1, s.x]), samples.map((s) => s.logRatio));
    if (!fit) return null;
    return {
        n: samples.length,
        logRatioAtRef: round(fit.beta[0]),
        slopePerYear: round(fit.beta[1]),
        slopeSe: round(fit.se[1]),
        residualSd: round(fit.residualSd),
        xMin: round(Math.min(...xs), 3),
        xMax: round(Math.max(...xs), 3),
    };
}

/** 时间 + 时长：logRatio = a + b·x + c·ln(cnHours / jpHours)；两服同 id 活动时长常不同。 */
function durationTrendOf(samples) {
    if (samples.length < DURATION_TREND_MIN_N) return null;
    const ds = samples.map(logDuration);
    const md = ds.reduce((a, b) => a + b, 0) / ds.length;
    if (Math.sqrt(ds.reduce((a, d) => a + (d - md) ** 2, 0) / ds.length) < 0.02) return null;
    const fit = fitLinear(samples.map((s, i) => [1, s.x, ds[i]]), samples.map((s) => s.logRatio));
    if (!fit) return null;
    return {
        n: samples.length,
        logRatioAtRef: round(fit.beta[0]),
        slopePerYear: round(fit.beta[1]),
        slopeSe: round(fit.se[1]),
        durationElasticity: round(fit.beta[2]),
        durationElasticitySe: round(fit.se[2]),
        residualSd: round(fit.residualSd),
    };
}

/** 同一格内各档位共享斜率、各自截距（档位内去均值后回归）。 */
function pooledTrend(byRank) {
    let sxx = 0;
    let sxy = 0;
    let n = 0;
    const means = [];
    for (const [rank, ss] of byRank) {
        if (ss.length < 2) continue;
        const mx = ss.reduce((a, s) => a + s.x, 0) / ss.length;
        const my = ss.reduce((a, s) => a + s.logRatio, 0) / ss.length;
        means.push({ rank, mx, my, ss });
        for (const s of ss) {
            sxx += (s.x - mx) ** 2;
            sxy += (s.x - mx) * (s.logRatio - my);
        }
        n += ss.length;
    }
    const dof = n - means.length - 1;
    if (means.length === 0 || sxx === 0 || dof < 3) return null;
    const slope = sxy / sxx;
    let rss = 0;
    for (const m of means) for (const s of m.ss) rss += (s.logRatio - m.my - slope * (s.x - m.mx)) ** 2;
    const residualSd = Math.sqrt(rss / dof);
    return {
        n,
        tiers: means.length,
        slopePerYear: round(slope),
        slopeSe: round(residualSd / Math.sqrt(sxx)),
        residualSd: round(residualSd),
        logRatioAtRef: Object.fromEntries(means.map((m) => [m.rank, round(m.my - slope * m.mx)])),
    };
}

export function buildRatios(cnEvents, jpEvents, cnFinals, jpFinals) {
    const cnById = new Map(cnEvents.map((e) => [e.eventId, e]));
    const jpById = new Map(jpEvents.map((e) => [e.eventId, e]));
    const samples = [];
    const unmatchedCn = [];
    for (const f of cnFinals) {
        const cn = cnById.get(f.eventId);
        const jp = jpById.get(f.eventId);
        const hit = jp ? jpFinals.get(`${f.eventId}|${scopeKey(f.scope)}|${f.rank}`) : null;
        if (!cn) continue;
        if (!hit) {
            unmatchedCn.push(f);
            continue;
        }
        const ratio = f.score / hit.score;
        samples.push({
            eventId: f.eventId,
            cell: cellKey(cn, jp),
            group: cn.group,
            wlTurn: cn.wlTurn,
            scope: f.scope,
            rank: f.rank,
            cnScore: f.score,
            jpScore: hit.score,
            ratio: round(ratio),
            logRatio: round(Math.log(ratio)),
            cnStartAt: cn.startAt,
            jpStartAt: jp.startAt,
            cnHours: round((cn.aggregateAt - cn.startAt) / HOUR, 2),
            jpHours: round((jp.aggregateAt - jp.startAt) / HOUR, 2),
            x: round((cn.startAt - REF_EPOCH) / YEAR, 4),
            jpSource: hit.source,
        });
    }
    samples.sort((a, b) => a.cnStartAt - b.cnStartAt || a.rank - b.rank);

    const cells = new Map();
    for (const s of samples) {
        if (!cells.has(s.cell)) cells.set(s.cell, []);
        cells.get(s.cell).push(s);
    }
    const cellRows = [];
    for (const [key, ss] of [...cells].sort((a, b) => a[0].localeCompare(b[0]))) {
        const eventIds = [...new Set(ss.map((s) => s.eventId))];
        const recentIds = new Set(
            eventIds
                .map((id) => ss.find((s) => s.eventId === id))
                .sort((a, b) => a.cnStartAt - b.cnStartAt)
                .slice(-RECENT_WINDOW)
                .map((s) => s.eventId),
        );
        const byRank = new Map();
        for (const s of ss) {
            if (!byRank.has(s.rank)) byRank.set(s.rank, []);
            byRank.get(s.rank).push(s);
        }
        const tiers = [...byRank]
            .sort((a, b) => a[0] - b[0])
            .map(([rank, rs]) => {
                const logs = rs.map((s) => s.logRatio);
                const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
                const sd = logs.length > 1 ? Math.sqrt(logs.reduce((a, v) => a + (v - mean) ** 2, 0) / (logs.length - 1)) : null;
                const recent = rs.filter((s) => recentIds.has(s.eventId));
                return {
                    rank,
                    n: rs.length,
                    meanLogRatio: round(mean),
                    sdLogRatio: round(sd),
                    medianRatio: round(median(rs.map((s) => s.ratio))),
                    minRatio: round(Math.min(...rs.map((s) => s.ratio))),
                    maxRatio: round(Math.max(...rs.map((s) => s.ratio))),
                    trend: trendOf(rs),
                    durationTrend: durationTrendOf(rs),
                    recentTrend: eventIds.length > RECENT_WINDOW ? trendOf(recent) : null,
                };
            });
        const first = ss[0];
        cellRows.push({
            key,
            group: first.group,
            wlTurn: first.wlTurn,
            events: eventIds.sort((a, b) => a - b),
            nEvents: eventIds.length,
            meanDurationRatio: round(ss.reduce((a, s) => a + s.cnHours / s.jpHours, 0) / ss.length, 4),
            tiers,
            pooledTrend: pooledTrend(byRank),
        });
    }
    return { samples, cells: cellRows, unmatchedCn };
}

// ---------------------------------------------------------------------------
// 输出

function writeRowsJson(file, rows) {
    writeFileSync(file, `[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]\n`);
}

export async function buildCn(cfg) {
    const log = [];
    const cnEv = loadEvents("cn", cfg);
    const jpEv = loadEvents("jp", cfg);
    log.push(`events: cn ${cnEv.rows.length} (${cnEv.source}), jp ${jpEv.rows.length} (${jpEv.source})`);
    const cnById = new Map(cnEv.rows.map((e) => [e.eventId, e]));
    const cnMasterEvents = new Map(readJson(path.join(cfg.masterdata, "cn_events.json")).map((e) => [e.id, e]));
    const tierSet = (ev) => new Set((cnMasterEvents.get(ev.eventId)?.eventRankingRewardRanges ?? []).map((r) => r.toRank));

    // 终榜
    const rk = await loadRkFinals(cfg, cnEv.rows, log);
    const live = loadLiveRecordings(cfg.live);
    const finalsByKey = new Map();
    const putFinal = (eventId, rank, score, source) => {
        const k = `${eventId}|overall|${rank}`;
        if (!finalsByKey.has(k)) finalsByKey.set(k, { region: "cn", eventId, scope: OVERALL, rank, score, source });
    };
    for (const [eventId, rec] of live) {
        const ev = cnById.get(eventId);
        // 结算榜快照须在活动结束后（留 10 分钟余量）才算终榜
        if (!ev || !rec.aggregate || ev.aggregateAt > cfg.now || rec.aggregate.updatedAt < ev.aggregateAt - FINAL_MAX_EARLY_MS) continue;
        const tiers = tierSet(ev);
        for (const r of rec.aggregate.rankings) if (tiers.has(r.rank)) putFinal(eventId, r.rank, r.score, "live-recorder:v2-latest-aggregate");
    }
    for (const [eventId, items] of rk) for (const x of items) putFinal(eventId, x.rank, x.score, "rk-timeline-final");
    const checks = [];
    const charts = loadCnCharts(cfg);
    for (const { file, body } of charts) {
        const ev = cnById.get(body.eventId);
        if (!ev || body.status !== "finished") continue;
        for (const c of body.charts ?? []) {
            const k = `${body.eventId}|overall|${c.Rank}`;
            const have = finalsByKey.get(k);
            if (have) checks.push({ eventId: body.eventId, rank: c.Rank, chart: c.CurrentScore, final: have.score, source: have.source, equal: c.CurrentScore === have.score, file });
            else putFinal(body.eventId, c.Rank, c.CurrentScore, `metrics-chart:${file}`);
        }
    }
    /** @type {DatasetFinal[]} */
    const finals = [...finalsByKey.values()].sort((a, b) => a.eventId - b.eventId || a.rank - b.rank);
    const warnings = [];
    for (const [eventId, rows] of Map.groupBy(finals, (f) => f.eventId)) {
        for (let i = 1; i < rows.length; i++) {
            if (rows[i].score > rows[i - 1].score) warnings.push(`cn #${eventId}: T${rows[i].rank} ${rows[i].score} > T${rows[i - 1].rank} ${rows[i - 1].score}`);
        }
    }

    // 逐时序列
    const seriesByEvent = new Map();
    const seriesStats = [];
    const addSeries = (eventId, rank, points, source, stat) => {
        if (!seriesByEvent.has(eventId)) seriesByEvent.set(eventId, []);
        seriesByEvent.get(eventId).push({ region: "cn", eventId, scope: OVERALL, rank, points, source });
        seriesStats.push({ eventId, rank, points: points.length, ...stat, source });
    };
    for (const { file, body } of charts) {
        const ev = cnById.get(body.eventId);
        if (!ev) continue;
        for (const c of body.charts ?? []) {
            const raw = (c.HistoryPoints ?? []).map((p) => [Date.parse(p.t), p.y]);
            const { points, dropped } = cleanSeries(raw, ev.startAt, ev.aggregateAt);
            if (points.length >= MIN_SERIES_POINTS) {
                addSeries(ev.eventId, c.Rank, points, `metrics-chart:${file}`, { dropped, first: points[0][0], last: points[points.length - 1][0] });
            }
        }
    }
    for (const [eventId, rec] of live) {
        const ev = cnById.get(eventId);
        if (!ev) continue;
        const tiers = tierSet(ev);
        for (const [rank, raw] of [...rec.points].sort((a, b) => a[0] - b[0])) {
            if (!tiers.has(rank)) continue;
            const { points, dropped } = cleanSeries(raw, ev.startAt, ev.aggregateAt);
            if (points.length < MIN_SERIES_POINTS) continue;
            const srcs = [...new Set(raw.map((p) => p[2]))].sort().join("+");
            addSeries(ev.eventId, rank, points.map(([t, s]) => [t, s]), `live-recorder:${srcs}`, { dropped, first: points[0][0], last: points[points.length - 1][0] });
        }
    }
    const seriesDir = path.join(cfg.data, "series");
    mkdirSync(seriesDir, { recursive: true });
    const seriesFiles = [];
    for (const [eventId, rows] of seriesByEvent) {
        const file = path.join(seriesDir, `cn-${eventId}.json`);
        rows.sort((a, b) => a.rank - b.rank);
        writeFileSync(file, JSON.stringify(rows));
        seriesFiles.push(file);
    }

    // 比例
    const jpFinals = loadJpFinals(cfg, jpEv.rows, log);
    const ratios = buildRatios(cnEv.rows, jpEv.rows, finals, jpFinals);

    const endedCn = cnEv.rows.filter((e) => e.aggregateAt + FINAL_GRACE_MS < cfg.now);
    const withFinals = new Set(finals.map((f) => f.eventId));
    const cnFinalsByGroup = {};
    for (const ev of endedCn.filter((e) => withFinals.has(e.eventId))) {
        const k = ev.group === "normal" ? "normal" : `${ev.group}|turn=${ev.wlTurn ?? "unknown"}|${eventShape(ev)}`;
        (cnFinalsByGroup[k] ??= []).push(ev.eventId);
    }
    const sampleSizes = Object.fromEntries(ratios.cells.map((c) => [c.key, Object.fromEntries(c.tiers.map((t) => [t.rank, t.n]))]));
    const running = cnEv.rows.filter((e) => e.startAt <= cfg.now && e.aggregateAt + FINAL_GRACE_MS >= cfg.now).map((e) => e.eventId);
    const cnChapterEvents = endedCn.filter((e) => e.group === "wl_overall" && withFinals.has(e.eventId)).map((e) => e.eventId);
    const gaps = [];
    if (cnChapterEvents.length > 0) {
        gaps.push(`wl_chapter_*: no CN chapter finals (rk timeline serves only the overall ranking of ended events; the v2 worldlink series only the running event), so no CN/JP chapter ratio; WL events with overall finals: ${cnChapterEvents.join(", ")}`);
    }
    for (const id of running) gaps.push(`cn #${id} is running; its final and full series arrive after it ends (rerun this script)`);
    const wlNoJp = [...new Set(ratios.unmatchedCn.filter((f) => cnById.get(f.eventId)?.group !== "normal").map((f) => f.eventId))];
    if (wlNoJp.length) gaps.push(`no JP same-id final for WL events ${wlNoJp.join(", ")} (JP WL rows of the local borders table are empty; needs finals-jp.json or data/series/jp-<id>.json)`);
    const normalMissingTiers = {};
    for (const f of ratios.unmatchedCn.filter((x) => cnById.get(x.eventId)?.group === "normal")) normalMissingTiers[f.rank] = (normalMissingTiers[f.rank] ?? 0) + 1;

    const ratiosOut = {
        version: 1,
        generatedAt: new Date(cfg.now).toISOString(),
        definition: "ratio = CN final / JP final of the same game event id, scope and rank; logRatio = ln(ratio); x = years from refEpoch to the CN event start; trend: logRatio = logRatioAtRef + slopePerYear * x (OLS, needs n >= 6 over >= 0.25 y); durationTrend adds durationElasticity * ln(cnHours / jpHours) (n >= 10); pooledTrend shares one slope across the tiers of a cell; recentTrend uses the last 25 CN events of the cell",
        cellKey: "normal|cn=bt<breakTimeId>|jp=bt<breakTimeId>; wl_overall|turn=<wlTurn>|cn=<chapters>x<hours>h|jp=<chapters>x<hours>h; wl_finale|event=<id>",
        refEpoch: new Date(REF_EPOCH).toISOString(),
        sources: {
            events: { cn: cnEv.source, jp: jpEv.source },
            cnFinals: Object.fromEntries([...Map.groupBy(finals, (f) => f.source)].map(([k, v]) => [k, v.length])),
            jpFinals: Object.fromEntries([...Map.groupBy(ratios.samples, (s) => s.jpSource.split(":")[0])].map(([k, v]) => [k, v.length])),
        },
        cnFinalEventsByGroup: cnFinalsByGroup,
        sampleSizes,
        cells: ratios.cells,
        gaps,
        cnFinalsWithoutJpMatch: { normalByRank: normalMissingTiers, total: ratios.unmatchedCn.length },
        samples: ratios.samples,
    };

    mkdirSync(cfg.out, { recursive: true });
    writeRowsJson(path.join(cfg.out, "finals.json"), finals);
    if (cfg.ratiosOut) {
        const { samples, ...head } = ratiosOut;
        // 数字数组写成一行
        const headText = JSON.stringify(head, null, 1)
            .replace(/\[\n\s*(-?[\d.]+(?:,\n\s*-?[\d.]+)*)\n\s*\]/g, (_, body) => `[${body.replace(/,\n\s*/g, ", ")}]`)
            .replace(/\n}$/, "");
        mkdirSync(path.dirname(cfg.ratiosOut), { recursive: true });
        writeFileSync(cfg.ratiosOut, `${headText},\n "samples": [\n${samples.map((s) => `  ${JSON.stringify(s)}`).join(",\n")}\n ]\n}\n`);
    }

    return { log, warnings, checks, finals, seriesFiles, seriesStats, ratios: ratiosOut };
}

async function main() {
    const cfg = parseArgs(process.argv.slice(2));
    const res = await buildCn(cfg);
    const fmt = (ms) => new Date(ms).toISOString().slice(0, 16);
    for (const l of res.log) console.log(l);
    for (const w of res.warnings) console.log(`WARN ${w}`);
    const eq = res.checks.filter((c) => c.equal).length;
    if (res.checks.length) console.log(`chart cross-check: ${eq}/${res.checks.length} chart finals equal the rk finals${eq < res.checks.length ? ` (diff: ${res.checks.filter((c) => !c.equal).map((c) => `#${c.eventId} T${c.rank} ${c.chart} vs ${c.final}`).join(", ")})` : ""}`);
    const evs = new Set(res.finals.map((f) => f.eventId));
    console.log(`finals: ${res.finals.length} rows, ${evs.size} events (#${Math.min(...evs)}..#${Math.max(...evs)}) -> ${path.join(cfg.out, "finals.json")}`);
    for (const [g, ids] of Object.entries(res.ratios.cnFinalEventsByGroup)) console.log(`  ${g}: ${ids.length} events [${ids.join(", ")}]`);
    for (const f of res.seriesFiles) console.log(`series -> ${f}`);
    for (const s of res.seriesStats) console.log(`  cn #${s.eventId} T${s.rank}: ${s.points} pts ${fmt(s.first)}..${fmt(s.last)}, ${s.dropped} dropped, ${s.source}`);
    console.log(`ratios: ${res.ratios.samples.length} samples${cfg.ratiosOut ? ` -> ${cfg.ratiosOut}` : " (not written; --ratios-out <file> writes them)"}`);
    for (const c of res.ratios.cells) {
        console.log(`  ${c.key}: ${c.nEvents} events, duration ratio ${c.meanDurationRatio}, pooled slope ${c.pooledTrend?.slopePerYear ?? "-"}/y`);
        for (const t of c.tiers) {
            const d = t.durationTrend;
            console.log(`    T${t.rank}: n=${t.n} median ${t.medianRatio} sdLog ${t.sdLogRatio ?? "-"} slope ${t.trend?.slopePerYear ?? "-"}/y (resid ${t.trend?.residualSd ?? "-"})${t.recentTrend ? ` recent25 ${t.recentTrend.slopePerYear}/y` : ""}${d ? ` | +duration: slope ${d.slopePerYear}/y elasticity ${d.durationElasticity}±${d.durationElasticitySe} resid ${d.residualSd}` : ""}`);
        }
    }
    for (const g of res.ratios.gaps) console.log(`GAP ${g}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
