/**
 * 冲榜规划器核心计算（src/lib/goal-planner/core.ts）单元测试，期望值均为手算。
 * Run with: node --test --experimental-strip-types tests/goal-planner-core.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    CRYSTALS_PER_STAMINA,
    DEFAULT_GAP_SECONDS,
    FIRE_MULTIPLIERS,
    NATURAL_STAMINA_PER_HOUR,
    STAMINA_PER_BIG_DRINK,
    compareSongs,
    estimateRank,
    fireMultiplier,
    planGoal,
    playsPerHour,
} from "../src/lib/goal-planner/core.ts";
import { simulateGauge } from "../src/lib/goal-planner/fatigue.ts";

const HOUR = 3_600_000;
const JP_TZ = 540;
const CN_TZ = 480;

function approx(actual, expected, eps = 1e-6, message = "") {
    assert.ok(Math.abs(actual - expected) <= eps, `${message} expected ${expected}, got ${actual}`);
}

function pt(over = {}) {
    return {
        mode: "direct",
        manualPtPerPlay: 2500,
        manualFire: 5,
        playsPerHour: 30,
        songSeconds: 90,
        autoPtPerPlay: 0,
        autoFire: 1,
        autoIsLowerBound: false,
        ...over,
    };
}

function input(over = {}) {
    const now = Date.UTC(2026, 8, 26, 3, 0, 0);
    return {
        now,
        tzOffsetMinutes: JP_TZ,
        endAt: now + 48 * HOUR,
        currentScore: 0,
        targetScore: 600_000,
        pt: pt(),
        dailyManualHours: 10,
        dailyAutoRuns: 10,
        autoDailyLimit: 10,
        gauge: null,
        ...over,
    };
}

// ---------------------------------------------------------------------------
// 火数倍率与常数
// ---------------------------------------------------------------------------

test("fireMultiplier: 0-10 火 = 1/5/10/15/20/25/27/29/31/33/35（官方 v4.0.0）", () => {
    const expected = [1, 5, 10, 15, 20, 25, 27, 29, 31, 33, 35];
    assert.deepEqual([...FIRE_MULTIPLIERS], expected);
    for (let fire = 0; fire <= 10; fire++) {
        assert.equal(fireMultiplier(fire), expected[fire], `fire ${fire}`);
    }
});

test("常数与每小时把数", () => {
    assert.equal(STAMINA_PER_BIG_DRINK, 10);
    assert.equal(CRYSTALS_PER_STAMINA, 10);
    assert.equal(NATURAL_STAMINA_PER_HOUR, 2);
    assert.deepEqual(DEFAULT_GAP_SECONDS, { multi: 50, solo: 30, cheerful: 50, auto: 30 });
    // 3600 / (120 + 30) = 24；3600 / (130 + 50) = 20
    assert.equal(playsPerHour(120, 30), 24);
    assert.equal(playsPerHour(130, 50), 20);
});

// ---------------------------------------------------------------------------
// 体力换算
// ---------------------------------------------------------------------------

test("体力 6670 点 → 667 个大火罐 / 66,700 水晶", () => {
    // 缺口 667,000，每把 1000 PT（10 火），无 Auto → 667 把 × 10 火 = 6670 点
    const r = planGoal(
        input({
            targetScore: 667_000,
            pt: pt({ manualPtPerPlay: 1000, manualFire: 10, playsPerHour: 20, autoPtPerPlay: 0 }),
            dailyManualHours: 24,
        }),
    );
    assert.equal(r.manualPlays, 667);
    assert.equal(r.stamina, 6670);
    assert.equal(r.bigDrinks, 667);
    assert.equal(r.crystals, 66_700);
    // 剩余 48 小时 × 2 点/小时
    assert.equal(r.naturalStamina, 96);
    // 667 / 20 = 33.35 小时，÷ 2 天 = 16.675 小时/天，÷ 24 = 0.6948 → 可达成
    approx(r.manualHoursTotal, 33.35);
    approx(r.manualHoursPerDay, 16.675);
    assert.equal(r.feasibility, "achievable");
});

// ---------------------------------------------------------------------------
// T1000 方案，Auto 跨两次本地 04:00 重置
// ---------------------------------------------------------------------------

const JP_TIERS = [
    { rank: 100, score: 5_200_000 },
    { rank: 500, score: 3_600_000 },
    { rank: 1000, score: 3_000_000 },
    { rank: 2000, score: 2_400_000 },
];

test("JP T1000：12:00 JST 至 09-28 21:00 JST，跨 09-27 与 09-28 两次 04:00 重置 → 3 个 Auto 日", () => {
    const now = Date.UTC(2026, 8, 26, 3, 0, 0); // 2026-09-26 12:00 JST
    const endAt = Date.UTC(2026, 8, 28, 12, 0, 0); // 2026-09-28 21:00 JST
    const t1000 = JP_TIERS.find((t) => t.rank === 1000).score;
    const base = {
        now,
        endAt,
        tzOffsetMinutes: JP_TZ,
        currentScore: 1_000_000,
        targetScore: t1000,
        pt: pt({ manualPtPerPlay: 3000, manualFire: 3, playsPerHour: 24, songSeconds: 120, autoPtPerPlay: 2000, autoFire: 1 }),
        dailyManualHours: 16,
        dailyAutoRuns: 10,
        autoDailyLimit: 10,
        gauge: null,
    };
    const r = planGoal(base);
    assert.equal(r.gap, 2_000_000);
    assert.equal(r.remainingHours, 57);
    approx(r.remainingDays, 2.375);
    // 3 个重置窗口 × 10 次 = 30 次，30 × 2000 = 60,000 PT
    assert.equal(r.autoRuns, 30);
    assert.equal(r.autoTotalPt, 60_000);
    // ceil(1,940,000 / 3000) = 647 把；647 / 24 = 26.9583 小时；÷ 2.375 天 = 11.3509 小时/天
    assert.equal(r.manualPlays, 647);
    approx(r.manualHoursTotal, 647 / 24);
    approx(r.manualHoursPerDay, 647 / 24 / 2.375);
    // 11.3509 / 16 = 0.709 → 可达成
    assert.equal(r.feasibility, "achievable");
    // 647 × 3 + 30 × 1 = 1971 点 → 198 罐 / 19,710 水晶；自然回复 floor(57 × 2) = 114
    assert.equal(r.stamina, 1971);
    assert.equal(r.bigDrinks, 198);
    assert.equal(r.crystals, 19_710);
    assert.equal(r.naturalStamina, 114);
    assert.equal(r.gaugeCapHoursPerDay, null);
    assert.deepEqual(r.perChapter, []);

    // 每日 99 次（PRECIOUS）：3 × 99 = 297 次，594,000 PT；ceil(1,406,000 / 3000) = 469 把
    const precious = planGoal({ ...base, dailyAutoRuns: 99, autoDailyLimit: 99 });
    assert.equal(precious.autoRuns, 297);
    assert.equal(precious.autoTotalPt, 594_000);
    assert.equal(precious.manualPlays, 469);
    // 469 / 24 / 2.375 = 8.228 小时/天，÷ 16 = 0.514 → 轻松
    approx(precious.manualHoursPerDay, 469 / 24 / 2.375);
    assert.equal(precious.feasibility, "comfortable");
    // 469 × 3 + 297 × 1 = 1704 点 → 171 罐
    assert.equal(precious.stamina, 1704);
    assert.equal(precious.bigDrinks, 171);

    // 每日计划次数高于本期上限时按上限算
    assert.equal(planGoal({ ...base, dailyAutoRuns: 99, autoDailyLimit: 10 }).autoRuns, 30);
});

test("CN T1000：12:00 CST 至 09-28 21:00 CST，跨两次 04:00（UTC+8）重置 → 3 个 Auto 日", () => {
    const now = Date.UTC(2026, 8, 26, 4, 0, 0); // 2026-09-26 12:00 CST
    const endAt = Date.UTC(2026, 8, 28, 13, 0, 0); // 2026-09-28 21:00 CST
    const r = planGoal({
        now,
        endAt,
        tzOffsetMinutes: CN_TZ,
        currentScore: 350_000,
        targetScore: 1_850_000,
        pt: pt({ manualPtPerPlay: 2500, manualFire: 2, playsPerHour: 20, songSeconds: 130, autoPtPerPlay: 1500, autoFire: 1 }),
        dailyManualHours: 14,
        dailyAutoRuns: 10,
        autoDailyLimit: 10,
        gauge: null,
    });
    assert.equal(r.gap, 1_500_000);
    assert.equal(r.remainingHours, 57);
    // 3 × 10 = 30 次 × 1500 = 45,000；(1,500,000 − 45,000) / 2500 = 582 把整
    assert.equal(r.autoRuns, 30);
    assert.equal(r.autoTotalPt, 45_000);
    assert.equal(r.manualPlays, 582);
    approx(r.manualHoursTotal, 29.1);
    approx(r.manualHoursPerDay, 29.1 / 2.375);
    // 12.2526 / 14 = 0.875 → 可达成
    assert.equal(r.feasibility, "achievable");
    // 582 × 2 + 30 = 1194 点 → 120 罐 / 11,940 水晶
    assert.equal(r.stamina, 1194);
    assert.equal(r.bigDrinks, 120);
    assert.equal(r.crystals, 11_940);
    assert.equal(r.naturalStamina, 114);
});

test("同一时刻 JP/CN 的重置窗口数不同；包含 now 的窗口在时间够时给全天额度", () => {
    // 2026-09-26 19:30Z = JST 09-27 04:30（刚过重置）= CST 09-27 03:30（重置前）
    const now = Date.UTC(2026, 8, 26, 19, 30, 0);
    // 2026-09-28 11:59:59Z = JST 09-28 20:59:59 = CST 09-28 19:59:59
    const endAt = Date.UTC(2026, 8, 28, 11, 59, 59);
    const common = {
        now,
        endAt,
        currentScore: 0,
        targetScore: 10_000_000,
        pt: pt({ manualPtPerPlay: 3000, autoPtPerPlay: 1000 }),
        dailyManualHours: 24,
        dailyAutoRuns: 10,
        autoDailyLimit: 10,
        gauge: null,
    };
    // JP：[09-27 04:00, 09-28 04:00) + [09-28 04:00, …) = 2 个窗口
    assert.equal(planGoal({ ...common, tzOffsetMinutes: JP_TZ }).autoRuns, 20);
    // CN：[09-26 04:00, 09-27 04:00)（含 now，剩 30 分钟可打 12 次 ≥ 10，给全天额度）+ 09-27 + 09-28 = 3 个窗口
    assert.equal(planGoal({ ...common, tzOffsetMinutes: CN_TZ }).autoRuns, 30);
    // 已结束：没有窗口
    assert.equal(planGoal({ ...common, tzOffsetMinutes: JP_TZ, endAt: now - HOUR }).autoRuns, 0);
});

// ---------------------------------------------------------------------------
// 缺口为 0、剩余 48 小时、可行性阈值
// ---------------------------------------------------------------------------

test("缺口为 0：不打歌、不耗体力、轻松", () => {
    const r = planGoal(input({ currentScore: 3_100_000, targetScore: 3_000_000, pt: pt({ autoPtPerPlay: 2000 }) }));
    assert.equal(r.gap, 0);
    assert.equal(r.autoRuns, 0);
    assert.equal(r.autoTotalPt, 0);
    assert.equal(r.manualPlays, 0);
    assert.equal(r.manualHoursTotal, 0);
    assert.equal(r.manualHoursPerDay, 0);
    assert.equal(r.stamina, 0);
    assert.equal(r.bigDrinks, 0);
    assert.equal(r.crystals, 0);
    assert.equal(r.feasibility, "comfortable");
    assert.equal(r.naturalStamina, 96);
});

test("剩余 48 小时：每日小时 = 总小时 ÷ 2 天", () => {
    // 缺口 600,000，每把 2500（5 火），每小时 30 把 → 240 把 = 8 小时，每天 4 小时
    const r = planGoal(input());
    assert.equal(r.remainingHours, 48);
    assert.equal(r.remainingDays, 2);
    assert.equal(r.manualPlays, 240);
    assert.equal(r.manualHoursTotal, 8);
    assert.equal(r.manualHoursPerDay, 4);
    assert.equal(r.manualHoursPerDay * r.remainingDays, r.manualHoursTotal);
    // 4 / 10 = 0.4 → 轻松；240 × 5 = 1200 点
    assert.equal(r.feasibility, "comfortable");
    assert.equal(r.stamina, 1200);
    assert.equal(r.bigDrinks, 120);
    assert.equal(r.crystals, 12_000);
});

test("剩余不足 1 小时：每日小时按 1/24 天折算", () => {
    // 剩 30 分钟，10 把 / 30 把每小时 = 1/3 小时，÷ (1/24) 天 = 8 小时/天
    // 判定比较总量：1/3 ÷ min(每日 10 小时, 剩余 0.5 小时) = 0.667 → 可达成
    const now = Date.UTC(2026, 8, 28, 11, 30, 0);
    const r = planGoal(input({ now, endAt: now + HOUR / 2, targetScore: 25_000 }));
    assert.equal(r.manualPlays, 10);
    approx(r.manualHoursTotal, 1 / 3);
    approx(r.manualHoursPerDay, 8);
    assert.equal(r.feasibility, "achievable");
    assert.equal(r.naturalStamina, 1);
});

test("可行性阈值：≤0.6 轻松，≤0.9 可达成，≤1.0 吃力，>1 时间不够", () => {
    // 剩 24 小时（1 天），每把 1000，每小时 10 把，每日 10 小时 → 比例 = 把数 / 100
    const now = Date.UTC(2026, 8, 27, 3, 0, 0);
    const base = { now, endAt: now + 24 * HOUR, pt: pt({ manualPtPerPlay: 1000, playsPerHour: 10 }), dailyManualHours: 10 };
    const cases = [
        [60_000, "comfortable"],
        [61_000, "achievable"],
        [90_000, "achievable"],
        [91_000, "hard"],
        [100_000, "hard"],
        [101_000, "impossible"],
    ];
    for (const [targetScore, expected] of cases) {
        assert.equal(planGoal(input({ ...base, targetScore })).feasibility, expected, `target ${targetScore}`);
    }
    // 每日可用时长超过 24 小时按 24 小时计：200 把 = 20 小时 / 24 = 0.83 → 可达成
    assert.equal(planGoal(input({ ...base, targetScore: 200_000, dailyManualHours: 30 })).feasibility, "achievable");
});

test("Auto 覆盖全部缺口时不需要手动", () => {
    // 2 个窗口 × 10 次 × 2000 = 40,000 ≥ 30,000 → ceil(30,000 / 2000) = 15 次
    const r = planGoal(input({ targetScore: 30_000, pt: pt({ autoPtPerPlay: 2000, autoFire: 2 }) }));
    assert.equal(r.autoRuns, 15);
    assert.equal(r.autoTotalPt, 30_000);
    assert.equal(r.manualPlays, 0);
    assert.equal(r.manualHoursPerDay, 0);
    assert.equal(r.stamina, 30);
    assert.equal(r.feasibility, "comfortable");
});

test("每把 PT 为 0 时无法达成，结果不含 NaN", () => {
    const r = planGoal(input({ pt: pt({ manualPtPerPlay: 0, manualFire: 0 }) }));
    assert.equal(r.manualPlays, Infinity);
    assert.equal(r.feasibility, "impossible");
    assert.ok(!Number.isNaN(r.stamina));
});

// ---------------------------------------------------------------------------
// WL 总榜：剩余各章统一每日手动小时
// ---------------------------------------------------------------------------

function wlChapters(now, specs) {
    return specs.map(([chapterNo, gameCharacterId, startH, endH, chapterPt]) => ({
        window: { chapterNo, gameCharacterId, startAt: now + startH * HOUR, endAt: now + endH * HOUR },
        pt: chapterPt,
    }));
}

const WL_NOW = Date.UTC(2026, 7, 20, 3, 0, 0); // 2026-08-20 12:00 JST

function wlInput(over = {}) {
    return {
        now: WL_NOW,
        tzOffsetMinutes: JP_TZ,
        endAt: WL_NOW + 120 * HOUR,
        currentScore: 0,
        targetScore: 1_280_000,
        pt: pt({ manualPtPerPlay: 1000, manualFire: 2, playsPerHour: 20 }),
        // 第 3 章已开始 24 小时（剪到 now），第 4、5 章各 48 小时
        chapters: wlChapters(WL_NOW, [
            [3, 21, -24, 24, pt({ manualPtPerPlay: 1000, manualFire: 2, playsPerHour: 20 })],
            [4, 22, 24, 72, pt({ manualPtPerPlay: 1200, manualFire: 2, playsPerHour: 20 })],
            [5, 23, 72, 120, pt({ manualPtPerPlay: 1500, manualFire: 2, playsPerHour: 20 })],
        ]),
        dailyManualHours: 12,
        dailyAutoRuns: 0,
        autoDailyLimit: 10,
        gauge: null,
        ...over,
    };
}

test("WL 总榜（无疲劳槽）：H = 缺口 ÷ Σ(天数 × 每小时 PT)，逐章同一每日小时", () => {
    // Σ = 1 × 20,000 + 2 × 24,000 + 2 × 30,000 = 128,000；H = 1,280,000 / 128,000 = 10 小时/天
    const r = planGoal(wlInput());
    assert.equal(r.remainingDays, 5);
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.gameCharacterId, c.remainingHours, c.manualPlays, c.pt, c.gaugeCapHours]),
        [
            [3, 21, 24, 200, 200_000, null],
            [4, 22, 48, 400, 480_000, null],
            [5, 23, 48, 400, 600_000, null],
        ],
    );
    approx(r.perChapter[0].manualHours, 10);
    approx(r.perChapter[1].manualHours, 20);
    approx(r.perChapter[2].manualHours, 20);
    assert.equal(r.manualPlays, 1000);
    approx(r.manualHoursTotal, 50);
    approx(r.manualHoursPerDay, 10);
    // 1000 把 × 2 火 = 2000 点；10 / 12 = 0.83 → 可达成
    assert.equal(r.stamina, 2000);
    assert.equal(r.bigDrinks, 200);
    assert.equal(r.feasibility, "achievable");
    assert.equal(r.gaugeCapHoursPerDay, null);
});

test("WL 总榜 Auto：每个重置日的次数给当天所跨章节中 Auto PT 最高的一章", () => {
    // A：now → +24h（JST 08-21 12:00），Auto 800；B：+24h → +72h，Auto 1000
    // JST 窗口：08-20（仅 A）、08-21（A+B → B）、08-22（B）、08-23（B，至 12:00）
    const r = planGoal({
        now: WL_NOW,
        tzOffsetMinutes: JP_TZ,
        endAt: WL_NOW + 72 * HOUR,
        currentScore: 0,
        targetScore: 35_000,
        pt: pt(),
        chapters: wlChapters(WL_NOW, [
            [1, 1, 0, 24, pt({ autoPtPerPlay: 800 })],
            [2, 2, 24, 72, pt({ autoPtPerPlay: 1000 })],
        ]),
        dailyManualHours: 10,
        dailyAutoRuns: 10,
        autoDailyLimit: 10,
        gauge: null,
    });
    // B 的 3 天各 10 次 = 30,000，剩 5,000 由 A 的 1 天补 ceil(5000 / 800) = 7 次
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.autoRuns, c.manualPlays, c.pt]),
        [
            [1, 7, 0, 5_600],
            [2, 30, 0, 30_000],
        ],
    );
    assert.equal(r.autoRuns, 37);
    assert.equal(r.autoTotalPt, 35_600);
    assert.equal(r.manualPlays, 0);
    assert.equal(r.stamina, 37);
    assert.equal(r.feasibility, "comfortable");
});

// ---------------------------------------------------------------------------
// estimateRank：对数名次插值
// ---------------------------------------------------------------------------

const TIERS = [
    { rank: 1000, score: 2_000_000 },
    { rank: 1, score: 9_000_000 },
    { rank: 100, score: 4_000_000 },
    { rank: 10, score: 6_000_000 },
    { rank: 10000, score: 1_000_000 },
];

test("estimateRank：档位之间按 log(名次) 线性插值", () => {
    // T100 4M 与 T1000 2M 之间，3M 在正中 → 10^2.5 = 316.2
    assert.deepEqual(estimateRank(3_000_000, TIERS), { rank: 316, reachedTier: 1000, outside: null });
    // T1000 2M 与 T10000 1M 之间，1.25M 在 3/4 处 → 10^3.75 = 5623.4
    assert.deepEqual(estimateRank(1_250_000, TIERS), { rank: 5623, reachedTier: 10000, outside: null });
});

test("estimateRank：正好落在档位线上", () => {
    assert.deepEqual(estimateRank(2_000_000, TIERS), { rank: 1000, reachedTier: 1000, outside: null });
    assert.deepEqual(estimateRank(1_000_000, TIERS), { rank: 10000, reachedTier: 10000, outside: null });
    assert.deepEqual(estimateRank(9_000_000, TIERS), { rank: 1, reachedTier: 1, outside: null });
});

test("estimateRank：高于最高档", () => {
    // 有 T1：第 1 名
    assert.deepEqual(estimateRank(9_500_000, TIERS), { rank: 1, reachedTier: 1, outside: null });
    // 最高只有 T10：高于或等于 T10 线 → 无法估计
    const noTop = TIERS.filter((t) => t.rank !== 1);
    assert.deepEqual(estimateRank(7_000_000, noTop), { rank: null, reachedTier: 10, outside: "above" });
    assert.deepEqual(estimateRank(6_000_000, noTop), { rank: null, reachedTier: 10, outside: "above" });
});

test("estimateRank：低于最低档、无档位", () => {
    assert.deepEqual(estimateRank(999_999, TIERS), { rank: null, reachedTier: null, outside: "below" });
    assert.deepEqual(estimateRank(1_000_000, []), { rank: null, reachedTier: null, outside: null });
});

test("estimateRank：不单调的噪声按名次排序后取累计最小值", () => {
    // T500 4.1M 高于 T100 4.0M → 视为 4.0M
    const noisy = [...TIERS, { rank: 500, score: 4_100_000 }];
    // 3M 落在 T500(4M) 与 T1000(2M) 正中 → 500 × √2 = 707.1
    assert.deepEqual(estimateRank(3_000_000, noisy), { rank: 707, reachedTier: 1000, outside: null });
    // 4.05M：T10 6M 与 T100 4M 之间 0.975 处 → 10^1.975 = 94.4；达到的最小档是 T100
    assert.deepEqual(estimateRank(4_050_000, noisy), { rank: 94, reachedTier: 100, outside: null });
});

// ---------------------------------------------------------------------------
// compareSongs
// ---------------------------------------------------------------------------

function song(key, over) {
    return { key, label: key, pt: pt(over) };
}

test("compareSongs：每点体力最高（排除 0 火）与每小时最高", () => {
    // 基准：2500 PT / 5 火（每点体力 500），30 把/时（每小时 75,000）
    const base = song("base", { manualPtPerPlay: 2500, manualFire: 5, playsPerHour: 30 });
    const options = [
        base,
        // 0 火：每点体力无定义，不参与；每小时 18,000
        song("zero", { manualPtPerPlay: 600, manualFire: 0, playsPerHour: 30 }),
        // 每点体力 600，每小时 72,000
        song("eff", { manualPtPerPlay: 3000, manualFire: 5, playsPerHour: 24 }),
        // 每点体力 480，每小时 96,000
        song("fast", { manualPtPerPlay: 2400, manualFire: 5, playsPerHour: 40 }),
        // 每点体力 550，每小时 55,000
        song("cheap", { manualPtPerPlay: 1650, manualFire: 3, playsPerHour: 20 }),
    ];
    const c = compareSongs(base, options, input({ pt: base.pt }));
    assert.equal(c.base.key, "base");
    assert.equal(c.bestPerStamina.key, "eff");
    assert.equal(c.bestPerHour.key, "fast");
    // 基准 240 把 = 8 小时 = 4 小时/天，1200 点
    // eff：200 把 = 8.333 小时 = 4.1667 小时/天，1000 点
    assert.equal(c.perStaminaDelta.staminaSaved, 200);
    approx(c.perStaminaDelta.hoursPerDayMore, 1 / 6);
    approx(c.perStaminaDelta.hoursTotalMore, 1 / 3);
    // fast：250 把 = 6.25 小时 = 3.125 小时/天，1250 点
    approx(c.perHourDelta.hoursPerDaySaved, 0.875);
    approx(c.perHourDelta.hoursTotalSaved, 1.75);
    assert.equal(c.perHourDelta.staminaMore, 50);
});

test("compareSongs：基准已是最优时两项均为 null", () => {
    const base = song("base", { manualPtPerPlay: 3000, manualFire: 5, playsPerHour: 40 });
    const options = [
        song("slow", { manualPtPerPlay: 3000, manualFire: 5, playsPerHour: 24 }),
        // 与基准持平不算更优
        song("tie", { manualPtPerPlay: 3000, manualFire: 5, playsPerHour: 40 }),
        song("zero", { manualPtPerPlay: 700, manualFire: 0, playsPerHour: 40 }),
    ];
    const c = compareSongs(base, options, input({ pt: base.pt }));
    assert.equal(c.bestPerStamina, null);
    assert.equal(c.bestPerHour, null);
    assert.equal(c.perStaminaDelta, null);
    assert.equal(c.perHourDelta, null);
});

test("compareSongs：0 火基准不体力对比", () => {
    const base = song("base", { manualPtPerPlay: 700, manualFire: 0, playsPerHour: 30 });
    const options = [song("fire5", { manualPtPerPlay: 3500, manualFire: 5, playsPerHour: 30 })];
    const c = compareSongs(base, options, input({ pt: base.pt }));
    assert.equal(c.bestPerStamina, null);
    assert.equal(c.perStaminaDelta, null);
    assert.equal(c.bestPerHour.key, "fire5");
});

test("compareSongs：WL 总榜按歌曲 PT 比例缩放每章 PT", () => {
    // 换成 1.1 倍 PT、25 把/时：各章 1100 / 1320 / 1650，每小时 27,500 / 33,000 / 41,250
    // Σ = 27,500 + 66,000 + 82,500 = 176,000；H = 7.2727；取整后 182 + 364 + 364 = 910 把
    const base = song("base", { manualPtPerPlay: 1000, manualFire: 2, playsPerHour: 20 });
    const fast = song("fast", { manualPtPerPlay: 1100, manualFire: 2, playsPerHour: 25 });
    const c = compareSongs(base, [fast], wlInput());
    assert.equal(c.bestPerHour.key, "fast");
    // 基准 50 小时（10 小时/天）→ 910 / 25 = 36.4 小时（7.28 小时/天）
    approx(c.perHourDelta.hoursTotalSaved, 13.6);
    approx(c.perHourDelta.hoursPerDaySaved, 2.72);
    // 体力 910 × 2 − 2000 = −180
    assert.equal(c.perHourDelta.staminaMore, -180);
    assert.equal(c.bestPerStamina.key, "fast");
    assert.equal(c.perStaminaDelta.staminaSaved, 180);
});

// ---------------------------------------------------------------------------
// 疲劳槽上限（gaugeCapHoursPerDay 来自 fatigue.ts）
// ---------------------------------------------------------------------------

// 手算用疲劳槽：每把 +(歌长 + 10 秒) × 100，上限 2,080,000；休息 5 分钟后每 30 分钟 −2,080,000（隔天必清空）。
// 满槽才不得分（跨过上限的那把仍得分），所以每天可得分把数 = ceil(上限 / 每把增量)：
//   歌长 120 秒、20 把/时：每把 13,000 → 160 把 = 8.0 小时/天
//   歌长 90 秒、30 把/时：每把 10,000 → 208 把 = 6.93 小时 → 0.1 小时粒度取 6.9（207 把）
const TEST_GAUGE = {
    id: 99,
    gainPerSecond: 100,
    fixedSecondsPerPlay: 10,
    max: 2_080_000,
    restStartMinutes: 5,
    restStepMinutes: 30,
    restStepDecrease: 2_080_000,
    resetPerWlChapter: true,
};

test("单期疲劳槽：每日上限替代 24 小时参与可行性判断", () => {
    // 剩 48 小时，每把 2500、歌长 90 秒、30 把/时 → 上限 6.9 小时/天
    // 目标 975,000 → 390 把 = 13 小时 = 6.5 小时/天；无槽 6.5 / 10 = 0.65 可达成，有槽 6.5 / 6.9 = 0.942 吃力
    const withoutGauge = planGoal(input({ targetScore: 975_000 }));
    assert.equal(withoutGauge.manualPlays, 390);
    approx(withoutGauge.manualHoursPerDay, 6.5);
    assert.equal(withoutGauge.feasibility, "achievable");
    const withGauge = planGoal(input({ targetScore: 975_000, gauge: TEST_GAUGE }));
    approx(withGauge.gaugeCapHoursPerDay, 6.9);
    assert.equal(withGauge.manualPlays, 390);
    assert.equal(withGauge.feasibility, "hard");
    assert.deepEqual(withGauge.perChapter, []);
});

function gaugeWlInput(targetScore) {
    return wlInput({
        targetScore,
        gauge: TEST_GAUGE,
        chapters: wlChapters(WL_NOW, [
            // 上限 8.0 小时/天
            [3, 21, -24, 24, pt({ manualPtPerPlay: 1000, manualFire: 2, playsPerHour: 20, songSeconds: 120 })],
            [4, 22, 24, 72, pt({ manualPtPerPlay: 1200, manualFire: 2, playsPerHour: 20, songSeconds: 120 })],
            // 上限 6.9 小时/天
            [5, 23, 72, 120, pt({ manualPtPerPlay: 1500, manualFire: 2, playsPerHour: 30, songSeconds: 90 })],
        ]),
    });
}

test("WL 总榜：一章触及疲劳槽上限，超出部分摊给其余各章", () => {
    // 每小时 PT：20,000 / 24,000 / 45,000；Σ(天数 × 每小时 PT) = 20,000 + 48,000 + 90,000 = 158,000
    // 缺口 1,131,000 → 统一 H = 7.158 小时/天；第 5 章 2 天 × 7.158 = 14.3 > 上限 2 × 6.9 = 13.8 小时
    // 第 5 章封顶 13.8 小时 = 414 把 = 621,000 PT；其余 510,000 ÷ 68,000 = 7.5 小时/天
    const r = planGoal(gaugeWlInput(1_131_000));
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.manualPlays, c.pt]),
        [
            [3, 150, 150_000],
            [4, 300, 360_000],
            [5, 414, 621_000],
        ],
    );
    approx(r.perChapter[0].manualHours, 7.5);
    approx(r.perChapter[1].manualHours, 15);
    approx(r.perChapter[2].manualHours, 13.8);
    approx(r.perChapter[0].gaugeCapHours, 8);
    approx(r.perChapter[1].gaugeCapHours, 16);
    approx(r.perChapter[2].gaugeCapHours, 13.8);
    // 封顶的一章正好等于其上限
    approx(r.perChapter[2].manualHours, r.perChapter[2].gaugeCapHours);
    assert.equal(r.manualPlays, 864);
    approx(r.manualHoursTotal, 36.3);
    approx(r.manualHoursPerDay, 7.26);
    // 各章每日上限取最小：6.9
    approx(r.gaugeCapHoursPerDay, 6.9);
    // 第 3、4 章 7.5 / 8 = 0.94，第 5 章 6.9 / 6.9 = 1.0 → 吃力
    assert.equal(r.feasibility, "hard");
    assert.equal(r.stamina, 1728);
});

test("WL 总榜：各章都封顶仍不够时，余量按统一每日小时超出上限 → 时间不够", () => {
    // 各章上限 PT：8 × 20,000 + 16 × 24,000 + 13.8 × 45,000 = 1,165,000
    // 缺口 1,323,000，余 158,000 ÷ 158,000 = 每天再多 1 小时：9 / 18 / 15.8 小时
    const r = planGoal(gaugeWlInput(1_323_000));
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.manualPlays, c.pt]),
        [
            [3, 180, 180_000],
            [4, 360, 432_000],
            [5, 474, 711_000],
        ],
    );
    assert.equal(r.feasibility, "impossible");
});

// ---------------------------------------------------------------------------
// 疲劳槽容量按窗口实际长度计算（不足一天、非整天、WL 进行中章节）
// 容量 = 以每日上限从窗口起点排程时窗口内可得分的手动小时（整把），与 manualHoursTotal 直接比较；
// 结果里的 gaugeCapHoursPerDay 与 manualHoursPerDay 同一折算：容量 ÷ max(剩余天数, 1/24)。
// ---------------------------------------------------------------------------

test("单期剩余 12 小时：疲劳槽容量是窗口内 6.9 小时，不按每天上限放大比较", () => {
    // TEST_GAUGE、歌长 90 秒、30 把/时：每日上限 6.9 小时（207 把），12 小时窗口内容量同为 6.9 小时 → 13.8 小时/天
    // 目标 487,500 → 195 把 = 6.5 小时 → 13 小时/天；13 / 13.8 = 0.942 → 吃力（旧算法 13 / 6.9 = 1.88 误判时间不够）
    const now = Date.UTC(2026, 8, 28, 0, 0, 0);
    const base = input({ now, endAt: now + 12 * HOUR, targetScore: 487_500, dailyManualHours: 24, gauge: TEST_GAUGE });
    const r = planGoal(base);
    assert.equal(r.manualPlays, 195);
    approx(r.manualHoursTotal, 6.5);
    approx(r.manualHoursPerDay, 13);
    approx(r.gaugeCapHoursPerDay, 13.8);
    assert.equal(r.feasibility, "hard");
    // 按计划从现在连打 6.5 小时，模拟器确认不丢把
    const sim = simulateGauge({ gauge: TEST_GAUGE, songSeconds: 90, playsPerHour: 30, windowHours: 12, plannedManualHoursPerDay: 6.5 });
    assert.equal(sim.hitsCap, false);
    approx(sim.effectiveManualHours, 6.5);
    // 无疲劳槽：13 / 24 = 0.54 → 轻松
    assert.equal(planGoal({ ...base, gauge: null }).feasibility, "comfortable");
    // 207 把 = 6.9 小时正好等于容量 → 吃力；210 把 = 7.0 小时超过容量 → 时间不够
    assert.equal(planGoal({ ...base, targetScore: 517_500 }).feasibility, "hard");
    assert.equal(planGoal({ ...base, targetScore: 525_000 }).feasibility, "impossible");
    // 剩余不足一天时每日可用小时按一整天算（R8r3-01）：6.5 / min(10, 12, 6.9) = 0.942 → 吃力（旧算法折成 10 × 12/24 = 5 小时，1.3 时间不够）
    assert.equal(planGoal({ ...base, dailyManualHours: 10 }).feasibility, "hard");
    // 每日只有 6 小时：6.5 / 6 = 1.083 → 时间不够
    assert.equal(planGoal({ ...base, dailyManualHours: 6 }).feasibility, "impossible");
});

test("单期剩余 36 小时：第二天只剩 12 小时，容量 = 6.9 + 6.9 小时，不按 1.5 天折算", () => {
    // 36 小时窗口的每日上限仍是 6.9 小时（夜间休息清空槽）；容量 = 207 + 207 把 = 13.8 小时 → 13.8 / 1.5 = 9.2 小时/天
    // 目标 900,000 → 360 把 = 12 小时 → 8 小时/天；8 / 9.2 = 0.87 → 可达成（旧算法 8 / 6.9 = 1.16 时间不够）
    const now = Date.UTC(2026, 8, 27, 0, 0, 0);
    const r = planGoal(input({ now, endAt: now + 36 * HOUR, targetScore: 900_000, dailyManualHours: 24, gauge: TEST_GAUGE }));
    assert.equal(r.manualPlays, 360);
    approx(r.manualHoursPerDay, 8);
    approx(r.gaugeCapHoursPerDay, 9.2);
    assert.equal(r.feasibility, "achievable");
    const sim = simulateGauge({ gauge: TEST_GAUGE, songSeconds: 90, playsPerHour: 30, windowHours: 36, plannedManualHoursPerDay: 6.9 });
    assert.equal(sim.hitsCap, false);
    approx(sim.effectiveManualHours, 13.8);
});

test("WL 进行中章节剩 20 小时：章节容量 6.9 小时，不按 20/24 折成 5.75 小时", () => {
    // 第 3 章已开始 28 小时，剪到 now 后剩 20 小时；容量 207 把 = 6.9 小时（每日口径 6.9 / (20/24) = 8.28）
    // 目标 195,000 → 195 把 = 6.5 小时 ≤ 6.9，不封顶；7.8 / min(12, 8.28) = 0.942 → 吃力
    const chapterPt = pt({ manualPtPerPlay: 1000, manualFire: 2, playsPerHour: 30, songSeconds: 90 });
    const r = planGoal({
        now: WL_NOW,
        tzOffsetMinutes: JP_TZ,
        endAt: WL_NOW + 20 * HOUR,
        currentScore: 0,
        targetScore: 195_000,
        pt: chapterPt,
        chapters: wlChapters(WL_NOW, [[3, 21, -28, 20, chapterPt]]),
        dailyManualHours: 12,
        dailyAutoRuns: 0,
        autoDailyLimit: 10,
        gauge: TEST_GAUGE,
    });
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.remainingHours, c.manualPlays, c.pt]),
        [[3, 20, 195, 195_000]],
    );
    approx(r.perChapter[0].manualHours, 6.5);
    approx(r.perChapter[0].gaugeCapHours, 6.9);
    approx(r.gaugeCapHoursPerDay, 8.28);
    assert.equal(r.feasibility, "hard");
});

test("真实疲劳槽第 2 套（#198 起）：Envy 协力剩 20 小时需手动 16 小时 → 吃力而非时间不够", () => {
    // 每把 (74.8 + 10) × 157 = 13,313.6，第 496 把跨过 6,600,000 仍得分 → 每日上限 17.2 小时（496 把）
    // 需 floor(16 × 3600 / 124.8) = 461 把 = 15.98 小时；容量 496 把 = 17.19 小时 → 0.929 吃力；无槽 19.18 / 24 = 0.80 可达成
    const set2 = {
        id: 2,
        gainPerSecond: 157,
        fixedSecondsPerPlay: 10,
        max: 6_600_000,
        restStartMinutes: 5,
        restStepMinutes: 30,
        restStepDecrease: 550_000,
        resetPerWlChapter: false,
    };
    const perHour = 3600 / 124.8;
    const envy = pt({ manualPtPerPlay: 30_000, playsPerHour: perHour, songSeconds: 74.8 });
    const now = Date.UTC(2026, 8, 27, 0, 0, 0);
    const base = input({ now, endAt: now + 20 * HOUR, targetScore: 461 * 30_000, pt: envy, dailyManualHours: 24, gauge: set2 });
    const r = planGoal(base);
    assert.equal(r.manualPlays, 461);
    approx(r.gaugeCapHoursPerDay, (496 / perHour) / (20 / 24));
    assert.equal(r.feasibility, "hard");
    assert.equal(planGoal({ ...base, gauge: null }).feasibility, "achievable");
    const sim = simulateGauge({ gauge: set2, songSeconds: 74.8, playsPerHour: perHour, windowHours: 20, plannedManualHoursPerDay: 461 / perHour });
    assert.equal(sim.hitsCap, false);
});

// ---------------------------------------------------------------------------
// 剩余时间项：手动与 Auto 都占真实时间（Auto 一次按 120 秒歌 + 30 秒间隔 = 150 秒，每小时 24 次）
// ---------------------------------------------------------------------------

const LAST_END = Date.UTC(2026, 8, 28, 11, 0, 0);
// 手动每把 3000、36 把/时（每小时 108,000）；Auto 每次 2000（每小时 48,000）
const P5 = pt({ manualPtPerPlay: 3000, playsPerHour: 36, autoPtPerPlay: 2000 });

test("最后 1 小时无疲劳槽：手动时长超过剩余时间 → 时间不够", () => {
    // 10 把 / 30 把每小时 = 20 分钟，每日可用 20 小时；剩余不足一天时直接和 min(20, 剩余时间) 比较：
    // 10 分钟 → 2；19 分钟 → 1.05；21 分钟 → 0.95；25 分钟 → 0.8
    const at = (minutes) =>
        planGoal(input({ now: LAST_END - minutes * 60_000, endAt: LAST_END, targetScore: 25_000, dailyManualHours: 20, dailyAutoRuns: 0 }))
            .feasibility;
    assert.equal(at(10), "impossible");
    assert.equal(at(19), "impossible");
    assert.equal(at(21), "hard");
    assert.equal(at(25), "achievable");
    // 剩 61 分钟：(1/3) / min(20, 61/60) = 0.33 → 轻松
    assert.equal(at(61), "comfortable");
});

test("最后 30 分钟：Auto 次数受剩余时间限制，不按全天额度", () => {
    // 30 分钟 / 150 秒 = 12 次（旧算法按每日 99 次）
    const r = planGoal(
        input({ now: LAST_END - HOUR / 2, endAt: LAST_END, targetScore: 10_000_000, pt: P5, dailyAutoRuns: 99, autoDailyLimit: 99 }),
    );
    assert.equal(r.autoRuns, 12);
    assert.equal(r.autoTotalPt, 24_000);
    assert.equal(r.feasibility, "impossible");
});

test("本地 04:00 前 30 分钟：当前重置窗口只剩 30 分钟可打 Auto", () => {
    // JST 03:30 起 24.5 小时：[03:30, 04:00) 12 次 + [04:00, 次日 04:00) 99 次 = 111 次（旧算法 2 × 99 = 198）
    const now = Date.UTC(2026, 8, 26, 18, 30, 0);
    const r = planGoal(input({ now, endAt: now + 24.5 * HOUR, targetScore: 10_000_000, pt: P5, dailyAutoRuns: 99, autoDailyLimit: 99 }));
    assert.equal(r.autoRuns, 111);
    assert.equal(r.autoTotalPt, 222_000);
});

test("最后 30 分钟：手动更快时减少 Auto，取最好判定档里 Auto 最多的次数", () => {
    // 缺口 41,000，Auto 优先 12 次（占满 30 分钟）。x 次 Auto：手动 ceil((41,000 − 2000x) / 3000) 把，空余 0.5 − x/24 小时
    // 比例 = 手动小时 / min(每日 10, 空余)：x = 0 → 14 把 0.3889 / 0.5 = 0.778；x = 1 → 13 把 / 0.4583 = 0.788；
    //   x = 2 → 13 把 / 0.4167 = 0.867；x = 3 → 12 把 0.3333 / 0.375 = 0.889；x = 4 → 11 把 0.3056 / 0.3333 = 0.917 吃力；
    //   x = 5 → 11 把 / 0.2917 = 1.048；x ≥ 5 都放不下
    // 最好的一档是可达成，其中 Auto 最多的是 3 次（6,000）+ 手动 12 把（36,000）（修复前取放得下的最多次数 4 次，判吃力）
    const r = planGoal(
        input({ now: LAST_END - HOUR / 2, endAt: LAST_END, targetScore: 41_000, pt: P5, dailyAutoRuns: 99, autoDailyLimit: 99 }),
    );
    assert.equal(r.autoRuns, 3);
    assert.equal(r.autoTotalPt, 6_000);
    assert.equal(r.manualPlays, 12);
    approx(r.manualHoursPerDay, (12 / 36) * 24);
    assert.equal(r.feasibility, "achievable");
    // 12 × 5 + 3 × 1 = 63 点
    assert.equal(r.stamina, 63);
});

test("整天窗口：手动与 Auto 合计不能超过 24 小时", () => {
    // JST 04:00 起 24 小时（1 个重置窗口）：Auto 99 次 × 150 秒 = 4.125 小时，每次 5000（每小时 120,000，快于手动 108,000）
    // 缺口 495,000 + 21 小时 × 108,000 → 手动 756 把 = 21 小时；减少 Auto 只会更费时 → 保留 99 次
    // 21 / (24 − 4.125) = 1.057 → 时间不够（旧算法 21 / 24 = 0.875 可达成）；手动 19 小时（684 把）19 / 19.875 = 0.956 → 吃力
    const now = Date.UTC(2026, 8, 26, 19, 0, 0);
    const base = {
        now,
        endAt: now + 24 * HOUR,
        pt: pt({ manualPtPerPlay: 3000, playsPerHour: 36, autoPtPerPlay: 5000 }),
        dailyManualHours: 24,
        dailyAutoRuns: 99,
        autoDailyLimit: 99,
    };
    const r = planGoal(input({ ...base, targetScore: 2_763_000 }));
    assert.equal(r.autoRuns, 99);
    assert.equal(r.manualPlays, 756);
    assert.equal(r.feasibility, "impossible");
    const lighter = planGoal(input({ ...base, targetScore: 2_547_000 }));
    assert.equal(lighter.manualPlays, 684);
    assert.equal(lighter.feasibility, "hard");
});

test("WL 总榜：进行中章节剩 30 分钟，Auto 按各章重叠时长分配，手动挪到下一章", () => {
    // A：剩 30 分钟，Auto 2500；B：随后 48 小时，Auto 2000；每日 99 次
    // JST 窗口 [08-20 12:00, 08-21 04:00)：A 的 30 分钟放 12 次，余 87 次给 B；其后两个窗口 B 各 99 次 → B 共 285 次
    // Auto 共 12 × 2500 + 285 × 2000 = 600,000；缺口 900,000 余 300,000 手动
    // A 的时间已被 Auto 占满（可手动 0 小时）→ 封顶 0，全部给 B：300,000 / 3000 = 100 把（旧算法 A 在 30 分钟里打 99 次 Auto）
    const chapters = wlChapters(WL_NOW, [
        [1, 1, -10, 0.5, pt({ manualPtPerPlay: 3000, playsPerHour: 36, autoPtPerPlay: 2500 })],
        [2, 2, 0.5, 48.5, P5],
    ]);
    const base = {
        now: WL_NOW,
        tzOffsetMinutes: JP_TZ,
        endAt: WL_NOW + 48.5 * HOUR,
        currentScore: 0,
        targetScore: 900_000,
        pt: P5,
        chapters,
        dailyManualHours: 12,
        dailyAutoRuns: 99,
        autoDailyLimit: 99,
        gauge: null,
    };
    const r = planGoal(base);
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.autoRuns, c.manualPlays, c.pt]),
        [
            [1, 12, 0, 30_000],
            [2, 285, 100, 870_000],
        ],
    );
    assert.equal(r.autoRuns, 297);
    assert.equal(r.autoTotalPt, 600_000);
    assert.equal(r.manualPlays, 100);
    // B：100 / 36 = 2.78 小时 ÷ 2 天 = 1.39 小时/天 → 轻松
    assert.equal(r.feasibility, "comfortable");

    // Auto PT 相同时交给重叠时间更长的一章：每日 10 次全给 B（旧算法第一个窗口给 A 10 次）
    const tie = planGoal({
        ...base,
        targetScore: 60_000,
        chapters: wlChapters(WL_NOW, [
            [1, 1, -10, 0.5, P5],
            [2, 2, 0.5, 48.5, P5],
        ]),
        dailyAutoRuns: 10,
        autoDailyLimit: 10,
    });
    assert.deepEqual(
        tie.perChapter.map((c) => [c.chapterNo, c.autoRuns]),
        [
            [1, 0],
            [2, 30],
        ],
    );
});

test("WL 总榜只剩最后一章 30 分钟：与单期一样减少 Auto，结果一致", () => {
    const base = {
        now: WL_NOW,
        tzOffsetMinutes: JP_TZ,
        endAt: WL_NOW + HOUR / 2,
        currentScore: 0,
        targetScore: 41_000,
        pt: P5,
        chapters: wlChapters(WL_NOW, [[5, 5, -47.5, 0.5, P5]]),
        dailyManualHours: 10,
        dailyAutoRuns: 99,
        autoDailyLimit: 99,
        gauge: null,
    };
    const r = planGoal(base);
    // 同“最后 30 分钟”单期用例：Auto 3 次 + 手动 12 把 = 42,000，可达成
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.autoRuns, c.manualPlays, c.pt]),
        [[5, 3, 12, 42_000]],
    );
    assert.equal(r.feasibility, "achievable");
    const single = planGoal({ ...base, chapters: undefined });
    assert.deepEqual(
        [single.autoRuns, single.manualPlays, single.feasibility],
        [r.autoRuns, r.manualPlays, r.feasibility],
    );
});

test("剩余时间内疲劳槽不会满时，显示的每日上限为 24 小时，WL 总榜取最小值时跳过", () => {
    // TEST_GAUGE：歌长 90 秒、30 把/时，要 208 把（6.93 小时）才满；剩 10 分钟只能打 5 把 → 疲劳槽不起作用
    // 旧算法显示 5 把 = 1/6 小时 ÷ (1/24 天) = 4 小时/天
    const single = planGoal(
        input({ now: LAST_END - 10 * 60_000, endAt: LAST_END, targetScore: 5_000, dailyManualHours: 20, dailyAutoRuns: 0, gauge: TEST_GAUGE }),
    );
    assert.equal(single.gaugeCapHoursPerDay, 24);
    assert.equal(single.feasibility, "comfortable");

    // WL 总榜：第 3 章剩 10 分钟（不受限，跳过），第 4 章 48 小时每日上限 6.9 小时 → 6.9（旧算法取最小值 4）
    const wl = {
        now: WL_NOW,
        tzOffsetMinutes: JP_TZ,
        endAt: WL_NOW + (48 + 1 / 6) * HOUR,
        currentScore: 0,
        targetScore: 100_000,
        pt: pt(),
        chapters: wlChapters(WL_NOW, [
            [3, 21, -47, 1 / 6, pt()],
            [4, 22, 1 / 6, 48 + 1 / 6, pt()],
        ]),
        dailyManualHours: 12,
        dailyAutoRuns: 0,
        autoDailyLimit: 10,
        gauge: TEST_GAUGE,
    };
    approx(planGoal(wl).gaugeCapHoursPerDay, 6.9);
    // 只剩第 3 章的 10 分钟：没有受限的章节 → 24
    const lastOnly = planGoal({
        ...wl,
        endAt: WL_NOW + HOUR / 6,
        targetScore: 5_000,
        chapters: wlChapters(WL_NOW, [[3, 21, -47, 1 / 6, pt()]]),
    });
    assert.equal(lastOnly.gaugeCapHoursPerDay, 24);
});

// ---------------------------------------------------------------------------
// Auto 歌长（PtPlan.autoSongSeconds）：一次 Auto = 歌长 + 30 秒间隔；缺省按 120 秒
// ---------------------------------------------------------------------------

// Auto 歌 150 秒：一次 180 秒 = 0.05 小时，每小时 20 次
const P5_AUTO150 = { ...P5, autoSongSeconds: 150 };

test("Auto 歌长 150 秒：重置窗口额度按每次 180 秒计", () => {
    // 最后 30 分钟：1800 / 180 = 10 次（按 150 秒一次是 12 次）
    const last = planGoal(
        input({ now: LAST_END - HOUR / 2, endAt: LAST_END, targetScore: 10_000_000, pt: P5_AUTO150, dailyAutoRuns: 99, autoDailyLimit: 99 }),
    );
    assert.equal(last.autoRuns, 10);
    assert.equal(last.autoTotalPt, 20_000);
    // JST 03:30 起 24.5 小时：[03:30, 04:00) 10 次 + 整天窗口 99 次（86,400 / 180 = 480 ≥ 99）= 109 次（按 150 秒是 111）
    const now = Date.UTC(2026, 8, 26, 18, 30, 0);
    const r = planGoal(
        input({ now, endAt: now + 24.5 * HOUR, targetScore: 10_000_000, pt: P5_AUTO150, dailyAutoRuns: 99, autoDailyLimit: 99 }),
    );
    assert.equal(r.autoRuns, 109);
    // 缺省 autoSongSeconds 仍按 120 秒：同一窗口 111 次
    assert.equal(planGoal(input({ now, endAt: now + 24.5 * HOUR, targetScore: 10_000_000, pt: P5, dailyAutoRuns: 99, autoDailyLimit: 99 })).autoRuns, 111);
});

test("Auto 歌长 150 秒：最后 30 分钟减少 Auto 时按每次 180 秒计", () => {
    // 缺口 41,000，Auto 优先 10 次；x 次 Auto 的空余 = 0.5 − 0.05x 小时
    //   x = 0 → 14 把 0.3889 / 0.5 = 0.778；x = 1 → 13 把 0.3611 / 0.45 = 0.802；x = 2 → 13 把 / 0.4 = 0.903 吃力；
    //   x = 3 → 12 把 0.3333 / 0.35 = 0.952 吃力；x = 4 → 11 把 0.3056 / 0.3 = 1.019
    // → 可达成一档里最多 1 次 Auto（2,000）+ 手动 13 把（39,000）（按 150 秒一次是 3 次 + 12 把；修复前 3 次 + 12 把判吃力）
    const r = planGoal(
        input({ now: LAST_END - HOUR / 2, endAt: LAST_END, targetScore: 41_000, pt: P5_AUTO150, dailyAutoRuns: 99, autoDailyLimit: 99 }),
    );
    assert.equal(r.autoRuns, 1);
    assert.equal(r.manualPlays, 13);
    approx(r.manualHoursPerDay, (13 / 36) * 24);
    assert.equal(r.feasibility, "achievable");
    // 13 × 5 + 1 × 1 = 66 点
    assert.equal(r.stamina, 66);
});

test("Auto 歌长 180 秒：整天窗口的空余时间按每次 210 秒扣除", () => {
    // JST 04:00 起 24 小时，Auto 99 次 × 210 秒 = 5.775 小时（按 150 秒是 4.125 小时），每次 7000
    // Auto 每小时 7000 × 3600 / 210 = 120,000，快于手动 108,000 → 减少 Auto 只会更费时，保留 99 次
    const now = Date.UTC(2026, 8, 26, 19, 0, 0);
    const base = {
        now,
        endAt: now + 24 * HOUR,
        pt: pt({ manualPtPerPlay: 3000, playsPerHour: 36, autoPtPerPlay: 7000, autoSongSeconds: 180 }),
        dailyManualHours: 24,
        dailyAutoRuns: 99,
        autoDailyLimit: 99,
    };
    // 693,000 + 手动 612 把（17 小时）：17 + 5.775 = 22.775 ≤ 24；17 / (24 − 5.775) = 0.933 → 吃力（按 150 秒 17 / 19.875 = 0.855 可达成）
    const r = planGoal(input({ ...base, targetScore: 2_529_000 }));
    assert.equal(r.autoRuns, 99);
    assert.equal(r.manualPlays, 612);
    assert.equal(r.feasibility, "hard");
    // 693,000 + 手动 666 把（18.5 小时）：18.5 + 5.775 > 24，每少 1 次 Auto 平均多用约 23 秒 → 保留 99 次
    // 18.5 / 18.225 = 1.015 → 时间不够（按 150 秒 18.5 / 19.875 = 0.931 吃力）
    const heavier = planGoal(input({ ...base, targetScore: 2_691_000 }));
    assert.equal(heavier.autoRuns, 99);
    assert.equal(heavier.manualPlays, 666);
    assert.equal(heavier.feasibility, "impossible");
});

test("WL 总榜：每章按自己 PtPlan 的 Auto 歌长计算窗口额度与空余时间", () => {
    // A：剩 30 分钟，Auto 2500、歌长 150 秒（每次 180 秒）；B：随后 48 小时，Auto 2000、歌长 60 秒（每次 90 秒）
    // 窗口 [08-20 12:00, 08-21 04:00)：A 先拿（PT 高）1800 / 180 = 10 次，余 89 次给 B；其后两个窗口 B 各 99 次 → B 287 次
    // Auto 10 × 2500 + 287 × 2000 = 599,000；B 可手动 48 − 287 × 90 / 3600 = 48 − 7.175 = 40.825 小时，A 为 0
    // 目标 4,703,000 → 手动 4,104,000 全给 B：1368 把 = 38 小时 ≤ 40.825
    // B：19 / min(24, 40.825 / 2 = 20.41) = 0.931 → 吃力（若 B 用 A 的 180 秒，可手动只剩 33.65 小时 → 时间不够）
    const chapters = wlChapters(WL_NOW, [
        [1, 1, -10, 0.5, pt({ manualPtPerPlay: 3000, playsPerHour: 36, autoPtPerPlay: 2500, autoSongSeconds: 150 })],
        [2, 2, 0.5, 48.5, { ...P5, autoSongSeconds: 60 }],
    ]);
    const r = planGoal({
        now: WL_NOW,
        tzOffsetMinutes: JP_TZ,
        endAt: WL_NOW + 48.5 * HOUR,
        currentScore: 0,
        targetScore: 4_703_000,
        pt: P5,
        chapters,
        dailyManualHours: 24,
        dailyAutoRuns: 99,
        autoDailyLimit: 99,
        gauge: null,
    });
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.autoRuns, c.manualPlays, c.pt]),
        [
            [1, 10, 0, 25_000],
            [2, 287, 1368, 4_678_000],
        ],
    );
    assert.equal(r.autoRuns, 297);
    assert.equal(r.autoTotalPt, 599_000);
    approx(r.perChapter[1].manualHours, 38);
    assert.equal(r.feasibility, "hard");
});

test("WL 总榜只剩最后一章 30 分钟、Auto 歌长 150 秒：与单期结果一致", () => {
    const base = {
        now: WL_NOW,
        tzOffsetMinutes: JP_TZ,
        endAt: WL_NOW + HOUR / 2,
        currentScore: 0,
        targetScore: 41_000,
        pt: P5_AUTO150,
        chapters: wlChapters(WL_NOW, [[5, 5, -47.5, 0.5, P5_AUTO150]]),
        dailyManualHours: 10,
        dailyAutoRuns: 99,
        autoDailyLimit: 99,
        gauge: null,
    };
    const r = planGoal(base);
    // 同上：Auto 1 次 + 手动 13 把 = 41,000，可达成
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.autoRuns, c.manualPlays, c.pt]),
        [[5, 1, 13, 41_000]],
    );
    assert.equal(r.feasibility, "achievable");
    const single = planGoal({ ...base, chapters: undefined });
    assert.deepEqual([single.autoRuns, single.manualPlays, single.feasibility], [r.autoRuns, r.manualPlays, r.feasibility]);
});

// ---------------------------------------------------------------------------
// WL 总榜：跨两章的重置窗口，Auto PT 相同时先放进疲劳槽留下的休息时间，先结束的一章先放
// ---------------------------------------------------------------------------

// 第 2 套疲劳槽（#198 起，WL 每章重置）；Envy 74.8 秒 + 50 秒间隔 = 124.8 秒一把，每把 13,313.6，第 496 把跨过 6,600,000 仍得分
const SET2_WL = {
    id: 2,
    gainPerSecond: 157,
    fixedSecondsPerPlay: 10,
    max: 6_600_000,
    restStartMinutes: 5,
    restStepMinutes: 30,
    restStepDecrease: 550_000,
    resetPerWlChapter: true,
};
const PLAY_H = 124.8 / 3600;

test("WL 总榜（#214 形状）：章节最后一天 10:00 规划，共享窗口的 Auto 进疲劳槽受限一章的休息时间，本章手动上限不再被 Auto 挤占", () => {
    // now = 08-23 10:00 JST；第 3 章 20:00 结算（剩 10 小时），第 4、5 章各 48 小时（20:00 → 20:00）
    // 手动 30,000 PT/把、28.846 把/时；Auto 10,000 PT、缺省 120 秒歌（每次 150 秒），每日 99 次
    // 疲劳槽：第 3 章 10 小时只能打 288 把 < 496，不受限，容量 288 把 = 9.984 小时，休息 0
    //         第 4、5 章每天 496 把、夜间清空 → 容量 992 把 = 34.389 小时，休息 48 − 34.389 = 13.611 小时 = 326 次 Auto
    // JST 重置窗口：W1 [08-23 10:00, 08-24 04:00) 第 3 章 10 小时 / 第 4 章 8 小时；W2 第 4 章 24 小时；
    //              W3 第 4 章 16 小时 / 第 5 章 8 小时；W4、W5 第 5 章 24 / 16 小时
    // 分配：W1 第 3 章没有休息，99 次进第 4 章的休息；W2 第 4 章 99 次；W3 先结束的第 4 章休息还余 326 − 198 = 128，
    //       99 次仍给第 4 章；W4、W5 第 5 章 → 各章 Auto 0 / 297 / 198（297 × 150 秒 = 12.375 小时 ≤ 13.611）
    // 旧分配 W1 按重叠时长给第 3 章 99 次：手动上限 min(9.984, 10 − 4.125) = 5.875 小时
    const now = Date.UTC(2026, 7, 23, 1, 0, 0);
    const envy = pt({ manualPtPerPlay: 30_000, manualFire: 3, playsPerHour: 3600 / 124.8, songSeconds: 74.8, autoPtPerPlay: 10_000 });
    const plan = (targetScore) =>
        planGoal({
            now,
            tzOffsetMinutes: JP_TZ,
            endAt: now + 106 * HOUR,
            currentScore: 0,
            targetScore,
            pt: envy,
            chapters: wlChapters(now, [
                [3, 25, -38, 10, envy],
                [4, 19, 10, 58, envy],
                [5, 7, 58, 106, envy],
            ]),
            dailyManualHours: 24,
            dailyAutoRuns: 99,
            autoDailyLimit: 99,
            gauge: SET2_WL,
        });

    // 目标 7,100 万：Auto 495 × 10,000 = 495 万，手动 6,605 万
    // 统一 H = 6,605 万 ÷ (4.4167 天 × 865,384.6) = 17.28 小时/天 → 第 4、5 章 34.56 > 34.389 → 封顶 992 把（各 2,976 万）
    // 第 3 章承担 653 万 = 217.67 → 218 把 = 7.557 小时（> 旧上限 5.875，≤ 容量 9.984）
    const r = plan(71_000_000);
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.autoRuns, c.manualPlays, c.pt]),
        [
            [3, 0, 218, 6_540_000],
            [4, 297, 992, 32_730_000],
            [5, 198, 992, 31_740_000],
        ],
    );
    approx(r.perChapter[0].gaugeCapHours, 288 * PLAY_H);
    approx(r.perChapter[1].gaugeCapHours, 992 * PLAY_H);
    approx(r.perChapter[0].manualHours, 218 * PLAY_H);
    assert.ok(r.perChapter[0].manualHours > 10 - 99 * (150 / 3600));
    assert.equal(r.autoRuns, 495);
    assert.equal(r.manualPlays, 2202);
    // 第 4、5 章 34.389 / min(48, 空余 35.625 或 39.75, 容量 34.389) = 1.0；第 3 章 7.557 / 9.984 = 0.76 → 吃力（R1-8 之前时间不够）
    assert.equal(r.feasibility, "hard");

    // 目标 7,250 万：第 3 章 803 万 = 267.67 → 268 把 = 9.291 小时 ≤ 9.984 → 仍为吃力
    const tighter = plan(72_500_000);
    assert.deepEqual(
        tighter.perChapter.map((c) => [c.chapterNo, c.autoRuns, c.manualPlays]),
        [
            [3, 0, 268],
            [4, 297, 992],
            [5, 198, 992],
        ],
    );
    assert.equal(tighter.feasibility, "hard");

    // Auto 歌 182 秒（每次 212 秒 = 0.058889 小时）：第 4、5 章休息 13.611 小时 = 231 次
    // W1 第 4 章 99；W2 第 4 章 99；W3 第 4 章休息余 33 → 33，余 66 次进第 5 章休息；W4 第 5 章 99；
    // W5 第 5 章休息余 66 → 66，余 33 次按重叠时长也给第 5 章 → 各章 Auto 0 / 231 / 264，共 495 次 = 495 万
    // 手动上限：第 4 章 min(34.389, 48 − 13.603) = 34.389；第 5 章 min(34.389, 48 − 15.547 = 32.453) = 32.453
    // 目标 7,100 万：手动 6,605 万，统一 H = 17.28 小时/天 → 第 4、5 章封顶 992 把 = 2,976 万、32.453 小时 = 2,808.46 万
    // 第 3 章 820.54 万 = 9.4817 小时 → 取整 273 把，补 1 把 → 274 把；第 4、5 章取整 992 / 936 把
    // 第 5 章 32.448 / min(48, 32.453, 34.389) = 0.9998；少放 Auto 最多降到约 0.95，仍是吃力 → 保留 264 次 → 吃力
    // （旧分配 W3 把 99 次给休息多的第 5 章，第 5 章 297 次超出休息，只能减到 282 次，判时间不够）
    const longAuto = { ...envy, autoSongSeconds: 182 };
    const r182 = planGoal({
        now,
        tzOffsetMinutes: JP_TZ,
        endAt: now + 106 * HOUR,
        currentScore: 0,
        targetScore: 71_000_000,
        pt: longAuto,
        chapters: wlChapters(now, [
            [3, 25, -38, 10, longAuto],
            [4, 19, 10, 58, longAuto],
            [5, 7, 58, 106, longAuto],
        ]),
        dailyManualHours: 24,
        dailyAutoRuns: 99,
        autoDailyLimit: 99,
        gauge: SET2_WL,
    });
    assert.deepEqual(
        r182.perChapter.map((c) => [c.chapterNo, c.autoRuns, c.manualPlays]),
        [
            [3, 0, 274],
            [4, 231, 992],
            [5, 264, 936],
        ],
    );
    assert.equal(r182.feasibility, "hard");
});

test("WL 总榜（#214 形状，00:00 JST）：Auto 歌 150 秒时先填快结束一章的休息，最后一章的 Auto 不超出休息", () => {
    // now = 08-23 00:00 JST；第 3 章剩 20 小时，第 4、5 章各 48 小时；Auto 150 秒歌（每次 180 秒 = 0.05 小时），每日 99 次
    // 疲劳槽：第 3 章 20 小时容量 496 把 = 17.195 小时，休息 2.805 小时 = 56 次；第 4、5 章 992 把 = 34.389 小时，休息 13.611 = 272 次
    // JST 重置窗口：W1 4 小时（第 3 章）；W2 第 3 章 16 / 第 4 章 8；W3 第 4 章 24；W4 第 4 章 16 / 第 5 章 8；W5 第 5 章 24；W6 第 5 章 16
    // W1：第 3 章休息 56 + 按重叠 24 = 80 次（4 小时正好放 80 次）；W2：第 3 章休息已用完，99 次进第 4 章；W3：第 4 章 99（共 198）
    // W4：先结束的第 4 章休息余 74 → 74，余 25 次进第 5 章；W5、W6：第 5 章各 99 → 各章 80 / 272 / 223
    // （旧分配 W4 给休息多的第 5 章 99 次 → 80 / 198 / 297，第 5 章 297 × 0.05 = 14.85 > 13.611，空余只剩 33.15 小时）
    const now = Date.UTC(2026, 7, 22, 15, 0, 0);
    const envy = pt({
        manualPtPerPlay: 30_000,
        manualFire: 3,
        playsPerHour: 3600 / 124.8,
        songSeconds: 74.8,
        autoPtPerPlay: 10_000,
        autoSongSeconds: 150,
    });
    const r = planGoal({
        now,
        tzOffsetMinutes: JP_TZ,
        endAt: now + 116 * HOUR,
        currentScore: 0,
        targetScore: 69_000_000,
        pt: envy,
        chapters: wlChapters(now, [
            [3, 25, -28, 20, envy],
            [4, 19, 20, 68, envy],
            [5, 7, 68, 116, envy],
        ]),
        dailyManualHours: 24,
        dailyAutoRuns: 99,
        autoDailyLimit: 99,
        gauge: SET2_WL,
    });
    // 手动 6,325 万；Σ(天数 × 865,384.6) = 4.8333 × 865,384.6 → H = 15.1218 小时/天，各章 12.602 / 30.244 / 30.244 小时，都不封顶
    // 取整 363 / 872 / 872 把，差 40,000 → 补第 3 章 1 把、第 4 章 1 把 → 364 / 873 / 872
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.autoRuns, c.manualPlays, c.pt]),
        [
            [3, 80, 364, 11_720_000],
            [4, 272, 873, 28_910_000],
            [5, 223, 872, 28_390_000],
        ],
    );
    assert.equal(r.autoRuns, 575);
    // 第 3 章 12.619 / min(20, 16, 17.195) = 0.789；第 4 章 30.264 / min(48, 34.4, 34.389) = 0.880；
    // 第 5 章 30.229 / min(48, 36.85, 34.389) = 0.879 → 可达成（旧分配第 5 章 30.229 / 33.15 = 0.912 → 吃力）
    approx(r.perChapter[2].manualHours, 872 * PLAY_H);
    assert.equal(r.feasibility, "achievable");
});

// ---------------------------------------------------------------------------
// R1-10：Auto 次数取最好判定档里最多的次数；R8r3-01：剩余不足一天时每日可用小时按一整天算
// ---------------------------------------------------------------------------

test("最后 3 小时、PRECIOUS 99 次：少放 Auto 能落到轻松时不按放得下的最多次数判吃力，目标调高判定不变轻松", () => {
    // 手动 17,010 PT/把、124.8 秒一把；Auto 4,560 PT、150 秒歌（每次 0.05 小时）；每日 20 小时，剩 3 小时（1 个重置窗口，最多 60 次）
    // 缺口 325,000：x 次 Auto 的比例 = ceil((325,000 − 4,560x) / 17,010) × 0.034667 / (3 − 0.05x)
    //   x = 0 → 20 把 0.6933 / 3 = 0.231 轻松；x = 54 → 5 把 0.1733 / 0.3 = 0.578 轻松；x = 55 → 5 把 / 0.25 = 0.693；
    //   x = 57 → 4 把 0.1387 / 0.15 = 0.924；x ≥ 58 放不下
    // → 轻松，Auto 54 次 + 手动 5 把（修复前 57 次 + 4 把判吃力）
    const endAt = Date.UTC(2026, 8, 20, 11, 59, 59);
    const plan = pt({
        manualPtPerPlay: 17_010,
        manualFire: 3,
        playsPerHour: 3600 / 124.8,
        songSeconds: 74.8,
        autoPtPerPlay: 4_560,
        autoSongSeconds: 150,
    });
    const at = (hoursLeft, targetScore) =>
        planGoal({
            now: endAt - hoursLeft * HOUR,
            tzOffsetMinutes: JP_TZ,
            endAt,
            currentScore: 0,
            targetScore,
            pt: plan,
            dailyManualHours: 20,
            dailyAutoRuns: 99,
            autoDailyLimit: 99,
            gauge: null,
        });
    const r = at(3, 325_000);
    assert.equal(r.autoRuns, 54);
    assert.equal(r.manualPlays, 5);
    assert.equal(r.feasibility, "comfortable");
    // 缺口 330,000：x = 54 → ceil(4.924) = 5 把，同样 0.578 → 轻松（修复前 56 次 + 5 把判可达成，比 325,000 还轻）
    const bigger = at(3, 330_000);
    assert.deepEqual([bigger.autoRuns, bigger.manualPlays, bigger.feasibility], [54, 5, "comfortable"]);

    const order = ["comfortable", "achievable", "hard", "impossible"];
    for (const hoursLeft of [0.5, 1, 2, 3]) {
        let prev = 0;
        for (let target = 5_000; target <= 17_010 * 28.846 * hoursLeft * 1.05; target += 5_000) {
            const band = order.indexOf(at(hoursLeft, target).feasibility);
            assert.ok(band >= prev, `剩 ${hoursLeft} 小时，目标 ${target} 比上一档更轻松`);
            prev = band;
        }
    }
});

test("剩余 8 小时、每日 6 小时：需手动 3.02 小时按总量和 6 小时比较，不按 8/24 天折成 2 小时", () => {
    // JP #218 形状（直接填写）：手动 40,000 PT/把、28.8 把/时；Auto 20,000 PT（缺省 120 秒歌），每日 10 次
    // 剩 8 小时（JST 12:00 → 20:00，1 个重置窗口）：Auto 10 次 = 200,000；手动 ceil(3,460,000 / 40,000) = 87 把 = 3.0208 小时
    // 空余 8 − 10 × 150 / 3600 = 7.583 小时；少放 Auto 只会多打手动 → 保留 10 次
    // 每日 6：3.0208 / min(6, 7.583) = 0.503 → 轻松（修复前 3.0208 / (6 × 8/24 = 2) = 1.51 → 时间不够）
    const endAt = Date.UTC(2026, 8, 28, 11, 0, 0);
    const base = {
        now: endAt - 8 * HOUR,
        tzOffsetMinutes: JP_TZ,
        endAt,
        currentScore: 30_000_000,
        targetScore: 33_660_000,
        pt: pt({ manualPtPerPlay: 40_000, manualFire: 3, playsPerHour: 28.8, songSeconds: undefined, autoPtPerPlay: 20_000 }),
        dailyManualHours: 6,
        dailyAutoRuns: 10,
        autoDailyLimit: 10,
        gauge: null,
    };
    const r = planGoal(base);
    assert.equal(r.autoRuns, 10);
    assert.equal(r.manualPlays, 87);
    approx(r.manualHoursTotal, 87 / 28.8);
    // 每日口径的显示值不变：3.0208 ÷ (8/24) = 9.0625 小时/天
    approx(r.manualHoursPerDay, (87 / 28.8) * 3);
    assert.equal(r.feasibility, "comfortable");
    // 每日 3.5：0.863 → 可达成；每日 3：1.007 → 时间不够
    assert.equal(planGoal({ ...base, dailyManualHours: 3.5 }).feasibility, "achievable");
    assert.equal(planGoal({ ...base, dailyManualHours: 3 }).feasibility, "impossible");
    // 剩 24 小时及以上仍按天折算：剩 30 小时跨 1 次 04:00，Auto 20 次 = 400,000，手动 ceil(81.5) = 82 把 = 2.847 小时
    // 每日 2.5 小时 → 2.847 / (2.5 × 1.25) = 0.911 → 吃力
    const longer = planGoal({ ...base, now: endAt - 30 * HOUR, dailyManualHours: 2.5 });
    assert.deepEqual([longer.autoRuns, longer.manualPlays, longer.feasibility], [20, 82, "hard"]);
});

// ---------------------------------------------------------------------------
// R1-12：裁 Auto 后各章 PT 合计不低于差距；R1-13：只裁到总判定需要的程度；R1-14：补整把避开剩几分钟的章节
// ---------------------------------------------------------------------------

// CN #179 各章（2026-09-06 12:00Z 起每章 48 小时），结算为下一章开始前 1 秒
const CN179_START = Date.UTC(2026, 8, 6, 12, 0, 0);
function cn179Chapters(now, chapterPt) {
    const out = [];
    for (let i = 0; i < 6; i++) {
        const startAt = CN179_START + i * 48 * HOUR;
        const endAt = startAt + 48 * HOUR - 1000;
        if (endAt > now) {
            out.push({ window: { chapterNo: i + 1, gameCharacterId: 20 + i, startAt: Math.max(startAt, now), endAt }, pt: chapterPt });
        }
    }
    return out;
}
const CN179_END = CN179_START + 6 * 48 * HOUR - 1000;
const ENVY_AUTO = pt({
    mode: "manual",
    manualPtPerPlay: 30_000,
    manualFire: 3,
    playsPerHour: 3600 / 124.8,
    songSeconds: 74.8,
    autoPtPerPlay: 10_000,
    autoSongSeconds: 150.7,
});
function cn179Input(nowIso, targetScore) {
    const now = Date.parse(nowIso);
    return {
        now,
        tzOffsetMinutes: CN_TZ,
        endAt: CN179_END,
        currentScore: 0,
        targetScore,
        pt: ENVY_AUTO,
        chapters: cn179Chapters(now, ENVY_AUTO),
        dailyManualHours: 20,
        dailyAutoRuns: 99,
        autoDailyLimit: 99,
        gauge: null,
    };
}
const chapterPtSum = (r) => r.perChapter.reduce((sum, c) => sum + c.pt, 0);

test("WL 总榜（CN #179 形状）：第 1 章裁 Auto 后按连续份额重算手动，再补整把，各章 PT 合计仍够差距", () => {
    // 第 1 章 297 → 191 次 Auto；修复前按连续份额 594.46 + 106/3 取整为 630 把，丢了先前补给它的 1 把，
    // 合计 123,740,000，比差距少 10,000 却判轻松；现在再补 1 把给第 3 章
    const r = planGoal(cn179Input("2026-09-06T14:00:00Z", 123_750_000));
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.autoRuns, c.manualPlays]),
        [
            [1, 191, 630],
            [2, 198, 621],
            [3, 198, 621],
            [4, 198, 620],
            [5, 198, 620],
            [6, 198, 620],
        ],
    );
    assert.equal(chapterPtSum(r), 123_770_000);
    assert.ok(chapterPtSum(r) >= r.gap);
    assert.equal(r.feasibility, "comfortable");
});

test("WL 总榜（CN #179 形状）：总判定由只剩 1 小时的第 1 章决定时，其他章保留全部 Auto", () => {
    // 09-08 11:00Z：第 1 章剩约 1 小时，22 把 = 0.763 小时；后面还有章节，每日额度按 1/24 天 × 20 = 0.833 小时
    // → 0.763 / min(0.833, 1) = 0.915 → 吃力
    // 其他章的最好档是可达成，但总判定已是吃力，所以不为了本章变可达成而少放 Auto：第 2 章 297、第 3–6 章各 198
    // （修复前第 2 章裁到 198、第 3–6 章裁到 163，多打约 2.84 小时手动，判定同样是吃力）
    const r = planGoal(cn179Input("2026-09-08T11:00:00Z", 162_675_000));
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.autoRuns, c.manualPlays]),
        [
            [1, 0, 22],
            [2, 297, 954],
            [3, 198, 1021],
            [4, 198, 1021],
            [5, 198, 1021],
            [6, 198, 1021],
        ],
    );
    assert.ok(chapterPtSum(r) >= r.gap);
    assert.equal(r.feasibility, "hard");
    // Auto 实际用时：297 + 4 × 198 = 1,089 次 × (150.7 + 30) 秒
    assert.equal(r.autoRuns, 1089);
    approx(r.autoHoursTotal, (1089 * 180.7) / 3600, 1e-9);
});

test("WL 总榜：补整把时一把放不下的章节（剩 4 分钟）让给下一章，判定不因取整变难", () => {
    // 第 1 章剩 4 分钟（1/15 小时），第 2 章 48 小时；每把 1,000 PT、每小时 20 把，无 Auto、无疲劳槽，每日 24 小时
    // 统一每日 H = 500,000 / ((1/360 + 2) × 20,000) = 12.4827 小时 → 第 1 章 0.6935 把、第 2 章 499.3065 把，取整 0 / 499
    // 差 1 把：修复前给小数部分大的第 1 章 → 0.05 / min(24 × 1/24, 1/15) = 0.75 → 可达成
    // 现在比较多打 1 把后的档：第 1 章可达成、第 2 章 25 / 48 = 0.521 轻松 → 给第 2 章 → 0 / 500 把，轻松
    const p = pt({ manualPtPerPlay: 1000, manualFire: 2, playsPerHour: 20 });
    const r = planGoal({
        now: WL_NOW,
        tzOffsetMinutes: JP_TZ,
        endAt: WL_NOW + (48 + 1 / 15) * HOUR,
        currentScore: 0,
        targetScore: 500_000,
        pt: p,
        chapters: wlChapters(WL_NOW, [
            [1, 21, -44, 1 / 15, p],
            [2, 22, 1 / 15, 48 + 1 / 15, p],
        ]),
        dailyManualHours: 24,
        dailyAutoRuns: 0,
        autoDailyLimit: 10,
        gauge: null,
    });
    assert.deepEqual(
        r.perChapter.map((c) => [c.chapterNo, c.manualPlays]),
        [
            [1, 0],
            [2, 500],
        ],
    );
    assert.equal(r.feasibility, "comfortable");
});

test("autoHoursTotal：单期为 Auto 次数 × (Auto 歌长 + 30 秒)", () => {
    // 48 小时、JST 12:00 起跨 2 次 04:00 → 3 个重置窗口 × 10 次 = 30 次，每次 180 秒 → 1.5 小时
    const r = planGoal(input({ pt: pt({ autoPtPerPlay: 500, autoSongSeconds: 150 }) }));
    assert.equal(r.autoRuns, 30);
    approx(r.autoHoursTotal, 1.5);
    // 缺省歌长 120 秒：每次 150 秒
    const d = planGoal(input({ pt: pt({ autoPtPerPlay: 500 }) }));
    approx(d.autoHoursTotal, (d.autoRuns * 150) / 3600);
});
