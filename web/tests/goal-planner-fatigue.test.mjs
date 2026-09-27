/**
 * Break gauge simulation (src/lib/goal-planner/fatigue.ts) and WL chapter windows (src/lib/goal-planner/chapters.ts).
 * Run with: node --test --experimental-strip-types tests/goal-planner-fatigue.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceGauge,
  createGaugeState,
  gaugeCapHoursPerDay,
  recordPlay,
  simulateGauge,
} from "../src/lib/goal-planner/fatigue.ts";
import { remainingChapterWindows } from "../src/lib/goal-planner/chapters.ts";

// Masterdata eventBreakTimes rows (JP and CN snapshots are identical); set 1 = JP #197 trial, set 2 = JP #198 onwards.
const EVENT_BREAK_TIMES = [
  { id: 1, initialPoint: 0, maxPoint: 6600000, notificationBorderPoint: 5940000, gaugeDisplayBorderPoint: 3300000, pointsPerMusicSecond: 115, musicOffsetSeconds: 10, decreaseMinutes: 30, decreasePoint: 550000, requiredIntervalMinutes: 2 },
  { id: 2, initialPoint: 0, maxPoint: 6600000, notificationBorderPoint: 5940000, gaugeDisplayBorderPoint: 3300000, pointsPerMusicSecond: 157, musicOffsetSeconds: 10, decreaseMinutes: 30, decreasePoint: 550000, requiredIntervalMinutes: 5 },
];

function gaugeRule(id) {
  const row = EVENT_BREAK_TIMES.find((r) => r.id === id);
  return {
    id: row.id,
    gainPerSecond: row.pointsPerMusicSecond,
    fixedSecondsPerPlay: row.musicOffsetSeconds,
    max: row.maxPoint,
    restStartMinutes: row.requiredIntervalMinutes,
    restStepMinutes: row.decreaseMinutes,
    restStepDecrease: row.decreasePoint,
    resetPerWlChapter: true,
  };
}

const SET1 = gaugeRule(1);
const SET2 = gaugeRule(2);
const ENVY_SECONDS = 74.8;
const ENVY_PPH = 29;
const MIN = 60;
const HOUR = 3600;

function fillContinuously(gauge, songSeconds, playsPerHour) {
  const state = createGaugeState(0);
  const cycle = HOUR / playsPerHour;
  let plays = 0;
  while (state.point < gauge.max) {
    assert.equal(recordPlay(state, gauge, "manual", plays * cycle, songSeconds), true);
    plays++;
  }
  return { state, plays, lastEndSec: (plays - 1) * cycle + songSeconds };
}

// ---------------------------------------------------------------------------
// Gauge rise per play
// ---------------------------------------------------------------------------

test("a manual play adds (song + 10 s) x points per second for both sets", () => {
  for (const [gauge, expected] of [[SET1, 84.8 * 115], [SET2, 84.8 * 157]]) {
    const state = createGaugeState(0);
    assert.equal(recordPlay(state, gauge, "manual", 0, ENVY_SECONDS), true);
    assert.ok(Math.abs(state.point - expected) < 1e-6, `${gauge.id}: ${state.point}`);
  }
});

test("Envy example: 74.8 s at 29 plays/h fills set 2 in about 17 h, set 1 in about 23 h", () => {
  const set2 = fillContinuously(SET2, ENVY_SECONDS, ENVY_PPH);
  assert.equal(set2.plays, 496);
  assert.ok(Math.abs(set2.plays / ENVY_PPH - 17.1) < 0.05);
  assert.equal(gaugeCapHoursPerDay(SET2, ENVY_SECONDS, ENVY_PPH, 24), 17.1);

  const set1 = fillContinuously(SET1, ENVY_SECONDS, ENVY_PPH);
  assert.equal(set1.plays, 677);
  assert.equal(gaugeCapHoursPerDay(SET1, ENVY_SECONDS, ENVY_PPH, 24), 23.3);
});

test("the play that crosses the max earns; a manual play started at the max earns nothing", () => {
  const state = createGaugeState(0);
  state.point = SET2.max - 1;
  assert.equal(recordPlay(state, SET2, "manual", 0, ENVY_SECONDS), true);
  assert.equal(state.point, SET2.max);
  assert.equal(recordPlay(state, SET2, "manual", 124, ENVY_SECONDS), false);
  assert.equal(state.point, SET2.max);
});

// ---------------------------------------------------------------------------
// Rest
// ---------------------------------------------------------------------------

test("rest lowers the gauge 550,000 per 30 min, counted after 5 min (set 2) or 2 min (set 1)", () => {
  for (const [gauge, waitMin] of [[SET2, 5], [SET1, 2]]) {
    const { state, lastEndSec } = fillContinuously(gauge, ENVY_SECONDS, ENVY_PPH);
    advanceGauge(state, gauge, lastEndSec + (waitMin + 30) * MIN - 1);
    assert.equal(state.point, gauge.max, `set ${gauge.id} before the first step`);
    advanceGauge(state, gauge, lastEndSec + (waitMin + 30) * MIN);
    assert.equal(state.point, gauge.max - 550000, `set ${gauge.id} first step`);
    advanceGauge(state, gauge, lastEndSec + (waitMin + 60) * MIN);
    assert.equal(state.point, gauge.max - 1100000, `set ${gauge.id} second step`);
    advanceGauge(state, gauge, lastEndSec + 24 * HOUR);
    assert.equal(state.point, 0, "floors at 0");
  }
  assert.ok(Math.abs(simulateGauge({ gauge: SET2, songSeconds: 120, playsPerHour: 20, windowHours: 24, plannedManualHoursPerDay: 1 }).fullRecoveryHours - (5 + 12 * 30) / 60) < 1e-9);
  assert.ok(Math.abs(simulateGauge({ gauge: SET1, songSeconds: 120, playsPerHour: 20, windowHours: 24, plannedManualHoursPerDay: 1 }).fullRecoveryHours - (2 + 12 * 30) / 60) < 1e-9);
});

test("rest is cumulative across breaks and a short break before the threshold does not count", () => {
  const { state, lastEndSec } = fillContinuously(SET2, ENVY_SECONDS, ENVY_PPH);
  const start = state.point;
  // A manual play at a full gauge 20 min in does not restart the rest clock: the first step still lands at 35 min.
  assert.equal(recordPlay(state, SET2, "manual", lastEndSec + 20 * MIN, ENVY_SECONDS), false, "gauge still full");
  advanceGauge(state, SET2, lastEndSec + 35 * MIN);
  assert.equal(state.point, start - 550000);

  const fresh = createGaugeState(0);
  fresh.point = 3000000;
  recordPlay(fresh, SET2, "manual", 0, 100);
  const afterPlay = fresh.point;
  // 4 min 59 s idle never reaches the 5 min threshold, however often it repeats.
  let t = 100;
  for (let i = 0; i < 20; i++) {
    t += 4 * MIN + 59;
    recordPlay(fresh, SET2, "manual", t, 1);
    t += 1;
  }
  assert.equal(fresh.point, afterPlay + 20 * 11 * 157);
  // 20 + 10 counted minutes across two breaks make one 30 min step.
  const bank = createGaugeState(0);
  bank.point = 3000000;
  recordPlay(bank, SET2, "manual", 0, 100);
  const p0 = bank.point;
  recordPlay(bank, SET2, "manual", 100 + 25 * MIN, 100);
  const p1 = bank.point;
  assert.equal(p1, p0 + 110 * 157, "20 counted minutes, no step yet");
  advanceGauge(bank, SET2, 100 + 25 * MIN + 100 + 5 * MIN + 10 * MIN);
  assert.equal(bank.point, p1 - 550000);
});

test("manual plays at a full gauge count as rest: points return after the threshold plus one step", () => {
  const { state, plays } = fillContinuously(SET2, ENVY_SECONDS, ENVY_PPH);
  const cycle = HOUR / ENVY_PPH;
  let k = plays;
  let lost = 0;
  while (!recordPlay(state, SET2, "manual", k * cycle, ENVY_SECONDS)) {
    lost++;
    k++;
  }
  // First earning play starts at or after last end + 35 min.
  const lastEnd = (plays - 1) * cycle + ENVY_SECONDS;
  assert.ok(k * cycle >= lastEnd + 35 * MIN);
  assert.ok((k - 1) * cycle < lastEnd + 35 * MIN);
  assert.equal(lost, k - plays);
});

test("Auto and challenge lives never raise the gauge, earn at a full gauge and count as rest", () => {
  for (const kind of ["auto", "challenge"]) {
    const a = fillContinuously(SET2, ENVY_SECONDS, ENVY_PPH);
    const b = fillContinuously(SET2, ENVY_SECONDS, ENVY_PPH);
    // a: one Auto every 2 minutes for 3 hours; b: idle for 3 hours.
    for (let t = a.lastEndSec + 60; t < a.lastEndSec + 3 * HOUR; t += 2 * MIN) {
      assert.equal(recordPlay(a.state, SET2, kind, t, ENVY_SECONDS), true);
    }
    advanceGauge(a.state, SET2, a.lastEndSec + 3 * HOUR);
    advanceGauge(b.state, SET2, b.lastEndSec + 3 * HOUR);
    assert.equal(a.state.point, b.state.point);
    // 3 h - 5 min = 5 full steps.
    assert.equal(a.state.point, SET2.max - 5 * 550000);
  }
});

// ---------------------------------------------------------------------------
// Daily schedule and cap
// ---------------------------------------------------------------------------

test("simulateGauge: a plan at the cap loses nothing, above it the lost plays are reported", () => {
  const base = { gauge: SET2, songSeconds: ENVY_SECONDS, playsPerHour: ENVY_PPH, windowHours: 72 };
  const cap = gaugeCapHoursPerDay(SET2, ENVY_SECONDS, ENVY_PPH, 72);
  const atCap = simulateGauge({ ...base, plannedManualHoursPerDay: cap });
  assert.equal(atCap.hitsCap, false);
  assert.ok(Math.abs(atCap.effectiveManualHours - 3 * Math.floor(cap * ENVY_PPH) / ENVY_PPH) < 1e-9);
  assert.ok(Math.abs(atCap.effectiveManualHoursPerDay - atCap.effectiveManualHours / 3) < 1e-9);

  const over = simulateGauge({ ...base, plannedManualHoursPerDay: 22 });
  assert.equal(over.hitsCap, true);
  assert.ok(over.effectiveManualHours < 3 * 22);
  // Full-gauge plays count as rest, so part of the extra time still earns.
  assert.ok(over.effectiveManualHours > atCap.effectiveManualHours);

  const empty = simulateGauge({ ...base, windowHours: 0, plannedManualHoursPerDay: 10 });
  assert.equal(empty.effectiveManualHours, 0);
  assert.equal(empty.hitsCap, false);
});

test("both sets: set 2 drains overnight so its cap does not depend on the window; set 1 binds over several days", () => {
  for (const hours of [24, 48, 72, 192, 240]) {
    assert.equal(gaugeCapHoursPerDay(SET2, ENVY_SECONDS, ENVY_PPH, hours), 17.1, `set 2, ${hours} h`);
  }
  const set1Day = gaugeCapHoursPerDay(SET1, ENVY_SECONDS, ENVY_PPH, 24);
  const set1TwoDays = gaugeCapHoursPerDay(SET1, ENVY_SECONDS, ENVY_PPH, 48);
  const set1TenDays = gaugeCapHoursPerDay(SET1, ENVY_SECONDS, ENVY_PPH, 240);
  assert.equal(set1Day, 23.3);
  assert.ok(set1TwoDays < set1Day);
  assert.ok(set1TenDays <= set1TwoDays);
  assert.ok(set1TenDays > 17.1 && set1TenDays < 20, `${set1TenDays}`);
  // No gauge-relevant play at all -> the gauge never limits.
  assert.equal(gaugeCapHoursPerDay(SET2, ENVY_SECONDS, 0, 48), 24);
  // A short window that ends before the gauge fills.
  assert.equal(gaugeCapHoursPerDay(SET2, ENVY_SECONDS, ENVY_PPH, 10), 24);
});

test("gaugeCapHoursPerDay falls with song length (within one 0.1 h step of discrete plays and rest steps)", () => {
  for (const gauge of [SET1, SET2]) {
    for (const gap of [30, 50]) {
      for (const hours of [24, 48, 240]) {
        let runningMin = Infinity;
        const caps = [];
        for (let song = 60; song <= 300; song += 1) {
          const cap = gaugeCapHoursPerDay(gauge, song, HOUR / (song + gap), hours);
          assert.ok(cap <= runningMin + 0.1 + 1e-9, `set ${gauge.id} gap ${gap} ${hours} h song ${song}: ${cap} > ${runningMin}`);
          runningMin = Math.min(runningMin, cap);
          caps.push(cap);
        }
        assert.ok(caps[0] - caps[caps.length - 1] >= 1, `set ${gauge.id} gap ${gap} ${hours} h: 60 s vs 300 s`);
      }
    }
  }
  // Set 2 (every event since JP #198) at the multi-live gap: strictly lower at typical song lengths.
  for (const hours of [24, 48, 240]) {
    const caps = [60, 90, 120, 150, 180, 240, 300].map((song) => gaugeCapHoursPerDay(SET2, song, HOUR / (song + 50), hours));
    for (let i = 1; i < caps.length; i++) assert.ok(caps[i] < caps[i - 1], `${hours} h: ${caps.join(", ")}`);
  }
});

// ---------------------------------------------------------------------------
// WL chapters
// ---------------------------------------------------------------------------

// JP #214 worldBlooms rows (5 x 48 h) and JP #218 (finale).
const JP214_CHAPTERS = [
  { chapterNo: 1, gameCharacterId: 11, startAt: 1786964400000, aggregateAt: 1787137199000, endAt: 1787137799000 },
  { chapterNo: 2, gameCharacterId: 15, startAt: 1787137200000, aggregateAt: 1787309999000, endAt: 1787310599000 },
  { chapterNo: 3, gameCharacterId: 25, startAt: 1787310000000, aggregateAt: 1787482799000, endAt: 1787483399000 },
  { chapterNo: 4, gameCharacterId: 19, startAt: 1787482800000, aggregateAt: 1787655599000, endAt: 1787656199000 },
  { chapterNo: 5, gameCharacterId: 7, startAt: 1787655600000, aggregateAt: 1787828399000, endAt: 1787828999000 },
].map((c) => ({ ...c, hours: Math.round((c.aggregateAt - c.startAt) / 3.6e6) }));
const JP218_CHAPTERS = [
  { chapterNo: 1, gameCharacterId: null, startAt: 1790334000000, aggregateAt: 1790593199000, endAt: 1790593799000, hours: 72 },
];

function rulesWith(eventId, group, chapters, gauge) {
  const first = chapters[0];
  const last = chapters[chapters.length - 1];
  return {
    region: "jp",
    eventId,
    eventType: chapters.length > 0 ? "world_bloom" : "marathon",
    group,
    scope: { kind: "overall" },
    wlTurn: chapters.length > 0 ? 3 : null,
    isFinale: group === "wl_finale",
    startAt: first ? first.startAt : 1788750000000,
    aggregateAt: last ? last.aggregateAt : 1789268399000,
    scopeStartAt: first ? first.startAt : 1788750000000,
    scopeAggregateAt: last ? last.aggregateAt : 1789268399000,
    chapters,
    breakGauge: { value: gauge, source: "masterdata", ref: "eventBreakTimes#2" },
    breakGaugeConfigured: true,
  };
}

const RULES_214 = rulesWith(214, "wl_overall", JP214_CHAPTERS, SET2);

test("remainingChapterWindows: before, inside and after the chapters of a #214-shaped event", () => {
  const before = remainingChapterWindows(RULES_214, JP214_CHAPTERS[0].startAt - HOUR * 1000);
  assert.deepEqual(before.map((w) => w.chapterNo), [1, 2, 3, 4, 5]);
  assert.equal(before[0].startAt, JP214_CHAPTERS[0].startAt);
  assert.equal(before[4].endAt, JP214_CHAPTERS[4].aggregateAt, "windows end at aggregateAt");
  assert.equal(before[2].gameCharacterId, 25);

  const now = JP214_CHAPTERS[2].startAt + 10 * HOUR * 1000;
  const inside = remainingChapterWindows(RULES_214, now);
  assert.deepEqual(inside.map((w) => w.chapterNo), [3, 4, 5]);
  assert.equal(inside[0].startAt, now, "running chapter clipped to now");
  assert.equal(inside[0].endAt, JP214_CHAPTERS[2].aggregateAt);
  assert.equal(inside[1].startAt, JP214_CHAPTERS[3].startAt);

  const atAggregate = remainingChapterWindows(RULES_214, JP214_CHAPTERS[1].aggregateAt);
  assert.deepEqual(atAggregate.map((w) => w.chapterNo), [3, 4, 5], "a chapter at its aggregateAt is over");

  assert.deepEqual(remainingChapterWindows(RULES_214, JP214_CHAPTERS[4].aggregateAt + 1), []);

  const shuffled = rulesWith(214, "wl_overall", [JP214_CHAPTERS[3], JP214_CHAPTERS[0], JP214_CHAPTERS[4], JP214_CHAPTERS[1], JP214_CHAPTERS[2]], SET2);
  assert.deepEqual(remainingChapterWindows(shuffled, 0).map((w) => w.chapterNo), [1, 2, 3, 4, 5]);
  assert.deepEqual(RULES_214.chapters.map((c) => c.chapterNo), [1, 2, 3, 4, 5], "input not mutated");
});

test("remainingChapterWindows: a finale has one chapter, a normal event none", () => {
  const finale = rulesWith(218, "wl_finale", JP218_CHAPTERS, SET2);
  const now = JP218_CHAPTERS[0].startAt + 30 * HOUR * 1000;
  assert.deepEqual(remainingChapterWindows(finale, now), [
    { chapterNo: 1, gameCharacterId: null, startAt: now, endAt: JP218_CHAPTERS[0].aggregateAt },
  ]);
  assert.deepEqual(remainingChapterWindows(finale, JP218_CHAPTERS[0].aggregateAt), []);

  const normal = rulesWith(216, "normal", [], SET2);
  assert.deepEqual(remainingChapterWindows(normal, normal.startAt + HOUR * 1000), []);
  assert.deepEqual(remainingChapterWindows(normal, 0), []);
});

test("the gauge resets at every chapter start of a #214-shaped event", () => {
  const now = JP214_CHAPTERS[1].startAt + 20 * HOUR * 1000;
  const windows = remainingChapterWindows(RULES_214, now);
  assert.deepEqual(windows.map((w) => w.chapterNo), [2, 3, 4, 5]);
  const plan = { gauge: SET2, songSeconds: ENVY_SECONDS, playsPerHour: ENVY_PPH, plannedManualHoursPerDay: 20 };
  const hoursOf = (w) => (w.endAt - w.startAt) / 3.6e6;

  // With resetPerWlChapter every chapter window starts from an empty gauge, so every full chapter gives the same result.
  assert.equal(SET2.resetPerWlChapter, true);
  const perChapter = windows.map((w) => simulateGauge({ ...plan, windowHours: hoursOf(w) }));
  for (const result of perChapter.slice(2)) assert.deepEqual(result, perChapter[1]);
  assert.ok(Math.abs(hoursOf(windows[0]) - 28) < 0.01, "running chapter clipped to now");

  // One continuous run over the same span (a gauge that never resets) loses more plays.
  const resetTotal = perChapter.reduce((sum, r) => sum + r.effectiveManualHours, 0);
  const continuous = simulateGauge({ ...plan, windowHours: (windows[3].endAt - windows[0].startAt) / 3.6e6 });
  assert.ok(continuous.effectiveManualHours < resetTotal, `${continuous.effectiveManualHours} vs ${resetTotal}`);

  // Each chapter's cap comes from its own 48 h window.
  assert.equal(gaugeCapHoursPerDay(SET2, ENVY_SECONDS, ENVY_PPH, hoursOf(windows[1])), 17.1);
});

test("an extended end keeps the gauge: the window runs on without a reset", () => {
  const plan = { gauge: SET2, songSeconds: ENVY_SECONDS, playsPerHour: ENVY_PPH, plannedManualHoursPerDay: 20 };
  const chapter = JP214_CHAPTERS[0];
  const originalHours = (chapter.aggregateAt - chapter.startAt) / 3.6e6;
  const extended = simulateGauge({ ...plan, windowHours: originalHours + 24 });
  const original = simulateGauge({ ...plan, windowHours: originalHours });
  const freshDay = simulateGauge({ ...plan, windowHours: 24 });
  assert.ok(extended.effectiveManualHours > original.effectiveManualHours);
  assert.ok(extended.effectiveManualHours < original.effectiveManualHours + freshDay.effectiveManualHours);
});
