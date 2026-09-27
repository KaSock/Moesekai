"use client";
import React, { useMemo, useState } from "react";
import { useI18n } from "@/contexts/I18nContext";
import CollapsibleBlock from "./CollapsibleBlock";

export interface SongGainView {
    key: string;
    title: string;
    /** Translated title, shown under the original when present. */
    subtitle?: string;
    difficulty: string;
    ptPerPlay: number;
    ptPerHour: number;
    /** null at 0 fire (no stamina spent). */
    ptPerStamina: number | null;
}

type SortKey = "ptPerPlay" | "ptPerHour" | "ptPerStamina";

interface SongGainTableProps {
    rows: SongGainView[];
    selectedKey: string | null;
    onUse(key: string): void;
    /** Rows shown besides the pinned current song; default 10. */
    limit?: number;
}

export const DIFFICULTY_BADGE_COLORS: Record<string, string> = {
    easy: "bg-blue-500 text-white",
    normal: "bg-green-500 text-white",
    hard: "bg-amber-500 text-white",
    expert: "bg-red-500 text-white",
    master: "bg-purple-500 text-white",
    append: "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900",
};

/** Splits off the last word (a trailing Latin/digit run, else the last character) so the sort arrow can stay on its line. */
function splitLastWord(label: string): [string, string] {
    const i = label.search(/(?:[A-Za-z0-9]+|\S)$/);
    return i > 0 ? [label.slice(0, i), label.slice(i)] : ["", label];
}

function sortValue(row: SongGainView, key: SortKey): number {
    const v = row[key];
    return v === null ? -Infinity : v;
}

/** Per-song PT for the chosen deck: PT per play, per hour and per stamina, with a switch-song action. */
export default function SongGainTable({ rows, selectedKey, onUse, limit = 10 }: SongGainTableProps) {
    const { t, formatNumber } = useI18n();
    const [sortKey, setSortKey] = useState<SortKey>("ptPerHour");

    const visible = useMemo(() => {
        const sorted = [...rows].sort((a, b) => sortValue(b, sortKey) - sortValue(a, sortKey));
        const top = sorted.slice(0, limit);
        if (selectedKey && !top.some((r) => r.key === selectedKey)) {
            const current = rows.find((r) => r.key === selectedKey);
            if (current) top.push(current);
        }
        return top;
    }, [rows, sortKey, limit, selectedKey]);

    if (rows.length === 0) return null;

    // h-px on the cell lets the button's h-full resolve to the row height, so the whole cell is the tap target.
    // On phones the button is two label lines tall, so a label that wraps once the arrow is added keeps the row height.
    const header = (key: SortKey, label: string, width: string, last = false) => {
        const sorted = sortKey === key;
        const [head, tail] = splitLastWord(label);
        return (
            <th className={`${width} h-px p-0 text-right align-bottom font-medium`}>
                <button
                    type="button"
                    onClick={() => setSortKey(key)}
                    aria-pressed={sorted}
                    className={`flex h-full min-h-10 sm:min-h-0 w-full items-end justify-end py-1.5 pl-1 ${last ? "pr-2" : ""} text-right leading-tight whitespace-normal ${sorted ? "text-miku font-bold" : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"}`}
                >
                    {sorted ? (
                        // The arrow flows inline after the label, kept on one line with the last word.
                        <span>
                            {head}
                            <span className="whitespace-nowrap">
                                {tail}
                                <svg className="inline-block w-3 h-3 ml-0.5 align-[-2px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                                </svg>
                            </span>
                        </span>
                    ) : (
                        <span>{label}</span>
                    )}
                </button>
            </th>
        );
    };

    return (
        <CollapsibleBlock title={t("page.predictionPlanner.pt.songGain.title")}>
            <div className="overflow-x-auto rounded-xl border border-slate-100 dark:border-slate-800">
                <table className="w-full table-fixed text-[11px]">
                    <thead className="bg-slate-50 dark:bg-slate-800/60">
                        <tr>
                            <th className="py-1.5 px-2 text-left align-bottom font-medium text-slate-400">
                                {t("page.predictionPlanner.pt.songGain.columns.song")}
                            </th>
                            {header("ptPerPlay", t("page.predictionPlanner.pt.songGain.columns.ptPerPlay"), "w-[3.6rem] sm:w-24")}
                            {header("ptPerHour", t("page.predictionPlanner.pt.songGain.columns.ptPerHour"), "w-[4.1rem] sm:w-28")}
                            {/* Wide enough for the bold en "stamina" plus the arrow on one line. */}
                            {header("ptPerStamina", t("page.predictionPlanner.pt.songGain.columns.ptPerStamina"), "w-[4.5rem] sm:w-28", true)}
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((row) => {
                            const selected = row.key === selectedKey;
                            return (
                                <tr
                                    key={row.key}
                                    className={`border-t border-slate-100 dark:border-slate-800 ${selected ? "bg-miku/5 dark:bg-miku/10" : ""}`}
                                >
                                    <td className="py-1.5 px-2 align-top min-w-0">
                                        <div className={`truncate font-bold ${selected ? "text-miku" : "text-slate-700 dark:text-slate-200"}`} title={row.title}>
                                            {row.title}
                                        </div>
                                        {row.subtitle && (
                                            <div className="truncate text-[10px] text-slate-400" title={row.subtitle}>{row.subtitle}</div>
                                        )}
                                        <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                                            <span className={`px-1 rounded text-[9px] font-bold uppercase leading-4 ${DIFFICULTY_BADGE_COLORS[row.difficulty] ?? "bg-slate-400 text-white"}`}>
                                                {row.difficulty}
                                            </span>
                                            {!selected && (
                                                <button
                                                    type="button"
                                                    onClick={() => onUse(row.key)}
                                                    className="-my-1.5 -mx-1.5 px-1.5 py-1.5 rounded-md text-[10px] font-bold text-miku hover:underline whitespace-nowrap"
                                                >
                                                    {t("page.predictionPlanner.pt.songGain.use")}
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                    <td className="py-1.5 pl-1 text-right align-top font-mono text-slate-600 dark:text-slate-300">
                                        {formatNumber(Math.round(row.ptPerPlay))}
                                    </td>
                                    <td className="py-1.5 pl-1 text-right align-top font-mono font-bold text-slate-700 dark:text-slate-200">
                                        {formatNumber(Math.round(row.ptPerHour))}
                                    </td>
                                    <td className="py-1.5 pl-1 pr-2 text-right align-top font-mono text-slate-600 dark:text-slate-300">
                                        {row.ptPerStamina === null ? "-" : formatNumber(Math.round(row.ptPerStamina))}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </CollapsibleBlock>
    );
}
