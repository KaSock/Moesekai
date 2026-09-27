# @empty-sekai/allium-deck-wasm（Moesekai vendor 构建）

组卡页（deck-recommend / 控分组卡）用的 allium-deck wasm 引擎。上游 npm 0.0.14 把 JP #218（WL3 终章）按普通章节计算，上游发布修复之前，站点改用这里的本地构建：`copy:wasm`（`web/scripts/copy-wasm-artifacts.mjs`）发现本目录有 `allium_deck.js` 时直接从这里把产物拷到 `public/wasm/`，版本号取本目录的 `package.json`。`web/package.json` 仍依赖 npm 0.0.14，只在本目录不存在时作为回退来源；依赖、`bun.lock` 与 Dockerfile 都不需要改。

## 基线

- 上游仓库 <https://github.com/empty-sekai/allium-deck>，tag `v0.0.14`，提交 `98963c228b2823ea336ad11b34bf85f10fe516d6`。npm 0.0.14 的 SLSA provenance 指向同一提交（`.github/workflows/release.yml`）。
- 不跟上游 main：v0.0.15 之后还有别的行为变化。
- 构建流程与上游 release.yml 一致：Rust 1.98.0、wasm-pack 0.15.0、wasm-bindgen 0.2.126、binaryen version_117 的 wasm-opt（参数取自 `wasm/Cargo.toml`）。源码路径映射成上游 CI 的路径，panic 位置字符串与 npm 版相同。
- 未打补丁时，本机（macOS arm64）构建的 JS glue 和 `.d.ts` 与 npm 版逐字节相同。wasm 字节随构建机和 checkout 绝对路径变化，只是函数编号和常量布局不同，binaryen 统计的各类指令数与 npm 版完全一致；冒烟测试、参数测试和 31 个场景的完整结果对照都与 npm 版一致。

## 补丁（`patches/*.patch`，按文件名顺序 `git am`）

`0001` 修正下面第 1–4 条（#218 终章），`0002` 是这几条的测试，`0003` 修正第 5 条，`0004`、`0005` 修正第 6 条（后三个都是终章的固定卡/固定角色，均含测试）：

1. 终章判定只认 #180 和 WL3 模拟终章 ID，#218（worldBlooms 里 `worldBloomChapterType: "finale"`）走了普通章节路径：成员上限、队长限定、称号加成、支援卡组全都算错。
2. `eventSkillScoreUpLimits.scoreUpRateLimit` 被减去 100，#218 的 140 变成 40%。官方规则（JP 公告 note_332 / note_407）里这个值本身就是效果上限，140 就是 140%。
3. 引擎不读 `eventShuffleUnitBonuses`：主卡组含 3/4/5 个团时加成 10/30/50%，VS 成员即使带子团也只算 VIRTUAL SINGER。站点把这张表作为可选表下发（CN 没有这张表）。
4. 终章活动加成计入人数的回退值是 4，#218 官方为 5 人。
5. 终章的分组搜索只表达一个队长约束，固定卡、第二个起的固定角色、指定队长时与队长不同的固定角色都不会被强制，静默失效（v0.0.14 的 #180 本来如此，#218 按第 1 条走终章路径后同样受影响）。这类请求改走逐槽约束的 DFS，所有固定卡和固定角色都会保留，队长是指定的队长角色。无约束、只指定队长，或指定队长且只固定队长本人的终章请求仍走原来的分组搜索，结果不变。
6. 终章未指定队长时，上游的槽位规则（`docs/parameters.md`：slot 0 carries leader semantics）让 0 号槽当队长：第 5 条之后是第一张固定卡，没有固定卡时是第一个固定角色（v0.0.14 的 #180 丢弃固定卡，由第一个固定角色当队长）。但页面对固定卡和固定角色的说明是“必须上场”，另有单独的“指定队长”；首个固定项当队长时结果可能比满足全部固定项的最优卡组弱得多，还会随固定项的顺序变化。现在这类请求按每个候选队长角色各求一次（走第 5 条的指定队长路径），再按卡组合并 Top-K；固定项占满 5 个槽位时，队长只能是固定项的角色之一。

#218 以外的结果（普通活动、WL1–WL3 章节、JP/CN #180、cheerful、挑战 live、MySekai 等）必须与 v0.0.14 完全一致，唯一例外是第 5、6 条：#180 请求带固定卡或固定角色而未指定队长，或指定队长后又固定了别的角色时，结果可能与 v0.0.14 不同，这是预期差异（只指定队长的 #180 请求结果不变）。

## 重建

工具链装好并放进 PATH：rustup（含 1.98.0 和 `wasm32-unknown-unknown`）、`cargo install wasm-pack --version 0.15.0 --locked`、`cargo install wasm-bindgen-cli --version 0.2.126 --locked`、binaryen version_117 官方 release 里的 `wasm-opt`。

```sh
# 引擎 checkout 必须在本仓库之外；目录不存在时脚本会从上游 clone v0.0.14
node web/scripts/build-allium-deck.mjs /path/to/allium-deck
bun run --cwd web copy:wasm
```

脚本在 checkout 旁新建 worktree（`ALLIUM_DECK_BUILD_DIR`，默认 `<checkout>-moesekai-build`），从 v0.0.14 开始打 `patches/` 里的补丁，然后构建，覆盖本目录的 `allium_deck.js`、`allium_deck_bg.wasm`、`allium_deck.d.ts`，并打印所用工具版本。checkout 本身的 HEAD 和工作区不动。

改补丁时，在引擎仓库基于 `v0.0.14` 提交修改，然后先清空 `patches/` 再导出。脚本按文件名顺序打上目录里所有 `*.patch`，残留的旧补丁也会被打上（通常让 `git am` 失败）；`-o` 必须写站点仓库的绝对路径，相对路径会落到引擎仓库里：

```sh
rm -f /path/to/Moesekai/web/vendor/allium-deck-wasm/patches/*.patch
git -C /path/to/allium-deck format-patch v0.0.14..HEAD -o /path/to/Moesekai/web/vendor/allium-deck-wasm/patches/
```

产物有变化且旧版本已上线时，要提升 `package.json` 的 `version`（`0.0.14-moesekai.N`）。`copy:wasm` 会把它写进 `src/lib/deck-engine/wasm-version.ts`，这是 `/wasm/` 产物唯一的缓存击穿键。

## 回到 npm

上游发布同时包含上面 6 条修复的版本后（只修了 #218 而没修第 5、6 条的版本不能用，否则终章的固定卡/固定角色会再次静默失效，或首个固定项又被强制当队长）：

1. `web/package.json` 改成 `"@empty-sekai/allium-deck-wasm": "<新版本>"`，`bun install` 更新 `bun.lock`；
2. 删除 `web/vendor/allium-deck-wasm/` 和 `web/scripts/build-allium-deck.mjs`（`copy:wasm` 找不到本目录就会改用 npm 包）；
3. 再跑 `bun run --cwd web copy:wasm`。
