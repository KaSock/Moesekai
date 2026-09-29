// API utilities for event prediction data
// Data source: rk.exmeaning.com

import {
    PredictionData,
    EventListItem,
    ServerType,
    RkEventItem,
    RkLatestResponse,
    RkKlineResponse,
    RkTimelineResponse,
    KLinePoint,
    TierKLine,
    RankChart,
} from '@/types/prediction';
import {
    dedupeInflight,
    getCachedTimeline,
    setCachedTimeline,
    getCachedKline,
    setCachedKline,
    getCachedEventList,
    setCachedEventList,
    publishRankingSync,
    extractTierScoresFromEntries,
} from '@/lib/ranking-sync';
import { fetchLatestV2, fetchTierSeriesV2 } from '@/lib/realtime-ranking-next-api';
import { fetchMasterDataForServer, fetchMasterData } from '@/lib/fetch';
import { IEventInfo } from '@/types/events';
import type { PredictionContextSource } from '@/lib/prediction/live-prediction';

const BASE_URL = 'https://rk.exmeaning.com';
/** Wait for rk's latest and timeline headers before the page tries the v2 snapshot. */
const RK_TIMEOUT_MS = 3500;
/** Wait on the second rk attempt, made only after the v2 snapshot failed too (rk often takes 2-5 s or answers 525). */
const RK_RETRY_TIMEOUT_MS = 10_000;
/** Tiers built from a v2 snapshot when the event's reward tiers are unknown (masterdata unavailable). */
const TARGET_TIERS = [50, 100, 200, 300, 400, 500, 1000, 2000, 3000, 5000, 10000];

type LivePrediction = typeof import('@/lib/prediction/live-prediction');

let livePredictionPromise: Promise<LivePrediction> | null = null;

/** Engine, priors and context helpers, loaded on first use so event-list-only pages (realtime ranking) skip them. */
function loadLivePrediction(): Promise<LivePrediction> {
    if (!livePredictionPromise) {
        const pending = import('@/lib/prediction/live-prediction');
        livePredictionPromise = pending;
        pending.catch(() => {
            if (livePredictionPromise === pending) livePredictionPromise = null;
        });
    }
    return livePredictionPromise;
}

function tierScoreList(items: ReadonlyArray<{ rank: number; score: number }>): { rank: number; score: number }[] {
    return items.map((item) => ({ rank: item.rank, score: item.score }));
}

/**
 * A running tier's history ending on the snapshot (the timeline is hourly and may be missing), so every tier of
 * one snapshot is predicted from the same moment; without timeline points it runs from the scope start.
 */
function historyEndingOnSnapshot(
    points: ReadonlyArray<{ t: string; y: number }>,
    scopeStartAt: number,
    updatedAt: number,
    score: number,
): { t: string; y: number }[] {
    const out = [...points];
    const last = out[out.length - 1];
    if (!last) {
        return scopeStartAt > 0 && scopeStartAt < updatedAt
            ? [{ t: new Date(scopeStartAt).toISOString(), y: 0 }, { t: new Date(updatedAt).toISOString(), y: score }]
            : [];
    }
    const lastMs = new Date(last.t).getTime();
    const snapshotIso = new Date(updatedAt).toISOString();
    if (Math.abs(updatedAt - lastMs) < 60_000) out[out.length - 1] = { t: snapshotIso, y: score };
    else if (updatedAt > lastMs) out.push({ t: snapshotIso, y: score });
    return out;
}

export async function fetchEventList(server: ServerType): Promise<EventListItem[]> {
    const cached = getCachedEventList(server);
    if (cached) return cached;

    return dedupeInflight(`eventList:${server}`, async () => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3500);
            const response = await fetch(`${BASE_URL}/public/events?region=${server}`, {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (response.ok) {
                const data: RkEventItem[] = await response.json();
                if (Array.isArray(data) && data.length > 0) {
                    const list = data.map(e => ({
                        id: e.event_id,
                        name: e.name,
                        start_at: e.start_at,
                        end_at: e.end_at,
                        is_active: e.status === 'active',
                        has_data: e.has_realtime_data,
                        event_type: e.event_type,
                    }));
                    setCachedEventList(server, list);
                    return list;
                }
            }
        } catch (_err) {
            // Fallback gracefully below
        }

        // Fallback: masterdata events.json + active status from realtime ranking v2
        try {
            const masterEvents = await fetchMasterDataForServer<IEventInfo[]>(server, 'events.json')
                .catch(() => fetchMasterData<IEventInfo[]>('events.json'));
            
            let activeEventId: number | null = null;
            try {
                const latest = await fetchLatestV2(server);
                if (latest?.eventId) activeEventId = latest.eventId;
            } catch {
                // Ignore
            }

            const now = Date.now();
            // Masterdata also lists announced events that have not started; rk's list has only started ones.
            const started = masterEvents.filter(e => e.startAt <= now || e.id === activeEventId);
            const list: EventListItem[] = started.map(e => {
                const isOngoing = (now >= e.startAt && now <= e.aggregateAt) || (activeEventId ? e.id === activeEventId : false);
                return {
                    id: e.id,
                    name: e.name,
                    start_at: e.startAt,
                    end_at: e.aggregateAt,
                    is_active: isOngoing,
                    has_data: isOngoing || e.id === activeEventId,
                    event_type: e.eventType,
                };
            });

            setCachedEventList(server, list);
            return list;
        } catch (fallbackErr) {
            console.error('[prediction-api] Fallback event list failed:', fallbackErr);
            return [];
        }
    });
}

export async function fetchPredictionLatest(eventId: number, server: ServerType): Promise<RkLatestResponse> {
    const region = `region=${server}`;
    const url = `${BASE_URL}/public/event/${eventId}/latest?${region}`;

    return dedupeInflight(`latest:${server}:${eventId}`, async () => {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Failed to fetch latest: ${response.status}`);
        }
        const latest: RkLatestResponse = await response.json();
        const updatedAt = new Date(latest.updated_at).getTime();

        // Publish live sync update to the global bus
        publishRankingSync({
            region: server,
            eventId,
            updatedAt,
            tierScores: extractTierScoresFromEntries(latest.items),
            source: 'prediction',
        });

        return latest;
    });
}

// rk writes kline buckets in Beijing wall-clock time but suffixes them with Z; its timeline endpoint gives the
// same hours as +08:00.
function mapGlobalKline(klineData: RkKlineResponse | null): KLinePoint[] {
    return (klineData?.klines ?? []).map(k => ({
        t: k.time_bucket.replace(/Z$/, '+08:00'),
        o: k.open,
        c: k.close,
        l: k.low,
        h: k.high,
        v: k.volume,
    }));
}

/**
 * rk's kline response of an event (PGAI candles and tier speeds); null when rk fails (it often answers 522/525).
 * Only rk's answers are cached, so a failed load can be asked for again right away.
 */
function fetchRkKline(eventId: number, server: ServerType): Promise<RkKlineResponse | null> {
    const cached = getCachedKline(server, eventId);
    if (cached !== undefined) return Promise.resolve(cached);
    return dedupeInflight(`kline:${server}:${eventId}`, async () => {
        try {
            const res = await fetch(`${BASE_URL}/public/event/${eventId}/kline?region=${server}`, { signal: AbortSignal.timeout(3500) });
            if (!res.ok) return null;
            const data: RkKlineResponse = await res.json();
            setCachedKline(server, eventId, data);
            return data;
        } catch {
            return null;
        }
    });
}

/** PGAI kline of an event; [] when rk fails. */
export function fetchGlobalKline(eventId: number, server: ServerType): Promise<KLinePoint[]> {
    return fetchRkKline(eventId, server).then(mapGlobalKline);
}

async function buildPredictionDataFromRealtimeV2(server: ServerType, eventId: number, globalKline: Promise<KLinePoint[]>): Promise<PredictionData> {
    const livePromise = loadLivePrediction();
    const latestSnapshot = await fetchLatestV2(server);
    // v2 serves only the region's running event; another event's tiers must not be shown under this one.
    if (latestSnapshot.eventId && latestSnapshot.eventId !== eventId) {
        throw new Error(`Realtime snapshot is for event ${latestSnapshot.eventId}, not ${eventId}`);
    }
    const updatedAt = latestSnapshot.updatedAt || Date.now();
    const cachedList = getCachedEventList(server);
    const eventMeta = cachedList?.find(e => e.id === eventId);

    let eventStartAt = latestSnapshot.startAt || 0;
    let eventEndAt = latestSnapshot.endAt || 0;

    if (!eventStartAt || !eventEndAt) {
        if (eventMeta?.start_at && eventMeta?.end_at) {
            eventStartAt = eventMeta.start_at < 10000000000 ? eventMeta.start_at * 1000 : eventMeta.start_at;
            eventEndAt = eventMeta.end_at < 10000000000 ? eventMeta.end_at * 1000 : eventMeta.end_at;
        } else {
            eventStartAt = Date.now() - 4 * 24 * 3600000;
            eventEndAt = eventStartAt + 9 * 24 * 3600000;
        }
    }

    const [live, contextSource] = await Promise.all([
        livePromise,
        livePromise.then((m) => m.awaitContextSource(server, eventId)),
    ]);
    // Rows for the event's reward tiers that the snapshot covers, like the rk path's rows.
    const rewardTiers = contextSource?.rewardTiersFor({ kind: 'overall' }) ?? [];
    const tiers = rewardTiers.length > 0 ? [...rewardTiers] : TARGET_TIERS;
    // Tier-series is optional; fetchTierSeriesV2 carries its own 15s timeout.
    const tierSeriesMap = await fetchTierSeriesV2(server, { tiers })
        .catch((): Record<string, { t: number; s: number }[]> => ({}));
    const context = live.predictionContextFor(contextSource, { kind: 'overall' }, tierScoreList(latestSnapshot.entries), {
        region: server,
        eventId,
        eventType: eventMeta?.event_type,
        startAt: eventStartAt,
        endAt: eventEndAt,
        chapterCharacterId: null,
        chapterNo: null,
    });

    const tierScores = extractTierScoresFromEntries(latestSnapshot.entries);
    publishRankingSync({
        region: server,
        eventId,
        updatedAt,
        tierScores,
        source: 'prediction',
    });

    const charts: RankChart[] = tiers.flatMap(rank => {
        const entry = latestSnapshot.entries.find(e => e.rank === rank);
        const series = tierSeriesMap[String(rank)];
        const hasSeries = Array.isArray(series) && series.length > 0;
        // Like the rk path, a tier the snapshot does not cover gets no row (JP v2 serves only T1-T100 in a finale).
        if (!entry && !hasSeries) return [];
        const currentScore = entry?.score ?? series[series.length - 1].s;

        let historyPoints: { t: string; y: number }[] = [];
        if (hasSeries) {
            historyPoints = series.map(pt => ({
                t: new Date(pt.t).toISOString(),
                y: pt.s,
            }));
        }

        const startIso = new Date(eventStartAt).toISOString();
        const nowIso = new Date(updatedAt).toISOString();
        if (historyPoints.length === 0) {
            historyPoints = [{ t: startIso, y: 0 }, { t: nowIso, y: currentScore }];
        } else {
            if (new Date(historyPoints[0].t).getTime() > eventStartAt + 3600000) {
                historyPoints.unshift({ t: startIso, y: 0 });
            }
            // Per-tier series end at different times; every tier of the snapshot must end at updatedAt.
            const lastPt = historyPoints[historyPoints.length - 1];
            if (Math.abs(new Date(lastPt.t).getTime() - updatedAt) < 60000) {
                historyPoints[historyPoints.length - 1] = { t: nowIso, y: currentScore };
            } else {
                historyPoints.push({ t: nowIso, y: currentScore });
            }
        }

        const engineResult = live.calculateEventPrediction({
            server,
            rank,
            startAt: eventStartAt,
            endAt: eventEndAt,
            historyPoints,
            context,
        });

        return [{
            Rank: rank,
            CurrentScore: currentScore,
            PredictedScore: engineResult.predictedScore,
            PredictedScoreP10: engineResult.predictedScoreP10,
            PredictedScoreP90: engineResult.predictedScoreP90,
            HistoryPoints: historyPoints,
            PredictPoints: engineResult.predictPoints,
        }];
    });

    const elapsedHours = Math.max(0.1, (updatedAt - eventStartAt) / 3600000);
    const tier_klines: TierKLine[] = charts.map(chart => {
        const score = chart.CurrentScore;
        const speed = elapsedHours > 0 ? Math.round(score / elapsedHours) : 0;
        return {
            Rank: chart.Rank,
            Data: [],
            CurrentIndex: null,
            Speed: speed,
            ChangePct: 0,
        };
    });

    return {
        success: true,
        timestamp: updatedAt,
        data: {
            event_id: eventId,
            event_name: eventMeta?.name || '',
            charts,
            global_kline: await globalKline,
            tier_klines,
        },
    };
}

export async function fetchPredictionData(eventId: number, server: ServerType): Promise<PredictionData> {
    const region = `region=${server}`;
    const base = `${BASE_URL}/public/event/${eventId}`;

    return dedupeInflight(`predictionData:${server}:${eventId}`, async () => {
        // Engine and context load in parallel with the ranking requests; the charts wait for them (the context
        // at most CONTEXT_WAIT_MS).
        const livePromise = loadLivePrediction();
        const contextSource: Promise<PredictionContextSource | null> = livePromise.then(
            (live) => live.awaitContextSource(server, eventId),
            () => null,
        );
        // Loads on its own, so a slow or failed latest/timeline request does not take the kline with it.
        const klinePromise = fetchRkKline(eventId, server);
        const globalKline = klinePromise.then(mapGlobalKline);
        /**
         * The event from rk's latest and timeline; null when rk's latest is not OK. `retry` is the second attempt,
         * made after the v2 snapshot failed: it waits longer, and a failed timeline leaves the rows without history.
         */
        const fromRk = async (retry: boolean): Promise<PredictionData | null> => {
            // Check SWR cache for heavy timeline data
            const cachedTimeline = getCachedTimeline(server, eventId);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), retry ? RK_RETRY_TIMEOUT_MS : RK_TIMEOUT_MS);

            const fetchPromises: [Promise<Response>, Promise<Response | null>] = [
                fetch(`${base}/latest?${region}`, { cache: 'no-store', signal: controller.signal }),
                cachedTimeline
                    ? Promise.resolve(null)
                    : fetch(`${base}/timeline?${region}`, { signal: controller.signal }).catch((err: unknown) => {
                        if (retry) return null;
                        throw err;
                    }),
            ];

            const [latestRes, timelineRes] = await Promise.all(fetchPromises);
            clearTimeout(timeoutId);

            const latest: RkLatestResponse | null = latestRes.ok ? await latestRes.json() : null;

            // rk can list a running event without any tiers (JP #218); the v2 snapshot of the same event fills in.
            // A running event whose v2 load fails goes to the fallback below and rejects if that fails too, so the
            // page reports the failure and its poll retries; other events keep their empty rk result.
            if (latest && !(Array.isArray(latest.items) && latest.items.length > 0)) {
                // On the retry the v2 snapshot has already failed, so a running event has nothing to fill in.
                if (retry && latest.status === 'active') return null;
                const realtime = retry ? null : await buildPredictionDataFromRealtimeV2(server, eventId, globalKline).catch((err: unknown) => {
                    if (latest.status === 'active') throw err;
                    return null;
                });
                if (realtime) return realtime;
            }

            if (latest) {
                const live = await livePromise;
                let timeline: RkTimelineResponse;
                if (cachedTimeline) {
                    timeline = cachedTimeline;
                } else if (timelineRes && timelineRes.ok) {
                    timeline = await timelineRes.json();
                    setCachedTimeline(server, eventId, timeline);
                } else {
                    timeline = {
                        event_id: eventId,
                        status: latest.status || 'active',
                        granularity: 0,
                        final_only: false,
                        timeline: [],
                    };
                }

                const isActive = latest.status === 'active';
                const updatedAt = new Date(latest.updated_at).getTime();

                // Broadcast to shared sync layer
                publishRankingSync({
                    region: server,
                    eventId,
                    updatedAt,
                    tierScores: extractTierScoresFromEntries(latest.items),
                    source: 'prediction',
                });

                // ── Build per-rank history from timeline ────────────────────────────────
                const historyByRank = new Map<number, { t: string; score: number; prediction: number | null }[]>();

                (timeline.timeline ?? []).forEach(entry => {
                    entry.items.forEach(item => {
                        if (!historyByRank.has(item.rank)) historyByRank.set(item.rank, []);
                        historyByRank.get(item.rank)!.push({
                            t: entry.collect_time,
                            score: item.score,
                            prediction: item.prediction,
                        });
                    });
                });

                // Extract start and end times for the prediction engine
                const tlEntries = timeline.timeline ?? [];
                let eventStartAt = 0;
                let eventEndAt = 0;
                const cachedList = getCachedEventList(server);
                const eventMeta = cachedList?.find(e => e.id === eventId);
                if (eventMeta?.start_at && eventMeta?.end_at) {
                    eventStartAt = eventMeta.start_at < 10000000000 ? eventMeta.start_at * 1000 : eventMeta.start_at;
                    eventEndAt = eventMeta.end_at < 10000000000 ? eventMeta.end_at * 1000 : eventMeta.end_at;
                } else if (tlEntries.length > 0) {
                    eventStartAt = new Date(tlEntries[0].collect_time).getTime();
                    // Standard event duration is 9 days (777,600,000 ms)
                    eventEndAt = eventStartAt + (9 * 24 * 3600000);
                }

                const context = live.predictionContextFor(await contextSource, { kind: 'overall' }, tierScoreList(latest.items), {
                    region: server,
                    eventId,
                    eventType: eventMeta?.event_type,
                    startAt: eventStartAt,
                    endAt: eventEndAt,
                    chapterCharacterId: null,
                    chapterNo: null,
                });

                // ── Build charts from latest + history + prediction engine ───
                const charts = latest.items.map(item => {
                    const rankHistory = historyByRank.get(item.rank) ?? [];
                    const timelinePoints = rankHistory.map(h => ({ t: h.t, y: h.score }));
                    // Running tiers go through the model; rk's own prediction is not monotone across tiers.
                    const HistoryPoints = isActive
                        ? historyEndingOnSnapshot(timelinePoints, context.scopeStartAt, updatedAt, item.score)
                        : timelinePoints;

                    let predictedScore = item.prediction ?? 0;
                    let predictedScoreP10: number | undefined;
                    let predictedScoreP90: number | undefined;
                    let PredictPoints = rankHistory
                        .filter(h => h.prediction != null)
                        .map(h => ({ t: h.t, y: h.prediction! }));

                    if (isActive && HistoryPoints.length > 0) {
                        const result = live.calculateEventPrediction({
                            server,
                            rank: item.rank,
                            startAt: eventStartAt,
                            endAt: eventEndAt,
                            historyPoints: HistoryPoints,
                            context,
                        });

                        predictedScore = result.predictedScore;
                        predictedScoreP10 = result.predictedScoreP10;
                        predictedScoreP90 = result.predictedScoreP90;
                        PredictPoints = result.predictPoints;
                    }

                    return {
                        Rank: item.rank,
                        CurrentScore: item.score,
                        PredictedScore: predictedScore,
                        PredictedScoreP10: predictedScoreP10,
                        PredictedScoreP90: predictedScoreP90,
                        HistoryPoints,
                        PredictPoints,
                    };
                });

                // ── Compute tier_klines from API tier_speeds ────────────────────────────
                const klineData = await klinePromise;
                const tier_klines: TierKLine[] = [];
                if (isActive && klineData?.tier_speeds) {
                    const tlEntries = timeline.timeline ?? [];
                    const prevFrame = tlEntries[tlEntries.length - 2];

                    klineData.tier_speeds.forEach(ts => {
                        let changePct = 0;
                        
                        if (prevFrame) {
                            const item = latest.items.find(i => i.rank === ts.rank);
                            const prevItem = prevFrame.items.find(i => i.rank === ts.rank);
                            if (item && prevItem && prevItem.score > 0) {
                                changePct = ((item.score - prevItem.score) / prevItem.score) * 100;
                            }
                        }

                        tier_klines.push({
                            Rank: ts.rank,
                            Data: [],
                            CurrentIndex: ts.index_value,
                            Speed: ts.speed_ph,
                            ChangePct: changePct,
                        });
                    });
                } else if (isActive) {
                    const tlEntries = timeline.timeline ?? [];
                    const lastFrame = tlEntries[tlEntries.length - 1];
                    const prevFrame = tlEntries[tlEntries.length - 2];

                    if (lastFrame) {
                        lastFrame.items.forEach(item => {
                            const prevItem = prevFrame?.items.find(p => p.rank === item.rank);
                            let speed = 0;
                            let changePct = 0;
                            if (prevItem) {
                                const dtMs = new Date(lastFrame.collect_time).getTime() - new Date(prevFrame!.collect_time).getTime();
                                const dtHours = dtMs / 3600000;
                                const scoreDelta = item.score - prevItem.score;
                                speed = dtHours > 0 ? Math.round(scoreDelta / dtHours) : 0;
                                if (prevItem.score > 0) {
                                    changePct = ((item.score - prevItem.score) / prevItem.score) * 100;
                                }
                            }
                            tier_klines.push({
                                Rank: item.rank,
                                Data: [],
                                CurrentIndex: null,
                                Speed: speed,
                                ChangePct: changePct,
                            });
                        });
                    }
                }

                return {
                    success: true,
                    timestamp: updatedAt,
                    data: {
                        event_id: eventId,
                        event_name: '',
                        charts,
                        global_kline: await globalKline,
                        tier_klines,
                    },
                };
            }
            return null;
        };

        try {
            const primary = await fromRk(false);
            if (primary) return primary;
        } catch (err) {
            console.warn('[prediction-api] Primary endpoint failed, falling back to realtime ranking snapshot:', err);
        }

        try {
            return await buildPredictionDataFromRealtimeV2(server, eventId, globalKline);
        } catch (v2Err) {
            // v2 serves only the region's running event, so a finished event depends on rk: ask it once more.
            const retried = await fromRk(true).catch((err: unknown) => {
                console.warn('[prediction-api] rk retry failed:', err);
                return null;
            });
            if (retried) return retried;
            throw v2Err;
        }
    });
}
