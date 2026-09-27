// 回测数据集：读取提交的活动表 / 终榜与 sessions 下的逐时序列，并提供按 (区服, 活动, 范围) 的索引工具。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scopeGroup, scopeWindow } from "../../src/lib/prediction/model/dataset-context.ts";

export { scopeGroup, scopeWindow };

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SESSIONS_MODEL_DIR = "/Volumes/Amia/Akiyama_mizuki/Coding/sessions/prediction-model";
export const DEFAULT_DATA_DIR = path.join(SESSIONS_MODEL_DIR, "data");
export const COMMITTED_DATA_DIR = path.join(HERE, "data");

// 序列末点距结算不超过该值时，可在缺少终榜记录时当作终榜。
export const SERIES_FINAL_TOLERANCE_MS = 15 * 60_000;

const VS_CHARACTER_MIN = 21;
const VS_CHARACTER_MAX = 26;

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readOptionalArray(file, log) {
    if (!fs.existsSync(file)) {
        log(`[dataset] 缺少 ${file}，按空表处理`);
        return [];
    }
    const rows = readJson(file);
    if (!Array.isArray(rows)) throw new Error(`${file} 不是数组`);
    return rows;
}

function assertEvent(ev) {
    const ok = ev && (ev.region === "jp" || ev.region === "cn")
        && Number.isFinite(ev.eventId) && Number.isFinite(ev.startAt) && Number.isFinite(ev.aggregateAt)
        && Array.isArray(ev.chapters);
    if (!ok) throw new Error(`events.json 行格式不符合 DatasetEvent：${JSON.stringify(ev).slice(0, 200)}`);
}

/**
 * loadDataset(dataDir) → { events, series, finals, missingSeries }
 * events / finals 来自提交的 JSON（committedDir），series 来自 `<dataDir>/series/<region>-<eventId>.json`；缺失的序列文件记入 missingSeries。
 */
export function loadDataset(dataDir = DEFAULT_DATA_DIR, { committedDir = COMMITTED_DATA_DIR, log = console.warn } = {}) {
    const eventsFile = path.join(committedDir, "events.json");
    if (!fs.existsSync(eventsFile)) throw new Error(`缺少活动表 ${eventsFile}（由 build-events.mjs 生成）`);
    const events = readJson(eventsFile);
    if (!Array.isArray(events)) throw new Error(`${eventsFile} 不是数组`);
    events.forEach(assertEvent);
    events.sort((a, b) => a.startAt - b.startAt || a.region.localeCompare(b.region) || a.eventId - b.eventId);

    const finals = [
        ...readOptionalArray(path.join(committedDir, "finals-jp.json"), log),
        ...readOptionalArray(path.join(committedDir, "cn", "finals.json"), log),
    ];

    const series = [];
    const missingSeries = [];
    const seriesDir = path.join(dataDir, "series");
    for (const ev of events) {
        const file = path.join(seriesDir, `${ev.region}-${ev.eventId}.json`);
        if (!fs.existsSync(file)) {
            missingSeries.push(`${ev.region}-${ev.eventId}`);
            continue;
        }
        const rows = readJson(file);
        if (!Array.isArray(rows)) throw new Error(`${file} 不是 DatasetSeries[]`);
        for (const s of rows) {
            if (s.region !== ev.region || s.eventId !== ev.eventId) {
                throw new Error(`${file} 含有其他活动的序列：${s.region}-${s.eventId}`);
            }
            series.push(s);
        }
    }
    return { events, series, finals, missingSeries };
}

export function eventKey(region, eventId) {
    return `${region}-${eventId}`;
}

export function scopeKey(scope) {
    return scope.kind === "chapter" ? `ch${scope.gameCharacterId}` : "overall";
}

export function scopeRef(region, eventId, scope) {
    return `${eventKey(region, eventId)}/${scopeKey(scope)}`;
}

/** 活动的全部统计范围：总榜，加上非终章 WL 的各章节。 */
export function scopesOf(ev) {
    const scopes = [{ kind: "overall" }];
    if (!ev.isFinale && ev.eventType === "world_bloom") {
        for (const c of ev.chapters) {
            if (c.gameCharacterId != null) scopes.push({ kind: "chapter", gameCharacterId: c.gameCharacterId });
        }
    }
    return scopes;
}

function isVsEvent(ev) {
    return ev.chapters.length > 0
        && ev.chapters.every((c) => c.gameCharacterId != null && c.gameCharacterId >= VS_CHARACTER_MIN && c.gameCharacterId <= VS_CHARACTER_MAX);
}

/**
 * 回测单元格：组别 × WL 期数 × 区服，另加契约要求分开的维度：
 * 普通活动按疲劳槽参数套（#197 / #198 起），WL 按 VS 期与团期分开，终章按 (区服, 活动) 单列。
 */
export function cellOf(ev, scope) {
    const group = scopeGroup(ev, scope);
    let variant = "";
    if (group === "wl_finale") variant = `#${ev.eventId}`;
    else if (group === "normal") variant = `bt${ev.breakTimeId ?? 0}`;
    else if (isVsEvent(ev)) variant = "vs";
    return {
        key: `${ev.region}|${group}|${ev.wlTurn ?? "-"}|${variant}`,
        region: ev.region,
        group,
        wlTurn: ev.wlTurn ?? null,
        variant,
    };
}

/** 按 (区服, 活动, 范围) 建索引：序列按档位、终榜按档位。 */
export function indexDataset(data) {
    const series = new Map();
    for (const s of data.series) {
        const ref = scopeRef(s.region, s.eventId, s.scope);
        let byRank = series.get(ref);
        if (!byRank) series.set(ref, (byRank = new Map()));
        byRank.set(s.rank, s);
    }
    const finals = new Map();
    for (const f of data.finals) {
        const ref = scopeRef(f.region, f.eventId, f.scope);
        let byRank = finals.get(ref);
        if (!byRank) finals.set(ref, (byRank = new Map()));
        byRank.set(f.rank, f.score);
    }
    const events = new Map(data.events.map((ev) => [eventKey(ev.region, ev.eventId), ev]));
    return {
        events,
        seriesOf(region, eventId, scope) {
            return series.get(scopeRef(region, eventId, scope)) ?? new Map();
        },
        finalsOf(region, eventId, scope) {
            return finals.get(scopeRef(region, eventId, scope)) ?? new Map();
        },
    };
}

/**
 * 该范围各档终榜：优先终榜表；没有时取末点在结算前 SERIES_FINAL_TOLERANCE_MS 内的序列末值。
 * 返回 Map<rank, { score, source: "final" | "series" }>。
 */
export function actualFinals(index, ev, scope) {
    const out = new Map();
    for (const [rank, score] of index.finalsOf(ev.region, ev.eventId, scope)) {
        if (Number.isFinite(score) && score > 0) out.set(rank, { score, source: "final" });
    }
    const { endAt } = scopeWindow(ev, scope);
    for (const [rank, s] of index.seriesOf(ev.region, ev.eventId, scope)) {
        if (out.has(rank) || s.points.length === 0) continue;
        const [t, y] = s.points[s.points.length - 1];
        if (t >= endAt - SERIES_FINAL_TOLERANCE_MS && y > 0) out.set(rank, { score: y, source: "series" });
    }
    return out;
}

/** 升序序列中 t ≤ atMs 的最后一个点的下标；没有返回 -1。 */
export function lastIndexAtOrBefore(points, atMs) {
    let lo = 0;
    let hi = points.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid][0] <= atMs) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

/**
 * 序列在时刻 t 的分数（线性插值；范围开始时视为 0 分）。
 * t 在末点之后超过 maxGapMs、或两侧点间隔超过 maxGapMs 时返回 null。
 */
export function scoreAt(points, t, startAt, maxGapMs) {
    if (points.length === 0 || t < startAt) return null;
    const i = lastIndexAtOrBefore(points, t);
    const [t0, y0] = i >= 0 ? points[i] : [startAt, 0];
    if (t === t0) return y0;
    if (i === points.length - 1) return t - t0 <= maxGapMs ? y0 : null;
    const [t1, y1] = points[i + 1];
    if (t1 - t0 > maxGapMs) return null;
    return y0 + ((y1 - y0) * (t - t0)) / (t1 - t0);
}

/** 训练子集：只含给定活动及其序列、终榜。 */
export function subsetDataset(data, events) {
    const keys = new Set(events.map((ev) => eventKey(ev.region, ev.eventId)));
    return {
        events: [...events].sort((a, b) => a.startAt - b.startAt || a.eventId - b.eventId),
        series: data.series.filter((s) => keys.has(eventKey(s.region, s.eventId))),
        finals: data.finals.filter((f) => keys.has(eventKey(f.region, f.eventId))),
    };
}
