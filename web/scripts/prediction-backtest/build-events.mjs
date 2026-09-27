/**
 * 活动元数据与日服终榜构建（D2）。
 *
 * 输出（提交到仓库）：
 *   data/events.json     DatasetEvent[]，两服 masterdata 里的全部活动；group / wlTurn / isFinale / autoSpecialMeasure 取自 resolveEventRules（overall 范围）。
 *   data/finals-jp.json  DatasetFinal[]，日服终榜。来源优先级：D1 的 sekai.best 序列（仅取结算后的快照）> 本机终榜表 > 本机逐日表。
 *   wlrules 快照缺的表（eventStories、国服 gameCharacterUnits）首次运行从 metadata 站取一次，缓存在 prediction-model/raw/masterdata。
 *
 * 本机终榜表的 id 不是游戏活动 id，按「活动名 + 开始日期（JST）」对齐 masterdata；对不上的行在报告里逐条列出。
 * 章节的 group（wl_chapter_72h / wl_chapter_48h）按章节时长由调用方或 resolveEventRules 的 chapter 范围得出，这里的 group 是整期（overall）的。
 *
 * 使用方法:
 *   node --experimental-strip-types scripts/prediction-backtest/build-events.mjs \
 *     [--wlrules <dir>] [--borders <dir>] [--data <dir>] [--masterdata-cache <dir>] [--out <dir>] [--report <file>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveEventRules, EVENT_RULE_TABLES } from '../../src/lib/event-rules/index.ts';
import { applyMasterdataPatches } from '../../src/lib/masterdata-patches.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS = '/Volumes/Amia/Akiyama_mizuki/Coding/sessions';

export const DEFAULTS = {
    wlrules: `${SESSIONS}/wlrules`,
    borders: `${SESSIONS}/jp-border-data`,
    data: `${SESSIONS}/prediction-model/data`,
    masterdataCache: `${SESSIONS}/prediction-model/raw/masterdata`,
    out: path.join(HERE, 'data'),
};

const REGIONS = ['jp', 'cn'];
const METADATA_BASE = 'https://metadata.exmeaning.com';
const USER_AGENT = 'Moesekai-prediction-model/1.0 (+https://pjsk.moe)';
const HOUR = 3_600_000;
const JST_OFFSET = 9 * HOUR;
// 逐日表的列时间是整点（20:00 / 21:00），结算时刻是前一秒（19:59:59 / 20:59:59）。
const COLUMN_FINAL_TOLERANCE_MS = 2 * HOUR;

export const SOURCE = {
    borders: 'jp_event_borders_all',
    timeline: 'prsk_timeline',
    sekaiBest: 'sekai.best',
};
// sekai.best 结算后快照是机器记录；两张本机表是人工转录，冲突处有数字对调、恰好差 9,000 等笔误（#18、#54、#187），
// 只补 sekai.best 没有结算后快照的活动与档位。
const SOURCE_PRIORITY = [SOURCE.sekaiBest, SOURCE.borders, SOURCE.timeline];

// 本机终榜表的活动类型 → masterdata eventType，用于核对对齐结果。
const LEGACY_TYPE = {
    'マラソン': 'marathon',
    'チアフル': 'cheerful_carnival',
    'ワールドリンク': 'world_bloom',
};
// 本机终榜表的团 → masterdata unit；「混合 / バチャシン / -」不在表内，即 null。
const LEGACY_UNIT = {
    'レオニ': 'light_sound',
    'モモジャン': 'idol',
    'ビビバス': 'street',
    'ワンダショ': 'theme_park',
    'ニーゴ': 'school_refusal',
};

// ---------- 通用 ----------

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function jstDate(ms) {
    return new Date(ms + JST_OFFSET).toISOString().slice(0, 10);
}

function dayDiff(a, b) {
    return Math.round((Date.parse(a) - Date.parse(b)) / (24 * HOUR));
}

/** 名称规范化：NFKC、小写、去掉空白、标点与符号（本机表与 masterdata 的全半角、空格、波浪线写法不一）。 */
export function normalizeName(name) {
    return String(name ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function scopeKey(scope) {
    return scope.kind === 'overall' ? 'overall' : `chapter:${scope.gameCharacterId}`;
}

// ---------- masterdata ----------

async function fetchJson(url) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
}

/** 快照里上游不存在的表保存的是 404 文本而不是 JSON 数组，按缺表处理。 */
function readTableFile(file) {
    try {
        const rows = readJson(file);
        return Array.isArray(rows) ? rows : undefined;
    } catch {
        return undefined;
    }
}

/** 读 `<region>_<table>.json`：先找 wlrules 快照，再找缓存目录；fetchMissing 时从 metadata 站取一次并写入缓存。 */
async function loadTable(region, table, { wlrules, masterdataCache, fetchMissing }) {
    for (const dir of [wlrules, masterdataCache]) {
        const file = path.join(dir, `${region}_${table}.json`);
        if (!fs.existsSync(file)) continue;
        const rows = readTableFile(file);
        if (rows !== undefined) return rows;
    }
    if (!fetchMissing) return undefined;
    const url = `${METADATA_BASE}/${region}/master/${table}.json`;
    const rows = await fetchJson(url);
    fs.mkdirSync(masterdataCache, { recursive: true });
    fs.writeFileSync(path.join(masterdataCache, `${region}_${table}.json`), JSON.stringify(rows));
    console.log(`缓存中没有 ${region}_${table}.json，已从 ${url} 抓取并写入 ${masterdataCache}`);
    return rows;
}

async function loadRegionMasterdata(region, opts) {
    const masterdata = {};
    for (const table of new Set(['events', 'worldBlooms', ...EVENT_RULE_TABLES])) {
        const rows = await loadTable(region, table, { ...opts, fetchMissing: false });
        if (rows !== undefined) masterdata[table] = rows;
    }
    if (!masterdata.events || !masterdata.worldBlooms) throw new Error(`${region}: events / worldBlooms 快照缺失（${opts.wlrules}）`);
    const eventStories = applyMasterdataPatches('eventStories', region, await loadTable(region, 'eventStories', { ...opts, fetchMissing: true }));
    const gameCharacterUnits = await loadTable(region, 'gameCharacterUnits', { ...opts, fetchMissing: true });
    return { masterdata, eventStories, gameCharacterUnits };
}

function bannerCharacterMap(eventStories, gameCharacterUnits) {
    const unitToCharacter = new Map(gameCharacterUnits.map((u) => [u.id, u.gameCharacterId]));
    const out = new Map();
    for (const s of eventStories) {
        const characterId = unitToCharacter.get(s.bannerGameCharacterUnitId);
        if (characterId !== undefined) out.set(s.eventId, characterId);
    }
    return out;
}

// ---------- 活动表 ----------

/**
 * unit 取 masterdata events.unit（none → null）。早期团活的 events.unit 也是 none（日服 #1–#35 中 24 期），
 * 此时用本机终榜表同 id 活动的团补上；国服同 id 活动与日服是同一活动（assetbundleName 全部一致），同样补。
 */
function eventUnit(ev, legacyUnitById, report, region) {
    if (ev.unit && ev.unit !== 'none') return ev.unit;
    const fallback = legacyUnitById.get(ev.id) ?? null;
    if (fallback) report.unitFromLegacy.push(`${region} #${ev.id}`);
    return fallback;
}

function buildRegionEvents(region, { masterdata, eventStories, gameCharacterUnits }, legacy, report) {
    const banners = bannerCharacterMap(eventStories, gameCharacterUnits);
    const rows = [];
    for (const ev of [...masterdata.events].sort((a, b) => a.id - b.id)) {
        let rules;
        try {
            rules = resolveEventRules({ region, eventId: ev.id, masterdata });
        } catch (err) {
            report.errors.push(`${region} #${ev.id}: resolveEventRules 失败：${err.message}`);
            continue;
        }
        const hours = Math.round((ev.aggregateAt - ev.startAt) / HOUR);
        rows.push({
            region,
            eventId: ev.id,
            name: ev.name,
            eventType: ev.eventType,
            startAt: ev.startAt,
            aggregateAt: ev.aggregateAt,
            days: hours / 24,
            group: rules.group,
            wlTurn: rules.wlTurn,
            isFinale: rules.isFinale,
            chapters: rules.chapters.map((c) => ({
                chapterNo: c.chapterNo,
                gameCharacterId: c.gameCharacterId ?? null,
                startAt: c.startAt,
                aggregateAt: c.aggregateAt,
            })),
            unit: eventUnit(ev, legacy.unitById, report, region),
            bannerCharacterId: banners.get(ev.id) ?? null,
            breakTimeId: ev.eventBreakTimeId ?? null,
            autoSpecialMeasure: rules.auto.value.specialMeasure,
            bonusRatio: region === 'jp' ? (legacy.bonusRatioById.get(ev.id) ?? null) : null,
        });
        if (rules.breakGaugeConfigured !== (ev.eventBreakTimeId != null)) {
            report.errors.push(`${region} #${ev.id}: breakGaugeConfigured=${rules.breakGaugeConfigured} 与 eventBreakTimeId=${ev.eventBreakTimeId} 不一致`);
        }
        if (rules.warnings.length) report.ruleWarnings.push(`${region} #${ev.id}: ${rules.warnings.join(', ')}`);
    }
    return rows;
}

// ---------- 本机终榜表对齐 ----------

/**
 * 按名称 + 开始日期把本机终榜表的行对齐到日服游戏 id。
 * 名称唯一命中时接受；开始日期不同则记为日期存疑（表内有录入笔误）。名称未命中时退回同一天开始且类型一致的唯一活动。
 */
export function alignLegacyRows(legacyRows, jpEvents) {
    const byName = new Map();
    for (const ev of jpEvents) {
        const key = normalizeName(ev.name);
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(ev);
    }
    const aligned = [];
    const unaligned = [];
    const notes = [];
    const taken = new Map();
    for (const row of legacyRows) {
        const expectType = LEGACY_TYPE[row.type];
        let candidates = byName.get(normalizeName(row.name)) ?? [];
        let how = 'name';
        if (candidates.length > 1) candidates = candidates.filter((ev) => jstDate(ev.startAt) === row.start_date);
        if (candidates.length === 0) {
            candidates = jpEvents.filter((ev) => jstDate(ev.startAt) === row.start_date && ev.eventType === expectType);
            how = 'date';
        }
        if (candidates.length !== 1) {
            unaligned.push({ legacyId: row.id, name: row.name, startDate: row.start_date, reason: candidates.length ? `多个候选 ${candidates.map((e) => e.id).join('/')}` : '名称与开始日期都找不到对应活动' });
            continue;
        }
        const ev = candidates[0];
        const diff = dayDiff(row.start_date, jstDate(ev.startAt));
        if (how === 'date') notes.push(`表内 id ${row.id}「${row.name}」名称不一致，按开始日期 ${row.start_date} 对齐到 #${ev.id}「${ev.name}」`);
        if (diff !== 0) notes.push(`表内 id ${row.id}「${row.name}」开始日期 ${row.start_date} 与 #${ev.id} 的 ${jstDate(ev.startAt)} 相差 ${diff} 天（按名称对齐）`);
        if (expectType && expectType !== ev.eventType) notes.push(`表内 id ${row.id} 类型 ${row.type} 与 #${ev.id} 的 ${ev.eventType} 不一致`);
        if (taken.has(ev.id)) {
            unaligned.push({ legacyId: row.id, name: row.name, startDate: row.start_date, reason: `与表内 id ${taken.get(ev.id)} 对到同一活动 #${ev.id}` });
            continue;
        }
        taken.set(ev.id, row.id);
        aligned.push({ row, eventId: ev.id });
    }
    return { aligned, unaligned, notes };
}

function legacyFinals(aligned, report) {
    const out = [];
    for (const { row, eventId } of aligned) {
        let kept = 0;
        const zero = [];
        for (const [label, value] of Object.entries(row.borders ?? {})) {
            const m = /^(\d+)/.exec(label);
            if (!m) continue;
            const score = Number(value);
            if (!Number.isFinite(score) || score <= 0) {
                zero.push(Number(m[1]));
                continue;
            }
            out.push({ region: 'jp', eventId, scope: { kind: 'overall' }, rank: Number(m[1]), score, source: SOURCE.borders });
            kept++;
        }
        if (kept === 0) report.legacyWithoutBorders.push(`表内 id ${row.id} → #${eventId}「${row.name}」：${zero.length ? `档位值全为 0（${zero.length} 档）` : '档位为空'}`);
        else if (zero.length) report.legacyWithoutBorders.push(`表内 id ${row.id} → #${eventId}：${zero.length} 档为 0，已跳过`);
    }
    return out;
}

// ---------- 逐日表 ----------

const COLUMN_TIME = /^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/;
const TIER_LABEL = /\(T(\d+)\)/;

/** 逐日表标题 → 活动名：去掉「全档位…推移表」及其前面的「総合 / 章节別」。 */
function timelineTitleName(title) {
    return String(title).replace(/\s*(総合|章节別)?\s*全档位.*$/u, '').trim();
}

function columnTime(label, ev) {
    const m = COLUMN_TIME.exec(String(label).trim());
    if (!m) return null;
    const startYear = new Date(ev.startAt + JST_OFFSET).getUTCFullYear();
    for (const year of [startYear, startYear + 1]) {
        const t = Date.UTC(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4])) - JST_OFFSET;
        if (t >= ev.startAt - 2 * 24 * HOUR && t <= ev.aggregateAt + 2 * 24 * HOUR) return t;
    }
    return null;
}

/**
 * 解析逐日表 JSON 里的「推移表」（跳过日速表）：整期表取结算后那一列作为 overall 终榜，
 * 单章表取每章结算后那一列作为该章终榜。按列时间与 masterdata 的结算时刻匹配章节，不依赖表内的角色名。
 */
export function timelineFinals(workbook, jpEvents, report) {
    const byName = new Map(jpEvents.map((ev) => [normalizeName(ev.name), ev]));
    const out = [];
    for (const [key, rows] of Object.entries(workbook)) {
        if (!key.includes('推移表') || !Array.isArray(rows) || !rows.length) continue;
        const title = rows[0]?.[0];
        const ev = byName.get(normalizeName(timelineTitleName(title)));
        if (!ev) {
            report.timelineUnaligned.push(`${key}「${title}」：找不到同名日服活动`);
            continue;
        }
        const chapterTable = key.startsWith('单章');
        const header = rows.find((r) => Array.isArray(r) && r.slice(1).some((c) => COLUMN_TIME.test(String(c).trim())));
        if (!header) {
            report.timelineUnaligned.push(`${key} → #${ev.eventId}：没有时间表头`);
            continue;
        }
        const windows = chapterTable
            ? ev.chapters.filter((c) => c.gameCharacterId != null).map((c) => ({ scope: { kind: 'chapter', gameCharacterId: c.gameCharacterId }, aggregateAt: c.aggregateAt }))
            : [{ scope: { kind: 'overall' }, aggregateAt: ev.aggregateAt }];
        const finalColumns = [];
        for (const w of windows) {
            const col = header.findIndex((c, i) => {
                if (i === 0) return false;
                const t = columnTime(c, ev);
                return t !== null && t >= w.aggregateAt && t - w.aggregateAt <= COLUMN_FINAL_TOLERANCE_MS;
            });
            if (col < 0) {
                report.timelineUnaligned.push(`${key} → #${ev.eventId} ${scopeKey(w.scope)}：没有结算后的列`);
                continue;
            }
            finalColumns.push({ ...w, col });
        }
        let count = 0;
        for (const r of rows) {
            if (!Array.isArray(r) || typeof r[0] !== 'string') continue;
            const m = TIER_LABEL.exec(r[0]);
            if (!m) continue;
            const rank = Number(m[1]);
            for (const w of finalColumns) {
                const score = Number(r[w.col]);
                if (r[w.col] === '' || !Number.isFinite(score) || score <= 0) continue;
                out.push({ region: 'jp', eventId: ev.eventId, scope: w.scope, rank, score, source: SOURCE.timeline });
                count++;
            }
        }
        report.timelineTables.push(`${key} → #${ev.eventId}「${ev.name}」：${finalColumns.map((w) => scopeKey(w.scope)).join(', ')}，${count} 条`);
    }
    return out;
}

// ---------- D1 的 sekai.best 序列 ----------

/** 从 `<data>/series/jp-<id>.json` 取结算后的快照（冻结的终榜）；没有结算后快照的序列不产生终榜。 */
export function seriesFinals(seriesDir, jpEvents, report) {
    const out = [];
    if (!fs.existsSync(seriesDir)) {
        report.series.push(`序列目录不存在：${seriesDir}`);
        return out;
    }
    let files = 0;
    let withoutFinal = 0;
    for (const ev of jpEvents) {
        const file = path.join(seriesDir, `jp-${ev.eventId}.json`);
        if (!fs.existsSync(file)) continue;
        files++;
        for (const s of readJson(file)) {
            const aggregateAt = s.scope.kind === 'overall'
                ? ev.aggregateAt
                : ev.chapters.find((c) => c.gameCharacterId === s.scope.gameCharacterId)?.aggregateAt;
            if (aggregateAt === undefined) continue;
            const after = s.points.filter(([t]) => t >= aggregateAt);
            if (!after.length) {
                withoutFinal++;
                continue;
            }
            const score = after.at(-1)[1];
            if (score > 0) out.push({ region: 'jp', eventId: ev.eventId, scope: s.scope, rank: s.rank, score, source: SOURCE.sekaiBest });
        }
    }
    report.series.push(`读取 ${files} 个日服序列文件，得到 ${out.length} 条结算后终榜；${withoutFinal} 条序列没有结算后的快照（未计入）`);
    return out;
}

// ---------- 合并 ----------

function mergeFinals(lists, events, report) {
    const order = new Map(events.map((ev) => [ev.eventId, ev]));
    const merged = new Map();
    for (const f of lists.flat().sort((a, b) => SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source))) {
        const key = `${f.eventId}|${scopeKey(f.scope)}|${f.rank}`;
        const prev = merged.get(key);
        if (!prev) {
            merged.set(key, f);
            continue;
        }
        if (prev.score !== f.score) report.conflicts.push(`#${f.eventId} ${scopeKey(f.scope)} T${f.rank}：${prev.source}=${prev.score}，${f.source}=${f.score}（保留 ${prev.source}）`);
    }
    const chapterNo = (f) => {
        if (f.scope.kind === 'overall') return 0;
        return order.get(f.eventId)?.chapters.find((c) => c.gameCharacterId === f.scope.gameCharacterId)?.chapterNo ?? 99;
    };
    return [...merged.values()].sort((a, b) => a.eventId - b.eventId || chapterNo(a) - chapterNo(b) || a.rank - b.rank);
}

/** 同一范围内档位越低分数应越低；只报告，不改数据。 */
function monotoneReport(finals, report) {
    const groups = new Map();
    for (const f of finals) {
        const key = `${f.eventId}|${scopeKey(f.scope)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
    }
    for (const [key, rows] of groups) {
        for (let i = 1; i < rows.length; i++) {
            if (rows[i].score > rows[i - 1].score) report.nonMonotone.push(`${key} T${rows[i - 1].rank}=${rows[i - 1].score} < T${rows[i].rank}=${rows[i].score}`);
        }
    }
}

// ---------- 入口 ----------

export async function buildEvents(options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const report = {
        errors: [], ruleWarnings: [], legacyUnaligned: [], legacyNotes: [], legacyWithoutBorders: [],
        timelineTables: [], timelineUnaligned: [], series: [], conflicts: [], nonMonotone: [], unitFromLegacy: [],
    };

    const legacyRows = readJson(path.join(opts.borders, 'jp_event_borders_all.json'));
    const regionData = {};
    for (const region of REGIONS) regionData[region] = await loadRegionMasterdata(region, opts);

    const { aligned, unaligned, notes } = alignLegacyRows(legacyRows, regionData.jp.masterdata.events);
    report.legacyUnaligned = unaligned;
    report.legacyNotes = notes;
    const legacy = {
        bonusRatioById: new Map(aligned.filter(({ row }) => Number.isFinite(row.bonus_ratio)).map(({ row, eventId }) => [eventId, row.bonus_ratio])),
        unitById: new Map(aligned.filter(({ row }) => LEGACY_UNIT[row.unit]).map(({ row, eventId }) => [eventId, LEGACY_UNIT[row.unit]])),
    };

    const events = REGIONS.flatMap((region) => buildRegionEvents(region, regionData[region], legacy, report));
    const jpEvents = events.filter((ev) => ev.region === 'jp');

    const workbook = readJson(path.join(opts.borders, 'timeline', 'prsk_timelines_and_daily_speed_zh.json'));
    const finals = mergeFinals([
        legacyFinals(aligned, report),
        timelineFinals(workbook, jpEvents, report),
        seriesFinals(path.join(opts.data, 'series'), jpEvents, report),
    ], jpEvents, report);
    monotoneReport(finals, report);

    report.summary = {
        events: Object.fromEntries(REGIONS.map((r) => [r, events.filter((e) => e.region === r).length])),
        legacyRows: legacyRows.length,
        legacyAligned: aligned.length,
        finals: finals.length,
        finalsBySource: Object.fromEntries(SOURCE_PRIORITY.map((s) => [s, finals.filter((f) => f.source === s).length])),
        finalEvents: new Set(finals.map((f) => f.eventId)).size,
    };
    return { events, finals, report };
}

/** 每行一个元素的紧凑 JSON，便于 diff 且体积小。 */
function writeRows(file, rows) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`);
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        out[key] = argv[i + 1];
        i++;
    }
    return out;
}

function printReport(report) {
    const section = (title, rows) => {
        console.log(`\n## ${title}（${rows.length}）`);
        for (const r of rows) console.log(`- ${typeof r === 'string' ? r : JSON.stringify(r)}`);
    };
    console.log('# build-events 报告');
    console.log(JSON.stringify(report.summary, null, 1));
    section('错误', report.errors);
    section('本机终榜表未对齐的行', report.legacyUnaligned);
    section('对齐备注', report.legacyNotes);
    section('已对齐但没有可用档位的行', report.legacyWithoutBorders);
    section('逐日表', report.timelineTables);
    section('逐日表未对齐', report.timelineUnaligned);
    section('sekai.best 序列', report.series);
    section('来源冲突', report.conflicts);
    section('档位不单调', report.nonMonotone);
    section('规则告警', report.ruleWarnings);
    section('unit 由本机终榜表补全', report.unitFromLegacy);
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const { events, finals, report } = await buildEvents(args);
    const outDir = args.out ?? DEFAULTS.out;
    writeRows(path.join(outDir, 'events.json'), events);
    writeRows(path.join(outDir, 'finals-jp.json'), finals);
    if (args.report) fs.writeFileSync(args.report, `${JSON.stringify(report, null, 1)}\n`);
    printReport(report);
    console.log(`\n写出 ${events.length} 个活动 → ${path.join(outDir, 'events.json')}，${finals.length} 条日服终榜 → ${path.join(outDir, 'finals-jp.json')}`);
    if (report.errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await main();
}
