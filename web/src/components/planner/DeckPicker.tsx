"use client";
import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/contexts/I18nContext";
import SekaiCardThumbnail from "@/components/cards/SekaiCardThumbnail";
import { fetchMasterDataForServer } from "@/lib/fetch";
import type { ICardInfo } from "@/types/types";
import type { PlannerDeckOption } from "@/lib/deck-recommend/planner-types";

interface DeckPickerProps {
    options: PlannerDeckOption[];
    selectedRank: number | null;
    onSelect(rank: number): void;
}

function formatPercent(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Radio list of the engine's top decks; the chosen deck feeds the PT plan and the song-gain table. */
export default function DeckPicker({ options, selectedRank, onSelect }: DeckPickerProps) {
    const { t, formatNumber } = useI18n();
    const [cardsMaster, setCardsMaster] = useState<ICardInfo[]>([]);

    const hasOptions = options.length > 0;
    useEffect(() => {
        if (!hasOptions) return;
        let cancelled = false;
        // JP holds every card id CN has, matching the deck-recommend page.
        fetchMasterDataForServer<ICardInfo[]>("jp", "cards.json")
            .then((cards) => {
                if (!cancelled) setCardsMaster(cards);
            })
            .catch(() => {
                if (!cancelled) setCardsMaster([]);
            });
        return () => {
            cancelled = true;
        };
    }, [hasOptions]);

    const cardById = useMemo(() => new Map(cardsMaster.map((c) => [c.id, c])), [cardsMaster]);

    if (!hasOptions) return null;

    return (
        <div>
            <h3 className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-2">
                {t("page.predictionPlanner.pt.deck.resultsTitle", { count: options.length })}
            </h3>
            <div role="radiogroup" className="space-y-2">
                {options.map((option) => {
                    const selected = option.rank === selectedRank;
                    return (
                        <button
                            key={option.rank}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => onSelect(option.rank)}
                            className={`w-full text-left rounded-xl border p-3 transition-all ${selected
                                ? "border-miku bg-miku/5 dark:bg-miku/10 shadow-sm shadow-miku/20"
                                : "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 hover:border-miku/50"
                                }`}
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                <span
                                    aria-hidden="true"
                                    className={`w-4 h-4 shrink-0 rounded-full border-2 flex items-center justify-center ${selected ? "border-miku" : "border-slate-300 dark:border-slate-600"}`}
                                >
                                    {selected && <span className="w-2 h-2 rounded-full bg-miku" />}
                                </span>
                                <span className={`text-sm font-black ${option.rank === 1 ? "text-miku" : "text-slate-400 dark:text-slate-500"}`}>
                                    #{option.rank}
                                </span>
                                <span className="text-base font-black font-mono text-slate-800 dark:text-slate-100 truncate">
                                    {formatNumber(option.eventPoint)}
                                </span>
                                <span className="text-[10px] text-slate-400 whitespace-nowrap">
                                    {t("page.predictionPlanner.pt.deck.columns.ptPerPlay")}
                                </span>
                                <span className={`ml-auto shrink-0 text-[11px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap ${selected
                                    ? "bg-miku text-white"
                                    : "bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700"
                                    }`}>
                                    {selected ? t("page.predictionPlanner.pt.deck.selected") : t("page.predictionPlanner.pt.deck.select")}
                                </span>
                            </div>
                            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400 pl-6">
                                <span>
                                    {t("page.predictionPlanner.pt.deck.columns.power")}{" "}
                                    <span className="font-mono font-bold text-slate-700 dark:text-slate-200">{formatNumber(option.totalPower)}</span>
                                </span>
                                <span>
                                    {t("page.predictionPlanner.pt.deck.columns.bonus")}{" "}
                                    <span className="font-mono font-bold text-amber-600 dark:text-amber-400">{formatPercent(option.eventBonus)}%</span>
                                </span>
                                <span>
                                    {t("page.predictionPlanner.pt.deck.columns.effectiveSkill")}{" "}
                                    <span className="font-mono font-bold text-slate-700 dark:text-slate-200">{formatPercent(option.effectiveSkill)}%</span>
                                </span>
                            </div>
                            <div className="mt-2 flex gap-1.5 pl-6">
                                {option.cards.slice(0, 5).map((card, i) => {
                                    const master = cardById.get(card.cardId);
                                    const isBirthday = card.rarity === "rarity_birthday" || master?.cardRarityType === "rarity_birthday";
                                    const trained = (card.rarity === "rarity_3" || card.rarity === "rarity_4") && !isBirthday;
                                    return (
                                        <span key={`${card.cardId}-${i}`} className="relative block w-10 h-10 shrink-0">
                                            {master ? (
                                                <SekaiCardThumbnail card={master} trained={trained} mastery={card.masterRank} width={40} />
                                            ) : (
                                                <span className="flex w-10 h-10 rounded bg-slate-100 dark:bg-slate-800 items-center justify-center text-[10px] text-slate-400">?</span>
                                            )}
                                            {i === 0 && (
                                                <span className="absolute bottom-0 right-0 bg-miku/90 text-white text-[8px] font-bold px-1 py-[1px] rounded-tl-md leading-none">L</span>
                                            )}
                                        </span>
                                    );
                                })}
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
