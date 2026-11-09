#!/usr/bin/env node
/* global process, console, fetch, setTimeout, Buffer, URL, AbortSignal */
/**
 * The capture driver for the store and website pictures (DESIGN-app-screenshots-fable.md §3, lane L2): the Riverbend demo node
 * (demo-node.ts) on a fresh data dir, the real app on a phone that is Sam, and the seven screens of §1 taken in light AND dark:
 * 14 raw PNGs, `<n>-<id>-<scheme>.png` (shots.mjs), in --out.
 *
 *   node apps/native/e2e/demo/capture.mjs --out <folder> [--only home,market] [--lang en] [--ios] [--budget-min 9]
 *
 * A run stops itself, and cleans up, when its --budget-min is spent, so a call that is cut off cannot leave an emulator, Metro or
 * a node behind. The whole list takes longer than one ten-minute call: take it in goes with --only (the raw pictures add up in
 * --out; capture-report.json holds the last go's).
 *
 * No BeanPool node is contacted: the demo node answers loopback only (its guard refuses and logs anything else), the phone
 * reaches the node and Metro only through `adb reverse`, and the emulator's DNS (`-dns-server 127.0.0.1`) is either nothing at all
 * or, when the Map is among the shots (its tiles come from Google), dns-filter.mjs: it resolves Google's map servers and gives
 * NXDOMAIN to every other name, beanpool.org and every node's name included. The names the phone asked for are in the report.
 *
 * ANDROID (default). The AVD `Medium_Phone_API_36.1` headless and `-read-only` (nothing it does is saved, and another lane
 * may run the same AVD at once) on ITS OWN port (default 5584, serial emulator-5584; refused if that port, the next one, or
 * Metro's is taken), 1080x1920 at 420 dpi (Play rejects 2.22:1) and font 1.0, both put back at the end; SystemUI in demo mode
 * (9:41, battery 100, full signal, no notifications). The app is the dev client already on the AVD, loading its JS from a Metro
 * started on a `git archive` copy of this branch (never the worktree): the copy is the only place Sam's identity is patched in
 * (see `patchTree`), so no app source changes. Light and dark are chosen in Settings -> Appearance, as a member would, and the
 * app is restarted after the choice (the map bakes its scheme in when it is made). Pictures are `adb exec-out screencap -p`.
 *
 * IOS (`--ios`, written here, run by the director: it needs an iOS dev client built and installed on the simulator, which no
 * lane builds). iPhone 17 Pro Max (1320x2868), `simctl status_bar` 9:41, `simctl io screenshot`; light and dark by
 * `simctl ui appearance` with the app following the phone (the copy's patch sets that). The dev menu's first-run sheet must have
 * been put away once by hand.
 *
 * `--lang` is accepted for later; English is the only language with reviewed words, so anything else is refused for now.
 *
 * Cleanup kills only what this run started (by the PIDs it recorded) and its own emulator, after the writes are synced and the
 * app has stopped.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { SHOTS, SCHEMES, rawName } from './shots.mjs';
import { startDnsFilter } from './dns-filter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const SERVER_DIR = path.join(REPO, 'apps/server');
const riverbend = JSON.parse(fs.readFileSync(path.join(HERE, 'riverbend.json'), 'utf8'));

const SDK = process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk');
const ADB = path.join(SDK, 'platform-tools/adb');
const EMULATOR = path.join(SDK, 'emulator/emulator');
const AVD = 'Medium_Phone_API_36.1';
const APP = 'org.beanpool.pillar';
/** The phone's side of the node: `adb reverse tcp:8080 tcp:<the node's http port>`; the app's community address is localhost:8080. */
const PHONE_NODE_PORT = 8080;
const SIZE = { width: 1080, height: 1920 };
const IOS_DEVICE = 'iPhone 17 Pro Max';
const IOS_SIZE = { width: 1320, height: 2868 };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const flag = (name) => process.argv.includes(name);

const IOS = flag('--ios');
const OUT = path.resolve(arg('--out', path.join(REPO, 'scratch/store-shots', new Date().toISOString().slice(0, 10), 'raw')));
const LANG = arg('--lang', 'en');
const EMU_PORT = Number(arg('--emu-port', '5584'));
const METRO_PORT = Number(arg('--metro-port', '8101'));
const ONLY = arg('--only') ? new Set(arg('--only').split(',')) : null;
const SERIAL = `emulator-${EMU_PORT}`;
const BUDGET_MIN = Number(arg('--budget-min', '9'));
const EXPLORE = arg('--explore');

/** What a screen must say to be the right one (a soft check: a miss is logged and retried once), and what it must never say. */
const NEVER = /can't reach|cannot reach|something went wrong|unable to load|network request failed|invariant violation|unhandled js exception|couldn't connect|no connection/i;
/** Slow drags, in px, after a screen opens (Android). */
// The Ledger (Wallet tab): the balance card's top just under the header, with Beans, the stats, Send Beans and the first lines of history.
const SCROLL = { market: [500, 500], ledger: [520, 510] };
/** The pin whose preview card the Map shot opens: a single pin (not a bubble) on the 1080x1920 view the Map opens on. */
const MAP_PIN = { x: 238, y: 1512 };
const EXPECT = {
    home: [/Needs you/i, /Riverbend/i],
    market: [/Duck eggs|Bike fix/i, /Mending|Seed swap/i],
    listing: [/Duck eggs/i, /6/],
    chat: [/Two loaves for Saturday/i, /Perfect, see you there/i],
    map: [],
    event: [/Seed swap/i],
    ledger: [/Held in Trust|Lawn mowing/i],
};

// ─── Small helpers ────────────────────────────────────────────────────────────────────────────────────────────────────
const portTaken = (port) => {
    try { return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().length > 0; } catch { return false; }
};
const started = []; // every process this run spawned: { name, child }
const spawnOwn = (name, cmd, args, opts = {}) => {
    const child = spawn(cmd, args, { detached: true, ...opts });
    started.push({ name, child });
    return child;
};
const killGroup = (child, signal) => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch { /* gone */ } } };
const alive = (child) => { try { process.kill(child.pid, 0); return true; } catch { return false; } };
const lineReader = (stream, fn) => readline.createInterface({ input: stream }).on('line', fn);

// ─── The demo node (demo-node.ts, from this worktree) ──────────────────────────────────────────────────────────────────────
async function startNode() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-demo-capture-root-'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-demo-capture-data-'));
    const child = spawnOwn('demo-node', process.execPath, ['--import', 'tsx', path.join(HERE, 'demo-node.ts')], {
        cwd: SERVER_DIR, env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const tail = [];
    const waiting = new Map();
    const ready = new Promise((resolve, reject) => {
        child.on('exit', (code) => reject(new Error(`the demo node exited (${code}) before it was ready:\n${tail.slice(-25).join('\n')}`)));
        lineReader(child.stdout, (l) => {
            if (l.startsWith('FIXTURE_READY ')) resolve(JSON.parse(l.slice(14)));
            else if (l.startsWith('FIXTURE_ANSWER ')) { const a = JSON.parse(l.slice(15)); waiting.get(a.id)?.(a); waiting.delete(a.id); } else tail.push(l);
        });
        lineReader(child.stderr, (l) => tail.push(l));
    });
    const info = await Promise.race([ready, sleep(240_000).then(() => { throw new Error(`the demo node was not ready in 4 minutes:\n${tail.slice(-25).join('\n')}`); })]);
    child.removeAllListeners('exit');
    let n = 0;
    const ask = (req) => new Promise((resolve, reject) => {
        const id = ++n;
        waiting.set(id, (a) => (a.ok ? resolve(a.result) : reject(new Error(`demo node: ${a.error}`))));
        child.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
    });
    const blocked = () => tail.filter((l) => /BLOCKED-FETCH|BLOCKED-CONNECT/.test(l));
    return { info, ask, blocked, dirs: [root, dataDir], child };
}

// ─── The scratch copy of this branch that Metro serves ──────────────────────────────────────────────────────────────────────
/**
 * Sam on the phone, patched into the COPY only: when `EXPO_PUBLIC_DEMO_WORDS` and `EXPO_PUBLIC_DEMO_SERVER` are set at bundle
 * time, the identity provider makes sure the phone holds the account those 12 invented words give (createIdentityFromMnemonic)
 * and that its community is the demo node, then reads the identity as it always does. Also: LogBox is silenced (a dev build's
 * yellow warning bar would sit in every picture), and, for the iOS run, the theme follows the phone so `simctl ui appearance`
 * can switch it.
 */
export function patchTree(tree, { ios }) {
    const file = path.join(tree, 'apps/native/app/IdentityContext.tsx');
    let src = fs.readFileSync(file, 'utf8');
    const swap = (from, to) => {
        if (!src.includes(from)) throw new Error(`the identity provider no longer reads as the demo hook expects (missing: ${from.slice(0, 60)}...)`);
        src = src.replace(from, to);
    };
    swap("import { keepKeyOnThisPhone, loadIdentity, BeanPoolIdentity } from '../utils/identity';",
        "import { keepKeyOnThisPhone, loadIdentity, createIdentityFromMnemonic, BeanPoolIdentity } from '../utils/identity';\nimport { LogBox } from 'react-native';\n"
        + 'LogBox.ignoreAllLogs(true);\n'
        + 'async function loadDemoIdentity(): Promise<BeanPoolIdentity | null> {\n'
        + '    const words = process.env.EXPO_PUBLIC_DEMO_WORDS;\n'
        + '    const server = process.env.EXPO_PUBLIC_DEMO_SERVER;\n'
        + '    if (words && server) {\n'
        + "        await AsyncStorage.setItem('beanpool_anchor_url', server);\n"
        + (ios ? "        await AsyncStorage.setItem('beanpool_theme_mode', 'system');\n" : '')
        + '        if (!(await loadIdentity())) await createIdentityFromMnemonic(words.split(\' \'), \'Sam\');\n'
        + '    }\n'
        + '    return loadIdentity();\n'
        + '}');
    swap('        loadIdentity()\n            .then((loaded) => {', '        loadDemoIdentity()\n            .then((loaded) => {');
    fs.writeFileSync(file, src);
    // The listing and the event page are pushed over the tabs, which keep their own StatusBar ("light": white icons for the green
    // header) mounted underneath; the page declares none, so on the light page its clock and icons come out white on oat. The copy
    // sets the bar for those pages the way the root layout does (dark icons on light, light on dark) and gives it back on leaving.
    // This is a defect of the app, reported in the PR; it is mended here only so the pictures are readable.
    const post = path.join(tree, 'apps/native/app/post/[id].tsx');
    let p = fs.readFileSync(post, 'utf8');
    const hook = '    const { theme, colors } = useTheme();\n';
    const at = p.indexOf('export default function PostDetailModal() {');
    if (at < 0 || !p.slice(at).includes(hook) || !p.includes('import React, { useState,')) throw new Error('the post page no longer reads as the status-bar patch expects');
    p = p.slice(0, at).replace('import React, { useState,', "import { setStatusBarStyle as demoBarStyle } from 'expo-status-bar';\nimport React, { useState,")
        // asserted again every half second: the tabs underneath re-render as the phone syncs and would put their own style back
        + p.slice(at).replace(hook, `${hook}    useEffect(() => {\n        const set = () => demoBarStyle(theme === 'dark' ? 'light' : 'dark');\n        set();\n        const timer = setInterval(set, 500);\n        return () => { clearInterval(timer); demoBarStyle('light'); };\n    }, [theme]);\n`);
    fs.writeFileSync(post, p);
    if (ios) {
        // The theme provider reads the stored choice once at start: the patch above wrote 'system' first, but the two providers race,
        // so the provider's own default is 'system' in the copy as well.
        const theme = path.join(tree, 'apps/native/app/ThemeContext.tsx');
        let t = fs.readFileSync(theme, 'utf8');
        const from = "useState<ThemePreference>('light')";
        if (!t.includes(from)) throw new Error('the theme provider no longer reads as the demo hook expects');
        t = t.replace(from, "useState<ThemePreference>('system')").replace('.then(setThemePreferenceState)', ".then(() => setThemePreferenceState('system'))");
        fs.writeFileSync(theme, t);
    }
}

function prepareTree() {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-demo-capture-tree-'));
    const archive = spawnSync('sh', ['-c', 'git archive --format=tar HEAD | tar -x -C "$1"', 'sh', tree], { cwd: REPO, encoding: 'utf8' });
    if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
    // Built and installed things git does not hold, cloned (APFS copy-on-write: seconds, no bytes) into the same places.
    const clone = (rel) => {
        const from = path.join(REPO, rel);
        if (!fs.existsSync(from)) return;
        fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
        execFileSync('cp', ['-Rc', from, path.join(tree, rel)]);
    };
    clone('node_modules');
    clone('apps/native/node_modules');
    for (const pkg of fs.readdirSync(path.join(REPO, 'packages'))) {
        clone(`packages/${pkg}/node_modules`);
        clone(`packages/${pkg}/dist`);
    }
    patchTree(tree, { ios: IOS });
    return tree;
}

async function startMetro(tree, nodeHttpPort) {
    // A stub watchman that always fails: Metro then crawls with Node (a real Watchman hangs on a tree outside its roots).
    const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-demo-capture-stub-'));
    fs.writeFileSync(path.join(stub, 'watchman'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const logFile = path.join(os.tmpdir(), `bp-demo-capture-metro-${process.pid}.log`);
    const fd = fs.openSync(logFile, 'w');
    const child = spawnOwn('metro', 'npx', ['expo', 'start', '--dev-client', '--port', String(METRO_PORT), '--offline'], {
        cwd: path.join(tree, 'apps/native'),
        env: {
            ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', PATH: `${stub}:${process.env.PATH}`,
            EXPO_PUBLIC_DEMO_WORDS: riverbend.sam.words.join(' '),
            EXPO_PUBLIC_DEMO_SERVER: IOS ? `http://localhost:${nodeHttpPort}` : `http://localhost:${PHONE_NODE_PORT}`,
        },
        stdio: ['ignore', fd, fd],
    });
    for (let i = 0; ; i++) {
        if (i > 90) throw new Error(`Metro never came up (log: ${logFile})`);
        try { const r = await fetch(`http://localhost:${METRO_PORT}/status`); if ((await r.text()).includes('running')) break; } catch { /* not yet */ }
        await sleep(2000);
    }
    log('Metro is up; building the bundle (the first one takes a minute or two)');
    const t0 = Date.now();
    const url = `http://localhost:${METRO_PORT}/node_modules/expo-router/entry.bundle?platform=${IOS ? 'ios' : 'android'}&dev=true&minify=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(480_000) });
    const bundle = await res.text();
    if (!res.ok) throw new Error(`Metro could not build the app (HTTP ${res.status}): ${bundle.slice(0, 400)}`);
    if (!bundle.includes('loadDemoIdentity')) throw new Error('the bundle Metro serves does not hold the demo identity hook');
    log(`bundle ${Math.round(bundle.length / 1024)} KB in ${Math.round((Date.now() - t0) / 1000)} s, with Sam's hook`);
    return { child, stub, logFile };
}

// ─── uiautomator reading ─────────────────────────────────────────────────────────────────────────────────────────────────
const bounds = (tag) => {
    const b = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    return b ? { x: (+b[1] + +b[3]) >> 1, y: (+b[2] + +b[4]) >> 1, top: +b[2], bottom: +b[4], left: +b[1], right: +b[3] } : null;
};
const nodes = (xml) => [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0]);
const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] ?? '';
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, ' ');
/** All the words on screen (text and content-desc), one string, for the checks. */
const wordsOf = (xml) => nodes(xml).map((n) => `${decode(attr(n, 'text'))} ${decode(attr(n, 'content-desc'))}`.trim()).filter(Boolean).join(' | ');
const findNode = (xml, { desc, text, re }) => {
    for (const n of nodes(xml)) {
        const d = decode(attr(n, 'content-desc'));
        const t = decode(attr(n, 'text'));
        if ((desc != null && d === desc) || (text != null && t === text) || (re && (re.test(d) || re.test(t)))) {
            const b = bounds(n);
            if (b && b.bottom > b.top && b.right > b.left) return { tag: n, ...b };
        }
    }
    return null;
};

// ─── The Android phone ─────────────────────────────────────────────────────────────────────────────────────────────────────
function androidDevice() {
    const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 90_000 });
    const sh = (cmd) => adb('shell', cmd);
    const dev = {
        original: { size: null, density: null, font: null },
        async boot() {
            const logs = [fs.openSync(path.join(os.tmpdir(), `bp-demo-capture-emu-${process.pid}.log`), 'w'), fs.openSync(path.join(os.tmpdir(), `bp-demo-capture-emu-${process.pid}.err`), 'w')];
            // -read-only: nothing is saved and a second run of the same AVD may share it. -dns-server 127.0.0.1: no name resolves,
            // unless dns-filter.mjs is listening there (the Map's run).
            dev.emu = spawnOwn('emulator', EMULATOR, ['-avd', AVD, '-read-only', '-port', String(EMU_PORT), '-no-window', '-no-audio', '-no-boot-anim',
                '-no-snapshot-save', '-crash-report-mode', 'never', '-dns-server', '127.0.0.1'], { stdio: ['ignore', logs[0], logs[1]] });
            for (let i = 0; ; i++) {
                if (i > 180) throw new Error('the emulator never finished booting');
                try { if (adb('shell', 'getprop', 'sys.boot_completed').trim() === '1') break; } catch { /* not yet */ }
                await sleep(2000);
            }
            await sleep(10_000);
            for (let i = 0; i < 60; i++) { try { if (sh('cat /proc/loadavg').split(' ')[0] < 6) break; } catch { /* restarting */ } await sleep(3000); }
            log('booted', SERIAL, sh('cat /proc/loadavg').trim());
        },
        async setup() {
            dev.original = { size: sh('wm size').match(/Physical size: (\S+)/)?.[1], density: sh('wm density').match(/Physical density: (\d+)/)?.[1], font: sh('settings get system font_scale').trim() };
            sh(`wm size ${SIZE.width}x${SIZE.height}`);
            sh('wm density 420');
            sh('settings put system font_scale 1.0');
            for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) sh(`settings put global ${k} 0`);
            // gesture navigation: a slim pill, not three buttons, under the picture
            try { sh('cmd overlay enable com.android.internal.systemui.navbar.gestural'); } catch { /* keep the AVD's own */ }
            // A pristine app. The AVD's own disk holds the data of lanes that ran before (an old account, saved nodes): with
            // -read-only this run's writes, the clear included, go to a throwaway layer and are gone when the emulator exits.
            sh(`am force-stop ${APP}`);
            sh(`pm clear ${APP}`);
            // The dev client's first-run sheet and its floating gear would sit in every picture: mark its onboarding done, hide the gear.
            const devMenu = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n"
                + ['isOnboardingFinished:true', 'showFab:false', 'showsAtLaunch:false', 'motionGestureEnabled:false', 'touchGestureEnabled:false']
                    .map((kv) => `    <boolean name="${kv.split(':')[0]}" value="${kv.split(':')[1]}" />`).join('\n') + '\n</map>\n';
            sh(`run-as ${APP} mkdir -p shared_prefs`);
            execFileSync(ADB, ['-s', SERIAL, 'shell', `run-as ${APP} sh -c 'cat > shared_prefs/expo.modules.devmenu.sharedpreferences.xml'`], { input: devMenu, timeout: 30_000 });
            try { sh(`pm grant ${APP} android.permission.POST_NOTIFICATIONS`); } catch { /* none to grant */ }
            adb('reverse', `tcp:${METRO_PORT}`, `tcp:${METRO_PORT}`);
            adb('reverse', `tcp:${PHONE_NODE_PORT}`, `tcp:${dev.nodeHttpPort}`);
            await sleep(2000);
            // SystemUI demo mode: 9:41, battery 100, full signal and wifi, no notifications.
            sh('settings put global sysui_demo_allowed 1');
            const demo = (...extra) => sh(`am broadcast -a com.android.systemui.demo -e command ${extra.join(' ')}`);
            demo('enter');
            demo('clock -e hhmm 0941');
            demo('battery -e plugged false -e level 100 -e powersave false');
            demo('network -e wifi show -e level 4 -e fully true');
            // The mobile part is hidden: whatever data type the demo command is given (`none`, `lte`) the emulator's own radio keeps
            // drawing a "3G" badge and half its bars; the wifi icon is at full strength.
            demo('network -e mobile hide');
            demo('notifications -e visible false');
            demo('bars -e mode transparent');
            log('phone:', sh('wm size').trim().replace(/\n/g, ' '), sh('wm density').trim().replace(/\n/g, ' '), 'font', sh('settings get system font_scale').trim());
        },
        dump() {
            for (let i = 0; i < 3; i++) {
                try { sh('uiautomator dump /sdcard/bp-ui.xml >/dev/null 2>&1'); const xml = sh('cat /sdcard/bp-ui.xml'); if (xml.includes('<hierarchy')) return xml; } catch { /* idle never came */ }
            }
            return '';
        },
        /** Is BeanPool the app in front? (A slow or crashed start leaves the launcher there; a swipe on it opens the app drawer.) */
        inApp() { try { return sh('dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity"').includes(APP); } catch { return false; } },
        /** If the app is not in front, load it again and wait for its first screen. True when it had to. */
        async ensureApp() {
            if (dev.inApp()) return false;
            log('the app is not in front: loading it again');
            dev.launch();
            for (let i = 0; i < 40; i++) {
                await sleep(3000);
                const xml = dev.dump();
                if (xml && dev.clearOverlays(xml)) continue;
                if (/Needs you|Your Beans|Market|Ledger/i.test(wordsOf(xml)) && dev.inApp()) { await sleep(8000); return true; }
            }
            throw new Error('the app would not load again');
        },
        /** What killed the app, if something did: the crash buffer's fatal lines (a stack of the app's own code, no data). */
        diagnose() {
            try { return sh('logcat -b crash -d -t 60 | grep -E "FATAL|Process:|Caused by|Exception" | head -8').trim(); } catch { return ''; }
        },
        tap: (x, y) => sh(`input tap ${x} ${y}`),
        swipeUp: () => sh('input swipe 540 1500 540 700 350'),
        /** A slow drag of the finger up by `px`: the page moves by about that much and does not fling on. */
        drag: (px) => sh(`input swipe 540 1500 540 ${1500 - px} 1400`),
        back: () => sh('input keyevent 4'),
        stop: () => sh(`am force-stop ${APP}`),
        open(uri) { sh(`am start -a android.intent.action.VIEW -d '${uri.replace(/&/g, '\\&')}' ${APP}`); },
        launch() { sh(`am start -a android.intent.action.VIEW -d "beanpool://expo-development-client/?url=http%3A%2F%2Flocalhost%3A${METRO_PORT}" ${APP}`); },
        shot(file) {
            const png = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { timeout: 60_000, maxBuffer: 64 << 20 });
            fs.writeFileSync(file, png);
            return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
        },
        /** Put away the dev client's one-off sheet and any "isn't responding" dialog, if either is up. */
        clearOverlays(xml) {
            if (/developer menu/i.test(wordsOf(xml))) { dev.back(); return true; }
            // The dev client fell back to its launcher (a slow start gave up): load the app again.
            if (/Fetch development servers|RECENTLY OPENED/.test(wordsOf(xml))) { dev.launch(); return true; }
            const wait = findNode(xml, { text: 'Wait' });
            if (wait && /isn't responding/i.test(wordsOf(xml))) { dev.tap(wait.x, wait.y); return true; }
            return false;
        },
        async setScheme(scheme) {
            dev.open('beanpool://settings');
            await sleep(6000);
            const label = scheme === 'dark' ? 'Dark' : 'Light';
            let xml = '';
            for (let i = 0; i < 14; i++) {
                if (await dev.ensureApp()) { dev.open('beanpool://settings'); await sleep(6000); }
                xml = dev.dump();
                if (dev.clearOverlays(xml)) { await sleep(2000); continue; }
                const radio = findNode(xml, { desc: label });
                if (radio && attr(radio.tag, 'clickable') === 'true' && radio.top > 300 && radio.bottom < SIZE.height - 120) {
                    if (attr(radio.tag, 'checked') !== 'true') { dev.tap(radio.x, radio.y); await sleep(1500); }
                    const after = dev.dump();
                    const now = findNode(after, { desc: label });
                    if (now && attr(now.tag, 'checked') === 'true') { log(`Appearance: ${label}`); return; }
                    throw new Error(`tapped ${label} in Settings but it is not the checked choice`);
                }
                dev.swipeUp();
                await sleep(1200);
            }
            throw new Error(`could not find Appearance -> ${label} in Settings (on screen: ${wordsOf(xml).slice(0, 300)}; radios: ${nodes(xml).filter((n) => /radio/i.test(attr(n, 'class')) || /Light|Dark|Same as phone/.test(attr(n, 'content-desc'))).map((n) => `${attr(n, 'class')}/${attr(n, 'content-desc')}/${attr(n, 'clickable')}`).join(' ')})`);
        },
        async teardown() {
            try { dev.stop(); } catch { /* gone */ }
            try { adb('reverse', '--remove', `tcp:${METRO_PORT}`); adb('reverse', '--remove', `tcp:${PHONE_NODE_PORT}`); } catch { /* gone */ }
            try { sh('am broadcast -a com.android.systemui.demo -e command exit'); } catch { /* gone */ }
            try {
                sh('wm size reset');
                sh('wm density reset');
                sh(`settings put system font_scale ${dev.original.font && dev.original.font !== 'null' ? dev.original.font : '1.0'}`);
                for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) sh(`settings put global ${k} 1`);
                sh('cmd overlay disable com.android.internal.systemui.navbar.gestural');
            } catch { /* gone */ }
            // The memory rule: sync, then let the emulator exit on its own before any kill.
            try { sh('sync'); await sleep(2000); sh('sync'); await sleep(3000); } catch { /* gone */ }
            try { adb('emu', 'kill'); } catch { /* gone */ }
            for (let i = 0; i < 30 && dev.emu && alive(dev.emu); i++) await sleep(1000);
        },
    };
    return dev;
}

// ─── The iOS simulator (the director's step: needs an iOS dev client installed on it) ───────────────────────────────────────────
function iosDevice() {
    const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8', timeout: 90_000 });
    const dev = {
        udid: null,
        async boot() {
            const list = JSON.parse(simctl('list', 'devices', 'available', '-j')).devices;
            const found = Object.values(list).flat().find((d) => d.name === IOS_DEVICE);
            if (!found) throw new Error(`no simulator named "${IOS_DEVICE}" (Xcode -> Settings -> Platforms)`);
            dev.udid = found.udid;
            dev.wasBooted = found.state === 'Booted';
            if (!dev.wasBooted) simctl('boot', dev.udid);
            simctl('bootstatus', dev.udid, '-b');
            if (!/org\.beanpool/.test(simctl('listapps', dev.udid))) throw new Error('no BeanPool dev client on the simulator: the director builds and installs it first (eas build --local, development profile, simulator)');
            await sleep(3000);
        },
        async setup() {
            simctl('status_bar', dev.udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--cellularMode', 'active', '--cellularBars', '4', '--wifiMode', 'active', '--wifiBars', '3', '--operatorName', '');
        },
        dump: () => '',
        stop() { /* the app is left to the simulator */ },
        open(uri) { simctl('openurl', dev.udid, uri); },
        launch() { simctl('openurl', dev.udid, `exp+beanpool://expo-development-client/?url=${encodeURIComponent(`http://localhost:${METRO_PORT}`)}`); },
        shot(file) {
            simctl('io', dev.udid, 'screenshot', '--type=png', file);
            const png = fs.readFileSync(file);
            return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
        },
        clearOverlays: () => false,
        ensureApp: async () => false,
        async setScheme(scheme) { simctl('ui', dev.udid, 'appearance', scheme); await sleep(2500); },
        async teardown() {
            try { simctl('status_bar', dev.udid, 'clear'); } catch { /* gone */ }
            try { simctl('ui', dev.udid, 'appearance', 'light'); } catch { /* gone */ }
            if (!dev.wasBooted) { try { simctl('shutdown', dev.udid); } catch { /* gone */ } }
        },
    };
    return dev;
}

// ─── The run ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const routeOf = (shot, world) => ({
    home: 'beanpool://',
    market: 'beanpool://market',
    // Duck eggs, not the sourdough: Sam has an open deal on the loaves, so that page shows his Release and Cancel, not an Offer to take up.
    listing: `beanpool://post/${world.posts['duck-eggs']}`,
    chat: `beanpool://chat/${world.dm}`,
    map: 'beanpool://map',
    event: `beanpool://post/${world.events['seed-swap']}`,
    ledger: 'beanpool://ledger',
}[shot.id]);

async function main() {
    if (LANG !== 'en') throw new Error(`--lang ${LANG}: English is the only language with reviewed words; the machine drafts are not for the store yet`);
    fs.mkdirSync(OUT, { recursive: true });
    const wanted = SHOTS.filter((s) => !ONLY || ONLY.has(s.id));
    if (!wanted.length) throw new Error(`--only ${[...ONLY].join(',')} names no shot (${SHOTS.map((s) => s.id).join(', ')})`);
    if (!IOS) {
        for (const p of [EMU_PORT, EMU_PORT + 1, METRO_PORT]) if (portTaken(p)) throw new Error(`port ${p} is taken: another run holds it (pick others with --emu-port / --metro-port)`);
        if (!fs.existsSync(EMULATOR) || !fs.existsSync(ADB)) throw new Error(`no Android SDK at ${SDK}`);
    } else if (portTaken(METRO_PORT)) throw new Error(`port ${METRO_PORT} is taken (pick another with --metro-port)`);

    const dirs = [];
    const report = { startedAt: new Date().toISOString(), platform: IOS ? 'ios' : 'android', shots: [] };
    const dev = IOS ? iosDevice() : androidDevice();
    let node;
    let dns = null;
    let cleaned = false;
    const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        try { await dev.teardown?.(); } catch (e) { log('teardown:', e.message); }
        if (dns) {
            const names = new Map();
            for (const q of dns.asked) names.set(q.name, q.allowed);
            report.dnsNamesAsked = [...names].map(([name, allowed]) => ({ name, allowed })).sort((a, b) => a.name.localeCompare(b.name));
            await dns.close();
        }
        for (const { name, child } of started.slice().reverse()) {
            if (name === 'emulator' && alive(child)) { killGroup(child, 'SIGTERM'); await sleep(3000); }
            if (name !== 'emulator') killGroup(child, 'SIGTERM');
        }
        await sleep(2500);
        for (const { child } of started) if (alive(child)) killGroup(child, 'SIGKILL');
        for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
        report.finishedAt = new Date().toISOString();
        const reportFile = path.join(OUT, `capture-report-${ONLY ? [...ONLY].join('+') : 'all'}.json`);
        fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
        log(`report: ${reportFile}`);
    };
    // A run must end inside the time it was given: a tool call that is cut off leaves an emulator, Metro and a node behind.
    const watchdog = setTimeout(async () => {
        log(`the ${BUDGET_MIN}-minute budget is spent: stopping (take fewer shots with --only, or give a longer --budget-min)`);
        report.error = `stopped at the ${BUDGET_MIN}-minute budget`;
        await cleanup();
        process.exit(2);
    }, BUDGET_MIN * 60_000);
    try {
        log('starting the Riverbend demo node (fresh data dir)');
        node = await startNode();
        dirs.push(...node.dirs);
        const world = await node.ask({ op: 'world' });
        dev.nodeHttpPort = node.info.httpPort;
        log(`demo node up: ${Object.keys(world.members).length} members, ${Object.keys(world.posts).length} listings, http ${node.info.httpPort}`);

        log('preparing the scratch copy of this branch (git archive + Sam\'s hook)');
        const tree = prepareTree();
        dirs.push(tree);
        const metro = await startMetro(tree, node.info.httpPort);
        dirs.push(metro.stub);

        // The Map's tiles come from Google: a name server that resolves Google's map servers and nothing else (dns-filter.mjs).
        if (!IOS && wanted.some((s) => s.id === 'map')) {
            try {
                dns = await startDnsFilter();
                log('DNS: Google\'s map servers only; every other name, BeanPool\'s included, is refused');
            } catch (e) {
                log(`DNS: could not listen on port 53 (${e.code ?? e.message}); the phone gets no DNS and the Map will have no tiles`);
            }
        }
        await dev.boot();
        await dev.setup();

        // First launch: the dev client loads the bundle (the first load of a big bundle is slow), then the app starts as Sam.
        const startApp = async () => {
            dev.stop();
            await sleep(1500);
            dev.launch();
            for (let i = 0; i < 80; i++) {
                await sleep(3000);
                if (IOS) { if (i > 8) return; continue; }
                const xml = dev.dump();
                if (!xml) continue;
                if (dev.clearOverlays(xml)) continue;
                const words = wordsOf(xml);
                // The first screen is up: let the phone finish its first sync (RSVPs, deals, photos) before anything is taken.
                if (/Needs you|Your Beans|Market|Ledger/i.test(words) && !/Loading from|Bundling|Downloading/i.test(words)) {
                    await node.ask({ op: 'resetLimits' }).catch(() => {});
                    await sleep(12_000);
                    return;
                }
            }
            throw new Error('the app never reached its first screen (see the last picture for why)');
        };
        await startApp();

        // --explore <id>: not a capture, a look: that screen in light, five screens' worth down, to choose where a shot should sit.
        if (EXPLORE) {
            const shot = SHOTS.find((s) => s.id === EXPLORE);
            if (!shot) throw new Error(`--explore ${EXPLORE} names no shot`);
            await dev.setScheme('light');
            await startApp();
            dev.open(routeOf(shot, world));
            await sleep(7000);
            if (shot.id === 'map') {
                // the second visit (as the capture does), then the zoom-in button, a shot at each level
                dev.open('beanpool://'); await sleep(3500); dev.open(routeOf(shot, world)); await sleep(12_000);
                for (let k = 0; k < 3; k++) {
                    dev.shot(path.join(OUT, `explore-map-${k}.png`));
                    const zin = findNode(dev.dump(), { desc: 'Zoom in' });
                    if (!zin) { log('no Zoom in button'); break; }
                    dev.tap(zin.x, zin.y); await sleep(4000);
                }
                log(`explored map: ${OUT}/explore-map-0..2.png`);
                return;
            }
            if (shot.id === 'ledger') { const w = findNode(dev.dump(), { re: /^Wallet$/ }); if (w) { dev.tap(w.x, w.y); await sleep(2500); } }
            for (let k = 0; k < 5; k++) {
                const xml = dev.dump();
                dev.clearOverlays(xml);
                dev.shot(path.join(OUT, `explore-${shot.id}-${k}.png`));
                dev.swipeUp();
                await sleep(1800);
            }
            log(`explored ${shot.id}: ${OUT}/explore-${shot.id}-0..4.png`);
        }

        for (const scheme of SCHEMES) {
            await dev.setScheme(scheme);
            await startApp(); // a fresh start: the map takes its scheme when it is made
            for (const shot of wanted) {
                const entry = { id: shot.id, scheme, file: rawName(shot, scheme), tries: 0, size: null, issues: [] };
                const target = path.join(OUT, entry.file);
                for (let attempt = 1; attempt <= 3; attempt++) {
                    entry.tries = attempt;
                    entry.issues = [];
                    // The node's rate limiter counts the app's polling: start each look afresh (as the web proof does).
                    await node.ask({ op: 'resetLimits' }).catch(() => {});
                    // Another go starts from Home, so a screen that was scrolled last time is opened at its top again.
                    if (attempt > 1) { dev.open('beanpool://'); await sleep(3500); }
                    dev.open(routeOf(shot, world));
                    await sleep(shot.id === 'map' ? 9000 : shot.id === 'market' ? 8500 : 5500);
                    if (shot.id === 'map') {
                        // The map moves to the community's place (GET /api/node/config) when the Map tab comes into focus; on its first
                        // visit the native map is not made yet and the move is lost, so it opens on the app's built-in default (a real
                        // town). A second visit, with the map made, moves it. The app is not changed: only how it is visited.
                        dev.open('beanpool://');
                        await sleep(3500);
                        await node.ask({ op: 'resetLimits' }).catch(() => {});
                        dev.open(routeOf(shot, world));
                        await sleep(14_000);
                        // One pin tapped, for the preview card the design asks for. Where it sits is measured from the pictures of
                        // this very view (1080x1920, the community's centre, the same zoom each time), not looked up in the app.
                        if (!IOS) { dev.tap(MAP_PIN.x, MAP_PIN.y); await sleep(3000); }
                    }
                    if (await dev.ensureApp()) { dev.open(routeOf(shot, world)); await sleep(7000); }
                    let xml = dev.dump();
                    if (dev.clearOverlays(xml)) { await sleep(2500); xml = dev.dump(); }
                    if (shot.id === 'chat' || shot.id === 'listing' || shot.id === 'event') await sleep(1500);
                    // The Ledger opens on the trust levels; the history of trades is under Wallet.
                    if (shot.id === 'ledger' && !IOS) {
                        const wallet = findNode(xml, { re: /^Wallet$/ });
                        if (wallet) { dev.tap(wallet.x, wallet.y); await sleep(2500); } else entry.issues.push('no Wallet tab to open');
                    }
                    // Where on a long screen the picture sits: the Market, two screens down from its top, shows five cards with
                    // their photos, chips and prices; its top is the search box over one tall poll.
                    for (const px of SCROLL[shot.id] ?? []) {
                        if (!dev.drag) { entry.issues.push('this phone cannot scroll from a script: the screen is shown at its top'); break; }
                        dev.drag(px);
                        await sleep(1800);
                    }
                    xml = dev.dump() || xml;
                    const words = wordsOf(xml);
                    if (NEVER.test(words)) entry.issues.push(`the screen says: ${words.match(NEVER)[0]}`);
                    for (const re of EXPECT[shot.id]) if (xml && !re.test(words)) entry.issues.push(`not on screen: ${re}`);
                    entry.size = dev.shot(target);
                    const want = IOS ? IOS_SIZE : SIZE;
                    if (entry.size.width !== want.width || entry.size.height !== want.height) entry.issues.push(`picture is ${entry.size.width}x${entry.size.height}, wanted ${want.width}x${want.height}`);
                    entry.words = words.slice(0, 900);
                    if (!entry.issues.length) break;
                    log(`${entry.file}: ${entry.issues.join('; ')}${attempt < 3 ? ' (again)' : ''}`);
                }
                log(`${entry.file}: ${entry.size.width}x${entry.size.height}${entry.issues.length ? `  CHECK: ${entry.issues.join('; ')}` : ''}`);
                report.shots.push(entry);
            }
        }
        const blocked = node.blocked();
        report.demoNodeGuardRefused = blocked;
        if (blocked.length) log(`the demo node's guard refused (and logged) ${blocked.length} attempt(s) to leave the machine: ${blocked.join(' | ')}`);
    } catch (e) {
        report.error = e.message;
        log('FAILED:', e.message);
        const why = dev.diagnose?.();
        if (why) { report.crashLines = why; log(`crash buffer: ${why.replace(/\n/g, ' | ')}`); }
        try { dev.shot(path.join(OUT, 'failed.png')); } catch { /* no device */ }
        process.exitCode = 1;
    } finally {
        clearTimeout(watchdog);
        await cleanup();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
