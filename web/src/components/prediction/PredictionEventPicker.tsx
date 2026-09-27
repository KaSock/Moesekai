"use client";
import React from "react";
import Image from "next/image";
import { useI18n } from "@/contexts/I18nContext";
import { getCharacterIconUrl } from "@/lib/assets";
import { getCharacterName } from "@/lib/i18n";
import { findActiveWlChapter } from "@/lib/prediction/use-prediction-event";
import type { PredictionEventState } from "@/lib/prediction/types";

interface PredictionEventPickerProps {
    state: PredictionEventState;
}

interface PredictionServerEventControlsProps extends PredictionEventPickerProps {
    /** Extra items appended to the controls row (the prediction page puts its end-of-event notice here). */
    children?: React.ReactNode;
}

/** Server toggle and event selector. */
export function PredictionServerEventControls({ state, children }: PredictionServerEventControlsProps) {
    const { t } = useI18n();
    const { server, setServer, events, eventsLoading, selectedEventId, setSelectedEventId, masterEvent } = state;
    // An event opened from a link may be missing from the ranking API's list; it still gets an option so the
    // selector names the event the page shows.
    const unlistedEventId = selectedEventId != null && !events.some(event => event.id === selectedEventId)
        ? selectedEventId
        : null;

    return (
        <div className="flex flex-col sm:flex-row gap-4 mb-8 items-center sm:items-stretch">
            {/* Server Toggle */}
            <div className="flex bg-white rounded-xl border border-slate-200 p-1">
                <button
                    onClick={() => setServer("cn")}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${server === "cn"
                        ? "bg-miku text-white shadow-md"
                        : "text-slate-600 hover:bg-slate-50"
                        }`}
                >
                    {t("page.prediction.servers.cn")}
                </button>
                <button
                    onClick={() => setServer("jp")}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${server === "jp"
                        ? "bg-miku text-white shadow-md"
                        : "text-slate-600 hover:bg-slate-50"
                        }`}
                >
                    {t("page.prediction.servers.jp")}
                </button>
            </div>

            {/* Event Selector */}
            <div className="flex-1">
                <select
                    value={selectedEventId || ""}
                    onChange={(e) => setSelectedEventId(Number(e.target.value))}
                    disabled={eventsLoading || events.length === 0}
                    className="w-full px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-miku/20 focus:border-miku disabled:opacity-50"
                >
                    {eventsLoading ? (
                        <option>{t("page.prediction.events.loading")}</option>
                    ) : events.length === 0 && unlistedEventId == null ? (
                        <option>{t("page.prediction.events.empty")}</option>
                    ) : (
                        <>
                            {unlistedEventId != null && (
                                <option value={unlistedEventId}>
                                    #{unlistedEventId} {masterEvent?.name ?? ""}
                                </option>
                            )}
                            {events.map(event => (
                                <option key={event.id} value={event.id}>
                                    {event.is_active ? "🟢 " : ""}#{event.id} {event.name}
                                </option>
                            ))}
                        </>
                    )}
                </select>
            </div>
            {children}
        </div>
    );
}

/** Sticky World Link chapter selector (overall + one button per chapter); renders nothing for non-WL events. */
export function PredictionWlChapterBar({ state }: PredictionEventPickerProps) {
    const { t } = useI18n();
    const { isWorldBloomEvent, eventWorldBlooms, selectedWlChapter, setSelectedWlChapter, now } = state;

    if (!isWorldBloomEvent || eventWorldBlooms.length === 0) return null;

    const activeWlChapter = findActiveWlChapter(eventWorldBlooms, selectedWlChapter);

    return (
        <div className="sm:sticky sm:top-[5.5rem] z-20 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md rounded-2xl border border-slate-200/90 dark:border-slate-700/90 p-3 shadow-md mb-6 transition-all">
            <div className="flex items-center justify-between mb-2.5 px-1">
                <span className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                    <span>🌸</span>
                    <span>{t("page.prediction.wl.chapters")}</span>
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                    {selectedWlChapter === "overall"
                        ? t("page.prediction.wl.overall")
                        : activeWlChapter
                            ? t("page.prediction.wl.chapterItem", { no: activeWlChapter.chapterNo, name: getCharacterName(t, activeWlChapter.gameCharacterId) })
                            : ""}
                </span>
            </div>
            <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
                {/* Overall Button */}
                <button
                    type="button"
                    onClick={() => setSelectedWlChapter("overall")}
                    className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all shrink-0 border ${
                        selectedWlChapter === "overall"
                            ? "bg-miku text-white border-miku shadow-sm shadow-miku/30"
                            : "bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                    }`}
                >
                    <span>🌟</span>
                    <span>{t("page.prediction.wl.overall")}</span>
                </button>

                {/* Character Chapter Buttons */}
                {eventWorldBlooms.map((wb) => {
                    const isSelected = selectedWlChapter === wb.gameCharacterId;
                    const isOngoing = now >= wb.chapterStartAt && now <= wb.aggregateAt;
                    const isEnded = now > wb.aggregateAt;
                    const statusKey = isOngoing ? "ongoing" : isEnded ? "ended" : "upcoming";

                    return (
                        <button
                            key={wb.gameCharacterId}
                            type="button"
                            onClick={() => setSelectedWlChapter(wb.gameCharacterId)}
                            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all shrink-0 border ${
                                isSelected
                                    ? "bg-miku text-white border-miku shadow-sm shadow-miku/30"
                                    : "bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                            }`}
                        >
                            <div className="relative w-4 h-4 rounded-full overflow-hidden shrink-0 border border-white/40">
                                <Image
                                    src={getCharacterIconUrl(wb.gameCharacterId)}
                                    alt={getCharacterName(t, wb.gameCharacterId)}
                                    fill
                                    className="object-cover"
                                    unoptimized
                                />
                            </div>
                            <span>
                                {t("page.prediction.wl.chapterItem", {
                                    no: wb.chapterNo,
                                    name: getCharacterName(t, wb.gameCharacterId)
                                })}
                            </span>
                            <span className={`text-[10px] px-1.5 py-0.2 rounded font-medium ${
                                isSelected
                                    ? "bg-white/20 text-white"
                                    : isOngoing
                                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                                        : isEnded
                                            ? "bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400"
                                            : "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                            }`}>
                                {t(`page.prediction.wl.chapterStatus.${statusKey}`)}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/** Server / event / WL-chapter selectors shared by the prediction page and the planner. */
export function PredictionEventPicker({ state }: PredictionEventPickerProps) {
    return (
        <>
            <PredictionServerEventControls state={state} />
            <PredictionWlChapterBar state={state} />
        </>
    );
}

export default PredictionEventPicker;
