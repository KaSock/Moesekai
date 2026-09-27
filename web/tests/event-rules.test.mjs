/**
 * resolveEventRules：逐期规则档案（contract §1 / §1a）。
 * Run with: node --test --experimental-strip-types tests/event-rules.test.mjs
 * 夹具为回测工作目录 wlrules/ 下的真实 masterdata 行（按所需活动裁剪）；worldBloomChapterRankingRewardRanges
 * （仅 JP #214 / CN #112）与 eventTotalPowerLimits（JP 全部 6 行，CN 为空表）取自 metadata.exmeaning.com。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { ENGINE_READ_TABLES, EVENT_RULE_TABLES, resolveEventRules } from "../src/lib/event-rules/index.ts";
import { AUTO_BASE, OFFICIAL_LIMITS, SPECIAL_MEASURES } from "../src/lib/event-rules/overrides.ts";

const FIXTURES = new URL("./fixtures/event-rules/", import.meta.url);

function loadMasterdata(region) {
  const masterdata = {};
  for (const table of EVENT_RULE_TABLES) {
    const url = new URL(`${region}/${table}.json`, FIXTURES);
    if (existsSync(url)) masterdata[table] = JSON.parse(readFileSync(url, "utf8"));
  }
  return masterdata;
}

const MASTERDATA = { jp: loadMasterdata("jp"), cn: loadMasterdata("cn") };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WIKI = { source: "secondary", ref: "pjsekai wiki (auto live)" };

function resolve(region, eventId, extra = {}) {
  return resolveEventRules({ region, eventId, masterdata: MASTERDATA[region], ...extra });
}

// ---------------------------------------------------------------------------
// Golden table (contract §1a): one row per (region, event).
// ---------------------------------------------------------------------------

const NONE = { value: null };
const WL1 = { slots: 12, table: "WL1", source: "secondary", ref: "allium deck engine" };
const WL2 = { slots: 20, table: "WL2", source: "secondary", ref: "allium deck engine" };
// note_382 原文「メンバー枠数が20枠→25枠に」；#218 由 note_407 沿用 2026 年 WL（链接 6.4.0）。
const WL3 = { slots: 25, table: "WL3", source: "official", ref: "note_382 (v6.4.0)" };
const NORMAL_AUTO = { on: false, ...WIKI };
const LIMITS_NORMAL = [10, 10, 99];
const LIMITS_MEASURE = [10, 99, 99];
const JP_TIERS = [34, 300000];
const CN_TIERS = [33, 200000];
// eventTotalPowerLimits 行 id（JP）；表缺失时回退到 OFFICIAL_LIMITS（见下方回退用例）。
const POWER_ROW = { 202: 1, 205: 2, 207: 3, 211: 4, 214: 5, 218: 6 };
const wl3Power = (id) => ({ value: 336000, source: "masterdata", ref: `eventTotalPowerLimits#${POWER_ROW[id]}` });

function chapterRow(region, id, start, turn, chapters, hours, extra = {}) {
  const tiers = region === "jp" ? JP_TIERS : CN_TIERS;
  const support = turn === 1 ? WL1 : turn === 2 ? WL2 : WL3;
  const notes = turn === 3 ? ["wl3Chapter"] : turn === 1 && region === "cn" ? ["cnWl1"] : [];
  return {
    region, id, start, turn,
    groups: { overall: "wl_overall", chapter: hours === 72 ? "wl_chapter_72h" : "wl_chapter_48h" },
    chapters: [chapters, hours],
    breakTime: turn === 3 ? 2 : null,
    memberLimit: NONE, skillCap: NONE, fixtureCap: null,
    powerCap: turn === 3 ? wl3Power(id) : NONE,
    shuffle: [], support,
    eventCard: turn === 3 ? [30, 0] : [20, 0],
    honor: null,
    unitLimited: turn === 1 ? null : 20,
    autoMeasure: NORMAL_AUTO, autoLimit: LIMITS_NORMAL,
    tiers, notes,
    ...extra,
  };
}

const GOLDEN = [
  chapterRow("jp", 112, "2023-11-08", 1, 4, 72),
  chapterRow("jp", 118, "2024-01-09", 1, 4, 72),
  chapterRow("jp", 124, "2024-03-08", 1, 4, 72),
  chapterRow("jp", 130, "2024-05-09", 1, 4, 72),
  chapterRow("jp", 137, "2024-07-17", 1, 4, 72),
  chapterRow("jp", 140, "2024-08-17", 1, 6, 48),
  chapterRow("jp", 163, "2025-04-08", 2, 4, 72),
  chapterRow("jp", 167, "2025-05-09", 2, 4, 72),
  chapterRow("jp", 170, "2025-06-09", 2, 4, 72),
  chapterRow("jp", 171, "2025-06-23", 2, 4, 72),
  chapterRow("jp", 176, "2025-08-08", 2, 4, 72),
  chapterRow("jp", 179, "2025-09-06", 2, 6, 48),
  {
    region: "jp", id: 180, start: "2025-09-25", turn: 2,
    groups: { overall: "wl_finale" }, chapters: [1, 72], breakTime: null,
    memberLimit: { value: 4, source: "masterdata", ref: "eventCardBonusLimits#1" },
    skillCap: { value: 140, source: "official", ref: "note_332 (v5.3.0)" },
    fixtureCap: 2, powerCap: NONE, shuffle: [], support: WL2,
    eventCard: [25, 20], honor: [156, 50], unitLimited: 20,
    autoMeasure: { on: true, source: "official", ref: "in-game notice: finale auto live score measure (2025-09)" }, autoLimit: LIMITS_MEASURE,
    tiers: JP_TIERS, notes: ["finaleWl2"],
  },
  chapterRow("jp", 202, "2026-04-18", 3, 5, 48),
  chapterRow("jp", 205, "2026-05-17", 3, 6, 48),
  chapterRow("jp", 207, "2026-06-08", 3, 5, 48),
  chapterRow("jp", 211, "2026-07-19", 3, 5, 48),
  chapterRow("jp", 214, "2026-08-17", 3, 5, 48),
  {
    region: "jp", id: 218, start: "2026-09-25", turn: 3,
    groups: { overall: "wl_finale" }, chapters: [1, 72], breakTime: 2,
    memberLimit: { value: 5, source: "official", ref: "note_407 (v6.8.0)" },
    skillCap: { value: 140, source: "masterdata", ref: "eventSkillScoreUpLimits#2" },
    fixtureCap: 6,
    powerCap: wl3Power(218),
    shuffle: [{ unitCount: 3, bonusRate: 10 }, { unitCount: 4, bonusRate: 30 }, { unitCount: 5, bonusRate: 50 }],
    support: WL3, eventCard: [25, 20], honor: [156, 50], unitLimited: 20,
    autoMeasure: { on: false, source: "official", ref: "note_407 (v6.8.0)" }, autoLimit: LIMITS_NORMAL,
    tiers: JP_TIERS, notes: ["finaleWl3"],
  },
  chapterRow("cn", 124, "2025-04-18", 1, 4, 48),
  chapterRow("cn", 130, "2025-05-19", 1, 4, 48),
  chapterRow("cn", 118, "2025-06-12", 1, 4, 48),
  chapterRow("cn", 137, "2025-07-20", 1, 4, 48),
  chapterRow("cn", 140, "2025-08-13", 1, 6, 48),
  chapterRow("cn", 112, "2025-09-12", 1, 4, 48),
  chapterRow("cn", 163, "2026-04-09", 2, 4, 72),
  chapterRow("cn", 167, "2026-05-09", 2, 4, 72),
  chapterRow("cn", 170, "2026-06-09", 2, 4, 72),
  chapterRow("cn", 171, "2026-06-23", 2, 4, 72),
  chapterRow("cn", 176, "2026-08-08", 2, 4, 72),
  chapterRow("cn", 179, "2026-09-06", 2, 6, 48),
  {
    region: "cn", id: 180, start: "2026-09-25", turn: 2,
    groups: { overall: "wl_finale" }, chapters: [1, 72], breakTime: null,
    memberLimit: { value: 4, source: "masterdata", ref: "eventCardBonusLimits#1" },
    skillCap: { value: 140, source: "secondary", ref: "JP note_332" },
    fixtureCap: 2, powerCap: NONE, shuffle: [], support: WL2,
    eventCard: [25, 20], honor: [156, 50], unitLimited: 20,
    autoMeasure: { on: true, source: "official", ref: "operator-confirmed" }, autoLimit: LIMITS_MEASURE,
    tiers: CN_TIERS, notes: ["finaleWl2"],
  },
];

function assertSourced(actual, expected, label) {
  assert.equal(actual.value, expected.value, `${label} value`);
  if (expected.source) assert.equal(actual.source, expected.source, `${label} source`);
  if (expected.ref) assert.equal(actual.ref, expected.ref, `${label} ref`);
}

test("golden table covers 32 rows (19 JP + 13 CN)", () => {
  assert.equal(GOLDEN.length, 32);
  assert.equal(GOLDEN.filter((row) => row.region === "jp").length, 19);
  assert.equal(GOLDEN.filter((row) => row.region === "cn").length, 13);
});

for (const row of GOLDEN) {
  test(`golden ${row.region} #${row.id}`, () => {
    const rules = resolve(row.region, row.id);
    const label = `${row.region} #${row.id}`;

    assert.equal(rules.region, row.region);
    assert.equal(rules.eventId, row.id);
    assert.equal(rules.eventType, "world_bloom");
    assert.equal(new Date(rules.startAt).toISOString().slice(0, 10), row.start, `${label} start`);
    assert.equal(rules.wlTurn, row.turn, `${label} turn`);

    assert.equal(rules.group, row.groups.overall, `${label} overall group`);
    assert.deepEqual(rules.scope, { kind: "overall" });
    assert.equal(rules.scopeStartAt, rules.startAt);
    assert.equal(rules.scopeAggregateAt, rules.aggregateAt);
    assert.equal(rules.isFinale, row.groups.overall === "wl_finale");
    if (row.groups.chapter) {
      const first = rules.chapters[0];
      const chapterRules = resolve(row.region, row.id, { scope: { kind: "chapter", gameCharacterId: first.gameCharacterId } });
      assert.equal(chapterRules.group, row.groups.chapter, `${label} chapter group`);
    } else {
      assert.equal(rules.chapters[0].gameCharacterId, null, `${label} finale chapter has no character`);
    }

    assert.equal(rules.chapters.length, row.chapters[0], `${label} chapter count`);
    for (const chapter of rules.chapters) assert.equal(chapter.hours, row.chapters[1], `${label} chapter ${chapter.chapterNo} hours`);
    assert.deepEqual(rules.chapters.map((c) => c.chapterNo), rules.chapters.map((_, i) => i + 1));

    assert.equal(rules.breakGaugeConfigured, row.breakTime !== null, `${label} gauge configured`);
    assert.equal(rules.breakGauge.value?.id ?? null, row.breakTime, `${label} break time`);
    if (row.breakTime !== null) assert.equal(rules.breakGauge.value.resetPerWlChapter, true);

    assertSourced(rules.memberBonusLimit, row.memberLimit, `${label} memberBonusLimit`);
    assertSourced(rules.skillCap, row.skillCap, `${label} skillCap`);
    assert.equal(rules.fixtureBonusCap.value, row.fixtureCap, `${label} fixtureBonusCap`);
    if (row.fixtureCap !== null) assert.equal(rules.fixtureBonusCap.source, "masterdata");
    assertSourced(rules.powerCap, row.powerCap, `${label} powerCap`);
    assert.deepEqual(rules.shuffleUnitBonus.value, row.shuffle, `${label} shuffle`);

    assert.deepEqual(rules.supportDeck.value, { slots: row.support.slots, table: row.support.table }, `${label} support`);
    assert.equal(rules.supportDeck.source, row.support.source, `${label} support source`);
    assert.equal(rules.supportDeck.ref, row.support.ref, `${label} support ref`);

    assert.deepEqual(rules.eventCardBonus.value, { bonusRate: row.eventCard[0], leaderBonusRate: row.eventCard[1] }, `${label} eventCard`);
    assert.deepEqual(
      rules.honorBonus.value,
      row.honor === null ? null : { titles: row.honor[0], bonusRate: row.honor[1] },
      `${label} honor`,
    );
    assert.equal(rules.unitLimitedSupportBonus.value, row.unitLimited, `${label} unitLimited`);

    assert.equal(rules.auto.value.specialMeasure, row.autoMeasure.on, `${label} auto measure`);
    assert.equal(rules.auto.source, row.autoMeasure.source, `${label} auto source`);
    assert.equal(rules.auto.ref, row.autoMeasure.ref, `${label} auto ref`);
    const [none, normal, precious] = row.autoLimit;
    assert.deepEqual(rules.auto.value.dailyLimitByPass, { none, normal, precious }, `${label} auto limits`);
    assert.equal(rules.auto.value.minFire, 1);
    assert.equal(rules.auto.value.maxFire, 10);
    assert.equal(rules.pass, "none");
    assert.equal(rules.autoDailyLimit, none);
    assert.equal(resolve(row.region, row.id, { overrides: { pass: "normal" } }).autoDailyLimit, normal);
    assert.equal(resolve(row.region, row.id, { overrides: { pass: "precious" } }).autoDailyLimit, precious);

    assert.equal(rules.rankingTiers.length, row.tiers[0], `${label} tier count`);
    assert.equal(rules.rankingTiers.at(-1), row.tiers[1], `${label} last tier`);
    assert.deepEqual(rules.rankingTiers, [...rules.rankingTiers].sort((a, b) => a - b));

    assert.deepEqual(rules.engineCoverageGaps, [], `${label} engine gaps`);
    assert.deepEqual(rules.warnings, [], `${label} warnings`);
    assert.deepEqual(rules.editionNotes, row.notes, `${label} edition notes`);
  });
}

// ---------------------------------------------------------------------------
// Normal events and break-time sets.
// ---------------------------------------------------------------------------

function assertNormal(rules, tiers) {
  assert.equal(rules.group, "normal");
  assert.equal(rules.wlTurn, null);
  assert.equal(rules.isFinale, false);
  assert.deepEqual(rules.chapters, []);
  assert.deepEqual(rules.scope, { kind: "overall" });
  assert.equal(rules.memberBonusLimit.value, null);
  assert.equal(rules.skillCap.value, null);
  assert.equal(rules.fixtureBonusCap.value, null);
  assert.equal(rules.powerCap.value, null);
  assert.deepEqual(rules.shuffleUnitBonus.value, []);
  assert.equal(rules.supportDeck.value, null);
  assert.deepEqual(rules.eventCardBonus.value, { bonusRate: 20, leaderBonusRate: 0 });
  assert.equal(rules.honorBonus.value, null);
  assert.equal(rules.unitLimitedSupportBonus.value, null);
  assert.equal(rules.auto.value.specialMeasure, false);
  assert.deepEqual(rules.auto.value.dailyLimitByPass, { none: 10, normal: 10, precious: 99 });
  assert.equal(rules.auto.source, WIKI.source);
  assert.equal(rules.auto.ref, WIKI.ref);
  assert.equal(rules.rankingTiers.length, tiers[0]);
  assert.equal(rules.rankingTiers.at(-1), tiers[1]);
  assert.deepEqual(rules.warnings, []);
  assert.deepEqual(rules.editionNotes, []);
  assert.deepEqual(rules.engineCoverageGaps, []);
}

test("JP #217 is a normal event with break-time set 2", () => {
  const rules = resolve("jp", 217);
  assertNormal(rules, JP_TIERS);
  assert.equal(rules.eventType, "marathon");
  assert.equal(rules.breakGaugeConfigured, true);
  assert.equal(rules.breakGauge.value.id, 2);
  assert.equal(rules.breakGauge.value.resetPerWlChapter, false);
});

test("CN #178 is a normal event without a break gauge", () => {
  const rules = resolve("cn", 178);
  assertNormal(rules, CN_TIERS);
  assert.equal(rules.breakGaugeConfigured, false);
  assert.deepEqual(rules.breakGauge, { value: null, source: "masterdata" });
});

test("JP #197 uses break-time set 1 (115/s, rest after 2 min)", () => {
  const rules = resolve("jp", 197);
  assert.equal(rules.group, "normal");
  assert.equal(rules.breakGaugeConfigured, true);
  assert.deepEqual(rules.breakGauge, {
    value: {
      id: 1, gainPerSecond: 115, fixedSecondsPerPlay: 10, max: 6600000,
      restStartMinutes: 2, restStepMinutes: 30, restStepDecrease: 550000, resetPerWlChapter: false,
    },
    source: "masterdata",
    ref: "eventBreakTimes#1",
  });
});

test("JP #198 uses break-time set 2 (157/s, rest after 5 min)", () => {
  const rules = resolve("jp", 198);
  assert.deepEqual(rules.breakGauge, {
    value: {
      id: 2, gainPerSecond: 157, fixedSecondsPerPlay: 10, max: 6600000,
      restStartMinutes: 5, restStepMinutes: 30, restStepDecrease: 550000, resetPerWlChapter: false,
    },
    source: "masterdata",
    ref: "eventBreakTimes#2",
  });
});

// ---------------------------------------------------------------------------
// Chapter and overall scopes.
// ---------------------------------------------------------------------------

test("JP #214 chapter scope uses the chapter window and chapter ranking tiers", () => {
  const overall = resolve("jp", 214);
  const chapter3 = overall.chapters[2];
  assert.deepEqual(overall.chapters.map((c) => c.gameCharacterId), [11, 15, 25, 19, 7]);
  const rules = resolve("jp", 214, { scope: { kind: "chapter", gameCharacterId: chapter3.gameCharacterId } });
  assert.deepEqual(rules.scope, { kind: "chapter", gameCharacterId: 25 });
  assert.equal(rules.group, "wl_chapter_48h");
  assert.equal(rules.scopeStartAt, chapter3.startAt);
  assert.equal(rules.scopeAggregateAt, chapter3.aggregateAt);
  assert.equal(new Date(rules.scopeStartAt).toISOString(), "2026-08-21T11:00:00.000Z");
  assert.equal(rules.scopeAggregateAt - rules.scopeStartAt, 48 * HOUR - 1000);
  assert.equal(rules.startAt, overall.startAt);
  assert.equal(rules.rankingTiers.length, 18);
  assert.equal(rules.rankingTiers[0], 100);
  assert.equal(rules.rankingTiers.at(-1), 100000);
  assert.equal(rules.breakGauge.value.resetPerWlChapter, true);
  assert.equal(rules.powerCap.value, 336000);
  assert.deepEqual(rules.editionNotes, ["wl3Chapter"]);
});

test("JP #214 overall scope spans the event and uses event ranking tiers", () => {
  const rules = resolve("jp", 214, { scope: { kind: "overall" } });
  assert.equal(rules.group, "wl_overall");
  assert.equal(rules.scopeStartAt, rules.startAt);
  assert.equal(rules.scopeAggregateAt, rules.aggregateAt);
  assert.equal(rules.aggregateAt - rules.startAt, 240 * HOUR - 1000);
  assert.equal(rules.rankingTiers.length, 34);
  assert.equal(rules.rankingTiers.at(-1), 300000);
});

test("CN #112 chapter scope: 48 h unit chapter and CN chapter ranking tiers", () => {
  const overall = resolve("cn", 112);
  const first = overall.chapters[0];
  assert.equal(first.gameCharacterId, 18);
  const rules = resolve("cn", 112, { scope: { kind: "chapter", gameCharacterId: 18 } });
  assert.deepEqual(rules.scope, { kind: "chapter", gameCharacterId: 18 });
  assert.equal(rules.group, "wl_chapter_48h");
  assert.equal(rules.scopeStartAt, first.startAt);
  assert.equal(rules.scopeAggregateAt, first.aggregateAt);
  assert.equal(new Date(rules.scopeStartAt).toISOString(), "2025-09-12T12:00:00.000Z");
  assert.equal(rules.rankingTiers.length, 16);
  assert.equal(rules.rankingTiers.at(-1), 50000);
  assert.deepEqual(rules.editionNotes, ["cnWl1"]);
});

test("CN #112 overall scope: 4 x 48 h and 33 event tiers", () => {
  const rules = resolve("cn", 112, { scope: { kind: "overall" } });
  assert.equal(rules.group, "wl_overall");
  assert.equal(rules.aggregateAt - rules.startAt, 192 * HOUR - 1000);
  assert.equal(rules.rankingTiers.length, 33);
  assert.equal(rules.rankingTiers.at(-1), 200000);
});

test("unknown chapter character and finale chapter scopes fall back to overall", () => {
  const unknown = resolve("jp", 214, { scope: { kind: "chapter", gameCharacterId: 1 } });
  assert.deepEqual(unknown.scope, { kind: "overall" });
  assert.equal(unknown.group, "wl_overall");
  const finale = resolve("jp", 218, { scope: { kind: "chapter", gameCharacterId: 1 } });
  assert.deepEqual(finale.scope, { kind: "overall" });
  assert.equal(finale.group, "wl_finale");
  const normal = resolve("jp", 217, { scope: { kind: "chapter", gameCharacterId: 1 } });
  assert.deepEqual(normal.scope, { kind: "overall" });
});

// ---------------------------------------------------------------------------
// Overrides.
// ---------------------------------------------------------------------------

test("override: Auto special measure off on CN #180", () => {
  const rules = resolve("cn", 180, { overrides: { autoSpecialMeasure: false, pass: "normal" } });
  assert.equal(rules.auto.value.specialMeasure, false);
  assert.deepEqual(rules.auto.value.dailyLimitByPass, { none: 10, normal: 10, precious: 99 });
  assert.equal(rules.auto.source, "user");
  assert.equal(rules.auto.ref, undefined);
  assert.equal(rules.autoDailyLimit, 10);
  assert.deepEqual(rules.warnings, []);
});

test("override equal to the registry keeps the registry source", () => {
  const rules = resolve("cn", 180, { overrides: { autoSpecialMeasure: true } });
  assert.equal(rules.auto.source, "official");
  assert.equal(rules.auto.ref, "operator-confirmed");
});

test("override: Auto special measure on for JP #218 lifts the normal-pass limit", () => {
  const rules = resolve("jp", 218, { overrides: { autoSpecialMeasure: true, pass: "normal" } });
  assert.equal(rules.auto.value.specialMeasure, true);
  assert.equal(rules.auto.source, "user");
  assert.equal(rules.autoDailyLimit, 99);
});

test("override: break gauge off on JP #218", () => {
  const rules = resolve("jp", 218, { overrides: { breakGaugeEnabled: false } });
  assert.deepEqual(rules.breakGauge, { value: null, source: "user" });
  assert.equal(rules.breakGaugeConfigured, true);
  const on = resolve("jp", 218, { overrides: { breakGaugeEnabled: true } });
  assert.equal(on.breakGauge.value.id, 2);
  assert.equal(on.breakGauge.source, "masterdata");
});

test("override: break gauge off on an event without a gauge changes nothing", () => {
  const rules = resolve("jp", 180, { overrides: { breakGaugeEnabled: false } });
  assert.deepEqual(rules.breakGauge, { value: null, source: "masterdata" });
  assert.equal(rules.breakGaugeConfigured, false);
});

test("override: pass precious", () => {
  assert.equal(resolve("jp", 217, { overrides: { pass: "precious" } }).autoDailyLimit, 99);
  assert.equal(resolve("jp", 217, { overrides: { pass: "precious" } }).pass, "precious");
  assert.equal(resolve("jp", 217, { overrides: { pass: "normal" } }).autoDailyLimit, 10);
  assert.equal(resolve("jp", 180, { overrides: { pass: "precious" } }).autoDailyLimit, 99);
  assert.equal(resolve("cn", 180, { overrides: { pass: "normal" } }).autoDailyLimit, 99);
});

// ---------------------------------------------------------------------------
// WL turns are derived from start gaps, not ids.
// ---------------------------------------------------------------------------

test("WL turns follow start-gap order (CN WL1 runs 124, 130, 118, 137, 140, 112)", () => {
  const turns = (region, ids) => ids.map((id) => resolve(region, id).wlTurn);
  assert.deepEqual(turns("cn", [124, 130, 118, 137, 140, 112]), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(turns("cn", [163, 167, 170, 171, 176, 179, 180]), [2, 2, 2, 2, 2, 2, 2]);
  assert.deepEqual(turns("jp", [112, 118, 124, 130, 137, 140]), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(turns("jp", [163, 167, 170, 171, 176, 179, 180]), [2, 2, 2, 2, 2, 2, 2]);
  assert.deepEqual(turns("jp", [202, 205, 207, 211, 214, 218]), [3, 3, 3, 3, 3, 3]);
});

function withSyntheticTurn4() {
  const base = MASTERDATA.jp;
  const template = base.events.find((row) => row.id === 214);
  const startAt = Date.UTC(2027, 3, 17, 11);
  const chapterEvent = {
    ...template, id: 219, name: "synthetic WL4 chapter event",
    startAt, aggregateAt: startAt + 5 * 48 * HOUR - 1000,
  };
  const finaleStart = chapterEvent.aggregateAt + 30 * DAY;
  const finaleEvent = {
    ...template, id: 220, name: "synthetic WL4 finale",
    startAt: finaleStart, aggregateAt: finaleStart + 72 * HOUR - 1000,
  };
  const chapterRows = [21, 1, 5, 9, 13].map((gameCharacterId, i) => ({
    id: 21901 + i, eventId: 219, gameCharacterId, worldBloomChapterType: "game_character", chapterNo: i + 1,
    chapterStartAt: startAt + i * 48 * HOUR,
    aggregateAt: startAt + (i + 1) * 48 * HOUR - 1000,
    chapterEndAt: startAt + (i + 1) * 48 * HOUR - 1000 + 600_000,
    isSupplemental: false,
  }));
  const finaleRow = {
    id: 22001, eventId: 220, worldBloomChapterType: "finale", chapterNo: 1,
    chapterStartAt: finaleStart, aggregateAt: finaleEvent.aggregateAt,
    chapterEndAt: finaleEvent.aggregateAt + 600_000, isSupplemental: false,
  };
  return {
    ...base,
    events: [...base.events, chapterEvent, finaleEvent],
    worldBlooms: [...base.worldBlooms, ...chapterRows, finaleRow],
  };
}

test("synthetic 4th-turn WL event: null turn, unknownWlTurn warning, no turn-keyed rules", () => {
  const masterdata = withSyntheticTurn4();
  const rules = resolveEventRules({ region: "jp", eventId: 219, masterdata });
  assert.equal(rules.wlTurn, null);
  assert.deepEqual(rules.warnings, ["unknownWlTurn"]);
  assert.equal(rules.group, "wl_overall");
  assert.equal(rules.chapters.length, 5);
  assert.equal(rules.supportDeck.value, null);
  assert.equal(rules.powerCap.value, null);
  assert.deepEqual(rules.editionNotes, []);
  const chapter = resolveEventRules({ region: "jp", eventId: 219, masterdata, scope: { kind: "chapter", gameCharacterId: 5 } });
  assert.equal(chapter.group, "wl_chapter_48h");
  // earlier turns keep their numbers
  assert.equal(resolveEventRules({ region: "jp", eventId: 218, masterdata }).wlTurn, 3);
});

test("without eventTotalPowerLimits the registry supplies the JP power cap", () => {
  const { eventTotalPowerLimits, ...masterdata } = MASTERDATA.jp;
  assert.equal(eventTotalPowerLimits.length, 6);
  for (const id of [202, 205, 207, 211, 214]) {
    assert.deepEqual(resolveEventRules({ region: "jp", eventId: id, masterdata }).powerCap,
      { value: 336000, source: "official", ref: "note_382 (v6.4.0)" }, `jp #${id}`);
  }
  assert.deepEqual(resolveEventRules({ region: "jp", eventId: 218, masterdata }).powerCap,
    { value: 336000, source: "official", ref: "note_407 (v6.8.0)" });
  assert.equal(resolveEventRules({ region: "jp", eventId: 180, masterdata }).powerCap.value, null);
});

function withSyntheticCnTurn3(extraPowerRows = []) {
  const base = MASTERDATA.cn;
  const template = base.events.find((row) => row.id === 179);
  const startAt = Date.UTC(2027, 3, 18, 12);
  const event = { ...template, id: 202, name: "synthetic CN WL3 chapter event", startAt, aggregateAt: startAt + 5 * 48 * HOUR - 1000 };
  const chapterRows = [21, 1, 5, 9, 13].map((gameCharacterId, i) => ({
    id: 20201 + i, eventId: 202, gameCharacterId, worldBloomChapterType: "game_character", chapterNo: i + 1,
    chapterStartAt: startAt + i * 48 * HOUR,
    aggregateAt: startAt + (i + 1) * 48 * HOUR - 1000,
    chapterEndAt: startAt + (i + 1) * 48 * HOUR - 1000 + 600_000,
    isSupplemental: false,
  }));
  return {
    ...base,
    events: [...base.events.filter((row) => row.id !== 202), event],
    worldBlooms: [...base.worldBlooms, ...chapterRows],
    eventTotalPowerLimits: [...base.eventTotalPowerLimits, ...extraPowerRows],
  };
}

test("synthetic CN turn-3 chapter event: JP notes are secondary sources for CN", () => {
  const masterdata = withSyntheticCnTurn3();
  const rules = resolveEventRules({ region: "cn", eventId: 202, masterdata });
  assert.equal(rules.wlTurn, 3);
  assert.equal(rules.group, "wl_overall");
  assert.deepEqual(rules.supportDeck, { value: { slots: 25, table: "WL3" }, source: "secondary", ref: "JP note_382" });
  assert.deepEqual(rules.powerCap, { value: 336000, source: "secondary", ref: "JP note_382" });
  assert.deepEqual(rules.editionNotes, ["wl3Chapter"]);
  assert.deepEqual(rules.engineCoverageGaps, []);
  const withRow = withSyntheticCnTurn3([{ id: 1, eventId: 202, upperTotalPower: 336000 }]);
  assert.deepEqual(resolveEventRules({ region: "cn", eventId: 202, masterdata: withRow }).powerCap,
    { value: 336000, source: "masterdata", ref: "eventTotalPowerLimits#1" });
});

test("unregistered finale: normal Auto rules, warning, finale default member limit", () => {
  const masterdata = withSyntheticTurn4();
  const rules = resolveEventRules({ region: "jp", eventId: 220, masterdata });
  assert.equal(rules.group, "wl_finale");
  assert.equal(rules.isFinale, true);
  assert.equal(rules.wlTurn, null);
  assert.deepEqual(rules.warnings, ["unknownWlTurn", "unregisteredSpecialMeasure"]);
  assert.equal(rules.auto.value.specialMeasure, false);
  assert.deepEqual(rules.auto.value.dailyLimitByPass, { none: 10, normal: 10, precious: 99 });
  assert.deepEqual(rules.memberBonusLimit, { value: 5, source: "secondary", ref: "deck engine default" });
  assert.equal(rules.skillCap.value, null);
  const overridden = resolveEventRules({ region: "jp", eventId: 220, masterdata, overrides: { autoSpecialMeasure: true } });
  assert.deepEqual(overridden.warnings, ["unknownWlTurn"]);
  assert.equal(overridden.auto.source, "user");
});

// ---------------------------------------------------------------------------
// Tables, engine coverage, registry.
// ---------------------------------------------------------------------------

test("EVENT_RULE_TABLES lists every table the resolver reads", () => {
  assert.deepEqual([...EVENT_RULE_TABLES].sort(), [
    "eventBreakTimes",
    "eventCardBonusLimits",
    "eventCards",
    "eventHonorBonuses",
    "eventMysekaiFixtureGameCharacterPerformanceBonusLimits",
    "eventShuffleUnitBonuses",
    "eventSkillScoreUpLimits",
    "eventTotalPowerLimits",
    "events",
    "worldBloomChapterRankingRewardRanges",
    "worldBloomSupportDeckUnitEventLimitedBonuses",
    "worldBlooms",
  ]);
});

test("ENGINE_READ_TABLES covers the post-fix engine tables including shuffle and fixture limits", () => {
  for (const table of [
    "eventCards", "eventDeckBonuses", "eventCardBonusLimits", "eventHonorBonuses", "eventSkillScoreUpLimits",
    "eventShuffleUnitBonuses", "eventMysekaiFixtureGameCharacterPerformanceBonusLimits",
    "worldBloomSupportDeckUnitEventLimitedBonuses", "worldBloomDifferentAttributeBonuses",
  ]) {
    assert.ok(ENGINE_READ_TABLES.includes(table), table);
  }
  // 引擎不读 eventTotalPowerLimits，而是对 WL2 终章之后的 WL 活动内置 336000 上限（build.rs power_total_cap）。
  assert.ok(!ENGINE_READ_TABLES.includes("eventTotalPowerLimits"));
  for (const table of EVENT_RULE_TABLES) {
    if (table === "eventTotalPowerLimits") continue;
    if (/Bonus|Limit/.test(table) || table === "eventCards") assert.ok(ENGINE_READ_TABLES.includes(table), table);
  }
});

test("engineCoverageGaps lists bonus tables with rows for the event that the engine does not read", () => {
  const masterdata = {
    ...MASTERDATA.jp,
    eventHypotheticalBonuses: [{ id: 1, eventId: 218, bonusRate: 10 }],
    eventStoryUnits: [{ id: 1, eventId: 218 }],
  };
  const rules = resolveEventRules({ region: "jp", eventId: 218, masterdata });
  assert.deepEqual(rules.engineCoverageGaps, ["eventHypotheticalBonuses"]);
  assert.deepEqual(rules.warnings, ["engineGap"]);
  const clean = resolveEventRules({ region: "jp", eventId: 214, masterdata });
  assert.deepEqual(clean.engineCoverageGaps, []);
  assert.deepEqual(clean.warnings, []);
});

test("eventTotalPowerLimits is a gap only where the engine's built-in WL cap differs", () => {
  const base = MASTERDATA.jp.eventTotalPowerLimits;
  const withRows = (rows) => ({ ...MASTERDATA.jp, eventTotalPowerLimits: [...base, ...rows] });
  // 真实行（WL3 章节活动与 #218，均为 336000）由引擎内置上限覆盖。
  for (const id of [202, 214, 218]) {
    const rules = resolve("jp", id);
    assert.equal(rules.powerCap.value, 336000);
    assert.deepEqual(rules.engineCoverageGaps, [], `jp #${id}`);
  }
  // 普通活动出现综合力上限：引擎不会应用。
  const normal = resolveEventRules({ region: "jp", eventId: 217, masterdata: withRows([{ id: 7, eventId: 217, upperTotalPower: 336000 }]) });
  assert.deepEqual(normal.powerCap, { value: 336000, source: "masterdata", ref: "eventTotalPowerLimits#7" });
  assert.deepEqual(normal.engineCoverageGaps, ["eventTotalPowerLimits"]);
  assert.deepEqual(normal.warnings, ["engineGap"]);
  // WL 活动的上限与引擎内置值不同。
  const other = { ...withRows([]), eventTotalPowerLimits: base.map((row) => (row.eventId === 214 ? { ...row, upperTotalPower: 300000 } : row)) };
  const wl = resolveEventRules({ region: "jp", eventId: 214, masterdata: other });
  assert.equal(wl.powerCap.value, 300000);
  assert.deepEqual(wl.engineCoverageGaps, ["eventTotalPowerLimits"]);
  assert.deepEqual(wl.warnings, ["engineGap"]);
});

test("missing optional tables resolve to empty rules", () => {
  const { events, worldBlooms } = MASTERDATA.jp;
  const rules = resolveEventRules({ region: "jp", eventId: 218, masterdata: { events, worldBlooms } });
  assert.equal(rules.group, "wl_finale");
  assert.equal(rules.wlTurn, 3);
  assert.deepEqual(rules.shuffleUnitBonus.value, []);
  assert.equal(rules.fixtureBonusCap.value, null);
  assert.equal(rules.breakGaugeConfigured, false);
  assert.equal(rules.memberBonusLimit.value, 5);
  assert.equal(rules.skillCap.value, null);
  assert.deepEqual(rules.powerCap, { value: 336000, source: "official", ref: "note_407 (v6.8.0)" });
  assert.equal(rules.eventCardBonus.value, null);
  assert.equal(rules.rankingTiers.length, 34);
});

test("unknown event throws", () => {
  assert.throws(() => resolve("jp", 99999), /not found/);
});

test("registry holds exactly the contracted entries, each with source and ASCII ref", () => {
  assert.deepEqual(
    SPECIAL_MEASURES.map((e) => [e.region, e.eventId, e.specialMeasure, e.source, e.ref]),
    [
      ["jp", 180, true, "official", "in-game notice: finale auto live score measure (2025-09)"],
      ["cn", 180, true, "official", "operator-confirmed"],
      ["jp", 218, false, "official", "note_407 (v6.8.0)"],
    ],
  );
  assert.deepEqual(
    OFFICIAL_LIMITS.map((e) => [e.limit, e.region, JSON.stringify(e.target), e.value, e.source, e.ref]),
    [
      ["skillCap", "jp", '{"eventId":180}', 140, "official", "note_332 (v5.3.0)"],
      ["skillCap", "cn", '{"eventId":180}', 140, "secondary", "JP note_332"],
      ["memberBonusLimit", "jp", '{"eventId":218}', 5, "official", "note_407 (v6.8.0)"],
      ["powerCap", "jp", '{"wlTurn":3,"finale":false}', 336000, "official", "note_382 (v6.4.0)"],
      ["powerCap", "jp", '{"eventId":218}', 336000, "official", "note_407 (v6.8.0)"],
      ["powerCap", "cn", '{"wlTurn":3,"finale":false}', 336000, "secondary", "JP note_382"],
    ],
  );
  assert.deepEqual(AUTO_BASE.normal, { none: 10, normal: 10, precious: 99 });
  assert.deepEqual(AUTO_BASE.specialMeasure, { none: 10, normal: 99, precious: 99 });
  assert.equal(AUTO_BASE.source, "secondary");
  for (const entry of [...SPECIAL_MEASURES, ...OFFICIAL_LIMITS, AUTO_BASE]) {
    assert.ok(entry.source);
    assert.match(entry.ref, /^[\x20-\x7e]+$/);
  }
});

test("index.ts logic contains no WL event ids", () => {
  const source = readFileSync(new URL("../src/lib/event-rules/index.ts", import.meta.url), "utf8");
  const ids = [112, 118, 124, 130, 137, 140, 163, 167, 170, 171, 176, 179, 180, 202, 205, 207, 211, 214, 218];
  for (const id of ids) assert.doesNotMatch(source, new RegExp(`(?<![\\w.])${id}(?![\\w.])`), `id ${id}`);
});
