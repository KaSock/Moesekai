/**
 * 预测页的数据与走势图：prediction-api.ts（fetchPredictionData 的 rk 与 v2 两条路径）、
 * use-prediction-event.ts 的 WL 章节视图（按本章奖励档建行），以及 PredictionChart 的预测显示开关。
 * Run with: node --test --experimental-strip-types tests/prediction-api.test.mjs
 * 规则与主数据来自 tests/fixtures/event-rules（W6 的 masterdata 夹具），模型参数为提交的 priors.json；
 * 上游（rk、rks-n v2、metadata）全部用桩替换。
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
const CHART_URL = pathToFileURL(resolvePath(SRC_ROOT, "components/events/PredictionChart.tsx")).href;

// 与 prediction-engine.test.mjs 相同的加载钩子：@/ 别名与无扩展名导入按 tsconfig 解析，src 下的 .ts 用 TypeScript
// 转译，不带 type 属性的 JSON 导入转成 ES 模块。.tsx 里只有 PredictionChart 按 JSX 转译，其余给空模块；
// 两个 React context 和 echarts-for-react 换成最小实现（后者记下传给图表的 option，供断言）。
const STUBS = {
  "@/contexts/I18nContext": "const t = (key) => key; const formatNumber = (n) => String(n); const api = { t, formatNumber }; export function useI18n() { return api; }",
  "@/contexts/ThemeContext": "const theme = { serverSource: 'jp' }; export function useTheme() { return theme; }",
  "echarts-for-react": "export default function ReactECharts(props) { globalThis.__predictionChartOption = props.option; return null; }",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBS[specifier]) return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
    let target = null;
    const withTsExtension = (path) => [`${path}.ts`, `${path}.tsx`, `${path}/index.ts`].find((c) => existsSync(c));
    if (specifier.startsWith("@/")) {
      target = resolvePath(SRC_ROOT, specifier.slice(2));
      if (!extname(target)) target = withTsExtension(target) ?? target;
    } else if (/^\.\.?\//.test(specifier) && !extname(specifier) && context.parentURL?.startsWith("file:")) {
      target = withTsExtension(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)) ?? null;
    }
    return nextResolve(target ? pathToFileURL(target).href : specifier, context);
  },
  load(url, context, nextLoad) {
    const transpile = (jsx) => {
      const file = fileURLToPath(url);
      const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
        fileName: file,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false, ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}) },
      });
      return { format: "module", source: outputText, shortCircuit: true };
    };
    if (url === CHART_URL) return transpile(true);
    if (url.startsWith("file:") && url.endsWith(".tsx")) return { format: "module", source: "export {};", shortCircuit: true };
    if (url.startsWith(SRC_URL) && url.endsWith(".ts")) return transpile(false);
    if (url.startsWith("file:") && url.endsWith(".json") && !url.includes("/node_modules/") && context.importAttributes?.type !== "json") {
      return { format: "module", source: `export default ${readFileSync(fileURLToPath(url), "utf8")};`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { EVENT_RULE_TABLES, resolveEventRules } = await import("../src/lib/event-rules/index.ts");
// 先在没有 window 时载入 ranking-sync：有 window 时它会在模块顶层打开 BroadcastChannel，端口让测试进程无法退出。
await import("../src/lib/ranking-sync.ts");
const api = await import("../src/lib/prediction-api.ts");
const live = await import("../src/lib/prediction/live-prediction.ts");

const HOUR = 3_600_000;
const FIXTURES = new URL("./fixtures/event-rules/", import.meta.url);
const readJson = (url) => JSON.parse(readFileSync(url, "utf8"));

function loadMasterdata(region) {
  const masterdata = {};
  for (const table of EVENT_RULE_TABLES) {
    const url = new URL(`${region}/${table}.json`, FIXTURES);
    if (existsSync(url)) masterdata[table] = readJson(url);
  }
  return masterdata;
}

const MASTERDATA = { jp: loadMasterdata("jp"), cn: loadMasterdata("cn") };
const rulesOf = (region, eventId, scope = { kind: "overall" }) => resolveEventRules({ region, eventId, masterdata: MASTERDATA[region], scope });
const eventRow = (region, eventId) => MASTERDATA[region].events.find((e) => e.id === eventId);

const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Routes every upstream request to canned bodies (masterdata from the fixtures); records the URLs. */
function stubFetch(routes) {
  const requested = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    const master = url.match(/\/(jp|cn)\/master\/(\w+)\.json/);
    if (master) {
      const rows = MASTERDATA[master[1]][master[2]] ?? (/^(eventStories|gameCharacterUnits)$/.test(master[2]) ? [] : null);
      return rows ? json(rows)() : json({}, 404)();
    }
    for (const [pattern, reply] of routes) if (pattern.test(url)) return reply();
    return json({ error: "not stubbed" }, 404)();
  };
  return requested;
}

/** Quantiles of consecutive rows (ascending rank) never increase: P10, P50 and P90 each. */
function assertMonotoneQuantiles(charts) {
  for (let i = 1; i < charts.length; i++) {
    const [a, b] = [charts[i - 1], charts[i]];
    for (const key of ["PredictedScoreP10", "PredictedScore", "PredictedScoreP90"]) {
      assert.ok(b[key] <= a[key], `${key}: T${b.Rank} ${b[key]} is above T${a.Rank} ${a[key]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// R9-6：同一快照的各档历史都结束在快照时刻
// ---------------------------------------------------------------------------

// 日服 #218（WL3 终章）进行到 41.2 小时时 rks-n v2 的形状：latest 只有 T1–T100；tier-series 各档最后一点
// 早于 updated_at 的秒数各不相同（录制器 2026-09-27T04:04Z 的真实偏移：7–94 s），分数取同一时刻的真实量级。
const JP_218_START = eventRow("jp", 218).startAt;
const JP_218_END = eventRow("jp", 218).aggregateAt;
const JP_218_BORDERS = [[1, 143_896_395], [2, 142_860_910], [3, 142_670_330], [4, 142_065_290], [5, 141_549_805], [10, 140_297_465],
  [20, 138_872_295], [30, 138_259_290], [40, 137_403_115], [50, 136_005_160], [100, 133_398_580]];
const SERIES_END_OFFSET_S = { 1: 33, 10: 63, 20: 30, 30: 35, 40: 7, 50: 94, 100: 17 };

/** Score of any rank 1-100, interpolated in log(rank) between the recorded borders. */
function jp218ScoreAt(rank) {
  for (let i = 1; i < JP_218_BORDERS.length; i++) {
    const [r0, s0] = JP_218_BORDERS[i - 1];
    const [r1, s1] = JP_218_BORDERS[i];
    if (rank <= r1) return Math.round(s0 + (s1 - s0) * (Math.log(rank / r0) / Math.log(r1 / r0)));
  }
  return JP_218_BORDERS.at(-1)[1];
}

test("v2 fallback: tiers whose series end up to 60 s before the snapshot end on the snapshot, and quantiles stay monotone", async () => {
  const updatedAt = JP_218_START + Math.round(41.2 * HOUR);
  const rankings = Array.from({ length: 100 }, (_, i) => ({ rank: i + 1, score: jp218ScoreAt(i + 1), userId: String(i + 1), name: "p" }));
  const series = {};
  for (const [rank, offsetS] of Object.entries(SERIES_END_OFFSET_S)) {
    const endT = updatedAt - offsetS * 1000;
    const final = jp218ScoreAt(Number(rank)) * (endT - JP_218_START) / (updatedAt - JP_218_START);
    const points = [];
    for (let t = JP_218_START + 120_000; t < endT; t += 15 * 60_000) points.push({ t, s: Math.round(final * (t - JP_218_START) / (endT - JP_218_START)) });
    points.push({ t: endT, s: Math.round(final) });
    series[rank] = points;
  }
  stubFetch([
    [/rk\.exmeaning\.com\/public\/event\/218\/latest/, json({ event_id: 218, status: "active", items: [] })],
    [/rk\.exmeaning\.com\/public\/event\/218\//, json({ error: "origin error" }, 525)],
    [/\/v2\/jp\/latest/, json({ event_id: 218, region: "jp", start_at: JP_218_START, end_at: JP_218_END, updated_at: updatedAt, is_event_aggregate: false, rankings })],
    [/\/v2\/jp\/tier-series/, json({ event_id: 218, region: "jp", updated_at: updatedAt + 7000, tiers: series })],
  ]);
  const data = await api.fetchPredictionData(218, "jp");
  const covered = rulesOf("jp", 218).rankingTiers.filter((rank) => rank <= 100);
  assert.deepEqual(data.data.charts.map((c) => c.Rank), covered);
  const snapshotIso = new Date(updatedAt).toISOString();
  for (const c of data.data.charts) {
    assert.deepEqual(c.HistoryPoints.at(-1), { t: snapshotIso, y: c.CurrentScore }, `T${c.Rank} history ends on the snapshot`);
    assert.ok(c.PredictedScoreP10 <= c.PredictedScore && c.PredictedScore <= c.PredictedScoreP90, `T${c.Rank}`);
  }
  // T1 ended 33 s early: its series point was moved, not duplicated.
  const t1 = data.data.charts.find((c) => c.Rank === 1);
  assert.equal(t1.HistoryPoints.filter((p) => new Date(p.t).getTime() > updatedAt - 60_000).length, 1);
  assertMonotoneQuantiles(data.data.charts);
});

test("rk path: a timeline frame 30 s before the snapshot is moved onto it, like a tier the frame misses", async () => {
  // 日服 #217（普通活动）进行中：rk 的最后一帧比 latest 早 30 s，且 T20000 不在最后一帧里（只到上一小时）。
  const rules = rulesOf("jp", 217);
  const updatedAt = rules.scopeStartAt + 60 * HOUR + 24 * 60_000;
  const collect = new Date(updatedAt).toISOString();
  const ranks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  const score = (rank, h) => Math.round((90_000_000 / Math.sqrt(rank)) * h / 60.4);
  const items = ranks.map((rank) => ({ rank, score: score(rank, 60.4), prediction: null, collect_time: collect, is_final: false }));
  const frame = (atMs, ids) => ({ collect_time: new Date(atMs).toISOString(), items: ids.map((rank) => ({ rank, score: score(rank, (atMs - rules.scopeStartAt) / HOUR), prediction: null })) });
  const lastFrameAt = updatedAt - 30_000;
  const timeline = {
    event_id: 217, status: "active", granularity: 1, final_only: false,
    timeline: [frame(rules.scopeStartAt + 59 * HOUR, ranks), frame(lastFrameAt, ranks.filter((rank) => rank !== 20000))],
  };
  stubFetch([
    [/rk\.exmeaning\.com\/public\/event\/217\/latest/, json({ event_id: 217, status: "active", updated_at: collect, items })],
    [/rk\.exmeaning\.com\/public\/event\/217\/timeline/, json(timeline)],
    [/rk\.exmeaning\.com\/public\/event\/217\/kline/, json({ error: "origin error" }, 525)],
  ]);
  const data = await api.fetchPredictionData(217, "jp");
  assert.deepEqual(data.data.charts.map((c) => c.Rank), ranks);
  for (const c of data.data.charts) {
    assert.deepEqual(c.HistoryPoints.at(-1), { t: collect, y: c.CurrentScore }, `T${c.Rank} history ends on the snapshot`);
    assert.ok(!c.HistoryPoints.some((p) => p.t === new Date(lastFrameAt).toISOString()), `T${c.Rank} keeps no point 30 s before it`);
  }
  assertMonotoneQuantiles(data.data.charts);
});

// ---------------------------------------------------------------------------
// R10-6 / D6：WL 章节视图按本章奖励档建行，并按这些档请求章节 tier-series
// ---------------------------------------------------------------------------

test("chapterRowRanks: covered reward tiers only; every reward tier while the chapter has no data", async () => {
  const { chapterRowRanks } = await import("../src/lib/prediction/use-prediction-event.ts");
  const reward = [100, 200, 300, 4000, 7000, 20000, 100000];
  assert.deepEqual(chapterRowRanks(reward, [1, 2, 50, 100, 200, 4000, 20000], null), [100, 200, 4000, 20000]);
  assert.deepEqual(chapterRowRanks(reward, [100], { 300: [{ t: 1, s: 5 }], 7000: [], 100000: [{ t: 1, s: 2 }] }), [100, 300, 100000]);
  assert.deepEqual(chapterRowRanks(reward, [], { 100: [], 200: [] }), reward);
  assert.deepEqual(chapterRowRanks(reward, [1, 2, 3], null), reward);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describeState(s) {
  if (!s) return "none";
  const charts = s.activePredictionData?.data.charts;
  return JSON.stringify({
    loading: s.loading, error: s.error, event: s.selectedEventId, chapter: s.selectedWlChapter, isWl: s.isWorldBloomEvent,
    chapters: s.eventWorldBlooms.map((c) => c.gameCharacterId), groups: s.worldLinkSnapshot?.groups?.length ?? null,
    rows: charts?.map((c) => c.Rank) ?? null,
  });
}

/** Mounts usePredictionEvent in jsdom; `latest()` is the newest hook state. */
async function mountHook(options) {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: "http://localhost/zh-cn/prediction-next/" });
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
  const waitFor = async (cond, what, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (!cond(state)) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}; state: ${describeState(state)}`);
      await React.act(async () => sleep(20));
    }
  };
  const settle = (promise) => React.act(async () => {
    await promise;
    await sleep(50);
  });
  const unmount = async () => {
    await React.act(async () => root.unmount());
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    dom.window.close();
  };
  return { latest: () => state, waitFor, settle, unmount };
}

// rk 活动列表按服务器缓存 10 分钟，所以同一文件的各个钩子测试共用这一份。
const rkEvent = (region, id, status, type = "world_bloom") => {
  const row = eventRow(region, id);
  return { event_id: id, name: row?.name ?? `#${id}`, start_at: row?.startAt ?? 1790600000000, end_at: row?.aggregateAt ?? 1791200000000, status, has_realtime_data: true, event_type: type };
};
const RK_EVENTS = {
  jp: [rkEvent("jp", 218, "active"), { ...rkEvent("jp", 219, "finished"), start_at: 1786000000000, end_at: 1786600000000 }, rkEvent("jp", 214, "finished")],
  cn: [rkEvent("cn", 180, "active"), rkEvent("cn", 112, "finished")],
};
/** Border ranks the v2 boards list after T1-T100 (CN serves these to T200000). */
const V2_BORDERS = [200, 300, 400, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7000, 10000, 20000, 30000, 40000, 50000, 70000, 100000, 200000];
const boardEntries = (top) => [...Array.from({ length: 100 }, (_, i) => i + 1), ...V2_BORDERS]
  .map((rank) => ({ rank, score: Math.round(top / Math.sqrt(rank)), userId: String(rank), name: "p" }));

/** v2 worldlink-latest of a WL event: one group per chapter, each listing T1-T100 and the border ranks. */
function worldLinkLatest(region, eventId, chapters, top) {
  return {
    event_id: eventId, region, start_at: chapters[0].startAt, end_at: chapters.at(-1).endAt, updated_at: chapters.at(-1).endAt,
    groups: chapters.map((c, i) => ({
      event_id: eventId, region, start_at: c.startAt, end_at: c.endAt, updated_at: c.endAt,
      game_character_id: c.gameCharacterId, is_world_bloom_chapter_aggregate: false, rankings: boardEntries(top * (1 + i / 10)),
    })),
  };
}

function rkFinal(eventId, top) {
  const items = [100, 1000, 10000].map((rank) => ({ rank, score: Math.round(top / Math.sqrt(rank)), prediction: null, collect_time: "2026-09-20T11:59:42Z", is_final: true }));
  return { event_id: eventId, status: "finished", updated_at: "2026-09-20T11:59:42Z", items };
}

/** Mounts the hook on one WL chapter and returns its chapter rows and the last chapter tier-series request. */
async function chapterView(region, eventId, gameCharacterId, chapters, expectedRanks) {
  const v2 = region === "jp" ? "rks-n\\.exmeaning\\.com/api/public/v2/jp" : "rks-n-cn\\.exmeaning\\.com/api/public/v2/cn";
  const requested = stubFetch([
    [/rk\.exmeaning\.com\/public\/events/, json(RK_EVENTS[region])],
    [new RegExp(`rk\\.exmeaning\\.com/public/event/${eventId}/latest`), json(rkFinal(eventId, 3_000_000_000))],
    [new RegExp(`rk\\.exmeaning\\.com/public/event/${eventId}/timeline`), json({ event_id: eventId, status: "finished", granularity: 0, final_only: true, timeline: [] })],
    [new RegExp(`rk\\.exmeaning\\.com/public/event/${eventId}/kline`), json({ klines: [] })],
    [new RegExp(`${v2}/worldlink-latest`), json(worldLinkLatest(region, eventId, chapters, 2_000_000_000))],
    // Like the live API after a chapter: every requested tier, each with an empty series.
    [new RegExp(`${v2}/worldlink-tier-series`), () => {
      const url = new URL(requested.filter((u) => /worldlink-tier-series/.test(u)).at(-1));
      return json({ event_id: eventId, region, tiers: Object.fromEntries(url.searchParams.get("tiers").split(",").map((t) => [t, []])) })();
    }],
    [new RegExp(`${v2}/latest`), json({ error: "origin error" }, 522)],
  ]);
  const hook = await mountHook({ initialServer: region, initialEventId: eventId, initialChapter: gameCharacterId });
  try {
    const ranksOf = (s) => s.activePredictionData?.data.charts.map((c) => c.Rank) ?? [];
    const settled = (s) => !s.loading && s.eventWorldBlooms.length > 0 && ranksOf(s).join() === expectedRanks.join();
    const what = `${region} #${eventId} chapter ${gameCharacterId} rows ${expectedRanks.join(",")}`;
    await hook.waitFor(settled, what);
    // The rows must hold once the event's context source (its rules) has loaded, not only before.
    await hook.settle(live.loadPredictionContextSource(region, eventId));
    await hook.waitFor(settled, `${what} after the context source loaded`);
    const lastSeries = new URL(requested.filter((u) => /worldlink-tier-series/.test(u)).at(-1));
    return { state: hook.latest(), lastSeries };
  } finally {
    await hook.unmount();
  }
}

const chaptersOf = (region, eventId) => MASTERDATA[region].worldBlooms
  .filter((wb) => wb.eventId === eventId && wb.gameCharacterId > 0)
  .sort((a, b) => a.chapterNo - b.chapterNo)
  .map((wb) => ({ gameCharacterId: wb.gameCharacterId, startAt: wb.chapterStartAt, endAt: wb.aggregateAt }));

for (const [region, eventId, gameCharacterId, tierCount, lastTier] of [["jp", 214, 25, 18, 100_000], ["cn", 112, 18, 16, 50_000]]) {
  test(`chapter view ${region} #${eventId} (chapter ${gameCharacterId}): rows and tier-series follow the chapter's ${tierCount} reward tiers`, async () => {
    const reward = rulesOf(region, eventId, { kind: "chapter", gameCharacterId }).rankingTiers;
    assert.equal(reward.length, tierCount);
    assert.equal(reward.at(-1), lastTier);
    const { state, lastSeries } = await chapterView(region, eventId, gameCharacterId, chaptersOf(region, eventId), reward);
    const charts = state.activePredictionData.data.charts;
    const group = worldLinkLatest(region, eventId, chaptersOf(region, eventId), 2_000_000_000).groups.find((g) => g.game_character_id === gameCharacterId);
    for (const c of charts) assert.equal(c.CurrentScore, group.rankings.find((e) => e.rank === c.Rank).score, `T${c.Rank}`);
    assert.deepEqual(state.activePredictionData.data.tier_klines.map((k) => k.Rank), reward);
    assert.equal(lastSeries.searchParams.get("gameCharacterId"), String(gameCharacterId));
    assert.deepEqual(lastSeries.searchParams.get("tiers").split(",").map(Number), reward);
  });
}

test("chapter view without rules for the chapter (event not in masterdata yet): the page's 11 tiers", async () => {
  // 日服 #219：rk 列表里有这个 WL 活动，主数据还没有；章节来自 v2 快照的 group。
  const { PREDICTION_RANK_TIERS } = await import("../src/lib/prediction/use-prediction-event.ts");
  const chapters = [
    { gameCharacterId: 21, startAt: 1786000000000, endAt: 1786000000000 + 48 * HOUR },
    { gameCharacterId: 22, startAt: 1786000000000 + 48 * HOUR, endAt: 1786000000000 + 96 * HOUR },
  ];
  const { state, lastSeries } = await chapterView("jp", 219, 22, chapters, PREDICTION_RANK_TIERS);
  const source = await live.loadPredictionContextSource("jp", 219);
  assert.equal(source.rewardTiersFor({ kind: "chapter", gameCharacterId: 22 }), null);
  assert.deepEqual(state.activePredictionData.data.charts.map((c) => c.Rank), PREDICTION_RANK_TIERS);
  assert.deepEqual(lastSeries.searchParams.get("tiers").split(",").map(Number), PREDICTION_RANK_TIERS);
});

// ---------------------------------------------------------------------------
// R13-5 / D5：走势图的预测显示开关
// ---------------------------------------------------------------------------

test("PredictionChart: T20000+ shows the prediction only with showPredictionAtAllRanks; up to T10000 it always does", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: PredictionChart } = await import("../src/components/events/PredictionChart.tsx");
  const chart = (rank) => ({
    Rank: rank, CurrentScore: 400_000, PredictedScore: 900_000, PredictedScoreP10: 800_000, PredictedScoreP90: 1_000_000,
    HistoryPoints: [{ t: "2026-09-26T00:00:00.000Z", y: 0 }, { t: "2026-09-27T00:00:00.000Z", y: 400_000 }],
    PredictPoints: [{ t: "2026-09-28T00:00:00.000Z", y: 700_000 }, { t: "2026-09-29T00:00:00.000Z", y: 900_000 }],
  });
  const render = (props) => {
    globalThis.__predictionChartOption = null;
    const html = renderToStaticMarkup(React.createElement(PredictionChart, props));
    const option = globalThis.__predictionChartOption;
    return { html, series: option.series.map((s) => s.name), legend: option.legend.data };
  };
  const predicted = "page.prediction.chart.predictedScore";
  const shown = (r) => r.html.includes("80% CI: 800000 ~ 1000000") && r.html.includes("900000") && r.series.includes(predicted) && r.legend.includes(predicted);
  const hidden = (r) => !r.html.includes("80% CI") && !r.html.includes("900000") && !r.series.includes(predicted) && !r.legend.includes(predicted);

  // /prediction (default): T10000 and below only, as before.
  assert.ok(shown(render({ data: chart(10000) })), "T10000 default");
  assert.ok(hidden(render({ data: chart(20000) })), "T20000 default");
  // /prediction-next: every rank the page predicted.
  assert.ok(shown(render({ data: chart(20000), showPredictionAtAllRanks: true })), "T20000 all ranks");
  assert.ok(shown(render({ data: chart(100000), showPredictionAtAllRanks: true })), "T100000 all ranks");
  assert.ok(shown(render({ data: chart(1000), showPredictionAtAllRanks: true })), "T1000 all ranks");
});

test("only /prediction-next opts in to the prediction above T10000; /prediction keeps the default", () => {
  const src = (path) => readFileSync(new URL(`../src/app/${path}`, import.meta.url), "utf8");
  const uses = (text) => [...text.matchAll(/<PredictionChart\b[^>]*\/>/g)].map((m) => m[0]);
  assert.deepEqual(uses(src("prediction-next/client.tsx")).map((u) => /\bshowPredictionAtAllRanks\b/.test(u)), [true]);
  assert.deepEqual(uses(src("prediction/client.tsx")).map((u) => /\bshowPredictionAtAllRanks\b/.test(u)), [false]);
});
