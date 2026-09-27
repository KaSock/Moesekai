// Deck-engine types used by the planner (the planner subset of useDeckEngine).
import type { DeckLiveType, DeckResultCard } from "./engine-types";

export type PlannerLiveType = Extract<DeckLiveType, "multi" | "solo" | "auto" | "cheerful">;

export interface PlannerDeckRequest {
    server: "jp" | "cn";
    userId: string;
    eventId: number;
    eventType: string;
    liveType: PlannerLiveType;
    musicId: number;
    difficulty: string;
    /** 0-10 fires. */
    boost: number;
    /** WL chapter character; for the overall scope pass each chapter's character in turn. */
    supportCharacterId?: number;
    /** Default 5. */
    limit?: number;
}

export interface PlannerDeckOption {
    rank: number;
    /** PT per play with the fire multiplier for boost applied (W3 documents the measured engine behaviour). */
    eventPoint: number;
    liveScore: number;
    totalPower: number;
    eventBonus: number;
    effectiveSkill: number;
    cards: DeckResultCard[];
}

/** Manual parameters (mode B); also used to turn the deck chosen in mode A into a song-gain request. */
export interface PlannerDeckProfile {
    totalPower: number;
    /** Total event bonus in percentage points. */
    eventBonusRate: number;
    /** Score-up skill of the 5 cards in percentage points; index 0 is the leader. */
    skillScoreUps: [number, number, number, number, number];
}

export interface PlannerSongGainRow {
    musicId: number;
    difficulty: string;
    title: string;
    seconds: number;
    liveScore: number;
    /** PT per play without the fire multiplier (engine convention). */
    ptPerPlayNoBoost: number;
    ptPerPlay: number;
    playsPerHour: number;
    ptPerHour: number;
    ptPerStamina: number;
}

export interface PlannerSongGainRequest {
    server: "jp" | "cn";
    eventId: number;
    eventType: string;
    liveType: PlannerLiveType;
    boost: number;
    profile: PlannerDeckProfile;
    /** Multi-live teammate parameters; the theoretical maximum for the Auto special-measure lower bound. */
    teammates?: { power?: number; scoreUp?: number };
    /** Seconds between plays; default multi 50 / solo 30. */
    gapSeconds?: number;
}

export interface PlannerDeckEngine {
    status: "idle" | "warming" | "ready" | "error";
    error: string | null;
    progress: { percent: number; label: string } | null;
    recommend(req: PlannerDeckRequest): Promise<PlannerDeckOption[]>;
    songGains(req: PlannerSongGainRequest): Promise<PlannerSongGainRow[]>;
    cancel(): void;
}

/** Account saved by the deck-recommend page (localStorage and account list); null when none. */
export interface PlannerAccount {
    server: "jp" | "cn";
    userId: string;
}
