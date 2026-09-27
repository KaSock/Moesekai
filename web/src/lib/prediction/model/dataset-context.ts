// PredictionContext for a backtest dataset event; buildPredictionContext (live) must yield the same fields.
import type { EventGroup } from "../../event-rules/types";
import type { DatasetEvent, DatasetScope, PredictionContext } from "./types";

type DatasetChapter = DatasetEvent["chapters"][number];

const HOUR_MS = 3_600_000;

export function findScopeChapter(ev: DatasetEvent, scope: DatasetScope): DatasetChapter | null {
    if (scope.kind !== "chapter") return null;
    const chapter = ev.chapters.find((c) => c.gameCharacterId === scope.gameCharacterId);
    if (!chapter) {
        throw new Error(`${ev.region} #${ev.eventId}: no chapter for character ${scope.gameCharacterId}`);
    }
    return chapter;
}

export function scopeWindow(ev: DatasetEvent, scope: DatasetScope): { startAt: number; endAt: number } {
    const chapter = ev.isFinale ? null : findScopeChapter(ev, scope);
    return chapter
        ? { startAt: chapter.startAt, endAt: chapter.aggregateAt }
        : { startAt: ev.startAt, endAt: ev.aggregateAt };
}

/** Same rule as resolveEventRules: finale first, then WL overall / chapter by chapter length, else normal. */
export function scopeGroup(ev: DatasetEvent, scope: DatasetScope): EventGroup {
    if (ev.isFinale) return "wl_finale";
    if (ev.eventType !== "world_bloom" || ev.chapters.length === 0) return "normal";
    const chapter = findScopeChapter(ev, scope);
    if (!chapter) return "wl_overall";
    const hours = Math.round((chapter.aggregateAt - chapter.startAt) / HOUR_MS);
    return hours > 60 ? "wl_chapter_72h" : "wl_chapter_48h";
}

/**
 * `atMs` is accepted for signature parity with the live builder; the context itself does not depend on it.
 * `jpSameIdFinal` is kept for CN events only.
 */
export function contextFromDataset(
    ev: DatasetEvent,
    scope: DatasetScope,
    _atMs: number,
    otherTiers: ReadonlyArray<{ rank: number; score: number }>,
    jpSameIdFinal: Readonly<Record<number, number>> | null,
): PredictionContext {
    const chapter = ev.isFinale ? null : findScopeChapter(ev, scope);
    const window = scopeWindow(ev, scope);
    return {
        region: ev.region,
        eventId: ev.eventId,
        group: scopeGroup(ev, scope),
        wlTurn: ev.wlTurn,
        chapterCharacterId: chapter ? chapter.gameCharacterId : null,
        chapterNo: chapter ? chapter.chapterNo : null,
        autoSpecialMeasure: ev.autoSpecialMeasure,
        scopeStartAt: window.startAt,
        scopeEndAt: window.endAt,
        eventEndAt: ev.aggregateAt,
        breakGauge: ev.breakTimeId != null,
        unit: ev.unit,
        bannerCharacterId: ev.bannerCharacterId,
        jpSameIdFinal: ev.region === "cn" ? jpSameIdFinal : null,
        otherTiers: [...otherTiers].sort((a, b) => a.rank - b.rank).map((t) => ({ rank: t.rank, score: t.score })),
    };
}
