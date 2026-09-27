"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchMasterDataForServer } from "@/lib/fetch";
import { EVENT_RULE_TABLES, resolveEventRules } from "@/lib/event-rules";
import type {
    EventRules,
    EventRulesMasterdata,
    Region,
    RuleOverrides,
    RuleScope,
} from "@/lib/event-rules/types";

type MasterdataRows = ReadonlyArray<Record<string, unknown>>;

/** Tables resolveEventRules cannot work without; every other rule table may be missing (404) for a region. */
const REQUIRED_TABLES: ReadonlySet<string> = new Set(["events", "worldBlooms"]);

const EMPTY_OVERRIDES: RuleOverrides = {};

const masterdataByRegion = new Map<Region, Promise<EventRulesMasterdata>>();

function loadRulesMasterdata(region: Region): Promise<EventRulesMasterdata> {
    const cached = masterdataByRegion.get(region);
    if (cached) return cached;

    const pending = Promise.all(
        EVENT_RULE_TABLES.map(async (table) => {
            try {
                const rows = await fetchMasterDataForServer<MasterdataRows>(region, `${table}.json`);
                return [table, Array.isArray(rows) ? rows : undefined] as const;
            } catch (error) {
                if (REQUIRED_TABLES.has(table)) throw error;
                return [table, undefined] as const;
            }
        }),
    ).then((entries) => {
        const masterdata: EventRulesMasterdata = { events: [], worldBlooms: [] };
        for (const [table, rows] of entries) {
            if (rows) masterdata[table] = rows;
        }
        return masterdata;
    });

    masterdataByRegion.set(region, pending);
    pending.catch(() => {
        if (masterdataByRegion.get(region) === pending) masterdataByRegion.delete(region);
    });
    return pending;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface EventRulesState {
    rules: EventRules | null;
    /** Overrides of the current event (kept separately for every region + event). */
    overrides: RuleOverrides;
    setOverrides(overrides: RuleOverrides): void;
    loading: boolean;
    error: string | null;
}

export function useEventRules(region: Region, eventId: number | null, scope: RuleScope): EventRulesState {
    const [loaded, setLoaded] = useState<{ region: Region; masterdata: EventRulesMasterdata } | null>(null);
    const [failed, setFailed] = useState<{ region: Region; message: string } | null>(null);
    const [overridesByEvent, setOverridesByEvent] = useState<Record<string, RuleOverrides>>({});

    useEffect(() => {
        let cancelled = false;
        loadRulesMasterdata(region).then(
            (masterdata) => {
                if (cancelled) return;
                setLoaded({ region, masterdata });
                setFailed(null);
            },
            (error: unknown) => {
                if (!cancelled) setFailed({ region, message: errorMessage(error) });
            },
        );
        return () => {
            cancelled = true;
        };
    }, [region]);

    const masterdata = loaded?.region === region ? loaded.masterdata : null;
    const loadError = failed?.region === region ? failed.message : null;
    const eventKey = eventId != null ? `${region}:${eventId}` : null;
    const overrides = (eventKey && overridesByEvent[eventKey]) || EMPTY_OVERRIDES;

    const scopeCharacterId = scope.kind === "chapter" ? scope.gameCharacterId : null;
    const stableScope = useMemo<RuleScope>(
        () => (scopeCharacterId == null ? { kind: "overall" } : { kind: "chapter", gameCharacterId: scopeCharacterId }),
        [scopeCharacterId],
    );

    const resolved = useMemo<{ rules: EventRules | null; error: string | null }>(() => {
        if (!masterdata || eventId == null) return { rules: null, error: null };
        try {
            return {
                rules: resolveEventRules({ region, eventId, masterdata, scope: stableScope, overrides }),
                error: null,
            };
        } catch (error) {
            return { rules: null, error: errorMessage(error) };
        }
    }, [masterdata, region, eventId, stableScope, overrides]);

    const setOverrides = useCallback(
        (next: RuleOverrides) => {
            if (!eventKey) return;
            setOverridesByEvent((prev) => ({ ...prev, [eventKey]: next }));
        },
        [eventKey],
    );

    return {
        rules: resolved.rules,
        overrides,
        setOverrides,
        loading: eventId != null && !masterdata && !loadError,
        error: loadError ?? resolved.error,
    };
}
