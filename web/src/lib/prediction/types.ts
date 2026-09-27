// Types of the event-data hook shared by the prediction page and the planner.
import type { EventListItem, PredictionData, ServerType } from "@/types/prediction";
import type { IEventInfo } from "@/types/events";

export interface WorldBloomChapterRow {
    id: number;
    eventId: number;
    gameCharacterId: number;
    chapterNo: number;
    chapterStartAt: number;
    aggregateAt: number;
    chapterEndAt: number;
    isSupplemental?: boolean;
    worldBloomChapterType?: string;
}

export interface UsePredictionEventOptions {
    initialServer?: ServerType;
    initialEventId?: number | null;
    initialChapter?: "overall" | number;
}

export interface PredictionEventState {
    server: ServerType;
    setServer(server: ServerType): void;
    events: EventListItem[];
    eventsLoading: boolean;
    masterEvents: IEventInfo[];
    selectedEventId: number | null;
    setSelectedEventId(id: number | null): void;
    eventMeta: EventListItem | null;
    masterEvent: IEventInfo | null;
    /** WL chapters of the event in masterdata order; empty for non-WL events. */
    eventWorldBlooms: WorldBloomChapterRow[];
    isWorldBloomEvent: boolean;
    selectedWlChapter: "overall" | number;
    setSelectedWlChapter(chapter: "overall" | number): void;
    /** Data for the selected scope (chapter scopes recomputed per chapter). */
    activePredictionData: PredictionData | null;
    scopeStartAt: number | null;
    scopeEndAt: number | null;
    loading: boolean;
    error: string | null;
    now: number;
}
