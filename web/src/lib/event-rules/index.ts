// Per-edition event rules resolved from masterdata plus the manual registry in overrides.ts.
// Event ids appear only in overrides.ts; everything here is derived from the tables.
import type {
    AutoRule,
    BreakGaugeRule,
    EventGroup,
    EventRules,
    EventRulesMasterdata,
    Region,
    ResolveEventRulesInput,
    RuleScope,
    RuleSource,
    RuleValue,
    ShuffleUnitBonusRow,
    SupportDeckRule,
    WlChapterRule,
    WlTurn,
} from "./types";
import { AUTO_BASE, OFFICIAL_LIMITS, SPECIAL_MEASURES } from "./overrides.ts";
import type { OfficialLimitKind } from "./overrides.ts";

type Row = Readonly<Record<string, unknown>>;
type Table = ReadonlyArray<Row> | undefined;

/**
 * Every masterdata table resolveEventRules reads; only events and worldBlooms are required.
 * engineCoverageGaps can only see tables passed in, and masterdata has no table listing, so a new rule table
 * is detected only once it is added here.
 */
export const EVENT_RULE_TABLES: readonly string[] = [
    "events",
    "worldBlooms",
    "worldBloomChapterRankingRewardRanges",
    "eventBreakTimes",
    "eventCardBonusLimits",
    "eventSkillScoreUpLimits",
    "eventTotalPowerLimits",
    "eventShuffleUnitBonuses",
    "eventMysekaiFixtureGameCharacterPerformanceBonusLimits",
    "eventCards",
    "eventHonorBonuses",
    "worldBloomSupportDeckUnitEventLimitedBonuses",
];

/**
 * Event-scoped bonus tables the deck engine reads and the site sends once the WL3 finale engine fix ships
 * (engine.rs OwnedGameData::from_sources; data-provider PRELOAD_MASTER_KEYS + ENGINE_OPTIONAL_MASTER_KEYS,
 * which then also carry eventShuffleUnitBonuses and eventMysekaiFixtureGameCharacterPerformanceBonusLimits).
 */
export const ENGINE_READ_TABLES: readonly string[] = [
    "events",
    "worldBlooms",
    "eventCards",
    "eventDeckBonuses",
    "eventRarityBonusRates",
    "eventCardBonusLimits",
    "eventHonorBonuses",
    "eventSkillScoreUpLimits",
    "eventShuffleUnitBonuses",
    "eventMysekaiFixtureGameCharacterPerformanceBonusLimits",
    "worldBloomDifferentAttributeBonuses",
    "worldBloomSupportDeckBonuses",
    "worldBloomSupportDeckBonusesWL1",
    "worldBloomSupportDeckBonusesWL2",
    "worldBloomSupportDeckBonusesWL3",
    "worldBloomSupportDeckUnitEventLimitedBonuses",
];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A WL event starting more than this long after the previous one's aggregation opens a new turn. */
const WL_TURN_GAP_MS = 120 * DAY_MS;
const LAST_KNOWN_WL_TURN = 3;
/** Chapters are 48 h or 72 h; anything longer than 60 h counts as the 72 h shape. */
const LONG_CHAPTER_MIN_HOURS = 60;
/** Finale member-bonus limit when neither masterdata nor the registry has one (deck engine default after E4). */
const FINALE_DEFAULT_MEMBER_LIMIT = 5;

/**
 * The engine does not read eventTotalPowerLimits; it caps decks of every WL event after the WL2 finale at this
 * total power (build.rs power_total_cap), so only rows with another value, or on a non-WL event, are engine gaps.
 */
const ENGINE_WL_POWER_CAP = 336_000;
const POWER_LIMIT_TABLE = "eventTotalPowerLimits";
const POWER_LIMIT_COLUMN = "upperTotalPower";

interface SourcedRef {
    source: RuleSource;
    ref: string;
}

const DECK_ENGINE_REF: SourcedRef = { source: "secondary", ref: "allium deck engine" };

/** Slot counts match the deck engine (load_support_deck_count); the turn-3 count is the JP note_382 change (20 -> 25). */
const SUPPORT_DECK_BY_TURN: Readonly<Record<1 | 2 | 3, { rule: SupportDeckRule; source: Readonly<Record<Region, SourcedRef>> }>> = {
    1: { rule: { slots: 12, table: "WL1" }, source: { jp: DECK_ENGINE_REF, cn: DECK_ENGINE_REF } },
    2: { rule: { slots: 20, table: "WL2" }, source: { jp: DECK_ENGINE_REF, cn: DECK_ENGINE_REF } },
    3: {
        rule: { slots: 25, table: "WL3" },
        source: { jp: { source: "official", ref: "note_382 (v6.4.0)" }, cn: { source: "secondary", ref: "JP note_382" } },
    },
};

const BONUS_TABLE_PATTERN = /Bonus|Limit/;

function num(row: Row | undefined, key: string): number | null {
    const value = row?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rowsFor(table: Table, eventId: number): Row[] {
    return table ? table.filter((row) => num(row, "eventId") === eventId) : [];
}

function tableRef(table: string, row: Row | undefined): string {
    const id = num(row, "id");
    return id === null ? table : `${table}#${id}`;
}

function maxOf(rows: readonly Row[], key: string): number | null {
    let best: number | null = null;
    for (const row of rows) {
        const value = num(row, key);
        if (value !== null && (best === null || value > best)) best = value;
    }
    return best;
}

function isFinaleRow(row: Row): boolean {
    return row.worldBloomChapterType === "finale";
}

function resolveWlTurn(masterdata: EventRulesMasterdata, eventId: number): WlTurn {
    const withChapters = new Set(masterdata.worldBlooms.map((row) => num(row, "eventId")));
    const editions = masterdata.events
        .filter((row) => row.eventType === "world_bloom" && withChapters.has(num(row, "id")))
        .map((row) => ({ id: num(row, "id"), startAt: num(row, "startAt"), aggregateAt: num(row, "aggregateAt") }))
        .filter((row): row is { id: number; startAt: number; aggregateAt: number } =>
            row.id !== null && row.startAt !== null && row.aggregateAt !== null)
        .sort((a, b) => a.startAt - b.startAt || a.id - b.id);

    let turn = 0;
    let previousAggregateAt: number | null = null;
    for (const edition of editions) {
        if (previousAggregateAt === null || edition.startAt - previousAggregateAt > WL_TURN_GAP_MS) turn += 1;
        previousAggregateAt = edition.aggregateAt;
        if (edition.id === eventId) return turn <= LAST_KNOWN_WL_TURN ? (turn as 1 | 2 | 3) : null;
    }
    return null;
}

function readChapters(rows: readonly Row[]): WlChapterRule[] {
    const chapters: WlChapterRule[] = [];
    for (const row of rows) {
        const chapterNo = num(row, "chapterNo");
        const startAt = num(row, "chapterStartAt");
        const aggregateAt = num(row, "aggregateAt");
        if (chapterNo === null || startAt === null || aggregateAt === null) continue;
        chapters.push({
            chapterNo,
            gameCharacterId: isFinaleRow(row) ? null : num(row, "gameCharacterId"),
            startAt,
            aggregateAt,
            endAt: num(row, "chapterEndAt") ?? aggregateAt,
            hours: Math.round((aggregateAt - startAt) / HOUR_MS),
        });
    }
    return chapters.sort((a, b) => a.chapterNo - b.chapterNo);
}

function readBreakGauge(row: Row | undefined, isWl: boolean): BreakGaugeRule | null {
    const id = num(row, "id");
    const gainPerSecond = num(row, "pointsPerMusicSecond");
    const fixedSecondsPerPlay = num(row, "musicOffsetSeconds");
    const max = num(row, "maxPoint");
    const restStartMinutes = num(row, "requiredIntervalMinutes");
    const restStepMinutes = num(row, "decreaseMinutes");
    const restStepDecrease = num(row, "decreasePoint");
    if (
        id === null || gainPerSecond === null || fixedSecondsPerPlay === null || max === null ||
        restStartMinutes === null || restStepMinutes === null || restStepDecrease === null
    ) {
        return null;
    }
    // note_375 (v6.3.5): the gauge resets at every WL chapter start.
    return { id, gainPerSecond, fixedSecondsPerPlay, max, restStartMinutes, restStepMinutes, restStepDecrease, resetPerWlChapter: isWl };
}

function sourced<T>(value: T, source: RuleSource, ref?: string): RuleValue<T> {
    return ref === undefined ? { value, source } : { value, source, ref };
}

export function resolveEventRules(input: ResolveEventRulesInput): EventRules {
    const { region, eventId, masterdata } = input;
    const overrides = input.overrides ?? {};
    const event = masterdata.events.find((row) => num(row, "id") === eventId);
    const startAt = num(event, "startAt");
    const aggregateAt = num(event, "aggregateAt");
    if (!event || startAt === null || aggregateAt === null) {
        throw new Error(`resolveEventRules: event ${region} #${eventId} not found in masterdata`);
    }
    const eventType = typeof event.eventType === "string" ? event.eventType : "";

    const chapterRows = rowsFor(masterdata.worldBlooms, eventId);
    const isFinale = chapterRows.some(isFinaleRow);
    const isWl = isFinale || eventType === "world_bloom";
    const chapters = isWl ? readChapters(chapterRows) : [];
    const wlTurn = isWl ? resolveWlTurn(masterdata, eventId) : null;
    const warnings: string[] = [];
    if (isWl && wlTurn === null) warnings.push("unknownWlTurn");

    const requestedCharacterId = input.scope?.kind === "chapter" && isWl && !isFinale ? input.scope.gameCharacterId : null;
    const chapter = requestedCharacterId === null
        ? undefined
        : chapters.find((c) => c.gameCharacterId === requestedCharacterId);
    const scope: RuleScope = chapter && requestedCharacterId !== null
        ? { kind: "chapter", gameCharacterId: requestedCharacterId }
        : { kind: "overall" };

    let group: EventGroup = "normal";
    if (isFinale) group = "wl_finale";
    else if (isWl && chapter) group = chapter.hours > LONG_CHAPTER_MIN_HOURS ? "wl_chapter_72h" : "wl_chapter_48h";
    else if (isWl) group = "wl_overall";

    const officialLimit = (limit: OfficialLimitKind) => {
        const entries = OFFICIAL_LIMITS.filter((entry) => entry.limit === limit && entry.region === region);
        return (
            entries.find((entry) => "eventId" in entry.target && entry.target.eventId === eventId) ??
            entries.find((entry) =>
                "wlTurn" in entry.target && isWl && !isFinale && wlTurn !== null && entry.target.wlTurn === wlTurn)
        );
    };
    const resolveLimit = (limit: OfficialLimitKind, table: string, column: string, finaleDefault?: number): RuleValue<number | null> => {
        const row = rowsFor(masterdata[table], eventId).find((r) => num(r, column) !== null);
        const fromMasterdata = num(row, column);
        if (fromMasterdata !== null) return sourced(fromMasterdata, "masterdata", tableRef(table, row));
        const entry = officialLimit(limit);
        if (entry) return sourced(entry.value, entry.source, entry.ref);
        if (isFinale && finaleDefault !== undefined) return sourced(finaleDefault, "secondary", "deck engine default");
        return sourced(null, "masterdata");
    };

    const memberBonusLimit = resolveLimit("memberBonusLimit", "eventCardBonusLimits", "memberCountLimit", FINALE_DEFAULT_MEMBER_LIMIT);
    const skillCap = resolveLimit("skillCap", "eventSkillScoreUpLimits", "scoreUpRateLimit");
    const powerCap = resolveLimit("powerCap", POWER_LIMIT_TABLE, POWER_LIMIT_COLUMN);

    const fixtureTable = "eventMysekaiFixtureGameCharacterPerformanceBonusLimits";
    const fixtureRow = rowsFor(masterdata[fixtureTable], eventId).find((r) => num(r, "bonusRateLimit") !== null);
    const fixtureLimit = num(fixtureRow, "bonusRateLimit");
    // bonusRateLimit is in 0.1 % units (20 -> 2 %, 60 -> 6 %).
    const fixtureBonusCap = fixtureLimit !== null
        ? sourced<number | null>(fixtureLimit / 10, "masterdata", tableRef(fixtureTable, fixtureRow))
        : sourced(null, "masterdata");

    const shuffleRows: ShuffleUnitBonusRow[] = [];
    for (const row of rowsFor(masterdata.eventShuffleUnitBonuses, eventId)) {
        const unitCount = num(row, "unitCount");
        const bonusRate = num(row, "bonusRate");
        if (unitCount !== null && bonusRate !== null) shuffleRows.push({ unitCount, bonusRate });
    }
    shuffleRows.sort((a, b) => a.unitCount - b.unitCount);
    const shuffleUnitBonus = shuffleRows.length > 0
        ? sourced(shuffleRows, "masterdata", "eventShuffleUnitBonuses")
        : sourced(shuffleRows, "masterdata");

    let supportDeck: RuleValue<SupportDeckRule | null> = sourced(null, "masterdata");
    if (isWl && wlTurn !== null) {
        const entry = SUPPORT_DECK_BY_TURN[wlTurn];
        supportDeck = sourced<SupportDeckRule | null>({ ...entry.rule }, entry.source[region].source, entry.source[region].ref);
    } else if (isWl) {
        supportDeck = sourced(null, "secondary");
    }

    const cardRows = rowsFor(masterdata.eventCards, eventId);
    const cardBonus = maxOf(cardRows, "bonusRate");
    const eventCardBonus = cardBonus !== null
        ? sourced<{ bonusRate: number; leaderBonusRate: number } | null>(
            { bonusRate: cardBonus, leaderBonusRate: maxOf(cardRows, "leaderBonusRate") ?? 0 }, "masterdata", "eventCards")
        : sourced(null, "masterdata");

    const honorRows = rowsFor(masterdata.eventHonorBonuses, eventId);
    const honorRate = maxOf(honorRows, "bonusRate");
    const honorBonus = honorRate !== null
        ? sourced<{ titles: number; bonusRate: number } | null>(
            { titles: honorRows.length, bonusRate: honorRate }, "masterdata", "eventHonorBonuses")
        : sourced(null, "masterdata");

    const unitLimitedRate = maxOf(rowsFor(masterdata.worldBloomSupportDeckUnitEventLimitedBonuses, eventId), "bonusRate");
    const unitLimitedSupportBonus = unitLimitedRate !== null
        ? sourced<number | null>(unitLimitedRate, "masterdata", "worldBloomSupportDeckUnitEventLimitedBonuses")
        : sourced(null, "masterdata");

    const breakTimeId = num(event, "eventBreakTimeId");
    const breakTimeRow = breakTimeId === null ? undefined : masterdata.eventBreakTimes?.find((row) => num(row, "id") === breakTimeId);
    const configuredGauge = breakTimeRow ? readBreakGauge(breakTimeRow, isWl) : null;
    const breakGaugeConfigured = configuredGauge !== null;
    let breakGauge: RuleValue<BreakGaugeRule | null> = configuredGauge
        ? sourced<BreakGaugeRule | null>(configuredGauge, "masterdata", tableRef("eventBreakTimes", breakTimeRow))
        : sourced(null, "masterdata");
    if (breakGaugeConfigured && overrides.breakGaugeEnabled === false) breakGauge = sourced(null, "user");

    const measureEntry = SPECIAL_MEASURES.find((entry) => entry.region === region && entry.eventId === eventId);
    const defaultMeasure = measureEntry?.specialMeasure ?? false;
    const userMeasure = overrides.autoSpecialMeasure;
    const specialMeasure = userMeasure ?? defaultMeasure;
    const autoRule: AutoRule = {
        specialMeasure,
        dailyLimitByPass: { ...(specialMeasure ? AUTO_BASE.specialMeasure : AUTO_BASE.normal) },
        minFire: AUTO_BASE.minFire,
        maxFire: AUTO_BASE.maxFire,
    };
    let auto: RuleValue<AutoRule>;
    if (userMeasure !== undefined && userMeasure !== defaultMeasure) auto = sourced(autoRule, "user");
    else if (measureEntry) auto = sourced(autoRule, measureEntry.source, measureEntry.ref);
    else auto = sourced(autoRule, AUTO_BASE.source, AUTO_BASE.ref);
    if (isFinale && !measureEntry && userMeasure === undefined) warnings.push("unregisteredSpecialMeasure");
    const pass = overrides.pass ?? "none";

    const chapterRanges = chapter
        ? rowsFor(masterdata.worldBloomChapterRankingRewardRanges, eventId)
            .filter((row) => num(row, "gameCharacterId") === requestedCharacterId)
        : [];
    const eventRanges = Array.isArray(event.eventRankingRewardRanges) ? (event.eventRankingRewardRanges as Row[]) : [];
    const rankingTiers = [...new Set((chapterRanges.length > 0 ? chapterRanges : eventRanges)
        .map((row) => num(row, "toRank"))
        .filter((rank): rank is number => rank !== null))]
        .sort((a, b) => a - b);

    const engineRead = new Set(ENGINE_READ_TABLES);
    const engineCovers = (table: string, rows: readonly Row[]) =>
        engineRead.has(table) ||
        (table === POWER_LIMIT_TABLE && isWl && rows.every((row) => num(row, POWER_LIMIT_COLUMN) === ENGINE_WL_POWER_CAP));
    const engineCoverageGaps = Object.keys(masterdata)
        .filter((table) => BONUS_TABLE_PATTERN.test(table))
        .filter((table) => {
            const rows = rowsFor(masterdata[table], eventId);
            return rows.length > 0 && !engineCovers(table, rows);
        })
        .sort();
    if (engineCoverageGaps.length > 0) warnings.push("engineGap");

    const editionNotes: string[] = [];
    if (isFinale && wlTurn === 2) editionNotes.push("finaleWl2");
    if (isFinale && wlTurn === 3) editionNotes.push("finaleWl3");
    if (isWl && !isFinale && wlTurn === 3) editionNotes.push("wl3Chapter");
    if (isWl && !isFinale && wlTurn === 1 && region === "cn") editionNotes.push("cnWl1");

    return {
        region,
        eventId,
        eventType,
        group,
        scope,
        wlTurn,
        isFinale,
        startAt,
        aggregateAt,
        scopeStartAt: chapter ? chapter.startAt : startAt,
        scopeAggregateAt: chapter ? chapter.aggregateAt : aggregateAt,
        chapters,
        memberBonusLimit,
        skillCap,
        fixtureBonusCap,
        powerCap,
        shuffleUnitBonus,
        supportDeck,
        eventCardBonus,
        honorBonus,
        unitLimitedSupportBonus,
        breakGauge,
        breakGaugeConfigured,
        auto,
        pass,
        autoDailyLimit: autoRule.dailyLimitByPass[pass],
        rankingTiers,
        engineCoverageGaps,
        warnings,
        editionNotes,
    };
}
