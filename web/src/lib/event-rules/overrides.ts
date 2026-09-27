// Manual registry for event rules that masterdata does not carry.
// Every entry names its source; refs stay ASCII because web/src must not contain Han/kana text.
import type { ColorfulPass, Region, RuleSource } from "./types";

export interface SpecialMeasureEntry {
    region: Region;
    eventId: number;
    /** Auto special measure: Auto score at least a multi live with theoretical-max teammates, raised daily Auto limit. */
    specialMeasure: boolean;
    source: RuleSource;
    ref: string;
}

export const SPECIAL_MEASURES: readonly SpecialMeasureEntry[] = [
    { region: "jp", eventId: 180, specialMeasure: true, source: "official", ref: "in-game notice: finale auto live score measure (2025-09)" },
    { region: "cn", eventId: 180, specialMeasure: true, source: "official", ref: "operator-confirmed" },
    { region: "jp", eventId: 218, specialMeasure: false, source: "official", ref: "note_407 (v6.8.0)" },
];

export type OfficialLimitKind = "memberBonusLimit" | "skillCap" | "powerCap";

/** Selects either one event or every non-finale (chapter) event of a WL turn in the region. */
export type OfficialLimitTarget =
    | { eventId: number }
    | { wlTurn: 1 | 2 | 3; finale: false };

export interface OfficialLimitEntry {
    limit: OfficialLimitKind;
    region: Region;
    target: OfficialLimitTarget;
    value: number;
    source: RuleSource;
    ref: string;
}

export const OFFICIAL_LIMITS: readonly OfficialLimitEntry[] = [
    { limit: "skillCap", region: "jp", target: { eventId: 180 }, value: 140, source: "official", ref: "note_332 (v5.3.0)" },
    // CN masterdata has no eventSkillScoreUpLimits row for #180.
    { limit: "skillCap", region: "cn", target: { eventId: 180 }, value: 140, source: "secondary", ref: "JP note_332" },
    { limit: "memberBonusLimit", region: "jp", target: { eventId: 218 }, value: 5, source: "official", ref: "note_407 (v6.8.0)" },
    { limit: "powerCap", region: "jp", target: { wlTurn: 3, finale: false }, value: 336_000, source: "official", ref: "note_382 (v6.4.0)" },
    { limit: "powerCap", region: "jp", target: { eventId: 218 }, value: 336_000, source: "official", ref: "note_407 (v6.8.0)" },
    { limit: "powerCap", region: "cn", target: { wlTurn: 3, finale: false }, value: 336_000, source: "secondary", ref: "JP note_382" },
];

export interface AutoBase {
    /** Daily Auto limit by Colorful Pass tier without a special measure. */
    normal: Readonly<Record<ColorfulPass, number>>;
    /** Daily Auto limit by Colorful Pass tier while a special measure runs. */
    specialMeasure: Readonly<Record<ColorfulPass, number>>;
    minFire: number;
    maxFire: number;
    source: RuleSource;
    ref: string;
}

export const AUTO_BASE: AutoBase = {
    normal: { none: 10, normal: 10, precious: 99 },
    specialMeasure: { none: 10, normal: 99, precious: 99 },
    minFire: 1,
    maxFire: 10,
    source: "secondary",
    ref: "pjsekai wiki (auto live)",
};
