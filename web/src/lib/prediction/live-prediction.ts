// Prediction runtime of the prediction pages: per-event context sources, scope contexts and the live-sync
// recomputation. Kept apart from prediction-api.ts and ranking-sync.ts so pages that only need the event list
// or the sync bus (realtime ranking) do not load the engine and priors.json; prediction-api imports it lazily.

import type { PredictionData, RankChart, ServerType, TierKLine } from '@/types/prediction';
import { calculateEventPrediction } from '@/lib/prediction-engine';
import type { LiveRankingSyncPayload } from '@/lib/ranking-sync';
import { fetchMasterDataForServer } from '@/lib/fetch';
import { resolveEventRules } from '@/lib/event-rules';
import type { EventRules, EventRulesMasterdata, RuleScope } from '@/lib/event-rules/types';
import {
    PREDICTION_CONTEXT_META_TABLES,
    PREDICTION_CONTEXT_RULE_TABLES,
    bannerCharacterIdOf,
    buildPredictionContext,
    eventUnitOf,
    fallbackPredictionContext,
    type FallbackPredictionContextArgs,
    type PredictionContextFactory,
    type PredictionEventMeta,
} from '@/lib/prediction/model/context';
import type { DatasetFinal, PredictionContext } from '@/lib/prediction/model/types';

export { calculateEventPrediction };

// ─── Prediction context source (event rules, event meta, JP finals for CN) ───

type MasterRows = ReadonlyArray<Record<string, unknown>>;

/** Tables without which no context can be resolved; the others may be missing (404) for a region. */
const REQUIRED_CONTEXT_TABLES: ReadonlySet<string> = new Set(['events', 'worldBlooms']);

/**
 * Chapter reward tiers live in their own table. Only the page rows read it: the context keeps resolving from
 * PREDICTION_CONTEXT_RULE_TABLES, so the model's inputs (other tiers filtered by rankingTiers) stay unchanged.
 */
const REWARD_TIER_TABLES: readonly string[] = ['worldBloomChapterRankingRewardRanges'];

/** A stalled masterdata request must not hold back the ranking data; the fallback context is used meanwhile. */
const CONTEXT_WAIT_MS = 10_000;

interface ContextMasterdata {
    rules: EventRulesMasterdata;
    /** rules plus REWARD_TIER_TABLES. */
    rewardRules: EventRulesMasterdata;
    eventStories: MasterRows | undefined;
    gameCharacterUnits: MasterRows | undefined;
}

export interface PredictionContextSource {
    region: ServerType;
    eventId: number;
    /** Rules of a scope without user overrides; null when masterdata lacks the event or the chapter. */
    rulesFor(scope: RuleScope): EventRules | null;
    /** The scope's reward tiers (a chapter's own tiers included); null when masterdata lacks the event or the chapter. */
    rewardTiersFor(scope: RuleScope): readonly number[] | null;
    event: PredictionEventMeta;
    /** Committed JP finals table; loaded for CN only (the JP same-id final is CN's strongest prior). */
    jpFinals: ReadonlyArray<DatasetFinal> | null;
}

const contextMasterdataByRegion = new Map<ServerType, Promise<ContextMasterdata>>();
const contextSourceByEvent = new Map<string, Promise<PredictionContextSource>>();
let jpFinalsPromise: Promise<ReadonlyArray<DatasetFinal>> | null = null;

function cacheUntilRejected<K, V>(cache: Map<K, Promise<V>>, key: K, pending: Promise<V>): Promise<V> {
    cache.set(key, pending);
    pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
    });
    return pending;
}

function loadContextMasterdata(server: ServerType): Promise<ContextMasterdata> {
    const cached = contextMasterdataByRegion.get(server);
    if (cached) return cached;
    const tables = [...PREDICTION_CONTEXT_RULE_TABLES, ...REWARD_TIER_TABLES, ...PREDICTION_CONTEXT_META_TABLES];
    const pending = Promise.all(tables.map(async (table) => {
        try {
            const rows = await fetchMasterDataForServer<MasterRows>(server, `${table}.json`);
            return [table, Array.isArray(rows) ? rows : undefined] as const;
        } catch (err) {
            if (REQUIRED_CONTEXT_TABLES.has(table)) throw err;
            return [table, undefined] as const;
        }
    })).then((entries) => {
        const byTable = new Map(entries);
        const rules: EventRulesMasterdata = { events: byTable.get('events') ?? [], worldBlooms: byTable.get('worldBlooms') ?? [] };
        for (const table of PREDICTION_CONTEXT_RULE_TABLES) {
            const rows = byTable.get(table);
            if (rows) rules[table] = rows;
        }
        const rewardRules: EventRulesMasterdata = { ...rules };
        for (const table of REWARD_TIER_TABLES) {
            const rows = byTable.get(table);
            if (rows) rewardRules[table] = rows;
        }
        return { rules, rewardRules, eventStories: byTable.get('eventStories'), gameCharacterUnits: byTable.get('gameCharacterUnits') };
    });
    return cacheUntilRejected(contextMasterdataByRegion, server, pending);
}

function loadJpFinals(): Promise<ReadonlyArray<DatasetFinal>> {
    if (!jpFinalsPromise) {
        const pending = import('../../../scripts/prediction-backtest/data/finals-jp.json')
            .then((mod) => mod.default as unknown as ReadonlyArray<DatasetFinal>);
        jpFinalsPromise = pending;
        pending.catch(() => {
            if (jpFinalsPromise === pending) jpFinalsPromise = null;
        });
    }
    return jpFinalsPromise;
}

/** Everything buildPredictionContext needs for one event, cached per server and event. */
export function loadPredictionContextSource(server: ServerType, eventId: number): Promise<PredictionContextSource> {
    const key = `${server}:${eventId}`;
    const cached = contextSourceByEvent.get(key);
    if (cached) return cached;
    const pending = Promise.all([
        loadContextMasterdata(server),
        server === 'cn' ? loadJpFinals() : Promise.resolve(null),
    ]).then(([md, jpFinals]): PredictionContextSource => {
        const eventRow = md.rules.events.find((row) => row.id === eventId);
        const resolveScope = (masterdata: EventRulesMasterdata, scope: RuleScope): EventRules | null => {
            let rules: EventRules | null = null;
            try {
                rules = resolveEventRules({ region: server, eventId, masterdata, scope });
            } catch {
                rules = null;
            }
            // resolveEventRules falls back to the overall scope for a chapter it does not know.
            return rules && scope.kind === 'chapter' && rules.scope.kind !== 'chapter' ? null : rules;
        };
        const scopeKeyOf = (scope: RuleScope) => (scope.kind === 'chapter' ? `chapter:${scope.gameCharacterId}` : 'overall');
        const rulesByScope = new Map<string, EventRules | null>();
        const rewardTiersByScope = new Map<string, readonly number[] | null>();
        return {
            region: server,
            eventId,
            rulesFor(scope) {
                const scopeKey = scopeKeyOf(scope);
                if (!rulesByScope.has(scopeKey)) rulesByScope.set(scopeKey, resolveScope(md.rules, scope));
                return rulesByScope.get(scopeKey) ?? null;
            },
            rewardTiersFor(scope) {
                const scopeKey = scopeKeyOf(scope);
                if (!rewardTiersByScope.has(scopeKey)) {
                    rewardTiersByScope.set(scopeKey, resolveScope(md.rewardRules, scope)?.rankingTiers ?? null);
                }
                return rewardTiersByScope.get(scopeKey) ?? null;
            },
            event: {
                unit: eventUnitOf(eventRow),
                bannerCharacterId: bannerCharacterIdOf(eventId, md.eventStories, md.gameCharacterUnits),
            },
            jpFinals,
        };
    });
    return cacheUntilRejected(contextSourceByEvent, key, pending);
}

/** The context source, or null when it fails or takes longer than CONTEXT_WAIT_MS. */
export function awaitContextSource(server: ServerType, eventId: number): Promise<PredictionContextSource | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), CONTEXT_WAIT_MS);
        loadPredictionContextSource(server, eventId).then(
            (source) => resolve(source),
            (err) => {
                console.warn('[live-prediction] Prediction context unavailable, using the fallback context:', err);
                resolve(null);
            },
        ).finally(() => clearTimeout(timer));
    });
}

/**
 * Context of one scope at one snapshot. Without rules for the scope (source missing, event or chapter not in
 * masterdata) the fallback context describes the scope from the caller's window with an unknown WL turn.
 */
export function predictionContextFor(
    source: PredictionContextSource | null,
    scope: RuleScope,
    otherTiers: ReadonlyArray<{ rank: number; score: number }>,
    fallback: Omit<FallbackPredictionContextArgs, 'otherTiers'>,
): PredictionContext {
    const rules = source && source.region === fallback.region && source.eventId === fallback.eventId
        ? source.rulesFor(scope)
        : null;
    return rules && source
        ? buildPredictionContext({ rules, event: source.event, otherTiers, jpFinals: source.jpFinals })
        : fallbackPredictionContext({ ...fallback, otherTiers });
}

// ─── Live ranking sync: incremental recomputation ─────────────────────────────

/**
 * Merges a LiveRankingSyncPayload into an existing PredictionData instance.
 * Updates current scores and recalculates the predictions in-memory; `contextFor` builds the prediction
 * context of the data's scope from the payload's same-moment tier scores.
 */
export function applyLiveSyncToPrediction(
    currentData: PredictionData,
    syncPayload: LiveRankingSyncPayload,
    server: ServerType,
    eventStartAt: number | undefined,
    eventEndAt: number | undefined,
    contextFor: PredictionContextFactory,
): PredictionData {
    if (!currentData || !currentData.data || !Array.isArray(currentData.data.charts)) {
        return currentData;
    }
    if (syncPayload.eventId && currentData.data.event_id && syncPayload.eventId !== currentData.data.event_id) {
        return currentData;
    }

    const context = contextFor(Object.values(syncPayload.tierScores).map((t) => ({ rank: t.rank, score: t.score })));

    const updatedCharts: RankChart[] = currentData.data.charts.map((chart) => {
        const tierUpdate = syncPayload.tierScores[chart.Rank];
        if (!tierUpdate) return chart;

        const newScore = tierUpdate.score;
        const syncIsoTime = new Date(syncPayload.updatedAt).toISOString();

        // Update history points
        let nextHistory = [...chart.HistoryPoints];
        if (nextHistory.length > 0) {
            const lastPoint = nextHistory[nextHistory.length - 1];
            const lastTimeMs = new Date(lastPoint.t).getTime();
            // If the latest point is within 60s of the sync time, update it in place; otherwise append
            if (Math.abs(syncPayload.updatedAt - lastTimeMs) < 60_000) {
                nextHistory[nextHistory.length - 1] = { t: syncIsoTime, y: newScore };
            } else if (syncPayload.updatedAt > lastTimeMs) {
                nextHistory.push({ t: syncIsoTime, y: newScore });
            }
        } else {
            nextHistory = [{ t: syncIsoTime, y: newScore }];
        }

        let predictedScore = chart.PredictedScore;
        let predictedScoreP10 = chart.PredictedScoreP10;
        let predictedScoreP90 = chart.PredictedScoreP90;
        let predictPoints = chart.PredictPoints;

        const startAt = eventStartAt || (nextHistory.length > 0 ? new Date(nextHistory[0].t).getTime() : 0);
        const endAt = eventEndAt || (startAt > 0 ? startAt + (9 * 24 * 3600000) : 0);

        if (startAt > 0 && endAt > startAt && nextHistory.length > 0) {
            const engineResult = calculateEventPrediction({
                server,
                rank: chart.Rank,
                startAt,
                endAt,
                historyPoints: nextHistory,
                context,
            });

            predictedScore = engineResult.predictedScore;
            predictedScoreP10 = engineResult.predictedScoreP10;
            predictedScoreP90 = engineResult.predictedScoreP90;
            predictPoints = engineResult.predictPoints;
        }

        return {
            ...chart,
            CurrentScore: newScore,
            PredictedScore: predictedScore,
            PredictedScoreP10: predictedScoreP10,
            PredictedScoreP90: predictedScoreP90,
            HistoryPoints: nextHistory,
            PredictPoints: predictPoints,
        };
    });

    const elapsedHours = eventStartAt ? Math.max(0.1, (syncPayload.updatedAt - eventStartAt) / 3600000) : 1;
    const existingTierKlines = currentData.data.tier_klines || [];
    const updatedTierKlines: TierKLine[] = updatedCharts.map((chart) => {
        const existing = existingTierKlines.find(t => t.Rank === chart.Rank);
        const speed = existing?.Speed ?? (elapsedHours > 0 ? Math.round(chart.CurrentScore / elapsedHours) : 0);
        return {
            Rank: chart.Rank,
            Data: existing?.Data || [],
            CurrentIndex: existing?.CurrentIndex ?? null,
            Speed: speed,
            ChangePct: existing?.ChangePct ?? 0,
        };
    });

    return {
        ...currentData,
        timestamp: syncPayload.updatedAt,
        data: {
            ...currentData.data,
            charts: updatedCharts,
            tier_klines: updatedTierKlines,
        },
    };
}
