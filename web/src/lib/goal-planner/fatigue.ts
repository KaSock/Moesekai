// Break gauge (event rest system) per note_375 (v6.3.5) and masterdata eventBreakTimes.
import type { BreakGaugeRule } from "../event-rules/types";
import type { GaugeSimInput, GaugeSimResult } from "./types";

const DAY_SEC = 86_400;
const EPS = 1e-9;
const MAX_HOURS_PER_DAY = 24;

export type GaugePlayKind = "manual" | "auto" | "challenge";

/** Mutable gauge state; times are seconds on the caller's clock. */
export interface GaugeState {
    point: number;
    /** End of the last play that raised the gauge. */
    lastRaiseEndSec: number;
    /** Rest has been counted up to this time. */
    restCountedToSec: number;
    /** Counted rest not yet turned into a decrease. */
    restBankSec: number;
}

/**
 * Fresh gauge at `atSec` (event start or WL chapter start; masterdata initialPoint is 0).
 * Rest is first counted restStartMinutes after `atSec`, as if a play had just ended.
 */
export function createGaugeState(atSec = 0): GaugeState {
    return { point: 0, lastRaiseEndSec: atSec, restCountedToSec: atSec, restBankSec: 0 };
}

/**
 * Lets time pass up to `toSec` without a gauge-raising play.
 * Rest counts only after restStartMinutes since the last raising play (the waiting minutes themselves are not rest),
 * and is cumulative across breaks: every restStepMinutes of banked rest lowers the gauge by restStepDecrease, floor 0.
 */
export function advanceGauge(state: GaugeState, gauge: BreakGaugeRule, toSec: number): void {
    const from = Math.max(state.restCountedToSec, state.lastRaiseEndSec + gauge.restStartMinutes * 60);
    if (!(toSec > from)) return;
    state.restCountedToSec = toSec;
    const stepSec = gauge.restStepMinutes * 60;
    if (!(stepSec > 0)) return;
    state.restBankSec += toSec - from;
    const steps = Math.floor(state.restBankSec / stepSec + EPS);
    if (steps <= 0) return;
    state.restBankSec = Math.max(0, state.restBankSec - steps * stepSec);
    state.point = Math.max(0, state.point - steps * gauge.restStepDecrease);
}

/**
 * Records one play starting at `startSec` and returns whether it earns event points.
 * Manual plays (solo, multi, cheerful) add (songSeconds + fixedSecondsPerPlay) x gainPerSecond, capped at max.
 * note_375 blocks points only in the full state, so a play started below max earns even if it crosses max.
 * A manual play started at max earns nothing and counts as rest: the rest clock keeps running through it.
 * Auto and challenge lives never raise the gauge, earn even at max and count as rest.
 */
export function recordPlay(
    state: GaugeState,
    gauge: BreakGaugeRule,
    kind: GaugePlayKind,
    startSec: number,
    songSeconds: number,
): boolean {
    advanceGauge(state, gauge, startSec);
    if (kind !== "manual") return true;
    if (state.point >= gauge.max) return false;
    state.point = Math.min(gauge.max, state.point + (songSeconds + gauge.fixedSecondsPerPlay) * gauge.gainPerSecond);
    state.lastRaiseEndSec = startSec + songSeconds;
    return true;
}

interface ScheduleRun {
    earned: number;
    lost: number;
}

/**
 * Daily schedule from an empty gauge at the window start: the plays that fit in the first `hoursPerDay` hours of
 * each day, one every 3600 / playsPerHour seconds, then rest (or Auto, which is rest too) until the next day.
 * Days are counted from the window start and the last day is clipped at the window end.
 */
function runSchedule(
    gauge: BreakGaugeRule,
    windowSec: number,
    songSeconds: number,
    playsPerHour: number,
    hoursPerDay: number,
    stopAtFirstLoss: boolean,
): ScheduleRun {
    const run: ScheduleRun = { earned: 0, lost: 0 };
    if (!(playsPerHour > 0) || !(windowSec > 0)) return run;
    const state = createGaugeState(0);
    const cycleSec = 3600 / playsPerHour;
    const blockSec = Math.min(Math.max(hoursPerDay, 0), MAX_HOURS_PER_DAY) * 3600;
    for (let day = 0; day < windowSec; day += DAY_SEC) {
        const plays = Math.floor(Math.min(blockSec, windowSec - day) / cycleSec + EPS);
        for (let k = 0; k < plays; k++) {
            if (recordPlay(state, gauge, "manual", day + k * cycleSec, songSeconds)) {
                run.earned++;
            } else {
                run.lost++;
                if (stopAtFirstLoss) return run;
            }
        }
    }
    return run;
}

function fullRecoveryHours(gauge: BreakGaugeRule): number {
    return (gauge.restStartMinutes + Math.ceil(gauge.max / gauge.restStepDecrease) * gauge.restStepMinutes) / 60;
}

function toResult(run: ScheduleRun, gauge: BreakGaugeRule, playsPerHour: number, windowHours: number): GaugeSimResult {
    const effectiveManualHours = playsPerHour > 0 ? run.earned / playsPerHour : 0;
    return {
        effectiveManualHours,
        effectiveManualHoursPerDay: effectiveManualHours / Math.max(Math.max(windowHours, 0) / 24, 1 / 24),
        // True when a planned manual play started at a full gauge and earned nothing.
        hitsCap: run.lost > 0,
        fullRecoveryHours: fullRecoveryHours(gauge),
    };
}

/**
 * Simulates one window from an empty gauge. A WL chapter start resets the gauge (note_375), so with
 * resetPerWlChapter each chapter is its own window; an extended end keeps the gauge, so a window runs on
 * up to its (extended) aggregation time. The player's gauge at a mid-window start is unknown and taken as empty.
 */
export function simulateGauge(input: GaugeSimInput): GaugeSimResult {
    const { gauge, songSeconds, playsPerHour, windowHours, plannedManualHoursPerDay } = input;
    const windowSec = Math.max(windowHours, 0) * 3600;
    const run = runSchedule(gauge, windowSec, songSeconds, playsPerHour, plannedManualHoursPerDay, false);
    return toResult(run, gauge, playsPerHour, windowHours);
}

/** Largest manual hours per day (0.1 h steps, at most 24) whose daily schedule loses no play over the window. */
export function gaugeCapHoursPerDay(
    gauge: BreakGaugeRule,
    songSeconds: number,
    playsPerHour: number,
    windowHours: number,
): number {
    if (!(playsPerHour > 0) || !(windowHours > 0)) return MAX_HOURS_PER_DAY;
    const windowSec = windowHours * 3600;
    for (let tenths = MAX_HOURS_PER_DAY * 10; tenths > 0; tenths--) {
        const run = runSchedule(gauge, windowSec, songSeconds, playsPerHour, tenths / 10, true);
        if (run.lost === 0) return tenths / 10;
    }
    return 0;
}
