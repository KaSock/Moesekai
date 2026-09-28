// Types for the ranking-goal planner maths. Relative `import type` only.
import type { BreakGaugeRule } from "../event-rules/types";

/** Unified output of the PT source panel (deck engine / manual parameters / direct entry). */
export interface PtPlan {
    mode: "deck" | "manual" | "direct";
    /** Manual PT per play, fire multiplier included. */
    manualPtPerPlay: number;
    manualFire: number;
    playsPerHour: number;
    /** Song length in seconds for the break-gauge simulation; direct entry may omit it (120 s is assumed). */
    songSeconds?: number;
    /** Auto PT per play, fire multiplier included; 0 when not playing Auto. */
    autoPtPerPlay: number;
    /** Auto song length in seconds; omitted means 120 s is assumed. */
    autoSongSeconds?: number;
    autoFire: number;
    /** Lower-bound estimate under the Auto special measure. */
    autoIsLowerBound: boolean;
    songLabel?: string;
}

export interface TierPoint {
    rank: number;
    score: number;
}

export interface RankEstimate {
    /** Estimated rank; null outside the known tiers. */
    rank: number | null;
    /** Best tier (smallest rank) whose score is <= the input, for highlighting; null below every tier. */
    reachedTier: number | null;
    outside: "above" | "below" | null;
}

export interface ChapterWindow {
    chapterNo: number;
    gameCharacterId: number | null;
    startAt: number;
    endAt: number;
}

export interface PlannerInput {
    now: number;
    /** Region time-zone offset from UTC in minutes (JP 540, CN 480); Auto counts reset at local 04:00. */
    tzOffsetMinutes: number;
    /** Aggregation time of the selected scope. */
    endAt: number;
    currentScore: number;
    targetScore: number;
    /** Single PT plan; WL overall per-chapter plans use perChapterPt. */
    pt: PtPlan;
    /** WL overall: remaining chapters (current included) with their windows and PT; summed chapter by chapter when non-empty. */
    chapters?: ReadonlyArray<{ window: ChapterWindow; pt: PtPlan }>;
    dailyManualHours: number;
    dailyAutoRuns: number;
    autoDailyLimit: number;
    /** Break gauge after overrides; null means no gauge limit. */
    gauge: BreakGaugeRule | null;
}

export type Feasibility = "comfortable" | "achievable" | "hard" | "impossible";

export interface ChapterPlan {
    chapterNo: number;
    gameCharacterId: number | null;
    remainingHours: number;
    manualHours: number;
    manualPlays: number;
    autoRuns: number;
    pt: number;
    /** Effective manual hours this chapter allows under the break gauge; null without a gauge. */
    gaugeCapHours: number | null;
}

export interface PlannerResult {
    gap: number;
    remainingHours: number;
    remainingDays: number;
    autoRuns: number;
    autoTotalPt: number;
    /** Real time the Auto runs take (song plus gap per run); Auto shares real time with manual play. */
    autoHoursTotal: number;
    manualPlays: number;
    manualHoursTotal: number;
    /** = manualHoursTotal / remainingDays. */
    manualHoursPerDay: number;
    /** Manual hours the verdict allows: daily hours (at least one day's worth) capped by time left after Auto and by the gauge. */
    manualLimitHours: number;
    stamina: number;
    bigDrinks: number;
    crystals: number;
    /** Stamina recovered naturally during the remaining time. */
    naturalStamina: number;
    /** Effective manual hours per day under the break gauge; null without a gauge. */
    gaugeCapHoursPerDay: number | null;
    feasibility: Feasibility;
    perChapter: ChapterPlan[];
}

export interface SongOption {
    key: string;
    label: string;
    pt: PtPlan;
}

export interface SongComparison {
    base: SongOption;
    bestPerStamina: SongOption | null;
    bestPerHour: SongOption | null;
    /** Switching to the best PT-per-stamina song: stamina saved (positive = saved) and extra manual hours. */
    perStaminaDelta: { staminaSaved: number; hoursPerDayMore: number; hoursTotalMore: number } | null;
    /** Switching to the best PT-per-hour song: hours saved and extra stamina used. */
    perHourDelta: { hoursPerDaySaved: number; hoursTotalSaved: number; staminaMore: number } | null;
}

export interface GaugeSimInput {
    gauge: BreakGaugeRule;
    songSeconds: number;
    playsPerHour: number;
    /** Simulation window in hours; for WL the remaining length of the chapter. */
    windowHours: number;
    /** Planned continuous manual hours per day (the rest is rest / Auto). */
    plannedManualHoursPerDay: number;
}

export interface GaugeSimResult {
    /** Manual hours in the window that still earn points. */
    effectiveManualHours: number;
    effectiveManualHoursPerDay: number;
    /** Whether the plan hits a full gauge. */
    hitsCap: boolean;
    /** Rest hours needed to drain a full gauge to 0. */
    fullRecoveryHours: number;
}
