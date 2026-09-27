/**
 * allium-deck wasm 可复现构建（vendor 包 @empty-sekai/allium-deck-wasm）
 *
 * 以上游 v0.0.14（98963c22，即 npm 0.0.14 的构建源）为基线，按文件名顺序用
 * `git am` 打上 vendor/allium-deck-wasm/patches/*.patch，再按上游 release.yml 的
 * 流程（Rust 1.98.0 + wasm-pack 0.15.0 + wasm-bindgen 0.2.126 + binaryen
 * version_117，wasm-opt 参数取自 wasm/Cargo.toml）构建，把 allium_deck.js /
 * allium_deck_bg.wasm / allium_deck.d.ts 写进 vendor/allium-deck-wasm/。
 *
 * 引擎 checkout 由参数或 ALLIUM_DECK_SRC 指定，且必须在本仓库之外；目录不存在时
 * 从上游 clone。补丁打在该 checkout 旁的独立 worktree 上（ALLIUM_DECK_BUILD_DIR，
 * 默认 <checkout>-moesekai-build），不动 checkout 本身的 HEAD 和工作区。
 *
 * 工具链需预先装好并在 PATH 上：rustup（含 1.98.0 与 wasm32-unknown-unknown）、
 * wasm-pack 0.15.0、wasm-bindgen 0.2.126、wasm-opt（binaryen version_117）。
 *
 * 使用方法: node scripts/build-allium-deck.mjs <引擎 checkout 目录>
 *       或: ALLIUM_DECK_SRC=<目录> node scripts/build-allium-deck.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(webRoot, '..');
const vendorDir = path.join(webRoot, 'vendor', 'allium-deck-wasm');
const patchesDir = path.join(vendorDir, 'patches');

const UPSTREAM_URL = 'https://github.com/empty-sekai/allium-deck.git';
const BASE_TAG = 'v0.0.14';
const BASE_COMMIT = '98963c228b2823ea336ad11b34bf85f10fe516d6';

/** 与上游 release.yml 的 build-wasm-release job 一致。 */
const RUST_TOOLCHAIN = '1.98.0';
const TOOL_VERSIONS = {
    'wasm-pack': 'wasm-pack 0.15.0',
    'wasm-bindgen': 'wasm-bindgen 0.2.126',
    // wasm-pack 0.15.0 自带下载的就是 version_117；PATH 上有 wasm-opt 时它直接用 PATH 上的。
    'wasm-opt': 'wasm-opt version 117',
};

/** 上游 CI 的路径：panic 位置字符串里会嵌源码路径，映射过去后既与 npm 版一致，也不泄漏本机路径。 */
const CI_CHECKOUT = '/home/runner/work/allium-deck/allium-deck';
const CI_CARGO_HOME = '/home/runner/.cargo';

const ARTIFACTS = ['allium_deck.js', 'allium_deck_bg.wasm', 'allium_deck.d.ts'];

function fail(message) {
    console.error(`[build-allium-deck] ${message}`);
    process.exit(1);
}

function run(cmd, args, options = {}) {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim();
}

function runInherit(cmd, args, options = {}) {
    execFileSync(cmd, args, { stdio: 'inherit', ...options });
}

function assertOutsideRepo(dir, label) {
    const rel = path.relative(repoRoot, dir);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        fail(`${label} 不能放在本仓库里: ${dir}`);
    }
}

function prepareCheckout(src) {
    if (!fs.existsSync(src)) {
        console.log(`[build-allium-deck] clone ${UPSTREAM_URL}@${BASE_TAG} → ${src}`);
        runInherit('git', ['clone', '--branch', BASE_TAG, UPSTREAM_URL, src]);
    }
    try {
        run('git', ['-C', src, 'cat-file', '-e', `${BASE_COMMIT}^{commit}`]);
    } catch {
        fail(`${src} 里没有基线提交 ${BASE_COMMIT}（${BASE_TAG}），先 git fetch --tags`);
    }
}

/** 在独立 worktree 上从基线重新打补丁；已有的同名 worktree 先移除。 */
function prepareWorktree(src, work) {
    // 手动删掉的 worktree 仍挂在登记表里，先清掉，否则 worktree add 会拒绝同一路径。
    run('git', ['-C', src, 'worktree', 'prune']);
    const registered = run('git', ['-C', src, 'worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => path.resolve(line.slice('worktree '.length)));
    if (registered.includes(work)) {
        runInherit('git', ['-C', src, 'worktree', 'remove', '--force', work]);
    } else if (fs.existsSync(work)) {
        fail(`${work} 已存在且不是 ${src} 的 worktree，换一个 ALLIUM_DECK_BUILD_DIR`);
    }
    runInherit('git', ['-C', src, 'worktree', 'add', '--detach', work, BASE_COMMIT]);

    const patches = fs.existsSync(patchesDir)
        ? fs.readdirSync(patchesDir).filter((name) => name.endsWith('.patch')).sort()
        : [];
    if (patches.length === 0) {
        console.log('[build-allium-deck] patches/ 为空：构建未打补丁的基线');
        return patches;
    }
    try {
        // 补丁作者信息取自补丁本身；提交者身份只为让 git am 在没配 user 的机器上也能跑。
        runInherit('git', [
            '-C', work,
            '-c', 'user.name=moesekai-build',
            '-c', 'user.email=moesekai-build@localhost',
            'am', '--quiet',
            ...patches.map((name) => path.join(patchesDir, name)),
        ]);
    } catch {
        fail(`git am 失败，冲突留在 ${work}（git -C ${work} am --abort 可复原）`);
    }
    return patches;
}

function checkTools(env) {
    const versions = {};
    versions.rustc = run('rustc', ['-vV'], { env });
    if (!/^release: 1\.98\.0$/m.test(versions.rustc)) {
        fail(`需要 rustc ${RUST_TOOLCHAIN}，实际:\n${versions.rustc}`);
    }
    versions.cargo = run('cargo', ['-V'], { env });
    for (const [tool, expected] of Object.entries(TOOL_VERSIONS)) {
        const flag = tool === 'wasm-opt' ? '--version' : '-V';
        let actual;
        try {
            actual = run(tool, [flag], { env });
        } catch {
            fail(`PATH 上找不到 ${tool}（需要 ${expected}）`);
        }
        if (!actual.startsWith(expected)) fail(`需要 ${expected}，实际: ${actual}`);
        versions[tool] = actual;
    }
    versions.node = process.version;
    return versions;
}

function main() {
    const srcArg = process.argv[2] || process.env.ALLIUM_DECK_SRC;
    if (!srcArg) {
        fail('用法: node scripts/build-allium-deck.mjs <引擎 checkout 目录>（或设 ALLIUM_DECK_SRC）');
    }
    const src = path.resolve(srcArg);
    const work = path.resolve(process.env.ALLIUM_DECK_BUILD_DIR || `${src}-moesekai-build`);
    assertOutsideRepo(src, '引擎 checkout');
    assertOutsideRepo(work, '构建 worktree');

    prepareCheckout(src);
    const patches = prepareWorktree(src, work);

    const cargoHome = path.resolve(process.env.CARGO_HOME || path.join(os.homedir(), '.cargo'));
    const env = {
        ...process.env,
        RUSTUP_TOOLCHAIN: RUST_TOOLCHAIN,
        // 与上游 release.yml 相同的 profile 覆盖。
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
        CARGO_PROFILE_RELEASE_LTO: 'fat',
        CARGO_PROFILE_RELEASE_OPT_LEVEL: '3',
        CARGO_PROFILE_RELEASE_PANIC: 'abort',
        SOURCE_DATE_EPOCH: run('git', ['-C', work, 'show', '-s', '--format=%ct', 'HEAD']),
        // 覆盖而非追加：继承来的 RUSTFLAGS 会让产物偏离上游。
        RUSTFLAGS: [
            `--remap-path-prefix=${cargoHome}=${CI_CARGO_HOME}`,
            `--remap-path-prefix=${work}=${CI_CHECKOUT}`,
        ].join(' '),
    };
    delete env.CARGO_ENCODED_RUSTFLAGS;

    const versions = checkTools(env);
    const outDir = path.join(work, 'wasm', 'pkg');
    fs.rmSync(outDir, { recursive: true, force: true });
    runInherit('wasm-pack', ['build', 'wasm', '--target', 'web', '--scope', 'empty-sekai', '--out-dir', outDir], {
        cwd: work,
        env,
    });

    fs.mkdirSync(vendorDir, { recursive: true });
    let changed = false;
    for (const name of ARTIFACTS) {
        const built = fs.readFileSync(path.join(outDir, name));
        const target = path.join(vendorDir, name);
        if (!fs.existsSync(target) || !fs.readFileSync(target).equals(built)) changed = true;
        fs.writeFileSync(target, built);
    }

    const head = run('git', ['-C', work, 'rev-parse', 'HEAD']);
    console.log('\n[build-allium-deck] 完成');
    console.log(`  基线     ${BASE_TAG} ${BASE_COMMIT}`);
    console.log(`  补丁     ${patches.length ? patches.join(', ') : '（无）'}`);
    console.log(`  HEAD     ${head}`);
    console.log(`  worktree ${work}`);
    console.log(`  RUSTFLAGS ${env.RUSTFLAGS}`);
    console.log(`  rustc    ${versions.rustc.split('\n').filter((l) => /^(rustc|commit-hash|host|LLVM)/.test(l)).join(' | ')}`);
    for (const tool of ['cargo', 'wasm-pack', 'wasm-bindgen', 'wasm-opt']) {
        console.log(`  ${tool.padEnd(8)} ${versions[tool]}`);
    }
    console.log(`  node     ${versions.node}`);
    for (const name of ARTIFACTS) {
        console.log(`  → vendor/allium-deck-wasm/${name} (${fs.statSync(path.join(vendorDir, name)).size} bytes)`);
    }
    if (changed) {
        const { version } = JSON.parse(fs.readFileSync(path.join(vendorDir, 'package.json'), 'utf8'));
        console.log(
            `\n  产物有变化：若 ${version} 已经上线过，要提升 vendor/allium-deck-wasm/package.json 的 version，` +
                '它是 /wasm/ 产物唯一的缓存击穿键。',
        );
    }
    console.log('  下一步: bun run --cwd web copy:wasm');
}

main();
