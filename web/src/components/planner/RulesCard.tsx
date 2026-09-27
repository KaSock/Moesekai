"use client";
import React, { useState } from "react";
import { useI18n } from "@/contexts/I18nContext";
import { getCharacterName } from "@/lib/i18n";
import type {
    ColorfulPass,
    EventRules,
    RuleOverrides,
    RuleScope,
    RuleSource,
    RuleValue,
} from "@/lib/event-rules/types";
import type { WorldBloomChapterRow } from "@/lib/prediction/types";

interface RulesCardProps {
    rules: EventRules;
    overrides: RuleOverrides;
    onOverridesChange(o: RuleOverrides): void;
    scope: RuleScope;
    onScopeChange(s: RuleScope): void;
    chapters: WorldBloomChapterRow[];
}

const SOURCE_KEYS: Record<RuleSource, string> = {
    masterdata: "page.predictionPlanner.rules.source.masterdata",
    official: "page.predictionPlanner.rules.source.official",
    secondary: "page.predictionPlanner.rules.source.secondary",
    user: "page.predictionPlanner.rules.source.user",
};

const SOURCE_STYLES: Record<RuleSource, string> = {
    masterdata: "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
    official: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800",
    secondary: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800",
    user: "bg-miku/10 text-miku border-miku/30",
};

const PASS_OPTIONS: ReadonlyArray<{ value: ColorfulPass; key: string }> = [
    { value: "none", key: "page.predictionPlanner.rules.controls.passNone" },
    { value: "normal", key: "page.predictionPlanner.rules.controls.passNormal" },
    { value: "precious", key: "page.predictionPlanner.rules.controls.passPrecious" },
];

const WARNING_KEYS: Record<string, string> = {
    unregisteredSpecialMeasure: "page.predictionPlanner.rules.warnings.unregisteredSpecialMeasure",
    unknownWlTurn: "page.predictionPlanner.rules.warnings.unknownWlTurn",
    engineGap: "page.predictionPlanner.rules.warnings.engineGap",
};

const NOTE_KEYS: Record<string, string> = {
    finaleWl2: "page.predictionPlanner.rules.notes.finaleWl2",
    finaleWl3: "page.predictionPlanner.rules.notes.finaleWl3",
    wl3Chapter: "page.predictionPlanner.rules.notes.wl3Chapter",
    cnWl1: "page.predictionPlanner.rules.notes.cnWl1",
};

/** Accepts both a bare id and the full i18n key, since EventRules documents the full-key form. */
function lookupKey(map: Record<string, string>, raw: string): string {
    const bare = raw.slice(raw.lastIndexOf(".") + 1);
    return map[bare] ?? raw;
}

/** Chapter the "this chapter" scope should point at: the running one, else the latest started, else the first. */
function pickChapterCharacter(rules: EventRules, chapters: WorldBloomChapterRow[], now: number): number | null {
    const rows = chapters.length > 0
        ? chapters.map((c) => ({ id: c.gameCharacterId, start: c.chapterStartAt, end: c.aggregateAt }))
        : rules.chapters
            .filter((c) => c.gameCharacterId !== null)
            .map((c) => ({ id: c.gameCharacterId as number, start: c.startAt, end: c.aggregateAt }));
    if (rows.length === 0) return null;
    const sorted = [...rows].sort((a, b) => a.start - b.start);
    const running = sorted.find((c) => now >= c.start && now < c.end);
    if (running) return running.id;
    const started = sorted.filter((c) => c.start <= now);
    return (started.length > 0 ? started[started.length - 1] : sorted[0]).id;
}

function SegmentButton({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all border whitespace-nowrap ${active
                ? "bg-miku text-white border-miku shadow-sm shadow-miku/30"
                : "bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                }`}
        >
            {children}
        </button>
    );
}

function ResetButton({ onClick }: { onClick(): void }) {
    const { t } = useI18n();
    return (
        <button
            type="button"
            onClick={onClick}
            className="-my-1 px-1 py-1.5 rounded-md text-[11px] font-bold text-miku hover:underline whitespace-nowrap"
        >
            {t("page.predictionPlanner.rules.controls.reset")}
        </button>
    );
}

function SourceBadge({ source, sourceRef }: { source: RuleSource; sourceRef?: string }) {
    const { t } = useI18n();
    return (
        <span className="inline-flex flex-wrap items-center gap-1 min-w-0">
            <span className={`inline-block px-1.5 py-0.5 rounded-md border text-[10px] font-bold leading-none whitespace-nowrap ${SOURCE_STYLES[source]}`}>
                {t(SOURCE_KEYS[source])}
            </span>
            {sourceRef && (
                <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 break-all">{sourceRef}</span>
            )}
        </span>
    );
}

interface RuleRowProps {
    label: string;
    source?: { source: RuleSource; ref?: string };
    control?: React.ReactNode;
    children: React.ReactNode;
}

function RuleRow({ label, source, control, children }: RuleRowProps) {
    return (
        <div className="py-2.5 flex flex-col gap-1 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <dt className="text-xs font-bold text-slate-600 dark:text-slate-300">{label}</dt>
                {source && <SourceBadge source={source.source} sourceRef={source.ref} />}
            </div>
            <dd className="text-sm text-slate-800 dark:text-slate-100 break-words min-w-0">{children}</dd>
            {control && <div className="flex flex-wrap items-center gap-2">{control}</div>}
        </div>
    );
}

function sourceOf<T>(v: RuleValue<T>): { source: RuleSource; ref?: string } {
    return { source: v.source, ref: v.ref };
}

export default function RulesCard({ rules, overrides, onOverridesChange, scope, onScopeChange, chapters }: RulesCardProps) {
    const { t, formatNumber } = useI18n();
    const [expanded, setExpanded] = useState(false);

    const none = t("page.predictionPlanner.rules.values.none");
    const onText = t("page.predictionPlanner.rules.controls.on");
    const offText = t("page.predictionPlanner.rules.controls.off");
    const percent = (value: number) => t("page.predictionPlanner.rules.values.percent", { value: formatNumber(value) });

    const specialMeasure = rules.auto.value.specialMeasure;
    const gaugeOn = rules.breakGauge.value !== null;

    const patchOverrides = (patch: Partial<RuleOverrides>) => {
        onOverridesChange({ ...overrides, ...patch });
    };
    const clearOverride = (key: keyof RuleOverrides) => {
        const next = { ...overrides };
        delete next[key];
        onOverridesChange(next);
    };

    const showScope = !rules.isFinale && rules.chapters.some((c) => c.gameCharacterId !== null);
    const selectChapterScope = () => {
        if (scope.kind === "chapter") return;
        const id = pickChapterCharacter(rules, chapters, Date.now());
        if (id !== null) onScopeChange({ kind: "chapter", gameCharacterId: id });
    };

    const warnings = rules.warnings.map((raw) => {
        const key = lookupKey(WARNING_KEYS, raw);
        return key === WARNING_KEYS.engineGap
            ? t(key, { tables: rules.engineCoverageGaps.join(", ") })
            : t(key);
    });

    const chapterLines = rules.chapters.map((c) =>
        t("page.predictionPlanner.rules.values.chapter", {
            no: c.chapterNo,
            character: c.gameCharacterId !== null ? getCharacterName(t, c.gameCharacterId) : "",
            hours: c.hours,
        }).replace(/\s{2,}/g, " ").trim(),
    );

    const memberLimit = rules.memberBonusLimit.value;
    const skillCap = rules.skillCap.value;
    const fixtureCap = rules.fixtureBonusCap.value;
    const powerCap = rules.powerCap.value;
    const shuffle = rules.shuffleUnitBonus.value;
    const support = rules.supportDeck.value;
    const gauge = rules.breakGauge.value;
    const eventCard = rules.eventCardBonus.value;
    const honor = rules.honorBonus.value;
    const unitLimited = rules.unitLimitedSupportBonus.value;
    const lastTier = rules.rankingTiers[rules.rankingTiers.length - 1];
    // A resolved chapter scope reads the chapter ranking table (event-rules index.ts).
    const tiersRef = rules.scope.kind === "chapter" ? "worldBloomChapterRankingRewardRanges" : "eventRankingRewardRanges";

    const passChanged = overrides.pass !== undefined && overrides.pass !== "none";

    return (
        <section className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4 sm:p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
                <h2 className="min-w-0 text-sm sm:text-base font-bold text-slate-800 dark:text-slate-100">
                    {t("page.predictionPlanner.rules.title")}
                </h2>
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                    className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-miku bg-miku/10 hover:bg-miku/20 transition-colors"
                >
                    <span>{expanded ? t("page.predictionPlanner.rules.collapse") : t("page.predictionPlanner.rules.expand")}</span>
                    <svg className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                </button>
            </div>

            {warnings.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                    {warnings.map((text, i) => (
                        <li key={i} className="px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300 text-xs break-words">
                            {text}
                        </li>
                    ))}
                </ul>
            )}

            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2.5">
                {showScope && (
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-bold text-slate-600 dark:text-slate-300 mr-0.5">
                            {t("page.predictionPlanner.rules.controls.scope")}
                        </span>
                        <SegmentButton active={scope.kind === "chapter"} onClick={selectChapterScope}>
                            {t("page.predictionPlanner.rules.controls.scopeChapter")}
                        </SegmentButton>
                        <SegmentButton active={scope.kind === "overall"} onClick={() => onScopeChange({ kind: "overall" })}>
                            {t("page.predictionPlanner.rules.controls.scopeOverall")}
                        </SegmentButton>
                    </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-bold text-slate-600 dark:text-slate-300 mr-0.5">
                        {t("page.predictionPlanner.rules.controls.pass")}
                    </span>
                    {PASS_OPTIONS.map((option) => (
                        <SegmentButton
                            key={option.value}
                            active={rules.pass === option.value}
                            onClick={() => patchOverrides({ pass: option.value })}
                        >
                            {t(option.key)}
                        </SegmentButton>
                    ))}
                    {passChanged && <ResetButton onClick={() => clearOverride("pass")} />}
                </div>
            </div>

            {expanded && (
                <dl className="mt-3 pt-1 border-t border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                    <RuleRow
                        label={t("page.predictionPlanner.rules.items.chapters")}
                        source={rules.chapters.length > 0 ? { source: "masterdata", ref: "worldBlooms" } : undefined}
                    >
                        {chapterLines.length > 0 ? (
                            <ul className="space-y-0.5">
                                {chapterLines.map((line, i) => <li key={i}>{line}</li>)}
                            </ul>
                        ) : none}
                    </RuleRow>
                    <RuleRow label={t("page.predictionPlanner.rules.items.memberBonusLimit")} source={sourceOf(rules.memberBonusLimit)}>
                        {memberLimit === null ? none : t("page.predictionPlanner.rules.values.limitCards", { count: memberLimit })}
                    </RuleRow>
                    <RuleRow label={t("page.predictionPlanner.rules.items.skillCap")} source={sourceOf(rules.skillCap)}>
                        {skillCap === null ? none : percent(skillCap)}
                    </RuleRow>
                    <RuleRow label={t("page.predictionPlanner.rules.items.fixtureBonusCap")} source={sourceOf(rules.fixtureBonusCap)}>
                        {fixtureCap === null ? none : percent(fixtureCap)}
                    </RuleRow>
                    <RuleRow label={t("page.predictionPlanner.rules.items.powerCap")} source={sourceOf(rules.powerCap)}>
                        {powerCap === null ? none : formatNumber(powerCap)}
                    </RuleRow>
                    <RuleRow label={t("page.predictionPlanner.rules.items.shuffleUnitBonus")} source={sourceOf(rules.shuffleUnitBonus)}>
                        {shuffle.length === 0
                            ? none
                            : shuffle
                                .map((row) => t("page.predictionPlanner.rules.values.shuffle", { count: row.unitCount, rate: formatNumber(row.bonusRate) }))
                                .join(" / ")}
                    </RuleRow>
                    <RuleRow label={t("page.predictionPlanner.rules.items.supportDeck")} source={sourceOf(rules.supportDeck)}>
                        {support === null ? none : t("page.predictionPlanner.rules.values.supportSlots", { slots: support.slots, table: support.table ?? "?" })}
                    </RuleRow>
                    <RuleRow
                        label={t("page.predictionPlanner.rules.items.breakGauge")}
                        source={rules.breakGaugeConfigured ? sourceOf(rules.breakGauge) : undefined}
                        control={rules.breakGaugeConfigured ? (
                            <>
                                <span className="text-[11px] text-slate-500 dark:text-slate-400">{t("page.predictionPlanner.rules.controls.gauge")}</span>
                                <SegmentButton active={gaugeOn} onClick={() => patchOverrides({ breakGaugeEnabled: true })}>{onText}</SegmentButton>
                                <SegmentButton active={!gaugeOn} onClick={() => patchOverrides({ breakGaugeEnabled: false })}>{offText}</SegmentButton>
                                {overrides.breakGaugeEnabled !== undefined && <ResetButton onClick={() => clearOverride("breakGaugeEnabled")} />}
                            </>
                        ) : undefined}
                    >
                        {gauge === null
                            ? (rules.breakGaugeConfigured ? offText : none)
                            : t("page.predictionPlanner.rules.values.gauge", {
                                gain: formatNumber(gauge.gainPerSecond),
                                max: formatNumber(gauge.max),
                                step: formatNumber(gauge.restStepMinutes),
                                decrease: formatNumber(gauge.restStepDecrease),
                            })}
                    </RuleRow>
                    <RuleRow
                        label={t("page.predictionPlanner.rules.items.autoMeasure")}
                        source={sourceOf(rules.auto)}
                        control={(
                            <>
                                <span className="text-[11px] text-slate-500 dark:text-slate-400">{t("page.predictionPlanner.rules.controls.autoMeasure")}</span>
                                <SegmentButton active={specialMeasure} onClick={() => patchOverrides({ autoSpecialMeasure: true })}>{onText}</SegmentButton>
                                <SegmentButton active={!specialMeasure} onClick={() => patchOverrides({ autoSpecialMeasure: false })}>{offText}</SegmentButton>
                                {overrides.autoSpecialMeasure !== undefined && <ResetButton onClick={() => clearOverride("autoSpecialMeasure")} />}
                            </>
                        )}
                    >
                        {specialMeasure ? onText : offText}
                    </RuleRow>
                    <RuleRow label={t("page.predictionPlanner.rules.items.autoDailyLimit")} source={sourceOf(rules.auto)}>
                        {t("page.predictionPlanner.rules.values.autoLimit", { count: rules.autoDailyLimit })}
                    </RuleRow>
                    <RuleRow
                        label={t("page.predictionPlanner.rules.items.rankingTiers")}
                        source={rules.rankingTiers.length > 0 ? { source: "masterdata", ref: tiersRef } : undefined}
                    >
                        {lastTier === undefined
                            ? none
                            : t("page.predictionPlanner.rules.values.tiers", { count: rules.rankingTiers.length, last: formatNumber(lastTier) })}
                    </RuleRow>
                    <RuleRow label={t("page.predictionPlanner.rules.items.eventCardBonus")} source={sourceOf(rules.eventCardBonus)}>
                        {eventCard === null
                            ? none
                            : eventCard.leaderBonusRate === 0
                                ? percent(eventCard.bonusRate)
                                : t("page.predictionPlanner.rules.values.eventCard", { rate: formatNumber(eventCard.bonusRate), leader: formatNumber(eventCard.leaderBonusRate) })}
                    </RuleRow>
                    <RuleRow label={t("page.predictionPlanner.rules.items.honorBonus")} source={sourceOf(rules.honorBonus)}>
                        {honor === null
                            ? none
                            : t("page.predictionPlanner.rules.values.honor", { count: honor.titles, rate: formatNumber(honor.bonusRate) })}
                    </RuleRow>
                    <RuleRow label={t("page.predictionPlanner.rules.items.unitLimitedSupportBonus")} source={sourceOf(rules.unitLimitedSupportBonus)}>
                        {unitLimited === null ? none : percent(unitLimited)}
                    </RuleRow>
                    <RuleRow label={t("page.predictionPlanner.rules.items.editionNotes")}>
                        {rules.editionNotes.length === 0 ? none : (
                            <ul className="space-y-1.5 text-xs sm:text-sm text-slate-700 dark:text-slate-200 leading-relaxed">
                                {rules.editionNotes.map((raw) => (
                                    <li key={raw}>{t(lookupKey(NOTE_KEYS, raw))}</li>
                                ))}
                            </ul>
                        )}
                    </RuleRow>
                </dl>
            )}
        </section>
    );
}
