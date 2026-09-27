// Per-edition event-rules types. Relative `import type` only, so node --experimental-strip-types can load it.

export type Region = "jp" | "cn";

/** Source of a rule value; the page shows it as game data / official notice / secondary source / your change. */
export type RuleSource = "masterdata" | "official" | "secondary" | "user";

export interface RuleValue<T> {
    value: T;
    source: RuleSource;
    /** Source reference, e.g. `eventBreakTimes#2`, `note_407 (v6.8.0)`. */
    ref?: string;
}

/** Event group shared by the prediction model and the planner. */
export type EventGroup =
    | "normal"
    | "wl_chapter_72h"
    | "wl_chapter_48h"
    | "wl_overall"
    | "wl_finale";

/**
 * WL turn: sort the region's world_bloom events by start time; an event starting more than 120 days after the previous one's aggregation opens a new turn, numbered in order.
 * Turn 4 and later have unknown rules and map to null (shown as unknown turn). Never inferred from event-id ranges.
 */
export type WlTurn = 1 | 2 | 3 | null;

export type ColorfulPass = "none" | "normal" | "precious";

export interface WlChapterRule {
    chapterNo: number;
    /** null for the finale. */
    gameCharacterId: number | null;
    startAt: number;
    aggregateAt: number;
    endAt: number;
    hours: number;
}

export interface BreakGaugeRule {
    id: number;
    gainPerSecond: number;
    fixedSecondsPerPlay: number;
    max: number;
    restStartMinutes: number;
    restStepMinutes: number;
    restStepDecrease: number;
    resetPerWlChapter: boolean;
}

export interface AutoRule {
    /** Auto score/PT is at least that of a multi live with theoretical-max teammates (#180 in both regions). */
    specialMeasure: boolean;
    dailyLimitByPass: Record<ColorfulPass, number>;
    minFire: number;
    maxFire: number;
}

export interface SupportDeckRule {
    slots: number;
    table: "WL1" | "WL2" | "WL3" | null;
}

export interface ShuffleUnitBonusRow {
    unitCount: number;
    bonusRate: number;
}

export type RuleScope = { kind: "overall" } | { kind: "chapter"; gameCharacterId: number };

export interface RuleOverrides {
    autoSpecialMeasure?: boolean;
    breakGaugeEnabled?: boolean;
    pass?: ColorfulPass;
}

export interface EventRules {
    region: Region;
    eventId: number;
    /** masterdata events.eventType. */
    eventType: string;
    group: EventGroup;
    scope: RuleScope;
    wlTurn: WlTurn;
    isFinale: boolean;
    startAt: number;
    aggregateAt: number;
    /** Start and end of the selected scope (the chapter window for a chapter scope, the whole event otherwise). */
    scopeStartAt: number;
    scopeAggregateAt: number;
    /** Empty for non-WL events; a single chapter for finales. */
    chapters: WlChapterRule[];
    /** Maximum number of cards whose member bonus counts; null = no limit (ordinary WL chapters). */
    memberBonusLimit: RuleValue<number | null>;
    /** Skill effect cap in percentage points (e.g. 140); null = no cap. */
    skillCap: RuleValue<number | null>;
    /** Fixture (plush) bonus cap in %; masterdata bonusRateLimit is in 0.1% (20 -> 2%, 60 -> 6%). */
    fixtureBonusCap: RuleValue<number | null>;
    /** Power cap; not in masterdata, 336,000 for WL3 chapters and #218 (official notices). */
    powerCap: RuleValue<number | null>;
    shuffleUnitBonus: RuleValue<ShuffleUnitBonusRow[]>;
    supportDeck: RuleValue<SupportDeckRule | null>;
    /** Event-card bonus (max bonusRate / leaderBonusRate over eventCards, in %). */
    eventCardBonus: RuleValue<{ bonusRate: number; leaderBonusRate: number } | null>;
    /** Finale title bonus (eventHonorBonuses: number of titles and bonus %). */
    honorBonus: RuleValue<{ titles: number; bonusRate: number } | null>;
    /** Extra support-deck bonus for unit-event-limited cards (worldBloomSupportDeckUnitEventLimitedBonuses, in %). */
    unitLimitedSupportBonus: RuleValue<number | null>;
    /** Break gauge after overrides; value null when disabled or not configured for the event. */
    breakGauge: RuleValue<BreakGaugeRule | null>;
    /** Whether the event configures a break gauge (decides whether the page shows the gauge toggle). */
    breakGaugeConfigured: boolean;
    auto: RuleValue<AutoRule>;
    pass: ColorfulPass;
    /** Daily Auto limit derived from the pass tier and the special measure. */
    autoDailyLimit: number;
    /** Upper-bound ranks of eventRankingRewardRanges, ascending. */
    rankingTiers: number[];
    /** Bonus-related masterdata tables with rows for this event that the deck engine does not read. */
    engineCoverageGaps: string[];
    /** i18n keys (page.predictionPlanner.rules.warnings.*), e.g. unregisteredSpecialMeasure, unknownWlTurn. */
    warnings: string[];
    /** i18n keys of the edition's special-rule notes (page.predictionPlanner.rules.notes.*), by turn and finale. */
    editionNotes: string[];
}

/** Masterdata subset resolveEventRules needs; a missing optional table means the rule does not apply. */
export interface EventRulesMasterdata {
    events: ReadonlyArray<Record<string, unknown>>;
    worldBlooms: ReadonlyArray<Record<string, unknown>>;
    eventBreakTimes?: ReadonlyArray<Record<string, unknown>>;
    eventCardBonusLimits?: ReadonlyArray<Record<string, unknown>>;
    eventSkillScoreUpLimits?: ReadonlyArray<Record<string, unknown>>;
    eventShuffleUnitBonuses?: ReadonlyArray<Record<string, unknown>>;
    eventMysekaiFixtureGameCharacterPerformanceBonusLimits?: ReadonlyArray<Record<string, unknown>>;
    eventCards?: ReadonlyArray<Record<string, unknown>>;
    eventHonorBonuses?: ReadonlyArray<Record<string, unknown>>;
    worldBloomSupportDeckUnitEventLimitedBonuses?: ReadonlyArray<Record<string, unknown>>;
    [table: string]: ReadonlyArray<Record<string, unknown>> | undefined;
}

export interface ResolveEventRulesInput {
    region: Region;
    eventId: number;
    masterdata: EventRulesMasterdata;
    scope?: RuleScope;
    overrides?: RuleOverrides;
}
