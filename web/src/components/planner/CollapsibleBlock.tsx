"use client";
import React, { useId, useState } from "react";
import { useI18n } from "@/contexts/I18nContext";

interface CollapsibleBlockProps {
    title: React.ReactNode;
    children: React.ReactNode;
}

/** Titled sub-section with a show/hide toggle, open by default; hiding keeps the content mounted. */
export default function CollapsibleBlock({ title, children }: CollapsibleBlockProps) {
    const { t } = useI18n();
    const [open, setOpen] = useState(true);
    const contentId = useId();
    return (
        <div>
            <div className={`flex items-center justify-between gap-2 ${open ? "mb-2" : ""}`}>
                <h3 className="min-w-0 text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider">{title}</h3>
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    aria-expanded={open}
                    aria-controls={contentId}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold text-miku bg-miku/10 hover:bg-miku/20 transition-colors"
                >
                    <span>{open ? t("page.predictionPlanner.pt.sectionCollapse") : t("page.predictionPlanner.pt.sectionExpand")}</span>
                    <svg className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                </button>
            </div>
            <div id={contentId} hidden={!open}>
                {children}
            </div>
        </div>
    );
}
