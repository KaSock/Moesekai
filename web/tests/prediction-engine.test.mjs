/**
 * calculateEventPrediction（lib/prediction-engine.ts）与 buildPredictionContext（lib/prediction/model/context.ts）。
 * Run with: node --test --experimental-strip-types tests/prediction-engine.test.mjs
 * 规则来自 W6 的 masterdata 夹具（tests/fixtures/event-rules，另补日服 #216 的真实 events 行），
 * 数据集一侧来自提交的 scripts/prediction-backtest/data（events.json、finals-jp.json），模型参数为提交的 priors.json。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, extname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const SRC_URL = pathToFileURL(SRC_ROOT).href;

// 引擎按站点写法 `import x from "./priors.json"` 引入参数（Next 打包器支持，Node 需要 import 属性），
// 这里把没有 type: "json" 属性的 JSON 导入转成 ES 模块。prediction-api.ts 一侧用 @/ 别名和无扩展名导入，
// resolve 钩子按 tsconfig 的 paths 解析。站点代码里有不带 type 的纯类型导入（如 @/types/*），Node 的去类型
// 处理不了，src 下的 .ts 改用 TypeScript 转译（与打包器一样省略只作类型用的导入）；lib 代码对 .tsx
// （React context）只有 `import { type X }`，转译后剩下空导入，这里给空模块。
registerHooks({
  resolve(specifier, context, nextResolve) {
    let target = null;
    const withTsExtension = (path) => [`${path}.ts`, `${path}.tsx`, `${path}/index.ts`].find((c) => existsSync(c));
    if (specifier.startsWith("@/")) {
      target = resolvePath(SRC_ROOT, specifier.slice(2));
      if (!extname(target)) target = withTsExtension(target) ?? target;
    } else if (/^\.\.?\//.test(specifier) && !extname(specifier) && context.parentURL?.startsWith("file:")) {
      // Only TS sources; extensionless requires inside node_modules (jsdom) keep Node's own resolution.
      target = withTsExtension(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) ?? null;
    }
    return nextResolve(target ? pathToFileURL(target).href : specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) return { format: "module", source: "export {};", shortCircuit: true };
    if (url.startsWith(SRC_URL) && url.endsWith(".ts")) {
      const file = fileURLToPath(url);
      const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
        fileName: file,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
      });
      return { format: "module", source: outputText, shortCircuit: true };
    }
    if (url.startsWith("file:") && url.endsWith(".json") && !url.includes("/node_modules/") && context.importAttributes?.type !== "json") {
      return { format: "module", source: `export default ${readFileSync(fileURLToPath(url), "utf8")};`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { EVENT_RULE_TABLES, resolveEventRules } = await import("../src/lib/event-rules/index.ts");
const {
  bannerCharacterIdOf,
  buildPredictionContext,
  eventUnitOf,
  fallbackPredictionContext,
  jpSameIdFinalOf,
  normalizeOtherTiers,
  PREDICTION_CONTEXT_RULE_TABLES,
} = await import("../src/lib/prediction/model/context.ts");
const { contextFromDataset } = await import("../src/lib/prediction/model/dataset-context.ts");
const { actualFinals, eventKey, indexDataset } = await import("../scripts/prediction-backtest/dataset.mjs");
const engine = await import("../src/lib/prediction-engine.ts");
const { calculateEventPrediction } = engine;
const { default: PRIORS } = await import("../src/lib/prediction/priors.json");
const { fuseCellKey } = await import("../src/lib/prediction/model/fuse.ts");
const toriV2 = await import("../scripts/prediction-backtest/baselines/tori-v2.ts");

const HOUR = 3_600_000;
const FIXTURES = new URL("./fixtures/event-rules/", import.meta.url);
const DATA = new URL("../scripts/prediction-backtest/data/", import.meta.url);
const readJson = (url) => JSON.parse(readFileSync(url, "utf8"));

// 日服 #216 After the Fire（普通活动，疲劳槽第 2 套）：回测工作目录 wlrules/jp_events.json 原行（奖励区间只留榜线）。
const JP_216 = {
  id: 216, eventType: "marathon", name: "After the Fire", assetbundleName: "event_afterfire_2026",
  startAt: 1788674400000, aggregateAt: 1789214399000, closedAt: 1789365599000, unit: "street",
  isCountLeaderCharacterPlay: false, eventBreakTimeId: 2,
  eventRankingRewardRanges: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 100, 200, 300, 400, 500, 1000, 1500, 2000,
    2500, 3000, 4000, 5000, 10000, 20000, 30000, 40000, 50000, 100000, 200000, 300000]
    .map((toRank, i, all) => ({ id: 6669 + i, eventId: 216, fromRank: i === 0 ? 1 : all[i - 1] + 1, toRank, isToRankBorder: false })),
};

// eventStories / gameCharacterUnits（metadata.exmeaning.com 快照，按所需活动裁剪）。
const EVENT_STORIES = {
  jp: [{ id: 179, eventId: 179, bannerGameCharacterUnitId: 21 }, { id: 180, eventId: 180 }, { id: 214, eventId: 214 },
    { id: 216, eventId: 216, bannerGameCharacterUnitId: 11 }, { id: 218, eventId: 218 }],
  cn: [{ id: 179, eventId: 179, bannerGameCharacterUnitId: 21 }, { id: 180, eventId: 180 }],
};
const GAME_CHARACTER_UNITS = [{ id: 11, gameCharacterId: 11, unit: "street" }, { id: 21, gameCharacterId: 21, unit: "piapro" }];

function loadMasterdata(region) {
  const masterdata = {};
  for (const table of EVENT_RULE_TABLES) {
    const url = new URL(`${region}/${table}.json`, FIXTURES);
    if (existsSync(url)) masterdata[table] = readJson(url);
  }
  if (region === "jp") masterdata.events = [...masterdata.events, JP_216];
  return masterdata;
}

const MASTERDATA = { jp: loadMasterdata("jp"), cn: loadMasterdata("cn") };
const DATASET_EVENTS = readJson(new URL("events.json", DATA));
const JP_FINALS = readJson(new URL("finals-jp.json", DATA));
const DATASET_INDEX = indexDataset({ events: DATASET_EVENTS, finals: JP_FINALS, series: [] });

function rulesOf(region, eventId, scope = { kind: "overall" }) {
  return resolveEventRules({ region, eventId, masterdata: MASTERDATA[region], scope });
}

function eventMetaOf(region, eventId) {
  const row = MASTERDATA[region].events.find((e) => e.id === eventId);
  return { unit: eventUnitOf(row), bannerCharacterId: bannerCharacterIdOf(eventId, EVENT_STORIES[region], GAME_CHARACTER_UNITS) };
}

function liveContext(region, eventId, scope, otherTiers) {
  return buildPredictionContext({ rules: rulesOf(region, eventId, scope), event: eventMetaOf(region, eventId), otherTiers, jpFinals: JP_FINALS });
}

/** 与 harness.mjs 的 jpSameIdFinalFor 相同：国服取日服同 id、同范围、且在国服开始前已结算的终榜。 */
function datasetJpSameIdFinal(ev, scope) {
  if (ev.region !== "cn") return null;
  const jp = DATASET_INDEX.events.get(eventKey("jp", ev.eventId));
  if (!jp || jp.aggregateAt >= ev.startAt) return null;
  const finals = actualFinals(DATASET_INDEX, jp, scope);
  return finals.size === 0 ? null : Object.fromEntries([...finals].map(([rank, f]) => [rank, f.score]));
}

function datasetContext(region, eventId, scope, atMs, otherTiers) {
  const ev = DATASET_EVENTS.find((e) => e.region === region && e.eventId === eventId);
  assert.ok(ev, `${region} #${eventId} missing from events.json`);
  return contextFromDataset(ev, scope, atMs, otherTiers, datasetJpSameIdFinal(ev, scope));
}

/** 某期终榜 × share 作为同一时刻各档分数（只取给定档位）。 */
function tiersFromFinal(region, eventId, share, ranks) {
  const byRank = new Map(JP_FINALS.filter((f) => f.region === region && f.eventId === eventId && f.scope.kind === "overall").map((f) => [f.rank, f.score]));
  return ranks.filter((r) => byRank.has(r)).map((rank) => ({ rank, score: Math.round(byRank.get(rank) * share) }));
}

/** 从范围开始线性增长到 atMs 时的 score 的历史点（每 2 小时一个点）。 */
function linearHistory(startAt, atMs, score) {
  const points = [];
  for (let t = startAt; t < atMs; t += 2 * HOUR) points.push({ t: new Date(t).toISOString(), y: Math.round(score * (t - startAt) / (atMs - startAt)) });
  points.push({ t: new Date(atMs).toISOString(), y: score });
  return points;
}

const PAGE_TIERS = [50, 100, 200, 300, 400, 500, 1000, 2000, 3000, 5000, 10000];

// ---------------------------------------------------------------------------
// buildPredictionContext = contextFromDataset, field by field
// ---------------------------------------------------------------------------

const PARITY_CASES = [
  { name: "JP #214 WL3 chapter 3 (MEIKO)", region: "jp", eventId: 214, scope: { kind: "chapter", gameCharacterId: 25 }, source: [216, 0.4] },
  { name: "JP #214 WL3 last chapter (Airi)", region: "jp", eventId: 214, scope: { kind: "chapter", gameCharacterId: 7 }, source: [216, 0.4] },
  { name: "JP #214 WL3 overall", region: "jp", eventId: 214, scope: { kind: "overall" }, source: [214, 0.5] },
  { name: "JP #216 normal with break gauge", region: "jp", eventId: 216, scope: { kind: "overall" }, source: [216, 0.5] },
  { name: "JP #218 WL3 finale", region: "jp", eventId: 218, scope: { kind: "overall" }, source: [180, 0.5] },
  { name: "CN #179 WL2 VS overall", region: "cn", eventId: 179, scope: { kind: "overall" }, source: [216, 0.3] },
  { name: "CN #179 WL2 VS chapter (Miku)", region: "cn", eventId: 179, scope: { kind: "chapter", gameCharacterId: 21 }, source: [216, 0.1] },
  { name: "CN #179 WL2 VS last chapter (Rin)", region: "cn", eventId: 179, scope: { kind: "chapter", gameCharacterId: 22 }, source: [216, 0.1] },
  { name: "CN #180 WL2 finale", region: "cn", eventId: 180, scope: { kind: "overall" }, source: [180, 0.4] },
];

for (const c of PARITY_CASES) {
  test(`context parity: ${c.name}`, () => {
    const rules = rulesOf(c.region, c.eventId, c.scope);
    const atMs = Math.round((rules.scopeStartAt + rules.scopeAggregateAt) / 2);
    const otherTiers = tiersFromFinal("jp", c.source[0], c.source[1], PAGE_TIERS).filter((t) => rules.rankingTiers.includes(t.rank));
    assert.ok(otherTiers.length >= 5);
    const live = liveContext(c.region, c.eventId, c.scope, [...otherTiers].reverse());
    const dataset = datasetContext(c.region, c.eventId, c.scope, atMs, otherTiers);
    assert.deepStrictEqual(live, dataset);
  });
}

test("context fields per edition", () => {
  const tiers = [{ rank: 100, score: 1 }];
  const ch = liveContext("jp", 214, { kind: "chapter", gameCharacterId: 25 }, tiers);
  assert.equal(ch.group, "wl_chapter_48h");
  assert.equal(ch.wlTurn, 3);
  assert.equal(ch.chapterNo, 3);
  assert.equal(ch.chapterCharacterId, 25);
  assert.equal(ch.breakGauge, true);
  assert.equal(ch.scopeEndAt - ch.scopeStartAt, 48 * HOUR - 1000);
  // Chapter scopes carry the whole event's end; only the last chapter ends with it (R13-1).
  const jp214 = rulesOf("jp", 214);
  assert.equal(ch.eventEndAt, jp214.aggregateAt);
  assert.ok(ch.scopeEndAt < ch.eventEndAt);
  const last = liveContext("jp", 214, { kind: "chapter", gameCharacterId: 7 }, tiers);
  assert.deepEqual([last.chapterNo, last.scopeEndAt, last.eventEndAt], [5, jp214.aggregateAt, jp214.aggregateAt]);
  assert.equal(liveContext("jp", 214, { kind: "overall" }, tiers).eventEndAt, jp214.aggregateAt);
  const cn179Last = liveContext("cn", 179, { kind: "chapter", gameCharacterId: 22 }, tiers);
  assert.equal(cn179Last.scopeEndAt, cn179Last.eventEndAt);
  assert.equal(cn179Last.eventEndAt, rulesOf("cn", 179).aggregateAt);

  const normal = liveContext("jp", 216, { kind: "overall" }, tiers);
  assert.deepEqual([normal.group, normal.wlTurn, normal.unit, normal.bannerCharacterId, normal.breakGauge], ["normal", null, "street", 11, true]);

  const jp218 = liveContext("jp", 218, { kind: "overall" }, tiers);
  assert.deepEqual([jp218.group, jp218.wlTurn, jp218.autoSpecialMeasure, jp218.breakGauge, jp218.chapterNo], ["wl_finale", 3, false, true, null]);

  const cn180 = liveContext("cn", 180, { kind: "overall" }, tiers);
  assert.deepEqual([cn180.group, cn180.wlTurn, cn180.autoSpecialMeasure, cn180.breakGauge], ["wl_finale", 2, true, false]);

  const cn179 = liveContext("cn", 179, { kind: "overall" }, tiers);
  assert.deepEqual([cn179.group, cn179.wlTurn, cn179.unit, cn179.bannerCharacterId], ["wl_overall", 2, null, 21]);
});

test("CN context carries the JP same-id final; JP contexts never do", () => {
  const cn180 = liveContext("cn", 180, { kind: "overall" }, []);
  const jp180 = JP_FINALS.filter((f) => f.eventId === 180 && f.scope.kind === "overall");
  assert.ok(jp180.length >= 20);
  assert.equal(Object.keys(cn180.jpSameIdFinal).length, jp180.length);
  for (const f of jp180) assert.equal(cn180.jpSameIdFinal[f.rank], f.score);
  assert.equal(cn180.jpSameIdFinal[1000], 171245335);
  assert.equal(cn180.jpSameIdFinal[1500], 46718500);

  assert.equal(liveContext("jp", 180, { kind: "overall" }, []).jpSameIdFinal, null);
  assert.equal(liveContext("jp", 218, { kind: "overall" }, []).jpSameIdFinal, null);
  // A chapter scope takes only the same chapter's JP finals.
  assert.equal(jpSameIdFinalOf(JP_FINALS, 180, { kind: "chapter", gameCharacterId: 21 }), null);
  assert.equal(buildPredictionContext({ rules: rulesOf("cn", 180), event: eventMetaOf("cn", 180), otherTiers: [], jpFinals: null }).jpSameIdFinal, null);
});

test("WL chapter and overall contexts of one event differ", () => {
  const chapter = liveContext("jp", 214, { kind: "chapter", gameCharacterId: 25 }, []);
  const overall = liveContext("jp", 214, { kind: "overall" }, []);
  assert.equal(overall.group, "wl_overall");
  assert.notEqual(chapter.group, overall.group);
  assert.notEqual(chapter.scopeStartAt, overall.scopeStartAt);
  assert.notEqual(chapter.scopeEndAt, overall.scopeEndAt);
  assert.equal(overall.chapterCharacterId, null);
  assert.equal(overall.chapterNo, null);
});

test("other tiers keep positive border-rank scores, one per rank, ascending", () => {
  const out = normalizeOtherTiers(
    [{ rank: 1000, score: 5 }, { rank: 37, score: 9 }, { rank: 100, score: 0 }, { rank: 50, score: 8 }, { rank: 1000, score: 6 }],
    [50, 100, 1000],
  );
  assert.deepEqual(out, [{ rank: 50, score: 8 }, { rank: 1000, score: 6 }]);
});

test("fallback context: unknown WL turn, group from the scope shape", () => {
  const base = { region: "jp", eventId: 999, eventType: "world_bloom", startAt: 0, otherTiers: [] };
  const chapter48 = fallbackPredictionContext({ ...base, endAt: 48 * HOUR - 1000, chapterCharacterId: 3, chapterNo: 2 });
  assert.equal(chapter48.group, "wl_chapter_48h");
  // The chapter window alone does not tell where the event ends.
  assert.equal(chapter48.eventEndAt, null);
  assert.equal(fallbackPredictionContext({ ...base, endAt: 72 * HOUR - 1000, chapterCharacterId: 3, chapterNo: 2 }).group, "wl_chapter_72h");
  const overall = fallbackPredictionContext({ ...base, endAt: 240 * HOUR, chapterCharacterId: null, chapterNo: null });
  assert.deepEqual([overall.group, overall.wlTurn, overall.breakGauge, overall.jpSameIdFinal, overall.eventEndAt], ["wl_overall", null, false, null, 240 * HOUR]);
  const normal = fallbackPredictionContext({ ...base, eventType: "marathon", endAt: 192 * HOUR, chapterCharacterId: null, chapterNo: null });
  assert.deepEqual([normal.group, normal.eventEndAt], ["normal", 192 * HOUR]);
});

test("the context tables are a subset of the rule tables", () => {
  for (const t of PREDICTION_CONTEXT_RULE_TABLES) assert.ok(EVENT_RULE_TABLES.includes(t), t);
});

// ---------------------------------------------------------------------------
// calculateEventPrediction
// ---------------------------------------------------------------------------

const OUTPUT_KEYS = [
  "currentScore", "predictedScore", "predictedScoreP10", "predictedScoreP90", "effectiveHourlySpeed",
  "rolling24hSpeed", "progress", "isJpRestActive", "predictPoints",
].sort();

function assertOutputShape(out) {
  assert.deepEqual(Object.keys(out).sort(), OUTPUT_KEYS);
  for (const k of OUTPUT_KEYS) {
    if (k === "isJpRestActive") assert.equal(typeof out[k], "boolean");
    else if (k === "predictPoints") assert.ok(Array.isArray(out[k]));
    else assert.ok(Number.isFinite(out[k]), `${k} = ${out[k]}`);
  }
  for (const p of out.predictPoints) {
    assert.deepEqual(Object.keys(p).sort(), ["t", "y"]);
    assert.equal(typeof p.t, "string");
    assert.equal(new Date(p.t).toISOString(), p.t);
    assert.ok(Number.isInteger(p.y));
  }
}

/** One snapshot of a scope: every page tier's linear history up to atMs, and the shared context. */
function snapshot(region, eventId, scope, progress, final) {
  const rules = rulesOf(region, eventId, scope);
  const atMs = Math.round(rules.scopeStartAt + progress * (rules.scopeAggregateAt - rules.scopeStartAt));
  const tiers = tiersFromFinal("jp", final[0], final[1], PAGE_TIERS).filter((t) => rules.rankingTiers.includes(t.rank));
  const context = liveContext(region, eventId, scope, tiers);
  const run = (t) => calculateEventPrediction({
    server: region,
    rank: t.rank,
    startAt: rules.scopeStartAt,
    endAt: rules.scopeAggregateAt,
    historyPoints: linearHistory(rules.scopeStartAt, atMs, t.score),
    context,
  });
  return { rules, atMs, tiers, context, run };
}

test("output shape unchanged: running, empty history and ended scopes", () => {
  const { tiers, run, context, rules } = snapshot("jp", 216, { kind: "overall" }, 0.5, [216, 0.45]);
  const out = run(tiers.find((t) => t.rank === 1000));
  assertOutputShape(out);
  assert.equal(out.currentScore, tiers.find((t) => t.rank === 1000).score);
  assert.ok(out.predictedScoreP10 <= out.predictedScore && out.predictedScore <= out.predictedScoreP90);
  assert.ok(out.predictedScore >= out.currentScore);
  assert.ok(out.progress > 0.49 && out.progress < 0.51);
  assert.equal(out.isJpRestActive, true);
  assert.ok(out.predictPoints.length >= 2);
  assert.equal(out.predictPoints[0].y, out.currentScore);
  assert.equal(out.predictPoints.at(-1).y, out.predictedScore);
  assert.equal(new Date(out.predictPoints.at(-1).t).getTime(), rules.scopeAggregateAt);
  for (let i = 1; i < out.predictPoints.length; i++) assert.ok(out.predictPoints[i].y >= out.predictPoints[i - 1].y);

  const empty = calculateEventPrediction({ server: "jp", rank: 1000, startAt: rules.scopeStartAt, endAt: rules.scopeAggregateAt, historyPoints: [], context });
  assert.deepEqual(empty, {
    currentScore: 0, predictedScore: 0, predictedScoreP10: 0, predictedScoreP90: 0, effectiveHourlySpeed: 0,
    rolling24hSpeed: 0, progress: 0, isJpRestActive: true, predictPoints: [],
  });

  const history = linearHistory(rules.scopeStartAt, rules.scopeAggregateAt, 15_000_000);
  const ended = calculateEventPrediction({ server: "jp", rank: 1000, startAt: rules.scopeStartAt, endAt: rules.scopeAggregateAt, historyPoints: history, context });
  assertOutputShape(ended);
  assert.deepEqual([ended.predictedScore, ended.predictedScoreP10, ended.predictedScoreP90, ended.progress], [15_000_000, 15_000_000, 15_000_000, 1]);
  assert.equal(ended.predictPoints.length, history.length);
});

test("deterministic: the same input gives the same output, with a shared or a fresh context", () => {
  const { tiers, run, context, rules, atMs } = snapshot("cn", 180, { kind: "overall" }, 0.4, [180, 0.3]);
  for (const t of tiers) assert.deepStrictEqual(run(t), run(t));
  // Histories that end on the snapshot share one fused estimate per context; a fresh copy recomputes it.
  const onSnapshot = (t, ctx) => calculateEventPrediction({
    server: "cn", rank: t.rank, startAt: rules.scopeStartAt, endAt: rules.scopeAggregateAt,
    historyPoints: linearHistory(rules.scopeStartAt, atMs, t.score), context: ctx,
  });
  const shared = tiers.map((t) => onSnapshot(t, context));
  const fresh = tiers.map((t) => onSnapshot(t, structuredClone(context)));
  assert.deepStrictEqual(shared, fresh);
});

const MONOTONE_CASES = [
  ["jp", 216, { kind: "overall" }, 0.5, [216, 0.45]],
  ["jp", 214, { kind: "chapter", gameCharacterId: 25 }, 0.5, [216, 0.3]],
  ["jp", 214, { kind: "overall" }, 0.3, [214, 0.3]],
  ["jp", 218, { kind: "overall" }, 0.5, [180, 0.45]],
  ["cn", 180, { kind: "overall" }, 0.25, [180, 0.2]],
  ["cn", 179, { kind: "overall" }, 0.6, [216, 0.5]],
];

for (const [region, eventId, scope, progress, final] of MONOTONE_CASES) {
  test(`tiers stay monotone: ${region} #${eventId} ${scope.kind} at ${progress * 100}%`, () => {
    const { tiers, run } = snapshot(region, eventId, scope, progress, final);
    assert.ok(tiers.length >= 8);
    const outs = tiers.map((t) => ({ rank: t.rank, out: run(t) }));
    for (const { rank, out } of outs) {
      assertOutputShape(out);
      assert.ok(out.predictedScoreP10 <= out.predictedScore && out.predictedScore <= out.predictedScoreP90, `T${rank}`);
      assert.ok(out.predictedScore >= out.currentScore, `T${rank}`);
    }
    for (let i = 1; i < outs.length; i++) {
      const [hi, lo] = [outs[i - 1], outs[i]];
      assert.ok(lo.out.predictedScore <= hi.out.predictedScore, `T${lo.rank} p50 ${lo.out.predictedScore} > T${hi.rank} ${hi.out.predictedScore}`);
    }
  });
}

test("the JP same-id final moves the CN prediction early in the event", () => {
  const { tiers, context, rules, atMs } = snapshot("cn", 180, { kind: "overall" }, 0.1, [180, 0.05]);
  const t = tiers.find((x) => x.rank === 1000);
  const input = (ctx) => ({ server: "cn", rank: 1000, startAt: rules.scopeStartAt, endAt: rules.scopeAggregateAt, historyPoints: linearHistory(rules.scopeStartAt, atMs, t.score), context: ctx });
  const withJp = calculateEventPrediction(input(context));
  const withoutJp = calculateEventPrediction(input({ ...context, jpSameIdFinal: null }));
  assert.notEqual(withJp.predictedScore, withoutJp.predictedScore);
});

test("WL chapter and overall contexts give different predictions for the same history", () => {
  const chapterRules = rulesOf("jp", 214, { kind: "chapter", gameCharacterId: 25 });
  const atMs = chapterRules.scopeStartAt + 24 * HOUR;
  const history = linearHistory(chapterRules.scopeStartAt, atMs, 20_000_000);
  const input = (scope) => ({
    server: "jp", rank: 1000, startAt: chapterRules.scopeStartAt, endAt: chapterRules.scopeAggregateAt, historyPoints: history,
    context: liveContext("jp", 214, scope, [{ rank: 1000, score: 20_000_000 }]),
  });
  const chapter = calculateEventPrediction(input({ kind: "chapter", gameCharacterId: 25 }));
  const overall = calculateEventPrediction(input({ kind: "overall" }));
  assert.notEqual(chapter.predictedScore, overall.predictedScore);
  assert.notEqual(chapter.progress, overall.progress);
});

/** priors.json with the given contexts' cells recorded as tori-v2 fallbacks. */
function sectionsWithFallback(...contexts) {
  const fallback = { ...PRIORS.fuse.fallback };
  for (const ctx of contexts) fallback[fuseCellKey(ctx, PRIORS.fuse)] = { events: 1, points: 1, mape: 0.5, baselineMape: 0.1 };
  return { ...PRIORS, fuse: { ...PRIORS.fuse, fallback } };
}

test("a fallback cell runs the frozen tori-v2 engine with the inputs the site passed it", () => {
  const cases = [
    [snapshot("jp", 216, { kind: "overall" }, 0.5, [216, 0.45]), { bonusPercent: 475 }],
    [snapshot("jp", 214, { kind: "chapter", gameCharacterId: 25 }, 0.5, [216, 0.3]), { bonusPercent: 990, characterId: 25 }],
    [snapshot("cn", 179, { kind: "overall" }, 0.6, [216, 0.5]), { bonusPercent: 990, eventType: "world_bloom" }],
  ];
  for (const [{ tiers, context, rules, atMs }, legacyArgs] of cases) {
    const cleared = { ...PRIORS, fuse: { ...PRIORS.fuse, fallback: {} } };
    const t = tiers.find((x) => x.rank === 1000);
    const historyPoints = linearHistory(rules.scopeStartAt, atMs, t.score);
    const input = { server: context.region, rank: 1000, startAt: rules.scopeStartAt, endAt: rules.scopeAggregateAt, historyPoints, context };
    const out = calculateEventPrediction(input, sectionsWithFallback(context));
    const expected = toriV2.calculateEventPrediction({
      server: context.region, rank: 1000, startAt: context.scopeStartAt, endAt: context.scopeEndAt, historyPoints, ...legacyArgs,
    });
    assertOutputShape(out);
    assert.deepStrictEqual(out, { ...expected, isJpRestActive: context.breakGauge });
    assert.notDeepStrictEqual(calculateEventPrediction(input, cleared), out);
  }
  // A fallback recorded for another cell leaves this one on the model.
  const { tiers, context, run, rules, atMs } = snapshot("jp", 216, { kind: "overall" }, 0.5, [216, 0.45]);
  const other = liveContext("jp", 214, { kind: "chapter", gameCharacterId: 25 }, []);
  const t = tiers.find((x) => x.rank === 1000);
  const input = { server: "jp", rank: 1000, startAt: rules.scopeStartAt, endAt: rules.scopeAggregateAt, historyPoints: linearHistory(rules.scopeStartAt, atMs, t.score), context };
  const cleared = { ...PRIORS, fuse: { ...PRIORS.fuse, fallback: {} } };
  assert.deepStrictEqual(calculateEventPrediction(input, sectionsWithFallback(other)), calculateEventPrediction(input, cleared));
  assert.ok(run(t).predictedScore > 0);
});

test("the goal-planner section is gone from the engine", () => {
  for (const name of ["calculateGoalStrategy", "META_SONG_PROFILES", "CHARACTER_HEAT_MAP"]) assert.equal(engine[name], undefined, name);
  const src = readFileSync(new URL("../src/lib/prediction-engine.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
});

test("the fallback engine is a frozen copy in src, line for line the backtest baseline, and src does not import scripts/", () => {
  const unescape = (text) => text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  // 两份文件各有 2 行文件头注释，其后应完全一致（src 副本把假名写成 \u 转义）。
  const body = (url) => unescape(readFileSync(url, "utf8")).split("\n").slice(2).join("\n");
  const legacyUrl = new URL("../src/lib/prediction/legacy/tori-v2.ts", import.meta.url);
  assert.equal(body(legacyUrl), body(new URL("../scripts/prediction-backtest/baselines/tori-v2.ts", import.meta.url)));
  assert.doesNotMatch(readFileSync(legacyUrl, "utf8"), /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
  const engineSrc = readFileSync(new URL("../src/lib/prediction-engine.ts", import.meta.url), "utf8");
  assert.match(engineSrc, /from "\.\/prediction\/legacy\/tori-v2\.ts"/);
  assert.doesNotMatch(engineSrc, /scripts\/prediction-backtest\/baselines/);
});

test("ranking-sync and prediction-api do not statically import the engine (realtime ranking ships no priors.json)", () => {
  // 只允许类型导入与动态 import()；静态值导入会把引擎和 priors.json 带进 /realtime-ranking-next。
  const staticValueImports = (file) => [...readFileSync(new URL(file, import.meta.url), "utf8")
    .matchAll(/^import\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/gms)].map((m) => m[1]);
  for (const file of ["../src/lib/ranking-sync.ts", "../src/lib/prediction-api.ts"]) {
    const heavy = staticValueImports(file).filter((spec) => /prediction-engine|prediction\/(live-prediction|model|legacy|priors)|event-rules/.test(spec));
    assert.deepEqual(heavy, [], file);
  }
  assert.match(readFileSync(new URL("../src/lib/prediction-api.ts", import.meta.url), "utf8"), /import\('@\/lib\/prediction\/live-prediction'\)/);
});

// ---------------------------------------------------------------------------
// fetchPredictionData (prediction-api.ts) with stubbed upstreams
// ---------------------------------------------------------------------------

/** v2 latest of JP #218 as the rks-n API serves it during the finale: T1-T100 only. */
function v2Latest(eventId, updatedAt) {
  const rankings = Array.from({ length: 100 }, (_, i) => ({ rank: i + 1, score: 300_000_000 - i * 1_500_000, userId: String(i + 1), name: "p" }));
  return { event_id: eventId, region: "jp", start_at: 1790334000000, end_at: 1790593199000, updated_at: updatedAt, is_event_aggregate: false, rankings };
}

/** Routes the page's requests to canned bodies; records every URL. */
function stubFetch(routes) {
  const requested = [];
  const masterdata = { ...MASTERDATA.jp, eventStories: EVENT_STORIES.jp, gameCharacterUnits: GAME_CHARACTER_UNITS };
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const master = url.match(/\/jp\/master\/(\w+)\.json/);
    if (master) return masterdata[master[1]] ? json(masterdata[master[1]]) : json({}, 404);
    for (const [pattern, reply] of routes) if (pattern.test(url)) return reply();
    return json({ error: "not stubbed" }, 404);
  };
  return requested;
}

test("fetchPredictionData: an rk latest without tiers falls back to the v2 snapshot of the same event", async () => {
  const api = await import("../src/lib/prediction-api.ts");
  const updatedAt = 1790334000000 + 40 * HOUR;
  const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status });
  const series = (score) => [{ t: 1790334000000 + HOUR, s: Math.round(score / 40) }, { t: updatedAt, s: score }];
  const requested = stubFetch([
    [/rk\.exmeaning\.com\/public\/event\/218\/latest/, json({ event_id: 218, status: "active", items: [] })],
    [/rk\.exmeaning\.com\/public\/event\/218\//, json({ event_id: 218, status: "active" })],
    [/\/v2\/jp\/latest/, json(v2Latest(218, updatedAt))],
    [/\/v2\/jp\/tier-series/, json({ event_id: 218, tiers: { 50: series(226_500_000), 100: series(151_500_000), 200: [], 1000: [] } })],
  ]);
  const data = await api.fetchPredictionData(218, "jp");
  assert.equal(data.data.event_id, 218);
  // Rows for every reward tier the snapshot covers (T1-T100 here, not only the page's 11 tiers); none for T200+.
  const covered = rulesOf("jp", 218).rankingTiers.filter((rank) => rank <= 100);
  assert.deepEqual(covered, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 100]);
  assert.deepEqual(data.data.charts.map((c) => c.Rank), covered);
  assert.deepEqual(data.data.charts.map((c) => c.CurrentScore), covered.map((rank) => 300_000_000 - (rank - 1) * 1_500_000));
  for (const c of data.data.charts) {
    assert.ok(c.PredictedScore > c.CurrentScore && c.PredictedScoreP90 >= c.PredictedScore && c.PredictedScoreP10 <= c.PredictedScore, `T${c.Rank}`);
    assert.ok(c.HistoryPoints.length >= 2 && c.PredictPoints.length > 0, `T${c.Rank}`);
  }
  for (let i = 1; i < data.data.charts.length; i++) assert.ok(data.data.charts[i].PredictedScore <= data.data.charts[i - 1].PredictedScore);
  assert.deepEqual(data.data.tier_klines.map((k) => k.Rank), covered);
  assert.ok(requested.some((u) => /\/jp\/master\/events\.json/.test(u)), "the event's masterdata context was loaded");
  const seriesUrl = requested.find((u) => /\/v2\/jp\/tier-series/.test(u));
  assert.ok(seriesUrl && new URL(seriesUrl).searchParams.get("tiers").split(",").map(Number).includes(20000), "tier-series asks for the reward tiers");
});

test("fetchPredictionData: a running event without rk tiers whose v2 load fails rejects, so the page reports it", async () => {
  const api = await import("../src/lib/prediction-api.ts");
  const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status });
  const requested = stubFetch([
    [/rk\.exmeaning\.com\/public\/event\/218\/latest/, json({ event_id: 218, status: "active", items: [] })],
    [/rk\.exmeaning\.com\/public\/event\/218\//, json({ event_id: 218, status: "active" })],
    [/\/v2\/jp\/latest/, json({ error: "origin error" }, 522)],
  ]);
  await assert.rejects(api.fetchPredictionData(218, "jp"));
  assert.ok(requested.filter((u) => /\/v2\/jp\/latest/.test(u)).length >= 1);
});

test("fetchPredictionData: running rk tiers are predicted by the model from a history ending on the snapshot, T20000+ included", async () => {
  const api = await import("../src/lib/prediction-api.ts");
  const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status });
  const rules = rulesOf("jp", 216);
  const updatedAt = rules.scopeStartAt + 60 * HOUR + 24 * 60_000;
  const collect = new Date(updatedAt).toISOString();
  const ranks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
  const finals = new Map(JP_FINALS.filter((f) => f.eventId === 216 && f.scope.kind === "overall").map((f) => [f.rank, f.score]));
  // rk's own prediction, deliberately not monotone across tiers (T100 above T50, as seen on CN #180).
  const items = ranks.map((rank) => ({
    rank, score: Math.round(finals.get(rank) * 0.4), prediction: rank === 100 ? 999_000_000 : rank > 10000 ? null : 1, collect_time: collect, is_final: false,
  }));
  const hourly = (h) => ({ collect_time: new Date(rules.scopeStartAt + h * HOUR).toISOString(), items: items.map((i) => ({ rank: i.rank, score: Math.round(i.score * h / 60.4), prediction: null })) });
  const timeline = { event_id: 216, status: "active", granularity: 1, final_only: false, timeline: [hourly(58), hourly(59), hourly(60)] };
  const run = async (timelineReply) => {
    stubFetch([
      [/rk\.exmeaning\.com\/public\/event\/216\/latest/, json({ event_id: 216, status: "active", updated_at: collect, items })],
      [/rk\.exmeaning\.com\/public\/event\/216\/timeline/, timelineReply],
      [/rk\.exmeaning\.com\/public\/event\/216\/kline/, json({ error: "origin error" }, 525)],
    ]);
    return api.fetchPredictionData(216, "jp");
  };
  const check = (data) => {
    assert.deepEqual(data.data.charts.map((c) => c.Rank), ranks);
    for (const c of data.data.charts) {
      const item = items.find((i) => i.rank === c.Rank);
      assert.equal(c.CurrentScore, item.score);
      assert.deepEqual(c.HistoryPoints.at(-1), { t: collect, y: item.score }, `T${c.Rank} history ends on the snapshot`);
      assert.ok(Number.isFinite(c.PredictedScoreP10) && Number.isFinite(c.PredictedScoreP90), `T${c.Rank} has model quantiles`);
      assert.ok(c.PredictedScoreP10 <= c.PredictedScore && c.PredictedScore <= c.PredictedScoreP90, `T${c.Rank}`);
      assert.ok(c.PredictedScore > c.CurrentScore, `T${c.Rank}`);
      assert.notEqual(c.PredictedScore, item.prediction, `T${c.Rank} is not rk's prediction`);
    }
    for (let i = 1; i < data.data.charts.length; i++) assert.ok(data.data.charts[i].PredictedScore <= data.data.charts[i - 1].PredictedScore, `T${ranks[i]}`);
  };
  // Timeline failed: two-point history from the scope start.
  const failed = await run(json({ error: "origin error" }, 522));
  check(failed);
  for (const c of failed.data.charts) assert.deepEqual(c.HistoryPoints[0], { t: new Date(rules.scopeStartAt).toISOString(), y: 0 });
  assert.ok(failed.data.charts.every((c) => c.HistoryPoints.length === 2));
  // Hourly timeline: the snapshot 24 min after the last hour is appended.
  const hourlyData = await run(json(timeline));
  check(hourlyData);
  assert.ok(hourlyData.data.charts.every((c) => c.HistoryPoints.length === 4));
});

test("fetchPredictionData: the v2 snapshot of another event is never shown under the requested one", async () => {
  const api = await import("../src/lib/prediction-api.ts");
  const updatedAt = 1790334000000 + 40 * HOUR;
  const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status });
  // An upcoming event rk lists without tiers keeps its empty rk result.
  stubFetch([
    [/rk\.exmeaning\.com\/public\/event\/219\/latest/, json({ event_id: 219, status: "upcoming", items: [] })],
    [/rk\.exmeaning\.com\/public\/event\/219\//, json({ event_id: 219, status: "upcoming" })],
    [/\/v2\/jp\/latest/, json(v2Latest(218, updatedAt))],
    [/\/v2\/jp\/tier-series/, json({ event_id: 218, tiers: {} })],
  ]);
  const upcoming = await api.fetchPredictionData(219, "jp");
  assert.equal(upcoming.data.event_id, 219);
  assert.deepEqual(upcoming.data.charts, []);
  // An ended event rk fails for is reported as a failure, not filled with the running event's tiers.
  stubFetch([
    [/rk\.exmeaning\.com\/public\/event\/1\//, json({ error: "sql: no rows in result set" }, 500)],
    [/\/v2\/jp\/latest/, json(v2Latest(218, updatedAt))],
    [/\/v2\/jp\/tier-series/, json({ event_id: 218, tiers: {} })],
  ]);
  await assert.rejects(api.fetchPredictionData(1, "jp"), /event 218, not 1/);
});

test("fetchPredictionData: an rk latest with tiers is used as before, without asking v2", async () => {
  const api = await import("../src/lib/prediction-api.ts");
  const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status });
  const collect = "2026-09-20T11:59:42Z";
  const items = [50, 100, 1000].map((rank) => ({ rank, score: 60_000_000 / Math.sqrt(rank), prediction: null, collect_time: collect, is_final: true }));
  const requested = stubFetch([
    [/rk\.exmeaning\.com\/public\/event\/217\/latest/, json({ event_id: 217, status: "finished", updated_at: collect, items })],
    [/rk\.exmeaning\.com\/public\/event\/217\/timeline/, json({ event_id: 217, status: "finished", granularity: 0, final_only: true, timeline: [] })],
    [/rk\.exmeaning\.com\/public\/event\/217\/kline/, json({ klines: [] })],
  ]);
  const data = await api.fetchPredictionData(217, "jp");
  assert.deepEqual(data.data.charts.map((c) => [c.Rank, c.CurrentScore]), items.map((i) => [i.rank, i.score]));
  assert.ok(!requested.some((u) => /\/v2\//.test(u)), "no v2 request");
});

// ---------------------------------------------------------------------------
// usePredictionEvent (lib/prediction/use-prediction-event.ts) in jsdom with stubbed upstreams
// ---------------------------------------------------------------------------

// 两个 .tsx context 换成最小实现；t 必须是稳定引用，否则依赖 t 的请求 effect 每次渲染都会重跑。
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = {
      "@/contexts/I18nContext": "const t = (key) => key; export function useI18n() { return { t }; }",
      "@/contexts/ThemeContext": "const theme = { serverSource: 'jp' }; export function useTheme() { return theme; }",
    };
    if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

/** rk final items of an ended JP event (score falls with rank; `base` tells the events apart). */
function rkFinal(eventId, base) {
  const items = [50, 100, 1000, 10000].map((rank) => ({ rank, score: Math.round(base / Math.sqrt(rank)), prediction: null, collect_time: "2026-09-20T11:59:42Z", is_final: true }));
  return { event_id: eventId, status: "finished", updated_at: "2026-09-20T11:59:42Z", items };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mounts usePredictionEvent in jsdom; `latest()` is the newest hook state. */
async function mountHook(options) {
  const { JSDOM } = await import("jsdom");
  // 先在没有 window 时载入 ranking-sync：有 window 时它会在模块顶层打开 BroadcastChannel，端口让测试进程无法退出。
  await import("../src/lib/ranking-sync.ts");
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: "http://localhost/zh-cn/prediction-next/planner/" });
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { usePredictionEvent } = await import("../src/lib/prediction/use-prediction-event.ts");
  let state = null;
  const Probe = () => {
    state = usePredictionEvent(options);
    return null;
  };
  const root = createRoot(dom.window.document.getElementById("root"));
  await React.act(async () => root.render(React.createElement(Probe)));
  const waitFor = async (cond, what, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (!cond(state)) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await React.act(async () => sleep(20));
    }
  };
  const act = (fn) => React.act(async () => fn(state));
  const unmount = async () => {
    await React.act(async () => root.unmount());
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    dom.window.close();
  };
  return { latest: () => state, waitFor, act, unmount };
}

const RK_EVENTS = [
  { event_id: 218, name: "Connect to SEKAI", start_at: 1790334000000, end_at: 1790593199000, status: "active", has_realtime_data: true, event_type: "world_bloom" },
  { event_id: 217, name: "Drive to Dream", start_at: 1789740000000, end_at: 1790243999000, status: "finished", has_realtime_data: true, event_type: "marathon" },
  { event_id: 216, name: "After the Fire", start_at: 1788674400000, end_at: 1789214399000, status: "finished", has_realtime_data: true, event_type: "marathon" },
];

test("usePredictionEvent: a late reply of the previously selected event is dropped, and its tiers are never shown", async () => {
  const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status });
  const delayed = (ms, reply) => async () => { await sleep(ms); return reply(); };
  const finalOnly = (id) => json({ event_id: id, status: "finished", granularity: 0, final_only: true, timeline: [] });
  let delay217 = 0;
  stubFetch([
    [/rk\.exmeaning\.com\/public\/events/, json(RK_EVENTS)],
    [/rk\.exmeaning\.com\/public\/event\/216\/latest/, delayed(400, json(rkFinal(216, 150_000_000)))],
    [/rk\.exmeaning\.com\/public\/event\/217\/latest/, async () => { await sleep(delay217); return json(rkFinal(217, 90_000_000))(); }],
    [/rk\.exmeaning\.com\/public\/event\/216\/timeline/, finalOnly(216)],
    [/rk\.exmeaning\.com\/public\/event\/217\/timeline/, finalOnly(217)],
    [/rk\.exmeaning\.com\/public\/event\/21[67]\/kline/, json({ klines: [] })],
    [/\/v2\/jp\/latest/, json(v2Latest(218, 1790334000000 + 40 * HOUR))],
  ]);
  const hook = await mountHook({ initialServer: "jp", initialEventId: 216 });
  try {
    // #216 is still loading (400 ms) when #217 is chosen; #217 answers at once.
    await hook.act((s) => s.setSelectedEventId(217));
    await hook.waitFor((s) => !s.loading && s.activePredictionData, "#217 data");
    await hook.act(() => sleep(700));
    const s = hook.latest();
    assert.equal(s.selectedEventId, 217);
    assert.equal(s.error, null);
    assert.equal(s.activePredictionData.data.event_id, 217);
    assert.equal(s.activePredictionData.data.charts.find((c) => c.Rank === 1000).CurrentScore, rkFinal(217, 90_000_000).items[2].score);

    // Back to #216 (now answered at once from rk), then #217 again with a slow reply: while it loads,
    // #216's tiers are not presented as #217's.
    await hook.act((st) => st.setSelectedEventId(216));
    await hook.waitFor((st) => !st.loading && st.activePredictionData?.data.event_id === 216, "#216 data");
    delay217 = 300;
    await hook.act((st) => st.setSelectedEventId(217));
    assert.equal(hook.latest().activePredictionData, null);
    assert.equal(hook.latest().loading, true);
    await hook.waitFor((st) => !st.loading && st.activePredictionData?.data.event_id === 217, "#217 data again");
  } finally {
    await hook.unmount();
  }
});

test("usePredictionEvent: a running event whose first load failed recovers on the next poll once v2 serves it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status });
  const updatedAt = 1790334000000 + 40 * HOUR;
  let v2Down = true;
  const series = (score) => [{ t: 1790334000000 + HOUR, s: Math.round(score / 40) }, { t: updatedAt, s: score }];
  stubFetch([
    [/rk\.exmeaning\.com\/public\/events/, json(RK_EVENTS)],
    [/rk\.exmeaning\.com\/public\/event\/218\/latest/, json({ event_id: 218, status: "active", updated_at: new Date(updatedAt).toISOString(), items: [] })],
    [/rk\.exmeaning\.com\/public\/event\/218\//, json({ error: "origin error" }, 525)],
    [/\/v2\/jp\/latest/, () => (v2Down ? json({ error: "origin error" }, 522)() : json(v2Latest(218, updatedAt))())],
    [/\/v2\/jp\/tier-series/, json({ event_id: 218, tiers: { 50: series(226_500_000), 100: series(151_500_000) } })],
  ]);
  const hook = await mountHook({ initialServer: "jp", initialEventId: 218 });
  try {
    await hook.waitFor((s) => !s.loading, "the first load to settle");
    assert.equal(hook.latest().error, "page.prediction.errors.predictionFetchFailed");
    assert.equal(hook.latest().activePredictionData, null);

    v2Down = false;
    await hook.act(() => t.mock.timers.tick(10_000));
    await hook.waitFor((s) => (s.activePredictionData?.data.charts.length ?? 0) > 0, "the poll to reload the event");
    const s = hook.latest();
    assert.equal(s.error, null);
    assert.equal(s.activePredictionData.data.event_id, 218);
    assert.deepEqual(s.activePredictionData.data.charts.map((c) => c.Rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 100]);
  } finally {
    await hook.unmount();
  }
});
