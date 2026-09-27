// Remaining WL chapter windows for the planner.
import type { EventRules } from "../event-rules/types";
import type { ChapterWindow } from "./types";

/**
 * WL chapters whose scoring window ends after `now`, in start order; the running chapter is clipped to start at `now`.
 * A window ends at the chapter's aggregateAt (points stop counting there; endAt only closes the result display).
 * Normal events have no chapters and give an empty list; a finale gives its single chapter.
 */
export function remainingChapterWindows(rules: EventRules, now: number): ChapterWindow[] {
    return rules.chapters
        .filter((chapter) => chapter.aggregateAt > now)
        .sort((a, b) => a.startAt - b.startAt || a.chapterNo - b.chapterNo)
        .map((chapter) => ({
            chapterNo: chapter.chapterNo,
            gameCharacterId: chapter.gameCharacterId,
            startAt: Math.max(chapter.startAt, now),
            endAt: chapter.aggregateAt,
        }));
}
