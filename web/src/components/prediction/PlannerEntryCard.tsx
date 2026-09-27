"use client";
import React from "react";
import Link from "@/components/LocalizedLink";
import { useI18n } from "@/contexts/I18nContext";
import type { ServerType } from "@/types/prediction";

interface PlannerEntryCardProps {
    server: ServerType;
    eventId: number;
    /** "overall" or the WL chapter's gameCharacterId. */
    chapter: "overall" | number;
}

export function buildPlannerHref(server: ServerType, eventId: number, chapter: "overall" | number): string {
    const params = new URLSearchParams({ server, event: String(eventId), chapter: String(chapter) });
    return `/prediction-next/planner/?${params.toString()}`;
}

/** Link card from the prediction page to the ranking-goal planner, carrying server, event and chapter. */
export function PlannerEntryCard({ server, eventId, chapter }: PlannerEntryCardProps) {
    const { t } = useI18n();

    return (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4 sm:p-6 shadow-sm mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
                <div className="w-10 h-10 shrink-0 rounded-xl bg-miku/10 text-miku flex items-center justify-center">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                </div>
                <div className="min-w-0">
                    <h3 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                        {t("page.predictionPlanner.entryCard.title")}
                    </h3>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        {t("page.predictionPlanner.entryCard.description")}
                    </p>
                </div>
            </div>
            <Link
                href={buildPlannerHref(server, eventId, chapter)}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-miku text-white text-sm font-bold shadow-sm shadow-miku/30 hover:opacity-90 active:scale-[0.98] transition-all shrink-0"
            >
                <span>{t("page.predictionPlanner.entryCard.action")}</span>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
            </Link>
        </div>
    );
}

export default PlannerEntryCard;
