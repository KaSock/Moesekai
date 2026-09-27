#!/usr/bin/env node
/**
 * JP hourly border history from sekai.best: resumable fetcher, DatasetSeries builder and checks.
 *
 * Usage (from web/):
 *   node scripts/prediction-backtest/fetch-sekai-best.mjs get <url>
 *   node scripts/prediction-backtest/fetch-sekai-best.mjs probe [--events 1,60,120,180,217] [--chapter-event 214]
 *   node scripts/prediction-backtest/fetch-sekai-best.mjs fetch [--events 1-217] [--ranks 1,2,...] [--no-chapters] [--concurrency 1|2]
 *   node scripts/prediction-backtest/fetch-sekai-best.mjs build [--events 1-217] [--data <dir>] [--out <dir>]
 *   node scripts/prediction-backtest/fetch-sekai-best.mjs check [--events 1-217] [--data <dir>] [--out <dir>] [--borders <dir>]
 * Every command also takes --raw <cache dir> and --master <dir with jp_events.json, jp_worldBlooms.json>.
 * probe writes <raw>/ranks.json (fetch uses its `available` ranks), fetch logs to <raw>/fetch.log and
 * <raw>/progress.json, build writes <out>/jp-<eventId>.json plus <raw>/build-report.json, check writes
 * <raw>/check-report.json.
 *
 * Endpoints (from the sekai-viewer client, src/utils/eventTracker.ts):
 *   overall  /event/<id>/rankings/graph?region=jp&rank=<N>
 *   chapter  /event/<id>/chapter_rankings/graph?region=jp&charaId=<gameCharacterId>&rank=<N>
 *
 * Politeness: request starts at least 1.1 s apart (at most two in flight), a project User-Agent, every
 * final answer (2xx and definitive 4xx such as 404) cached per URL under --raw and never requested
 * again. 403/429/5xx and network errors are retried with backoff and never cached; three URLs in a row
 * failing that way stop the run with exit code 2. Cached bodies keep rank/score/timestamp only (player
 * identity dropped).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { WORK_ROOT } from "./workdir.mjs";

export const DEFAULTS = {
    raw: path.join(WORK_ROOT, "prediction-model/raw/sekai-best"),
    data: path.join(WORK_ROOT, "prediction-model/data"),
    master: path.join(WORK_ROOT, "wlrules"),
    borders: path.join(WORK_ROOT, "jp-border-data"),
};
const API = "https://api.sekai.best";
const USER_AGENT = "Moesekai-prediction-model/1.0 (+https://pjsk.moe)";
const MIN_INTERVAL_MS = 1100;
const MAX_ATTEMPTS = 5;
const STOP_AFTER_FAILED_URLS = 3;
/** 4xx answers that describe the resource itself and are safe to cache. */
const DEFINITIVE_4XX = new Set([400, 404, 410, 422]);
export const CANDIDATE_RANKS = [
    1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 100, 200, 300, 400, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000,
    10000, 20000, 30000, 40000, 50000, 100000,
];

// ---------- CLI ----------

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith("--")) out[key] = true;
            else {
                out[key] = next;
                i++;
            }
        } else out._.push(a);
    }
    return out;
}

/** "1-5,9,12-13" -> [1,2,3,4,5,9,12,13] */
export function parseIdList(spec) {
    const ids = [];
    for (const part of String(spec).split(",")) {
        const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
        if (!m) throw new Error(`bad id list: ${spec}`);
        const a = Number(m[1]);
        const b = m[2] ? Number(m[2]) : a;
        for (let x = a; x <= b; x++) ids.push(x);
    }
    return ids;
}

// ---------- URLs and cache ----------

export function overallUrl(eventId, rank) {
    return `${API}/event/${eventId}/rankings/graph?region=jp&rank=${rank}`;
}

export function chapterUrl(eventId, charaId, rank) {
    return `${API}/event/${eventId}/chapter_rankings/graph?region=jp&charaId=${charaId}&rank=${rank}`;
}

export function cachePath(rawDir, url) {
    const u = new URL(url);
    const query = [...u.searchParams.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
        .replace(/[^A-Za-z0-9=&._-]/g, "_");
    const segments = u.pathname.split("/").filter(Boolean).map((s) => s.replace(/[^A-Za-z0-9._-]/g, "_"));
    return path.join(rawDir, "cache", ...segments, `${query || "_"}.json.gz`);
}

export function readCache(rawDir, url) {
    const file = cachePath(rawDir, url);
    if (!existsSync(file)) return null;
    return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
}

function writeCache(rawDir, url, entry) {
    const file = cachePath(rawDir, url);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, gzipSync(JSON.stringify(entry)));
    renameSync(tmp, file);
}

/** Keep only what the model needs from each ranking row. */
function stripBody(body) {
    const rows = body?.data?.eventRankings;
    if (!Array.isArray(rows)) return body;
    return {
        ...body,
        data: {
            ...body.data,
            eventRankings: rows.map((r) =>
                r && typeof r === "object" ? { eventId: r.eventId, timestamp: r.timestamp, rank: r.rank, score: r.score } : r,
            ),
        },
    };
}

// ---------- polite fetcher ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StopError extends Error {}

export class PoliteFetcher {
    constructor({ rawDir, log }) {
        this.rawDir = rawDir;
        this.log = log;
        this.lastRequestAt = 0;
        this.failedInARow = 0;
        this.requests = 0;
    }

    /** Reserves the next start slot, so concurrent callers still start at most one request per interval. */
    async throttle() {
        const now = Date.now();
        const slot = Math.max(now, this.lastRequestAt + MIN_INTERVAL_MS);
        this.lastRequestAt = slot;
        if (slot > now) await sleep(slot - now);
    }

    /** Returns the cache entry { url, status, fetchedAt, bytes, body }; `fromCache` marks cache hits. */
    async get(url) {
        const cached = readCache(this.rawDir, url);
        if (cached) return { ...cached, fromCache: true };
        let lastProblem = "";
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            await this.throttle();
            this.requests++;
            let res;
            try {
                res = await fetch(url, {
                    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
                    signal: AbortSignal.timeout(60_000),
                });
            } catch (e) {
                lastProblem = `network ${e?.cause?.code ?? e?.name ?? ""} ${e?.message ?? e}`;
                await this.backoff(attempt, null, url, lastProblem);
                continue;
            }
            const text = await res.text();
            if (res.ok || DEFINITIVE_4XX.has(res.status)) {
                let body;
                try {
                    body = JSON.parse(text);
                } catch {
                    body = text.slice(0, 2000);
                }
                const entry = {
                    url,
                    status: res.status,
                    fetchedAt: new Date().toISOString(),
                    bytes: text.length,
                    body: res.ok ? stripBody(body) : body,
                };
                writeCache(this.rawDir, url, entry);
                this.failedInARow = 0;
                return { ...entry, fromCache: false };
            }
            lastProblem = `HTTP ${res.status} ${text.slice(0, 200).replace(/\s+/g, " ")}`;
            await this.backoff(attempt, res.headers.get("retry-after"), url, lastProblem);
        }
        this.failedInARow++;
        this.log(`FAIL ${url} after ${MAX_ATTEMPTS} attempts: ${lastProblem}`);
        if (this.failedInARow >= STOP_AFTER_FAILED_URLS) {
            throw new StopError(`${this.failedInARow} URLs in a row failed; last: ${url} ${lastProblem}`);
        }
        return null;
    }

    async backoff(attempt, retryAfter, url, problem) {
        if (attempt >= MAX_ATTEMPTS) return;
        const hinted = Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 0;
        const ms = Math.max(hinted, Math.min(120_000, 2000 * 2 ** (attempt - 1)));
        this.log(`RETRY ${attempt}/${MAX_ATTEMPTS - 1} in ${ms} ms: ${url} (${problem})`);
        // Pause every worker, not just this one.
        this.lastRequestAt = Math.max(this.lastRequestAt, Date.now() + ms - MIN_INTERVAL_MS);
        await sleep(ms);
    }
}

/** Runs `fn` over `items` with at most `n` in flight; the fetcher's throttle still spaces request starts. */
async function runPool(items, n, fn) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) await fn(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function makeLogger(rawDir, name) {
    mkdirSync(rawDir, { recursive: true });
    const file = path.join(rawDir, name);
    return (msg) => {
        const line = `${new Date().toISOString()} ${msg}`;
        appendFileSync(file, `${line}\n`);
        console.log(line);
    };
}

/** Rows of a cached graph answer, or [] for 404/empty answers. */
export function rowsOf(entry) {
    if (!entry || entry.status !== 200) return [];
    const rows = entry.body?.data?.eventRankings;
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r === "object") : [];
}

// ---------- masterdata ----------

export function loadMaster(masterDir) {
    const events = JSON.parse(readFileSync(path.join(masterDir, "jp_events.json"), "utf8"));
    const worldBlooms = JSON.parse(readFileSync(path.join(masterDir, "jp_worldBlooms.json"), "utf8"));
    return { events, worldBlooms };
}

/** Character chapters of an event, by chapterNo; finales have no character chapter. */
export function characterChapters(worldBlooms, eventId) {
    return worldBlooms
        .filter((w) => w.eventId === eventId && w.worldBloomChapterType === "game_character" && w.gameCharacterId)
        .sort((a, b) => a.chapterNo - b.chapterNo);
}

// ---------- commands ----------

async function cmdGet(args) {
    const rawDir = args.raw ?? DEFAULTS.raw;
    const log = makeLogger(rawDir, "fetch.log");
    const f = new PoliteFetcher({ rawDir, log });
    const url = args._[1];
    const entry = await f.get(url);
    if (!entry) return;
    const rows = rowsOf(entry);
    console.log(JSON.stringify({ url, status: entry.status, bytes: entry.bytes, fromCache: entry.fromCache, rows: rows.length, first: rows[0], last: rows.at(-1) }, null, 1));
}


function selectedEvents(master, spec, now = Date.now()) {
    const wanted = spec ? new Set(parseIdList(spec)) : null;
    return master.events
        .filter((e) => e.aggregateAt < now && (!wanted || wanted.has(e.id)))
        .sort((a, b) => a.id - b.id);
}

function writeJson(file, value) {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
    renameSync(tmp, file);
}

/** Fetch every candidate rank for a few events of different eras and record which ranks ever answer. */
async function cmdProbe(args) {
    const rawDir = args.raw ?? DEFAULTS.raw;
    const master = loadMaster(args.master ?? DEFAULTS.master);
    const log = makeLogger(rawDir, "fetch.log");
    const f = new PoliteFetcher({ rawDir, log });
    const events = parseIdList(args.events ?? "1,60,120,180,217");
    const chapterEvent = Number(args["chapter-event"] ?? 214);
    const [chapter] = characterChapters(master.worldBlooms, chapterEvent);
    const targets = [
        ...events.map((id) => ({ label: `#${id}`, url: (r) => overallUrl(id, r) })),
        ...(chapter ? [{ label: `#${chapterEvent}c${chapter.gameCharacterId}`, url: (r) => chapterUrl(chapterEvent, chapter.gameCharacterId, r) }] : []),
    ];
    const table = {};
    for (const rank of CANDIDATE_RANKS) {
        table[rank] = {};
        for (const t of targets) {
            const entry = await f.get(t.url(rank));
            table[rank][t.label] = entry ? (entry.status === 200 ? rowsOf(entry).length : `HTTP ${entry.status}`) : "fail";
        }
        log(`probe T${rank}: ${JSON.stringify(table[rank])}`);
    }
    const available = CANDIDATE_RANKS.filter((r) => Object.values(table[r]).some((v) => typeof v === "number" && v > 0));
    const absent = CANDIDATE_RANKS.filter((r) => !available.includes(r));
    writeJson(path.join(rawDir, "ranks.json"), { probedAt: new Date().toISOString(), targets: targets.map((t) => t.label), table, available, absent });
    log(`probe done: available ${available.join(",")}; absent ${absent.join(",") || "none"}`);
}

function loadRanks(rawDir, spec) {
    if (spec) {
        const ranks = String(spec).split(",").map(Number);
        if (!ranks.every((r) => Number.isInteger(r) && r > 0)) throw new Error(`bad rank list: ${spec}`);
        return ranks;
    }
    const file = path.join(rawDir, "ranks.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).available;
    return CANDIDATE_RANKS;
}

/** Every (scope, rank, url) the fetcher wants for one event. */
export function eventJobs(event, worldBlooms, ranks, withChapters = true) {
    const jobs = ranks.map((rank) => ({ scope: { kind: "overall" }, rank, url: overallUrl(event.id, rank) }));
    if (withChapters) {
        for (const ch of characterChapters(worldBlooms, event.id)) {
            for (const rank of ranks) {
                jobs.push({
                    scope: { kind: "chapter", gameCharacterId: ch.gameCharacterId },
                    rank,
                    url: chapterUrl(event.id, ch.gameCharacterId, rank),
                });
            }
        }
    }
    return jobs;
}

async function cmdFetch(args) {
    const rawDir = args.raw ?? DEFAULTS.raw;
    const master = loadMaster(args.master ?? DEFAULTS.master);
    const log = makeLogger(rawDir, "fetch.log");
    const f = new PoliteFetcher({ rawDir, log });
    const ranks = loadRanks(rawDir, args.ranks);
    const events = selectedEvents(master, args.events ?? "1-217").reverse();
    const withChapters = !args["no-chapters"];
    const concurrency = Math.max(1, Math.min(2, Number(args.concurrency ?? 2)));
    const plan = events.map((e) => ({ event: e, jobs: eventJobs(e, master.worldBlooms, ranks, withChapters) }));
    const total = plan.reduce((n, p) => n + p.jobs.length, 0);
    const pending = plan.reduce((n, p) => n + p.jobs.filter((j) => !existsSync(cachePath(rawDir, j.url))).length, 0);
    log(`fetch start: ${events.length} events (newest first), ranks ${ranks.join(",")}, chapters ${withChapters}, concurrency ${concurrency}, ${total} URLs, ${pending} not cached (~${Math.ceil((pending * MIN_INTERVAL_MS) / 60000)} min)`);
    const progressFile = path.join(rawDir, "progress.json");
    const failed = [];
    let done = 0;
    const startedAt = Date.now();
    const requestsAtStart = f.requests;
    for (const { event, jobs } of plan) {
        let fetched = 0;
        let withData = 0;
        let notFound = 0;
        await runPool(jobs, concurrency, async (job) => {
            const entry = await f.get(job.url);
            done++;
            if (!entry) {
                failed.push(job.url);
                return;
            }
            if (!entry.fromCache) fetched++;
            if (entry.status !== 200) notFound++;
            else if (rowsOf(entry).length > 0) withData++;
        });
        const reqs = f.requests - requestsAtStart;
        const perReq = reqs > 0 ? (Date.now() - startedAt) / reqs : MIN_INTERVAL_MS;
        const left = pending - reqs;
        log(
            `#${event.id} ${event.eventType}: ${jobs.length} URLs, ${withData} with data, ${notFound} non-200, ${fetched} fetched now; ` +
                `progress ${done}/${total}, requests ${reqs}, ETA ~${Math.max(0, Math.ceil((left * perReq) / 60000))} min`,
        );
        writeJson(progressFile, { updatedAt: new Date().toISOString(), lastEvent: event.id, done, total, requests: reqs, failed });
    }
    log(`fetch done: ${done}/${total} URLs, ${f.requests - requestsAtStart} requests, ${failed.length} failed`);
    if (failed.length) process.exitCode = 3;
}

// ---------- build ----------

const HOUR = 3_600_000;
/** Snapshots taken after aggregation show the frozen final; later ones add nothing. */
const AFTER_END_GRACE_MS = HOUR;
/**
 * A border falling by more than this between two snapshots is a ranking recalculation (JP #45 fell by
 * 26-94% on every tier), not a ban; readings before the last such fall are discarded. Real drops seen
 * elsewhere stay under 2%.
 */
const RESET_DROP = 0.1;

function scopeWindow(event, worldBlooms, scope) {
    if (scope.kind === "overall") return { startAt: event.startAt, endAt: event.aggregateAt };
    const ch = characterChapters(worldBlooms, event.id).find((c) => c.gameCharacterId === scope.gameCharacterId);
    return { startAt: ch.chapterStartAt, endAt: ch.aggregateAt };
}

/** Cached rows -> ascending [t, score] points inside the scope window, with counts of what was dropped. */
export function cleanPoints(rows, rank, window) {
    const stats = { rows: rows.length, badRow: 0, otherRank: 0, beforeStart: 0, afterEnd: 0, duplicateTime: 0, duplicateConflict: 0, beforeReset: 0, decreases: 0, maxDropRel: 0 };
    const pts = [];
    for (const r of rows) {
        const t = Date.parse(r.timestamp);
        const y = Number(r.score);
        if (!Number.isFinite(t) || !Number.isFinite(y) || y < 0) {
            stats.badRow++;
            continue;
        }
        if (Number(r.rank) !== rank) {
            stats.otherRank++;
            continue;
        }
        if (t < window.startAt) {
            stats.beforeStart++;
            continue;
        }
        if (t > window.endAt + AFTER_END_GRACE_MS) {
            stats.afterEnd++;
            continue;
        }
        pts.push([t, y]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    const out = [];
    // Borders never fall over time, so of two readings stamped alike the larger one is the later.
    for (const p of pts) {
        const prev = out.at(-1);
        if (prev && prev[0] === p[0]) {
            stats.duplicateTime++;
            if (prev[1] !== p[1]) stats.duplicateConflict++;
            prev[1] = Math.max(prev[1], p[1]);
        } else out.push(p);
    }
    let resetAt = 0;
    for (let i = 1; i < out.length; i++) if (out[i][1] < out[i - 1][1] * (1 - RESET_DROP)) resetAt = i;
    stats.beforeReset = resetAt;
    const kept = out.slice(resetAt);
    for (let i = 1; i < kept.length; i++) {
        if (kept[i][1] < kept[i - 1][1]) {
            stats.decreases++;
            stats.maxDropRel = Math.max(stats.maxDropRel, (kept[i - 1][1] - kept[i][1]) / kept[i - 1][1]);
        }
    }
    return { points: kept, stats };
}

export function seriesFile(outDir, eventId) {
    return path.join(outDir, `jp-${eventId}.json`);
}

function scopeKey(scope) {
    return scope.kind === "overall" ? "overall" : `chapter:${scope.gameCharacterId}`;
}

async function cmdBuild(args) {
    const rawDir = args.raw ?? DEFAULTS.raw;
    const dataDir = args.data ?? DEFAULTS.data;
    const outDir = args.out ?? path.join(dataDir, "series");
    const master = loadMaster(args.master ?? DEFAULTS.master);
    const events = selectedEvents(master, args.events ?? "1-217");
    mkdirSync(outDir, { recursive: true });
    const report = { builtAt: new Date().toISOString(), outDir, events: {} };
    let files = 0;
    let seriesCount = 0;
    for (const event of events) {
        const series = [];
        const perScope = {};
        const uncached = [];
        for (const job of eventJobs(event, master.worldBlooms, CANDIDATE_RANKS, true)) {
            const entry = readCache(rawDir, job.url);
            if (!entry) {
                uncached.push(job.rank);
                continue;
            }
            const rows = rowsOf(entry);
            if (!rows.length) continue;
            const { points, stats } = cleanPoints(rows, job.rank, scopeWindow(event, master.worldBlooms, job.scope));
            const key = scopeKey(job.scope);
            (perScope[key] ??= {})[job.rank] = { points: points.length, ...stats };
            if (!points.length) continue;
            series.push({
                region: "jp",
                eventId: event.id,
                scope: job.scope,
                rank: job.rank,
                points,
                source: job.scope.kind === "overall" ? "sekai.best/rankings/graph" : "sekai.best/chapter_rankings/graph",
            });
        }
        report.events[event.id] = { eventType: event.eventType, series: series.length, scopes: perScope, uncachedUrls: uncached.length };
        const file = seriesFile(outDir, event.id);
        if (series.length) {
            writeFileSync(file, `${JSON.stringify(series)}\n`);
            files++;
            seriesCount += series.length;
        }
    }
    writeJson(path.join(rawDir, "build-report.json"), report);
    console.log(`build: ${files} files, ${seriesCount} series in ${outDir}; report ${path.join(rawDir, "build-report.json")}`);
}

// ---------- check ----------

const JST_MS = 9 * HOUR;

export function normalizeName(name) {
    return String(name).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function editDistance(a, b) {
    const d = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let prev = d[0];
        d[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cur = d[j];
            d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = cur;
        }
    }
    return d[b.length];
}

function nameSimilarity(a, b) {
    const x = normalizeName(a);
    const y = normalizeName(b);
    return 1 - editDistance(x, y) / Math.max(x.length, y.length, 1);
}

function jstDate(ms) {
    return new Date(ms + JST_MS).toISOString().slice(0, 10);
}

/** Linear interpolation of ascending [t, y] points at t; null outside them or across a gap wider than maxGapMs. */
export function valueAt(points, t, maxGapMs) {
    if (!points.length || t < points[0][0] || t > points.at(-1)[0]) return null;
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (points[mid][0] <= t) lo = mid;
        else hi = mid;
    }
    const [t0, y0] = points[lo];
    const [t1, y1] = points[hi];
    if (t1 === t0) return y0;
    if (t1 - t0 > maxGapMs) return null;
    return y0 + ((y1 - y0) * (t - t0)) / (t1 - t0);
}

/**
 * Series reading to compare with a reference reading taken at t: the final for t at or after the scope
 * end (the series must reach the end), otherwise the nearest point within tolMs.
 */
export function seriesValueNear(points, t, endAt, tolMs = 5 * 60_000) {
    if (!points.length) return null;
    const last = points.at(-1);
    if (t >= endAt - 1000) return last[0] >= endAt - 30 * 60_000 ? last[1] : null;
    let best = null;
    for (const p of points) {
        if (best === null || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
        if (p[0] > t) break;
    }
    return Math.abs(best[0] - t) <= tolMs ? best[1] : null;
}

function loadSeries(outDir, eventId) {
    const file = seriesFile(outDir, eventId);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

function summarize(diffs) {
    const abs = diffs.map((d) => Math.abs(d.rel)).sort((a, b) => a - b);
    const q = (p) => (abs.length ? abs[Math.min(abs.length - 1, Math.floor(p * abs.length))] : null);
    return {
        n: abs.length,
        exact: abs.filter((x) => x === 0).length,
        within01pct: abs.filter((x) => x <= 0.001).length,
        within1pct: abs.filter((x) => x <= 0.01).length,
        medianAbsRel: q(0.5),
        p95AbsRel: q(0.95),
        maxAbsRel: abs.at(-1) ?? null,
    };
}

/**
 * Finals table rows aligned to game ids (its own ids are not game ids): same normalized name first,
 * else same JST start date with a similar name. Disagreements are returned as notes.
 */
export function alignFinalsTable(table, events) {
    const aligned = [];
    const unaligned = [];
    const notes = [];
    for (const row of table) {
        const sameName = events.filter((e) => normalizeName(e.name) === normalizeName(row.name));
        let ev = null;
        if (sameName.length) {
            ev = sameName.sort((a, b) => Math.abs(Date.parse(row.start_date) - a.startAt) - Math.abs(Date.parse(row.start_date) - b.startAt))[0];
            if (jstDate(ev.startAt) !== row.start_date) notes.push({ tableId: row.id, eventId: ev.id, note: `start_date ${row.start_date} but event starts ${jstDate(ev.startAt)}` });
        } else {
            const sameDay = events.filter((e) => jstDate(e.startAt) === row.start_date);
            if (sameDay.length === 1 && nameSimilarity(sameDay[0].name, row.name) >= 0.75) {
                ev = sameDay[0];
                notes.push({ tableId: row.id, eventId: ev.id, note: `name "${row.name}" vs "${ev.name}"` });
            }
        }
        if (ev) aligned.push({ row, event: ev });
        else unaligned.push({ id: row.id, name: row.name, start_date: row.start_date });
    }
    return { aligned, unaligned, notes };
}

function checkFinals(bordersDir, master, outDir) {
    const table = JSON.parse(readFileSync(path.join(bordersDir, "jp_event_borders_all.json"), "utf8"));
    const { aligned, unaligned, notes } = alignFinalsTable(table, master.events);
    const diffs = [];
    const perEvent = [];
    for (const { row, event } of aligned) {
        const borders = Object.entries(row.borders ?? {});
        if (!borders.length) continue;
        const series = loadSeries(outDir, event.id).filter((x) => x.scope.kind === "overall");
        const byRank = new Map(series.map((x) => [x.rank, x]));
        const evDiffs = [];
        for (const [label, score] of borders) {
            const rank = Number(label.replace(/\D/g, ""));
            const x = byRank.get(rank);
            if (!x || !Number(score)) continue;
            const last = x.points.at(-1);
            const d = { eventId: event.id, rank, table: Number(score), series: last[1], lastPointAfterEndMin: Math.round((last[0] - event.aggregateAt) / 60000), rel: (last[1] - Number(score)) / Number(score) };
            evDiffs.push(d);
            diffs.push(d);
        }
        perEvent.push({ eventId: event.id, tableId: row.id, compared: evDiffs.length, tableRanks: borders.length, ...summarize(evDiffs) });
    }
    return {
        tableRows: table.length,
        aligned: aligned.length,
        unaligned,
        alignmentNotes: notes,
        idMap: Object.fromEntries(aligned.map(({ row, event }) => [row.id, event.id])),
        eventsCompared: perEvent.filter((e) => e.compared > 0).length,
        overall: summarize(diffs),
        worst: diffs.sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel)).slice(0, 25),
        perEvent,
    };
}

/** Parses the daily timeline workbook export: normal, WL overall, WL chapter and finale sheets. */
export function parseTimelineSheets(workbook, master) {
    const sheets = [];
    for (const [sheetName, rows] of Object.entries(workbook)) {
        const isChapter = sheetName.startsWith("单章推移表");
        if (!isChapter && !sheetName.startsWith("总榜推移表") && !sheetName.startsWith("榜线推移表")) continue;
        const title = String(rows[0]?.[0] ?? "");
        const m = title.match(/^(.*?)\s*(?:総合|章节別)?全档位/);
        if (!m) continue;
        const event = master.events.find((e) => normalizeName(e.name) === normalizeName(m[1]));
        if (!event) {
            sheets.push({ sheetName, title, error: "event not found" });
            continue;
        }
        const header = rows.find((r) => r[0] === "档位 / 时间");
        const chapterRow = rows.find((r) => r[0] === "章节");
        const startYear = new Date(event.startAt + JST_MS).getUTCFullYear();
        const startMonth = new Date(event.startAt + JST_MS).getUTCMonth() + 1;
        const chapters = characterChapters(master.worldBlooms, event.id);
        const columns = [];
        let chapterIdx = -1;
        header.forEach((cell, i) => {
            if (chapterRow && i > 0 && chapterRow[i]) chapterIdx++;
            const dm = String(cell).match(/^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/);
            if (!dm) return;
            const [mo, d, h, mi] = dm.slice(1).map(Number);
            const year = mo < startMonth ? startYear + 1 : startYear;
            const t = Date.UTC(year, mo - 1, d, h, mi) - JST_MS;
            const scope = isChapter ? { kind: "chapter", gameCharacterId: chapters[chapterIdx]?.gameCharacterId } : { kind: "overall" };
            columns.push({ i, t, scope });
        });
        const values = [];
        for (const r of rows) {
            const rm = String(r[0] ?? "").match(/^第(\d+)名/);
            if (!rm) continue;
            for (const c of columns) {
                const v = r[c.i];
                if (typeof v === "number" && v > 0) values.push({ rank: Number(rm[1]), t: c.t, scope: c.scope, value: v });
            }
        }
        sheets.push({ sheetName, eventId: event.id, eventType: event.eventType, values });
    }
    return sheets;
}

function checkTimeline(bordersDir, master, outDir) {
    const workbook = JSON.parse(readFileSync(path.join(bordersDir, "timeline", "prsk_timelines_and_daily_speed_zh.json"), "utf8"));
    const out = [];
    for (const sheet of parseTimelineSheets(workbook, master)) {
        if (sheet.error) {
            out.push(sheet);
            continue;
        }
        const series = loadSeries(outDir, sheet.eventId);
        const event = master.events.find((e) => e.id === sheet.eventId);
        const diffs = [];
        let missing = 0;
        for (const v of sheet.values) {
            const x = series.find((s) => s.rank === v.rank && scopeKey(s.scope) === scopeKey(v.scope));
            const y = x ? seriesValueNear(x.points, v.t, scopeWindow(event, master.worldBlooms, v.scope).endAt) : null;
            if (y === null) {
                missing++;
                continue;
            }
            diffs.push({ rank: v.rank, scope: scopeKey(v.scope), at: new Date(v.t).toISOString(), table: v.value, series: Math.round(y), rel: (y - v.value) / v.value });
        }
        out.push({
            sheetName: sheet.sheetName,
            eventId: sheet.eventId,
            eventType: sheet.eventType,
            values: sheet.values.length,
            missing,
            ...summarize(diffs),
            worst: diffs.sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel)).slice(0, 5),
        });
    }
    return out;
}

/**
 * Local charts (their ids are local; aligned by name). Dense charts (<= 10 min steps) are interpolated at
 * each series point; sparse ones are compared at their own times like the daily tables. "Day N" charts
 * carry no timestamps and are skipped.
 */
function checkCharts(bordersDir, master, outDir) {
    const dir = path.join(bordersDir, "metrics", "charts");
    const out = [];
    for (const name of readdirSync(dir).filter((f) => f.startsWith("jp_") && f.endsWith(".json"))) {
        const chart = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
        const event = master.events.find((e) => normalizeName(e.name) === normalizeName(chart.eventName));
        if (!event) {
            out.push({ file: name, error: "event not found" });
            continue;
        }
        const series = loadSeries(outDir, event.id).filter((x) => x.scope.kind === "overall");
        const diffs = [];
        let skipped = 0;
        let undated = 0;
        for (const c of chart.charts ?? []) {
            const x = series.find((s) => s.rank === c.Rank);
            const ref = (c.HistoryPoints ?? [])
                .map((p) => [Date.parse(p.t), p.y])
                .filter(([t, y]) => Number.isFinite(t) && y > 0)
                .sort((a, b) => a[0] - b[0]);
            undated += (c.HistoryPoints ?? []).length - ref.length;
            if (!x || !ref.length) continue;
            const steps = ref.slice(1).map((p, i) => p[0] - ref[i][0]).sort((a, b) => a - b);
            const dense = steps.length > 0 && steps[steps.length >> 1] <= 10 * 60_000;
            const pairs = dense
                ? x.points.map(([t, y]) => [t, y, valueAt(ref, t, 10 * 60_000)])
                : ref.map(([t, v]) => [t, seriesValueNear(x.points, t, event.aggregateAt), v]);
            for (const [t, y, v] of pairs) {
                if (y === null || v === null) {
                    skipped++;
                    continue;
                }
                diffs.push({ rank: c.Rank, at: new Date(t).toISOString(), table: Math.round(v), series: y, dense, rel: (y - v) / v });
            }
        }
        out.push({ file: name, eventId: event.id, undated, skipped, ...summarize(diffs), worst: diffs.sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel)).slice(0, 5) });
    }
    return out;
}

function coverage(master, events, outDir) {
    const rows = [];
    for (const event of events) {
        const series = loadSeries(outDir, event.id);
        const scopes = [{ kind: "overall" }, ...characterChapters(master.worldBlooms, event.id).map((c) => ({ kind: "chapter", gameCharacterId: c.gameCharacterId }))];
        for (const scope of scopes) {
            const win = scopeWindow(event, master.worldBlooms, scope);
            const xs = series.filter((x) => scopeKey(x.scope) === scopeKey(scope));
            let worstGap = null;
            for (const x of xs) {
                for (let i = 1; i < x.points.length; i++) {
                    const ms = x.points[i][0] - x.points[i - 1][0];
                    if (!worstGap || ms > worstGap.ms) worstGap = { ms, from: x.points[i - 1][0] };
                }
            }
            const hours = (ms) => Math.round((ms / HOUR) * 10) / 10;
            rows.push({
                eventId: event.id,
                eventType: event.eventType,
                scope: scopeKey(scope),
                ranks: xs.map((x) => x.rank),
                minPoints: xs.length ? Math.min(...xs.map((x) => x.points.length)) : 0,
                maxPoints: xs.length ? Math.max(...xs.map((x) => x.points.length)) : 0,
                /** First reading of the scope (any rank) after its start; the deepest ranks naturally appear later. */
                startLagHours: xs.length ? hours(Math.min(...xs.map((x) => x.points[0][0])) - win.startAt) : null,
                maxGapHours: worstGap ? hours(worstGap.ms) : null,
                maxGapFrom: worstGap ? new Date(worstGap.from).toISOString() : null,
                lastPointBeforeEndHours: xs.length ? hours(win.endAt - Math.min(...xs.map((x) => x.points.at(-1)[0]))) : null,
                decreasingSeries: xs.filter((x) => x.points.some((p, i) => i > 0 && p[1] < x.points[i - 1][1])).length,
            });
        }
    }
    return rows;
}

async function cmdCheck(args) {
    const rawDir = args.raw ?? DEFAULTS.raw;
    const dataDir = args.data ?? DEFAULTS.data;
    const outDir = args.out ?? path.join(dataDir, "series");
    const bordersDir = args.borders ?? DEFAULTS.borders;
    const master = loadMaster(args.master ?? DEFAULTS.master);
    const events = selectedEvents(master, args.events ?? "1-217");
    const cov = coverage(master, events, outDir);
    const report = {
        checkedAt: new Date().toISOString(),
        finals: checkFinals(bordersDir, master, outDir),
        timeline: checkTimeline(bordersDir, master, outDir),
        charts: checkCharts(bordersDir, master, outDir),
        coverage: cov,
    };
    writeJson(path.join(rawDir, "check-report.json"), report);
    const f = report.finals;
    console.log(`finals table: ${f.tableRows} rows, ${f.aligned} aligned, ${f.unaligned.length} unaligned, ${f.eventsCompared} events compared: ${JSON.stringify(f.overall)}`);
    for (const t of report.timeline) console.log(`timeline ${t.sheetName} #${t.eventId ?? "?"} ${t.error ?? JSON.stringify({ values: t.values, missing: t.missing, n: t.n, exact: t.exact, within1pct: t.within1pct, medianAbsRel: t.medianAbsRel, maxAbsRel: t.maxAbsRel })}`);
    for (const c of report.charts) console.log(`chart ${c.file} #${c.eventId ?? "?"} ${c.error ?? JSON.stringify({ skipped: c.skipped, n: c.n, exact: c.exact, within1pct: c.within1pct, medianAbsRel: c.medianAbsRel, maxAbsRel: c.maxAbsRel })}`);
    const overall = cov.filter((r) => r.scope === "overall");
    const chapters = cov.filter((r) => r.scope !== "overall");
    console.log(`coverage: ${overall.filter((r) => r.ranks.length).length}/${overall.length} events with overall data, ${chapters.filter((r) => r.ranks.length).length}/${chapters.length} chapters with data, ${cov.reduce((n, r) => n + r.ranks.length, 0)} series`);
    for (const [label, rows] of [["overall", overall], ["chapter", chapters]]) {
        const perRank = CANDIDATE_RANKS.map((rank) => `T${rank}:${rows.filter((r) => r.ranks.includes(rank)).length}`);
        console.log(`  ${label} scopes with data per rank (of ${rows.length}): ${perRank.join(" ")}`);
        const firstWith = (rank) => rows.find((r) => r.ranks.includes(rank))?.eventId ?? "none";
        console.log(`  ${label} first event with T1500: ${firstWith(1500)}, with T2500: ${firstWith(2500)}`);
    }
    const describe = (r) => `#${r.eventId}${r.scope === "overall" ? "" : ` ${r.scope}`}`;
    const empty = cov.filter((r) => !r.ranks.length);
    console.log(`  scopes without data: ${empty.map(describe).join(", ") || "none"}`);
    const core = CANDIDATE_RANKS.filter((r) => r !== 1500 && r !== 2500);
    const partial = cov.filter((r) => r.ranks.length && core.some((k) => !r.ranks.includes(k)));
    console.log(`  scopes missing some of the other 26 ranks: ${partial.map((r) => `${describe(r)} [-${core.filter((k) => !r.ranks.includes(k)).join(",")}]`).join("; ") || "none"}`);
    const late = cov.filter((r) => r.startLagHours !== null && r.startLagHours > 1);
    console.log(`  scopes whose first reading is > 1 h after the start: ${late.map((r) => `${describe(r)} ${r.startLagHours}h`).join(", ") || "none"}`);
    const gappy = cov.filter((r) => r.maxGapHours !== null && r.maxGapHours > 3);
    console.log(`  scopes with an interior gap > 3 h: ${gappy.map((r) => `${describe(r)} ${r.maxGapHours}h from ${r.maxGapFrom.slice(0, 16)}`).join(", ") || "none"}`);
    const short = cov.filter((r) => r.lastPointBeforeEndHours !== null && r.lastPointBeforeEndHours > 0.5);
    console.log(`  scopes whose last point is > 0.5 h before the end: ${short.map((r) => `${describe(r)} ${r.lastPointBeforeEndHours}h`).join(", ") || "none"}`);
    console.log(`  series with a score decrease: ${cov.reduce((n, r) => n + r.decreasingSeries, 0)} in ${cov.filter((r) => r.decreasingSeries).length} scopes`);
    console.log(`report: ${path.join(rawDir, "check-report.json")}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    const commands = { get: cmdGet, probe: cmdProbe, fetch: cmdFetch, build: cmdBuild, check: cmdCheck };
    if (!commands[cmd]) {
        console.error(`unknown command ${cmd ?? ""}; expected one of ${Object.keys(commands).join(", ")}`);
        process.exit(1);
    }
    try {
        await commands[cmd](args);
    } catch (e) {
        if (e instanceof StopError) {
            console.error(`STOP: ${e.message}`);
            process.exit(2);
        }
        throw e;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
