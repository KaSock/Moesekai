/* tslint:disable */
/* eslint-disable */

/**
 * 解析一次用户数据、多次复用的句柄。
 *
 * `region` 词表：jp/tw/en/kr/cn。句柄与 masterdata 生命周期解耦：
 * masterdata 重载后旧句柄仍可用，但数据视图可能过期，由调用方自行重载。
 */
export class UserDataHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly region: string;
}

/**
 * 精确打歌分：给定战力/技能/谱面逐 note 计算。
 *
 * options：`{ live_type, power, skills: [..], music_score, fever_music_score?,
 * multi_sum_power? }`；`music_score`/`fever_music_score` 接受 JSON 字符串或对象。
 */
export function calculate_exact_live(options_json: string): string;

/**
 * 创建用户数据句柄：解析成本只付一次，后续 `recommend_with_user_data`
 * 直接复用（解析成本只付一次）。
 */
export function create_user_data(user_json: string, region: string): UserDataHandle;

/**
 * World Bloom 支援卡逐卡加成。
 *
 * options：`{ user_data / user_data_str, event_id | world_bloom_event_turn |
 * world_bloom_finale_turn, world_bloom_character_id?, event_unit?,
 * forced_leader_character_id?, support_master_max?, support_skill_max?,
 * filter_other_unit? }`；返回按 (bonus 降序, card_id 升序) 排序的数组。
 */
export function get_world_bloom_support_cards(options_json: string): string;

export function init(): void;

/**
 * 载入 masterdata：`masterdata_json` 形如
 * `{"cards": "<cards.json 原文>", "events": "...", ...}`（各表 JSON 原文，
 * 键名裸表名或带 `.json` 后缀均可），`music_metas_json` 为音乐元数据表
 * 原文（可为空字符串）。
 *
 * 数据在引擎内做一次「raw JSON → 扁平结构」转换并缓存，之后每次
 * recommend 零重复成本。辅助表（areas/areaItems/shopItems/ingameNotes/
 * ingameCombos）缺省时对应辅助接口报「未载入」错误，不影响组卡。
 */
export function load_masterdata(masterdata_json: string, music_metas_json: string): void;

/**
 * 组卡入口。需先 `load_masterdata`。`user_json`/`params_json` 为上传链路
 * camelCase 格式；返回卡组 JSON（真实游戏卡 ID + 展示指标），条数由
 * params 的 `limit` 决定（缺省 10，上限 30）。
 */
export function recommend(user_json: string, params_json: string): string;

/**
 * 曲目推荐：对一张已定卡组给全部曲目/难度打分排序。
 *
 * options：`{ deck, live_type, event_type?/event_id?, skill_order_choose_strategy?,
 * specific_skill_order?, multi_live_teammate_score_up?, multi_live_teammate_power? }`。
 */
export function recommendMusic(options_json: string): string;

/**
 * 组卡入口（句柄式）：options 即 `recommend` 的 `params_json`。
 */
export function recommendWithUserData(options_json: string, handle: UserDataHandle): string;

/**
 * 区域道具推荐。
 *
 * options：`{ user_data / user_data_str, card_ids: [..] }`；
 * 返回按 `power_per_coin` 降序的升级建议数组。
 */
export function recommend_area_items(options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_userdatahandle_free: (a: number, b: number) => void;
    readonly calculate_exact_live: (a: number, b: number, c: number) => void;
    readonly create_user_data: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly get_world_bloom_support_cards: (a: number, b: number, c: number) => void;
    readonly init: () => void;
    readonly load_masterdata: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly recommend: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly recommendMusic: (a: number, b: number, c: number) => void;
    readonly recommendWithUserData: (a: number, b: number, c: number, d: number) => void;
    readonly recommend_area_items: (a: number, b: number, c: number) => void;
    readonly userdatahandle_region: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
