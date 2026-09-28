// Ranking-goal planner maths (contract section 2). Pure functions, relative imports only.
import type { BreakGaugeRule } from "../event-rules/types";
import type {
    ChapterPlan,
    ChapterWindow,
    Feasibility,
    PlannerInput,
    PlannerResult,
    PtPlan,
    RankEstimate,
    SongComparison,
    SongOption,
    TierPoint,
} from "./types";
import { gaugeCapHoursPerDay, simulateGauge } from "./fatigue.ts";

/** Event-point multiplier by fire (live bonus) count 0-10; official v4.0.0 table, same in JP and CN. */
export const FIRE_MULTIPLIERS: readonly number[] = [1, 5, 10, 15, 20, 25, 27, 29, 31, 33, 35];

export function fireMultiplier(fire: number): number {
    return FIRE_MULTIPLIERS[Math.min(10, Math.max(0, Math.round(fire)))];
}

export const STAMINA_PER_BIG_DRINK = 10;
export const CRYSTALS_PER_STAMINA = 10;
export const NATURAL_STAMINA_PER_HOUR = 2;
export const DEFAULT_GAP_SECONDS: Readonly<Record<"multi" | "solo" | "cheerful" | "auto", number>> = {
    multi: 50,
    solo: 30,
    cheerful: 50,
    auto: 30,
};

/** Assumed song length when a PT plan omits it (see PtPlan.songSeconds and PtPlan.autoSongSeconds). */
const FALLBACK_SONG_SECONDS = 120;
const FULL_DAY_HOURS = 24;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RESET_OFFSET_MS = 4 * HOUR_MS;
const EPS = 1e-9;

export function playsPerHour(songSeconds: number, gapSeconds: number): number {
    const seconds = songSeconds + gapSeconds;
    return seconds > 0 ? 3600 / seconds : 0;
}

export function estimateRank(score: number, tiers: TierPoint[]): RankEstimate {
    const sorted = tiers
        .filter((t) => t.rank >= 1 && Number.isFinite(t.score))
        .sort((a, b) => a.rank - b.rank);
    if (sorted.length === 0) return { rank: null, reachedTier: null, outside: null };

    // Running minimum makes scores non-increasing in rank, discarding noisy inversions.
    const clean: TierPoint[] = [];
    let min = Infinity;
    for (const t of sorted) {
        min = Math.min(min, t.score);
        clean.push({ rank: t.rank, score: min });
    }

    const j = clean.findIndex((t) => t.score <= score);
    if (j === -1) return { rank: null, reachedTier: null, outside: "below" };
    const reachedTier = clean[j].rank;
    if (j === 0) {
        return clean[0].rank === 1
            ? { rank: 1, reachedTier, outside: null }
            : { rank: null, reachedTier, outside: "above" };
    }

    const hi = clean[j - 1];
    const lo = clean[j];
    const f = (hi.score - score) / (hi.score - lo.score);
    const logRank = Math.log(hi.rank) + f * (Math.log(lo.rank) - Math.log(hi.rank));
    return { rank: Math.round(Math.exp(logRank)), reachedTier, outside: null };
}

/** Index of the local 04:00-to-04:00 Auto reset window that contains `t`. */
function resetWindowIndex(t: number, tzOffsetMinutes: number): number {
    return Math.floor((t + tzOffsetMinutes * 60_000 - RESET_OFFSET_MS) / DAY_MS);
}

function resetWindowStart(index: number, tzOffsetMinutes: number): number {
    return index * DAY_MS + RESET_OFFSET_MS - tzOffsetMinutes * 60_000;
}

/** Reset windows overlapping [from, to), clipped to it; each gives a daily Auto budget capped by its clipped length. */
function resetWindows(from: number, to: number, tzOffsetMinutes: number): Array<{ start: number; end: number }> {
    if (to <= from) return [];
    const first = resetWindowIndex(from, tzOffsetMinutes);
    const last = resetWindowIndex(to - 1, tzOffsetMinutes);
    const out: Array<{ start: number; end: number }> = [];
    for (let k = first; k <= last; k++) {
        out.push({
            start: Math.max(from, resetWindowStart(k, tzOffsetMinutes)),
            end: Math.min(to, resetWindowStart(k + 1, tzOffsetMinutes)),
        });
    }
    return out;
}

function playsFor(needPt: number, ptPerPlay: number): number {
    if (needPt <= 0) return 0;
    // EPS absorbs float noise from PT shares computed as hours x PT per hour.
    return ptPerPlay > 0 ? Math.max(0, Math.ceil(needPt / ptPerPlay - EPS)) : Infinity;
}

function hoursFor(plays: number, perHour: number): number {
    if (plays === 0) return 0;
    return perHour > 0 ? plays / perHour : Infinity;
}

/** Real time one Auto live takes; Auto plays in real time and cannot overlap a manual live. */
function autoRunHours(pt: PtPlan): number {
    return ((pt.autoSongSeconds ?? FALLBACK_SONG_SECONDS) + DEFAULT_GAP_SECONDS.auto) / 3600;
}

/** Auto runs of `runHours` each that fit in `hours` of real time, at most `budget`. */
function autoRunsFitting(budget: number, hours: number, runHours: number): number {
    return Math.max(0, Math.min(budget, Math.floor(hours / runHours + EPS)));
}

const BANDS: readonly Feasibility[] = ["comfortable", "achievable", "hard", "impossible"];

function bandOf(ratio: number): number {
    return BANDS.indexOf(classify(ratio));
}

/**
 * Auto runs among 0..autoFirst: Auto first, dropping runs only where that reaches a better feasibility band (manual
 * earns more per hour and time is short), keeping the most runs within the best band. If every count is impossible,
 * the most runs whose manual and Auto time fit in `hours` (they share real time), else Auto-first.
 */
function pickAutoRuns(
    autoFirst: number,
    ratioAt: (runs: number) => number,
    busyHoursAt: (runs: number) => number,
    hours: number,
): number {
    let best = autoFirst;
    let bestBand = bandOf(ratioAt(autoFirst));
    for (let runs = autoFirst - 1; runs >= 0 && bestBand > 0; runs--) {
        const band = bandOf(ratioAt(runs));
        if (band < bestBand) {
            best = runs;
            bestBand = band;
        }
    }
    if (bestBand < BANDS.length - 1) return best;
    for (let runs = autoFirst; runs >= 0; runs--) {
        if (busyHoursAt(runs) <= hours + EPS) return runs;
    }
    return autoFirst;
}

function staminaFor(plays: number, fire: number): number {
    return plays > 0 && fire > 0 ? plays * fire : 0;
}

function songSecondsOf(pt: PtPlan): number {
    return pt.songSeconds ?? FALLBACK_SONG_SECONDS;
}

function classify(ratio: number): Feasibility {
    if (!(ratio > 0)) return "comfortable";
    if (ratio <= 0.6 + EPS) return "comfortable";
    if (ratio <= 0.9 + EPS) return "achievable";
    if (ratio <= 1 + EPS) return "hard";
    return "impossible";
}

function perDayOf(hours: number, days: number): number {
    return hours / Math.max(days, 1 / 24);
}

/**
 * Manual hours that earn points in the first `windowHours` of a gauge window when playing `capPerDay` hours a day
 * from its start. With the fatigue.ts cap no play is lost, so this is the window's gauge capacity; it counts each
 * day's real length, so windows that are not whole days are neither scaled up nor pro-rated.
 */
function gaugeHours(gauge: BreakGaugeRule, pt: PtPlan, capPerDay: number, windowHours: number): number {
    if (!(windowHours > 0)) return 0;
    return simulateGauge({
        gauge,
        songSeconds: songSecondsOf(pt),
        playsPerHour: pt.playsPerHour,
        windowHours,
        plannedManualHoursPerDay: capPerDay,
    }).effectiveManualHours;
}

function capPerDayFor(gauge: BreakGaugeRule, pt: PtPlan, windowHours: number): number {
    return gaugeCapHoursPerDay(gauge, songSecondsOf(pt), pt.playsPerHour, windowHours);
}

/** Manual hours a window allows: min(daily hours x budgetDays, time left free of Auto, gauge capacity). */
function manualLimit(budgetDays: number, dailyManualHours: number, freeHours: number, capacityHours: number | null): number {
    const limit = Math.min(dailyManualHours * budgetDays, Math.max(0, freeHours));
    return capacityHours !== null ? Math.min(limit, capacityHours) : limit;
}

/**
 * Manual hours over the window's manualLimit, all totals over the window.
 * For days >= 1 this equals manualHoursPerDay over the same limits on the per-day scale.
 */
function loadRatio(
    hours: number,
    budgetDays: number,
    dailyManualHours: number,
    freeHours: number,
    capacityHours: number | null,
): number {
    if (!(hours > 0)) return 0;
    return hours / manualLimit(budgetDays, dailyManualHours, freeHours, capacityHours);
}

/**
 * Days of the daily-hours budget a window gets. A window that runs to the end of the scope gets at least one full day
 * (with under a day left the verdict compares totals, as the results headline does); a WL chapter followed by another
 * shares its last day with that chapter and keeps the pro-rated share.
 */
function budgetDaysOf(days: number, endsScope: boolean): number {
    return endsScope ? Math.max(days, 1) : Math.max(days, 1 / 24);
}

/** The gauge limits a window only if playing all of it would lose a play; otherwise it allows the full day. */
function gaugeBinds(capPerDay: number): boolean {
    return capPerDay < FULL_DAY_HOURS - EPS;
}

interface Totals {
    gap: number;
    remainingHours: number;
    remainingDays: number;
    autoRuns: number;
    autoTotalPt: number;
    autoHoursTotal: number;
    manualPlays: number;
    manualHoursTotal: number;
    manualLimitHours: number;
    stamina: number;
    gaugeCapHoursPerDay: number | null;
    feasibility: Feasibility;
    perChapter: ChapterPlan[];
}

function finish(t: Totals): PlannerResult {
    return {
        gap: t.gap,
        remainingHours: t.remainingHours,
        remainingDays: t.remainingDays,
        autoRuns: t.autoRuns,
        autoTotalPt: t.autoTotalPt,
        autoHoursTotal: t.autoHoursTotal,
        manualPlays: t.manualPlays,
        manualHoursTotal: t.manualHoursTotal,
        manualHoursPerDay: perDayOf(t.manualHoursTotal, t.remainingDays),
        manualLimitHours: t.manualLimitHours,
        stamina: t.stamina,
        bigDrinks: Math.ceil(t.stamina / STAMINA_PER_BIG_DRINK),
        crystals: t.stamina * CRYSTALS_PER_STAMINA,
        naturalStamina: Math.floor(t.remainingHours * NATURAL_STAMINA_PER_HOUR),
        gaugeCapHoursPerDay: t.gaugeCapHoursPerDay,
        feasibility: t.feasibility,
        perChapter: t.perChapter,
    };
}

export function planGoal(input: PlannerInput): PlannerResult {
    const gap = Math.max(0, input.targetScore - input.currentScore);
    const remainingHours = Math.max(0, (input.endAt - input.now) / HOUR_MS);
    const remainingDays = remainingHours / 24;
    const autoPerDay = Math.max(0, Math.floor(Math.min(input.dailyAutoRuns, input.autoDailyLimit)));
    const chapters = input.chapters ?? [];
    if (chapters.length > 0) {
        return planChapters(input, chapters, gap, remainingHours, remainingDays, autoPerDay);
    }

    const pt = input.pt;
    const runHours = autoRunHours(pt);
    const capacity = resetWindows(input.now, input.endAt, input.tzOffsetMinutes).reduce(
        (sum, w) => sum + autoRunsFitting(autoPerDay, (w.end - w.start) / HOUR_MS, runHours),
        0,
    );
    let gaugeCapacity: number | null = null;
    let gaugeCapPerDay: number | null = null;
    if (input.gauge && remainingHours > 0 && pt.playsPerHour > 0) {
        const cap = capPerDayFor(input.gauge, pt, remainingHours);
        gaugeCapacity = gaugeHours(input.gauge, pt, cap, remainingHours);
        gaugeCapPerDay = gaugeBinds(cap) ? perDayOf(gaugeCapacity, remainingDays) : FULL_DAY_HOURS;
    }
    const budgetDays = budgetDaysOf(remainingDays, true);
    const manualHoursAt = (runs: number) =>
        hoursFor(playsFor(gap - runs * pt.autoPtPerPlay, pt.manualPtPerPlay), pt.playsPerHour);
    const ratioAt = (runs: number) => {
        const freeHours = remainingHours - runs * runHours;
        return loadRatio(manualHoursAt(runs), budgetDays, input.dailyManualHours, freeHours, gaugeCapacity);
    };
    const autoFirst = pt.autoPtPerPlay > 0 ? Math.min(capacity, playsFor(gap, pt.autoPtPerPlay)) : 0;
    const autoRuns = pickAutoRuns(autoFirst, ratioAt, (runs) => manualHoursAt(runs) + runs * runHours, remainingHours);
    const autoTotalPt = autoRuns * pt.autoPtPerPlay;
    const manualPlays = playsFor(gap - autoTotalPt, pt.manualPtPerPlay);
    const manualHoursTotal = hoursFor(manualPlays, pt.playsPerHour);
    const manualStamina = manualPlays === Infinity ? Infinity : staminaFor(manualPlays, pt.manualFire);
    const ratio = ratioAt(autoRuns);
    return finish({
        gap,
        remainingHours,
        remainingDays,
        autoRuns,
        autoTotalPt,
        autoHoursTotal: autoRuns * runHours,
        manualPlays,
        manualHoursTotal,
        manualLimitHours: manualLimit(budgetDays, input.dailyManualHours, remainingHours - autoRuns * runHours, gaugeCapacity),
        stamina: manualStamina + autoRuns * pt.autoFire,
        gaugeCapHoursPerDay: gaugeCapPerDay,
        feasibility: gap === 0 ? "comfortable" : classify(ratio),
        perChapter: [],
    });
}

interface ChapterState {
    window: ChapterWindow;
    pt: PtPlan;
    start: number;
    end: number;
    hours: number;
    days: number;
    ptPerHour: number;
    /** No-loss manual hours this chapter allows under the gauge. */
    capHours: number | null;
    /** Whether the gauge limits this chapter at all (see gaugeBinds). */
    gaugeBinds: boolean;
    /** Real time of one Auto run with this chapter's PT plan. */
    autoRunHours: number;
    autoRuns: number;
    /** Manual hours the chapter can hold: its gauge capacity and the time its Auto runs leave free. */
    limitHours: number;
    /** Continuous manual hours before rounding to whole plays. */
    plannedHours: number;
    capped: boolean;
    plays: number;
}

function planChapters(
    input: PlannerInput,
    chapters: NonNullable<PlannerInput["chapters"]>,
    gap: number,
    remainingHours: number,
    remainingDays: number,
    autoPerDay: number,
): PlannerResult {
    const states: ChapterState[] = chapters.map(({ window, pt }) => {
        const start = Math.max(window.startAt, input.now);
        const end = Math.min(window.endAt, input.endAt);
        const hours = Math.max(0, (end - start) / HOUR_MS);
        const playable = pt.manualPtPerPlay > 0 && pt.playsPerHour > 0;
        let capHours: number | null = null;
        let binds = false;
        if (input.gauge && hours > 0 && pt.playsPerHour > 0) {
            if (input.gauge.resetPerWlChapter) {
                const cap = capPerDayFor(input.gauge, pt, hours);
                capHours = gaugeHours(input.gauge, pt, cap, hours);
                binds = gaugeBinds(cap);
            } else {
                // One gauge over the whole remaining time: the chapter keeps that schedule's plays inside its window.
                const cap = capPerDayFor(input.gauge, pt, remainingHours);
                const offset = (start - input.now) / HOUR_MS;
                capHours = gaugeHours(input.gauge, pt, cap, offset + hours) - gaugeHours(input.gauge, pt, cap, offset);
                binds = gaugeBinds(cap);
            }
        }
        return {
            window,
            pt,
            start,
            end,
            hours,
            days: hours / 24,
            ptPerHour: playable ? pt.manualPtPerPlay * pt.playsPerHour : 0,
            capHours,
            gaugeBinds: binds,
            autoRunHours: autoRunHours(pt),
            autoRuns: 0,
            limitHours: hours,
            plannedHours: 0,
            capped: false,
            plays: 0,
        };
    });

    // Each reset window's daily Auto budget goes to the overlapping chapters by best Auto PT, each taking what fits in
    // its overlap. On equal Auto PT, runs first go into the rest a binding gauge leaves (chapter hours beyond its gauge
    // capacity not yet offered to Auto), since there Auto costs no manual time: the chapter that ends first fills
    // first, because a later chapter still gets its own later windows; then by longer overlap.
    const slots: Array<{ state: ChapterState; autoPt: number; runs: number }> = [];
    if (gap > 0 && autoPerDay > 0) {
        const offered = new Map<ChapterState, number>();
        const restRuns = (s: ChapterState) => {
            const rest = s.gaugeBinds && s.capHours !== null ? s.hours - s.capHours : 0;
            return Math.max(0, Math.floor(rest / s.autoRunHours + EPS) - (offered.get(s) ?? 0));
        };
        for (const w of resetWindows(input.now, input.endAt, input.tzOffsetMinutes)) {
            const overlaps = states
                .map((state) => {
                    const hours = (Math.min(w.end, state.end) - Math.max(w.start, state.start)) / HOUR_MS;
                    return { state, hours, room: autoRunsFitting(Infinity, hours, state.autoRunHours) };
                })
                .filter((o) => o.hours > 0 && o.state.pt.autoPtPerPlay > 0)
                .sort((a, b) => b.state.pt.autoPtPerPlay - a.state.pt.autoPtPerPlay || b.hours - a.hours);
            let budget = autoPerDay;
            const give = (o: (typeof overlaps)[number], limit: number) => {
                const runs = Math.min(budget, o.room, limit);
                if (runs <= 0) return;
                o.room -= runs;
                budget -= runs;
                offered.set(o.state, (offered.get(o.state) ?? 0) + runs);
                slots.push({ state: o.state, autoPt: o.state.pt.autoPtPerPlay, runs });
            };
            for (const autoPt of new Set(overlaps.map((o) => o.state.pt.autoPtPerPlay))) {
                const group = overlaps.filter((o) => o.state.pt.autoPtPerPlay === autoPt);
                const byEnd = [...group].sort((a, b) => a.state.end - b.state.end);
                for (const o of byEnd) give(o, restRuns(o.state));
                for (const o of group) give(o, Infinity);
            }
        }
    }
    slots.sort((a, b) => b.autoPt - a.autoPt);
    let autoLeft = gap;
    for (const slot of slots) {
        if (autoLeft <= 0) break;
        const runs = Math.min(slot.runs, Math.ceil(autoLeft / slot.autoPt));
        slot.state.autoRuns += runs;
        autoLeft -= runs * slot.autoPt;
    }
    for (const s of states) {
        s.limitHours = Math.min(s.capHours ?? Infinity, Math.max(0, s.hours - s.autoRuns * s.autoRunHours));
    }

    // One uniform manual hours-per-day across chapters; chapters over their limit (gauge cap or time left
    // beside Auto) are pinned at it and the rest is spread over the others (H only grows, so pinning is final).
    const need = Math.max(0, autoLeft);
    const usable = states.filter((s) => s.ptPerHour > 0 && s.days > 0);
    const unreachable = need > 0 && usable.length === 0;
    if (need > 0 && usable.length > 0) {
        let free = usable;
        let pinnedPt = 0;
        while (free.length > 0) {
            const denom = free.reduce((sum, s) => sum + s.days * s.ptPerHour, 0);
            const h = (need - pinnedPt) / denom;
            const over = free.filter((s) => h * s.days > s.limitHours + EPS);
            if (over.length === 0) {
                for (const s of free) s.plannedHours = h * s.days;
                break;
            }
            for (const s of over) {
                s.plannedHours = s.limitHours;
                s.capped = true;
                pinnedPt += s.plannedHours * s.ptPerHour;
            }
            free = free.filter((s) => !s.capped);
        }
        if (free.length === 0) {
            // Every chapter is at its limit: the remainder exceeds the limits uniformly.
            const denom = usable.reduce((sum, s) => sum + s.days * s.ptPerHour, 0);
            const extra = Math.max(0, need - pinnedPt) / denom;
            for (const s of usable) {
                s.plannedHours += extra * s.days;
                s.capped = false;
            }
        }

        const ratioOf = (s: ChapterState, plays: number, runs: number) =>
            loadRatio(
                hoursFor(plays, s.pt.playsPerHour),
                budgetDaysOf(s.days, s.end >= input.endAt),
                input.dailyManualHours,
                s.hours - runs * s.autoRunHours,
                s.capHours,
            );

        // Whole plays: floor everywhere, then add plays where one more gives the lowest band (a chapter with minutes
        // left cannot hold one), among equals the most under-allocated uncapped chapter.
        const topUp = usable.some((s) => !s.capped) ? usable.filter((s) => !s.capped) : usable;
        const planPt = () => states.reduce((sum, s) => sum + s.plays * s.pt.manualPtPerPlay + s.autoRuns * s.pt.autoPtPerPlay, 0);
        const topUpTo = (target: number) => {
            let earned = planPt();
            while (earned < target - 1e-6) {
                let pick = topUp[0];
                let pickBand = Infinity;
                let pickShort = -Infinity;
                for (const s of topUp) {
                    const band = bandOf(ratioOf(s, s.plays + 1, s.autoRuns));
                    const short = s.plannedHours * s.pt.playsPerHour - s.plays;
                    if (band < pickBand || (band === pickBand && short > pickShort)) {
                        pick = s;
                        pickBand = band;
                        pickShort = short;
                    }
                }
                pick.plays += 1;
                earned += pick.pt.manualPtPerPlay;
            }
        };
        for (const s of usable) s.plays = Math.floor(s.plannedHours * s.pt.playsPerHour + EPS);
        topUpTo(gap);

        // Auto trimming by the single-scope rule (pickAutoRuns) on each chapter's PT share, only as far as the verdict
        // needs: the verdict is the worst chapter's band, so a chapter keeps the most runs whose band is no worse.
        const trims = usable
            .filter((s) => s.autoRuns > 0)
            .map((s) => {
                const planned = s.autoRuns;
                const sharePt = s.plannedHours * s.ptPerHour + planned * s.pt.autoPtPerPlay;
                const playsAt = (runs: number) =>
                    runs === planned ? s.plays : playsFor(sharePt - runs * s.pt.autoPtPerPlay, s.pt.manualPtPerPlay);
                const ratioAt = (runs: number) => ratioOf(s, playsAt(runs), runs);
                const busyHoursAt = (runs: number) => hoursFor(playsAt(runs), s.pt.playsPerHour) + runs * s.autoRunHours;
                return { s, planned, playsAt, ratioAt, best: pickAutoRuns(planned, ratioAt, busyHoursAt, s.hours) };
            });
        let verdictBand = 0;
        for (const s of usable) {
            if (s.autoRuns === 0 && s.plays > 0) verdictBand = Math.max(verdictBand, bandOf(ratioOf(s, s.plays, 0)));
        }
        for (const t of trims) verdictBand = Math.max(verdictBand, bandOf(t.ratioAt(t.best)));
        for (const t of trims) {
            let runs = t.best;
            if (bandOf(t.ratioAt(t.best)) < BANDS.length - 1) {
                for (let r = t.planned; r > t.best; r--) {
                    if (bandOf(t.ratioAt(r)) <= verdictBand) {
                        runs = r;
                        break;
                    }
                }
            }
            if (runs < t.planned) {
                t.s.plays = t.playsAt(runs);
                t.s.autoRuns = runs;
            }
        }
        // A trimmed share rounds from its continuous part and loses the whole plays the first top-up gave it.
        topUpTo(gap);
    }

    let autoRuns = 0;
    let autoTotalPt = 0;
    let autoHoursTotal = 0;
    let manualPlays = 0;
    let manualHoursTotal = 0;
    let manualLimitHours = 0;
    let stamina = 0;
    let worstRatio = 0;
    const perChapter: ChapterPlan[] = states.map((s) => {
        const manualHours = hoursFor(s.plays, s.pt.playsPerHour);
        autoRuns += s.autoRuns;
        autoTotalPt += s.autoRuns * s.pt.autoPtPerPlay;
        autoHoursTotal += s.autoRuns * s.autoRunHours;
        manualPlays += s.plays;
        manualHoursTotal += manualHours;
        stamina += staminaFor(s.plays, s.pt.manualFire) + s.autoRuns * s.pt.autoFire;
        const freeHours = s.hours - s.autoRuns * s.autoRunHours;
        const budgetDays = budgetDaysOf(s.days, s.end >= input.endAt);
        manualLimitHours += manualLimit(budgetDays, input.dailyManualHours, freeHours, s.capHours);
        if (s.plays > 0) {
            const ratio = loadRatio(manualHours, budgetDays, input.dailyManualHours, freeHours, s.capHours);
            worstRatio = Math.max(worstRatio, ratio);
        }
        return {
            chapterNo: s.window.chapterNo,
            gameCharacterId: s.window.gameCharacterId,
            remainingHours: s.hours,
            manualHours,
            manualPlays: s.plays,
            autoRuns: s.autoRuns,
            pt: s.plays * s.pt.manualPtPerPlay + s.autoRuns * s.pt.autoPtPerPlay,
            gaugeCapHours: s.capHours,
        };
    });

    const gaugeStates = states.filter((s) => s.capHours !== null);
    const bindingCaps = gaugeStates.flatMap((s) => (s.gaugeBinds ? [perDayOf(s.capHours as number, s.days)] : []));
    let gaugeCapPerDay: number | null = null;
    if (gaugeStates.length > 0) gaugeCapPerDay = bindingCaps.length > 0 ? Math.min(...bindingCaps) : FULL_DAY_HOURS;
    let feasibility: Feasibility = classify(worstRatio);
    if (gap === 0) feasibility = "comfortable";
    else if (unreachable) feasibility = "impossible";
    return finish({
        gap,
        remainingHours,
        remainingDays,
        autoRuns,
        autoTotalPt,
        autoHoursTotal,
        manualPlays: unreachable ? Infinity : manualPlays,
        manualHoursTotal: unreachable ? Infinity : manualHoursTotal,
        manualLimitHours,
        stamina: unreachable ? Infinity : stamina,
        gaugeCapHoursPerDay: gaugeCapPerDay,
        feasibility,
        perChapter,
    });
}

/** Applies a song option to every chapter: its manual fields, with chapter PT scaled by the option/base PT ratio. */
function planWithSong(input: PlannerInput, base: SongOption, option: SongOption): PlannerResult {
    const chapters = input.chapters ?? [];
    if (chapters.length === 0) return planGoal({ ...input, pt: option.pt });
    const scale = base.pt.manualPtPerPlay > 0 ? option.pt.manualPtPerPlay / base.pt.manualPtPerPlay : 1;
    return planGoal({
        ...input,
        pt: option.pt,
        chapters: chapters.map(({ window, pt }) => ({
            window,
            pt: {
                ...pt,
                manualPtPerPlay: pt.manualPtPerPlay * scale,
                manualFire: option.pt.manualFire,
                playsPerHour: option.pt.playsPerHour,
                songSeconds: option.pt.songSeconds,
                songLabel: option.pt.songLabel,
            },
        })),
    });
}

/** First option with the strictly highest value; the base is listed first so ties keep it. */
function pickBest(candidates: SongOption[], value: (o: SongOption) => number): SongOption | null {
    let best: SongOption | null = null;
    let bestValue = -Infinity;
    for (const o of candidates) {
        const v = value(o);
        if (v > bestValue) {
            best = o;
            bestValue = v;
        }
    }
    return best;
}

export function compareSongs(base: SongOption, options: SongOption[], input: PlannerInput): SongComparison {
    const candidates = [base, ...options.filter((o) => o.key !== base.key)];
    // A 0-fire base already spends no stamina, so nothing beats it per stamina.
    const staminaPick =
        base.pt.manualFire >= 1
            ? pickBest(
                  candidates.filter((o) => o.pt.manualFire >= 1),
                  (o) => o.pt.manualPtPerPlay / o.pt.manualFire,
              )
            : base;
    const hourPick = pickBest(candidates, (o) => o.pt.manualPtPerPlay * o.pt.playsPerHour);
    const bestPerStamina = staminaPick && staminaPick.key !== base.key ? staminaPick : null;
    const bestPerHour = hourPick && hourPick.key !== base.key ? hourPick : null;

    const baseResult = planWithSong(input, base, base);
    let perStaminaDelta: SongComparison["perStaminaDelta"] = null;
    if (bestPerStamina) {
        const r = planWithSong(input, base, bestPerStamina);
        perStaminaDelta = {
            staminaSaved: baseResult.stamina - r.stamina,
            hoursPerDayMore: r.manualHoursPerDay - baseResult.manualHoursPerDay,
            hoursTotalMore: r.manualHoursTotal - baseResult.manualHoursTotal,
        };
    }
    let perHourDelta: SongComparison["perHourDelta"] = null;
    if (bestPerHour) {
        const r = planWithSong(input, base, bestPerHour);
        perHourDelta = {
            hoursPerDaySaved: baseResult.manualHoursPerDay - r.manualHoursPerDay,
            hoursTotalSaved: baseResult.manualHoursTotal - r.manualHoursTotal,
            staminaMore: r.stamina - baseResult.stamina,
        };
    }
    return { base, bestPerStamina, bestPerHour, perStaminaDelta, perHourDelta };
}
