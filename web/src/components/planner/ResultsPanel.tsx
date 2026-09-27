"use client";
import { useI18n } from "@/contexts/I18nContext";
import { getCharacterName } from "@/lib/i18n";
import type { EventRules } from "@/lib/event-rules/types";
import type { Feasibility, PlannerResult, SongComparison } from "@/lib/goal-planner/types";

export interface ResultsPanelProps {
    result: PlannerResult | null;
    comparison: SongComparison | null;
    rules: EventRules;
}

const FEASIBILITY: Record<Feasibility, { key: string; badge: string; value: string; tile: string }> = {
    comfortable: {
        key: "page.predictionPlanner.results.feasibility.comfortable",
        badge: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800",
        value: "text-emerald-600 dark:text-emerald-400",
        tile: "border-emerald-200/70 bg-emerald-50/40 dark:border-emerald-900/50 dark:bg-emerald-950/20",
    },
    achievable: {
        key: "page.predictionPlanner.results.feasibility.achievable",
        badge: "bg-miku/10 text-miku border-miku/30",
        value: "text-miku",
        tile: "border-miku/30 bg-miku/5",
    },
    hard: {
        key: "page.predictionPlanner.results.feasibility.hard",
        badge: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800",
        value: "text-amber-600 dark:text-amber-400",
        tile: "border-amber-200/70 bg-amber-50/40 dark:border-amber-900/50 dark:bg-amber-950/20",
    },
    impossible: {
        key: "page.predictionPlanner.results.feasibility.impossible",
        badge: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800",
        value: "text-red-600 dark:text-red-400",
        tile: "border-red-200/70 bg-red-50/40 dark:border-red-900/50 dark:bg-red-950/20",
    },
};

/**
 * Switch tips: perStamina and perHour trade stamina against time; both saves stamina and time;
 * timeOnly and staminaOnly save one at an equal cost in the other.
 */
interface ComparisonTip {
    kind: "perStamina" | "perHour" | "both" | "timeOnly" | "staminaOnly";
    key: string;
    song: string;
    stamina: number;
    perDay: number;
    total: number;
}

/** Hour deltas this small are float noise between plans that take the same time. */
const SAME_HOURS = 1e-6;
/** Below this many hours left the panel drops per-day figures (D3). */
const DAY_HOURS = 24;

const TILE = "p-3.5 rounded-xl border min-w-0";
const NEUTRAL_TILE = "bg-slate-50 dark:bg-slate-800/60 border-slate-100 dark:border-slate-800";
const TILE_LABEL = "block text-[11px] font-bold text-slate-500 dark:text-slate-400 mb-1";
const TILE_VALUE = "block text-base sm:text-lg font-black font-mono break-words";
const TILE_SUB = "block mt-1 text-xs text-slate-500 dark:text-slate-400 break-words";

export default function ResultsPanel({ result, comparison, rules }: ResultsPanelProps) {
    const { t, formatNumber } = useI18n();
    const hours = (value: number) => formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const staminaParams = (stamina: number) => ({
        stamina: formatNumber(stamina),
        drinks: formatNumber(Math.ceil(stamina / 10)),
        crystals: formatNumber(stamina * 10),
    });

    const style = result ? FEASIBILITY[result.feasibility] : null;
    const reached = result != null && result.gap <= 0;
    const remainingHours = result ? Math.max(0, result.remainingHours) : 0;
    const underDay = remainingHours < DAY_HOURS;
    const gaugeCap = result?.gaugeCapHoursPerDay ?? null;
    // Core reports 24 when the gauge does not bind within the time left.
    const showGaugeCap = gaugeCap != null && gaugeCap < DAY_HOURS;
    // Undoes core's per-day pro-rating (hours / max(days, 1/24)) to get the gauge hours in the time left.
    const gaugeCapLeftHours = gaugeCap != null ? (gaugeCap * Math.max(remainingHours, 1)) / DAY_HOURS : 0;

    const tips: ComparisonTip[] = [];
    const staminaPick = comparison?.bestPerStamina;
    const staminaDelta = comparison?.perStaminaDelta;
    if (staminaPick && staminaDelta && staminaDelta.staminaSaved > 0) {
        const { hoursPerDayMore, hoursTotalMore } = staminaDelta;
        const kind = hoursPerDayMore > SAME_HOURS ? "perStamina" : hoursPerDayMore < -SAME_HOURS ? "both" : "staminaOnly";
        tips.push({
            kind,
            key: staminaPick.key,
            song: staminaPick.label,
            stamina: staminaDelta.staminaSaved,
            perDay: Math.abs(hoursPerDayMore),
            total: Math.abs(hoursTotalMore),
        });
    }
    const hourPick = comparison?.bestPerHour;
    const hourDelta = comparison?.perHourDelta;
    if (hourPick && hourDelta && hourDelta.hoursPerDaySaved > SAME_HOURS) {
        const { staminaMore } = hourDelta;
        const kind = staminaMore > 0 ? "perHour" : staminaMore < 0 ? "both" : "timeOnly";
        const sameTip = kind === "both" && tips.some((tip) => tip.kind === "both" && tip.key === hourPick.key);
        if (!sameTip) {
            tips.push({
                kind,
                key: hourPick.key,
                song: hourPick.label,
                stamina: Math.abs(staminaMore),
                perDay: hourDelta.hoursPerDaySaved,
                total: hourDelta.hoursTotalSaved,
            });
        }
    }
    // Under a day left the tips name total hours only, like the headline (D3).
    const tipText = (tip: ComparisonTip) => {
        const values = { song: tip.song, perDay: hours(tip.perDay), total: hours(tip.total) };
        switch (tip.kind) {
            case "perHour": {
                const params = { ...values, stamina: formatNumber(tip.stamina) };
                return underDay
                    ? t("page.predictionPlanner.comparison.perHourTotal", params)
                    : t("page.predictionPlanner.comparison.perHour", params);
            }
            case "both": {
                const params = { ...values, ...staminaParams(tip.stamina) };
                return underDay
                    ? t("page.predictionPlanner.comparison.bothTotal", params)
                    : t("page.predictionPlanner.comparison.both", params);
            }
            case "timeOnly":
                return underDay
                    ? t("page.predictionPlanner.comparison.timeOnlyTotal", values)
                    : t("page.predictionPlanner.comparison.timeOnly", values);
            case "staminaOnly":
                return t("page.predictionPlanner.comparison.staminaOnly", { song: tip.song, ...staminaParams(tip.stamina) });
            default: {
                const params = { ...values, ...staminaParams(tip.stamina) };
                return underDay
                    ? t("page.predictionPlanner.comparison.perStaminaTotal", params)
                    : t("page.predictionPlanner.comparison.perStamina", params);
            }
        }
    };

    const showChapters = result != null && !reached && rules.group === "wl_overall" && result.perChapter.length > 0;

    return (
        <section className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-3">
                <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                    {t("page.predictionPlanner.results.title")}
                </h2>
                {style && result && (
                    <span className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-bold ${style.badge}`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-current" />
                        {t(style.key)}
                    </span>
                )}
            </div>

            {!result ? (
                <p className="text-sm font-mono text-slate-400">—</p>
            ) : (
                <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className={`${TILE} ${NEUTRAL_TILE}`}>
                            <span className={TILE_LABEL}>{t("page.predictionPlanner.results.gap")}</span>
                            <span className={`${TILE_VALUE} ${reached ? "text-emerald-600 dark:text-emerald-400" : "text-slate-800 dark:text-slate-100"}`}>
                                {reached ? t("page.predictionPlanner.results.reached") : formatNumber(result.gap)}
                            </span>
                            <span className={TILE_SUB}>
                                {underDay
                                    ? t("page.predictionPlanner.results.remainingHours", { hours: hours(remainingHours) })
                                    : t("page.predictionPlanner.results.remaining", {
                                        days: Math.floor(remainingHours / 24),
                                        hours: Math.floor(remainingHours % 24),
                                    })}
                            </span>
                        </div>

                        {!reached && style && (
                            <div className={`${TILE} ${style.tile}`}>
                                <span className={TILE_LABEL}>
                                    {underDay ? t("page.predictionPlanner.results.manualNeeded") : t("page.predictionPlanner.results.dailyManual")}
                                </span>
                                <span className={`${TILE_VALUE} ${style.value}`}>
                                    {underDay
                                        ? t("page.predictionPlanner.results.manualNeededValue", {
                                            total: hours(result.manualHoursTotal),
                                            left: hours(remainingHours),
                                        })
                                        : t("page.predictionPlanner.results.dailyManualValue", {
                                            perDay: hours(result.manualHoursPerDay),
                                            total: hours(result.manualHoursTotal),
                                        })}
                                </span>
                                <span className={TILE_SUB}>
                                    {t("page.predictionPlanner.results.manualPlays", { count: formatNumber(result.manualPlays) })}
                                </span>
                                <span className={TILE_SUB}>
                                    {/* Under a day the headline compares hours, and Auto takes real time too. */}
                                    {underDay && result.autoRuns > 0
                                        ? t("page.predictionPlanner.results.autoRunsTime", {
                                            count: formatNumber(result.autoRuns),
                                            pt: formatNumber(result.autoTotalPt),
                                            hours: hours(result.autoHoursTotal),
                                        })
                                        : t("page.predictionPlanner.results.autoRuns", {
                                            count: formatNumber(result.autoRuns),
                                            pt: formatNumber(result.autoTotalPt),
                                        })}
                                </span>
                                {showGaugeCap && (
                                    <span className={TILE_SUB}>
                                        {underDay
                                            ? t("page.predictionPlanner.results.gaugeCapLeft", { hours: hours(gaugeCapLeftHours) })
                                            : t("page.predictionPlanner.results.gaugeCap", { hours: hours(gaugeCap) })}
                                    </span>
                                )}
                            </div>
                        )}

                        {!reached && (
                            <div className={`${TILE} ${NEUTRAL_TILE} sm:col-span-2`}>
                                <span className={TILE_LABEL}>{t("page.predictionPlanner.results.stamina")}</span>
                                <span className={`${TILE_VALUE} text-amber-600 dark:text-amber-400`}>
                                    {t("page.predictionPlanner.results.staminaValue", {
                                        stamina: formatNumber(result.stamina),
                                        drinks: formatNumber(result.bigDrinks),
                                        crystals: formatNumber(result.crystals),
                                    })}
                                </span>
                                <span className={TILE_SUB}>
                                    {t("page.predictionPlanner.results.naturalStamina", { stamina: formatNumber(result.naturalStamina) })}
                                </span>
                            </div>
                        )}
                    </div>

                    {showChapters && (
                        <div>
                            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-2">
                                {t("page.predictionPlanner.results.perChapter")}
                            </h3>
                            <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-xl border border-slate-100 dark:border-slate-800">
                                {result.perChapter.map((chapter) => {
                                    const capped = chapter.gaugeCapHours != null && chapter.manualHours >= chapter.gaugeCapHours - 0.05;
                                    return (
                                        <li
                                            key={chapter.chapterNo}
                                            className={`px-3 py-2 text-xs break-words ${capped ? "text-amber-700 dark:text-amber-300" : "text-slate-600 dark:text-slate-300"}`}
                                        >
                                            {t("page.predictionPlanner.results.chapterRow", {
                                                no: chapter.chapterNo,
                                                character: chapter.gameCharacterId != null ? getCharacterName(t, chapter.gameCharacterId) : "",
                                                hours: hours(chapter.manualHours),
                                                pt: formatNumber(chapter.pt),
                                            })}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}

                    {!reached && tips.length > 0 && (
                        <div className="space-y-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                            {tips.map((tip) => (
                                <p key={`${tip.kind}:${tip.key}`}>{tipText(tip)}</p>
                            ))}
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
