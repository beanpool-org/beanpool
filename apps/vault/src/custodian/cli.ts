#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isVaultKeyHex } from '@beanpool/core';
import type { CustodianShare } from '../shared/ceremony.js';
import { rootKeysFor } from '../shared/pinned.js';
import { API_BUNDLE_ASSET, GitHubReleaseFeed, LocalDirectoryFeed, MANIFEST_ASSET, SIGNATURES_ASSET, type ReleaseFeed } from '../shared/release-feed.js';
import {
    addSignature,
    compareVersions,
    formatManifest,
    formatSignatures,
    imageHashOf,
    manifestHash,
    parseHostPolicy,
    parseManifest,
    parseSignatures,
    resolveChain,
    sha256Hex,
    signRelease,
    validSigners,
    type ReleaseImage,
    type ReleaseManifest,
} from '../shared/release.js';
import type { AlertChannels, OperatorSettings } from '../shared/settings.js';
import { parseSettings, settingsHash } from '../shared/settings.js';
import { openKeyFile, sealKeyFile } from './keyfile.js';
import {
    cancelPending,
    confirmShare,
    CustodianRefusal,
    custodianKey,
    fetchPendingShare,
    genesis,
    listBackups,
    loadReleases,
    newCustodianKey,
    presentShare,
    restoreFromBackup,
    sendSettings,
    type CallOptions,
    type CustodianCall,
    type CustodianKey,
    type ReleaseTrust,
} from './lib.js';
import { VaultWatcher } from './watch.js';

/**
 * `vault-custodian`: a custodian's tool (key vault design §2, §3; host design §5.1 item 4).
 *
 *   vault-custodian new-key       --out <keyfile>
 *   vault-custodian public-key    --key <keyfile>
 *   vault-custodian genesis       --url <vault> --key <keyfile> --out <dir>          [checks]
 *   vault-custodian unlock        --url <vault> --key <keyfile> --share <file>       [checks]
 *   vault-custodian reshare       --url <vault> --key <keyfile> --share <file> --new-custodians <a,b,c> --out <dir> [checks]
 *   vault-custodian restore       --url <vault> --key <keyfile> --backup <name>      [checks]
 *   vault-custodian fetch-share   --url <vault> --key <keyfile> --out <dir>
 *   vault-custodian confirm       --url <vault> --key <keyfile> --share <file>
 *   vault-custodian cancel        --url <vault> --key <keyfile> --pending <id>
 *   vault-custodian settings hash --file <settings.json>
 *   vault-custodian settings send --url <vault> --key <keyfile> --file <settings.json>  [checks]
 *   vault-custodian backups       --url <vault> --key <keyfile>
 *   vault-custodian watch         --url <vault> --ticket-key <hex> [--alerts <alerts.json>] [--every <seconds>] [--once]
 *   vault-custodian release status                                                  [feed]
 *   vault-custodian release propose --version <x.y.z> (--image <image.json> | --same-image) --api-bundle <file>
 *                                   (--custodian-keys <a,b,c> | --same-custodians) [--host-policy <file>] [--notes <text>]
 *                                   --out <dir>                                    [feed]
 *   vault-custodian release sign    --dir <dir> --key <keyfile> [--yes]              [feed]
 *   vault-custodian release verify  --dir <dir>                                      [feed]
 *
 *   [checks] = [--no-hardware-proof] [--accept-release <version>] [feed]
 *   [feed]   = [--feed <owner/name> | --feed-dir <dir>] [--root-keys <file>]
 *
 * Before genesis, an unlock, a reshare or a restore, the tool reads the releases (the repo's GitHub Releases, or a
 * directory), walks them from the vault's genesis custodian keys (built into this file; `--root-keys` only for a run
 * from source), and checks the vault's hello against the newest one: its image, then its host policy. On `none` it
 * says plainly that the host can read the vault's memory, and sends your part only when you type yes (or passed
 * `--no-hardware-proof`). A refused check sends nothing.
 *
 * `settings` are the vault's operator settings (shared/settings.ts: the off-box backup store, the alert channels): they
 * take effect when two custodians have sent the same file. `settings hash` prints the hash the vault answers and
 * reports, to check which settings are in force. `backups` lists what the vault's own store and the off-box store hold
 * (the cold path: set the settings on a fresh vault, list, then `restore --backup <name>`, then two unlock).
 *
 * `watch` runs anywhere but the vault (custodian/watch.ts): every `--every` seconds (60) it looks at the vault and tells
 * the channels in `--alerts` (`{"email": {...}, "webhook": {...}}`, as in the settings) when it is gone or locked for
 * five minutes, its report isn't signed by `--ticket-key` (the key the apps pin) or isn't fresh, or the report says
 * backups are failing. `--once` looks once, sends nothing, prints what it saw and exits 1 on any problem (for cron).
 *
 * Key files are sealed under a passphrase (keyfile.ts), asked for on the terminal, or taken from
 * VAULT_CUSTODIAN_PASSPHRASE. Every flag a command needs is checked, and every file it reads is read, before anything is
 * sent. New shares are written under --out first, and only then is this custodian's own share confirmed.
 */

const FEED_FLAGS = ['--feed', '--feed-dir', '--root-keys'];
const CHECK_FLAGS = [...FEED_FLAGS, '--accept-release'];

const COMMANDS: Record<string, { required: string[]; optional?: string[] }> = {
    'new-key': { required: ['--out'] },
    'public-key': { required: ['--key'] },
    genesis: { required: ['--url', '--key', '--out'], optional: CHECK_FLAGS },
    unlock: { required: ['--url', '--key', '--share'], optional: CHECK_FLAGS },
    reshare: { required: ['--url', '--key', '--share', '--new-custodians', '--out'], optional: CHECK_FLAGS },
    restore: { required: ['--url', '--key', '--backup'], optional: CHECK_FLAGS },
    'fetch-share': { required: ['--url', '--key', '--out'] },
    confirm: { required: ['--url', '--key', '--share'] },
    cancel: { required: ['--url', '--key', '--pending'] },
    'settings hash': { required: ['--file'] },
    'settings send': { required: ['--url', '--key', '--file'], optional: CHECK_FLAGS },
    backups: { required: ['--url', '--key'] },
    watch: { required: ['--url', '--ticket-key'], optional: ['--alerts', '--every'] },
    'release status': { required: [], optional: FEED_FLAGS },
    'release propose': { required: ['--version', '--api-bundle', '--out'], optional: [...FEED_FLAGS, '--image', '--custodian-keys', '--host-policy', '--notes'] },
    'release sign': { required: ['--dir', '--key'], optional: FEED_FLAGS },
    'release verify': { required: ['--dir'], optional: FEED_FLAGS },
};

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    const v = i === -1 ? undefined : process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? undefined : v;
}

const flag = (name: string) => process.argv.includes(name);

function stop(message: string, code = 2): never {
    console.error(message);
    process.exit(code);
}

// ─── The terminal ────────────────────────────────────────────────────────────────────────────

// One reader for stdin, piped or a terminal. It is resumed only while a read waits and paused again after it: a paused
// stream delivers nothing (a 'data' listener alone does not restart it), and a resumed one keeps the process alive.
let stdinBuf = '';
let stdinEnded = false;
let stdinListening = false;
let stdinWaiter: (() => void) | null = null;
let rawMode = false;

function setRaw(on: boolean): void {
    if (rawMode === on) return;
    process.stdin.setRawMode(on);
    rawMode = on;
}

/** Ctrl-C at a hidden read (raw mode passes it as a character, not a signal): the terminal back as it was, and not 0. */
function interrupted(): never {
    setRaw(false);
    process.stderr.write('\n');
    return stop('Stopped (Ctrl-C). Nothing more was done.', 130);
}

/** One line typed (or piped) in; null when there is none. Hidden on a terminal when `hidden`: no echo, raw mode until Enter. */
async function readLine(prompt: string, hidden = false): Promise<string | null> {
    const secret = Boolean(process.stdin.isTTY) && hidden;
    if (secret) setRaw(true); // before the prompt, so nothing typed after it is ever echoed
    process.stderr.write(prompt);
    if (!stdinListening) {
        stdinListening = true;
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d: string) => {
            stdinBuf += d;
            stdinWaiter?.();
        });
        process.stdin.on('end', () => {
            stdinEnded = true;
            stdinWaiter?.();
        });
    }
    let text = '';
    try {
        for (;;) {
            if (secret) {
                const chars = Array.from(stdinBuf);
                stdinBuf = '';
                for (let i = 0; i < chars.length; i++) {
                    const ch = chars[i];
                    if (ch === '\r' || ch === '\n') {
                        stdinBuf = chars.slice(i + 1).join('').replace(/^\n/, '');
                        process.stderr.write('\n');
                        return text;
                    }
                    if (ch === '\u0003') interrupted();
                    if (ch === '\u0004') {
                        process.stderr.write('\n');
                        return null;
                    }
                    if (ch === '\u007f' || ch === '\b') text = Array.from(text).slice(0, -1).join('');
                    else text += ch;
                }
            } else {
                const nl = stdinBuf.indexOf('\n');
                if (nl !== -1) {
                    const line = stdinBuf.slice(0, nl).replace(/\r$/, '');
                    stdinBuf = stdinBuf.slice(nl + 1);
                    return line;
                }
                if (stdinEnded && stdinBuf) {
                    const line = stdinBuf;
                    stdinBuf = '';
                    return line;
                }
            }
            if (stdinEnded) return null;
            await new Promise<void>(resolve => {
                stdinWaiter = resolve;
                process.stdin.resume();
            });
            stdinWaiter = null;
        }
    } finally {
        process.stdin.pause();
        if (secret) setRaw(false);
    }
}

async function passphrase(prompt: string): Promise<string> {
    const env = process.env.VAULT_CUSTODIAN_PASSPHRASE;
    if (env) return env;
    const typed = await readLine(prompt, true);
    if (!typed) stop('No passphrase given.');
    return typed;
}

async function confirmYes(question: string): Promise<boolean> {
    const answer = await readLine(`${question} Type yes to go on: `);
    return answer?.trim().toLowerCase() === 'yes';
}

// ─── Files ───────────────────────────────────────────────────────────────────────────────────

async function loadKey(file: string): Promise<CustodianKey> {
    const text = readFileSync(file, 'utf8');
    const needs = (JSON.parse(text) as { v?: number }).v === 2;
    const opened = openKeyFile(text, needs ? await passphrase(`Passphrase for ${file}: `) : null);
    if (!opened.protectedByPassphrase) console.error(`warning: ${file} is not protected by a passphrase. Make a new one with new-key and move to it.`);
    return custodianKey(opened.seed);
}

function loadShare(file: string): CustodianShare {
    const share = JSON.parse(readFileSync(file, 'utf8')) as CustodianShare;
    if (!share || share.v !== 1 || typeof share.custodian !== 'string' || !share.box) throw new Error(`${file} is not a custodian share.`);
    return share;
}

function writeShares(dir: string, shares: CustodianShare[]): void {
    for (const s of shares) {
        const file = path.join(dir, `share-${s.generation}-${s.index}-${s.custodian.slice(0, 8)}.json`);
        writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
        console.log(`share ${s.index} for ${s.custodian.slice(0, 8)}…: ${file}`);
    }
}

function print(result: CustodianCall): void {
    const rest: Record<string, unknown> = { ...result.body };
    delete rest.custodianShares;
    delete rest.share;
    console.log(result.status, JSON.stringify(rest));
}

function keyList(text: string, what: string): string[] {
    const keys = text.split(',').map(s => s.trim());
    if (keys.length !== 3 || !keys.every(isVaultKeyHex) || new Set(keys).size !== 3) stop(`${what} is three different custodian keys (64 hex characters each), comma-separated`);
    return keys;
}

function trustFromFlags(): ReleaseTrust {
    const rootFile = arg('--root-keys');
    const given = rootFile ? (JSON.parse(readFileSync(rootFile, 'utf8')) as { genesisCustodians?: unknown }).genesisCustodians : undefined;
    const rootKeys = rootKeysFor(given);
    if (!rootKeys) stop('This tool has no pinned custodian keys: use the released vault-custodian.mjs, or pass --root-keys <file> for a rehearsal.');
    const feed: ReleaseFeed = arg('--feed-dir') ? new LocalDirectoryFeed(arg('--feed-dir') as string) : new GitHubReleaseFeed({ repo: arg('--feed') });
    return { feed, rootKeys };
}

// ─── Releases ────────────────────────────────────────────────────────────────────────────────

function describeRelease(m: ReleaseManifest, previous: ReleaseManifest | null): string {
    const changed = (a: unknown, b: unknown) => (previous && JSON.stringify(a) !== JSON.stringify(b) ? '   (changed)' : '');
    return [
        `version        ${m.version}`,
        `previous       ${m.previous ?? '(none: the first release)'}${previous ? `  = ${previous.version}` : ''}`,
        `image          ${m.imageHash}${changed(m.imageHash, previous?.imageHash)}`,
        `  UKI          ${m.image.ukiSha256}`,
        `  root hash    ${m.image.roothash}`,
        `API bundle     ${m.apiBundleHash}${changed(m.apiBundleHash, previous?.apiBundleHash)}`,
        `next signers   ${m.custodianKeys.join('\n               ')}${changed(m.custodianKeys, previous?.custodianKeys)}`,
        `host policy    ${JSON.stringify(m.hostPolicy)}${changed(m.hostPolicy, previous?.hostPolicy)}`,
        ...(m.notes ? [`notes          ${m.notes}`] : []),
    ].join('\n');
}

async function release(sub: string, trust: ReleaseTrust): Promise<void> {
    const files = await trust.feed.list();
    const chain = resolveChain(files, trust.rootKeys);
    if (sub === 'status') {
        for (const r of chain.releases) console.log(`${r.manifest.version}  ${r.hash.slice(0, 16)}  image ${r.manifest.imageHash.slice(0, 16)}  api ${r.manifest.apiBundleHash.slice(0, 16)}  ${r.label ?? ''}`);
        console.log(chain.newest ? `newest: ${chain.newest.manifest.version}` : 'no release signed by two custodians');
        if (chain.stopped) console.log(`STOPPED (${chain.stopped.reason}): ${chain.stopped.detail}`);
        for (const p of chain.problems) console.log(`not taken: ${p.label ?? p.hash?.slice(0, 16)}: ${p.reason}`);
        if (chain.stopped) process.exit(1);
        return;
    }
    if (chain.stopped) stop(`The releases stop at ${chain.newest?.manifest.version ?? 'the first'} (${chain.stopped.reason}): ${chain.stopped.detail}`, 1);
    const newest = chain.newest?.manifest ?? null;

    if (sub === 'propose') {
        const out = arg('--out') as string;
        const bundle = readFileSync(arg('--api-bundle') as string);
        let image: ReleaseImage;
        if (flag('--same-image')) {
            if (!newest) stop('--same-image: there is no release yet.');
            image = newest.image;
        } else {
            if (!arg('--image')) stop('missing --image (the image build\'s image.json) or --same-image');
            const built = JSON.parse(readFileSync(arg('--image') as string, 'utf8')) as ReleaseImage & { imageHash?: string; version?: string };
            image = { ukiSha256: built.ukiSha256, roothash: built.roothash };
            if (built.imageHash && built.imageHash !== imageHashOf(image)) stop(`${arg('--image')}: imageHash does not match its UKI and root hash.`);
            // The image's version names its partitions and UKI (beanpool-vault_<version>), which the monthly restart's
            // systemd-sysupdate matches against the release's: they must be the same.
            if (built.version !== arg('--version')) stop(`${arg('--image')} is image version ${String(built.version)}: build it with --version ${arg('--version')}, or propose ${String(built.version)}.`);
        }
        const custodianKeys = flag('--same-custodians') ? [...(newest?.custodianKeys ?? trust.rootKeys)]
            : arg('--custodian-keys') ? keyList(arg('--custodian-keys') as string, '--custodian-keys') : stop('missing --custodian-keys or --same-custodians');
        const hostPolicy = arg('--host-policy') ? parseHostPolicy(JSON.parse(readFileSync(arg('--host-policy') as string, 'utf8'))) : { platform: 'none' as const };
        const m: ReleaseManifest = {
            v: 1, version: arg('--version') as string, previous: chain.newest?.hash ?? null, imageHash: imageHashOf(image), image,
            apiBundleHash: sha256Hex(bundle), custodianKeys, hostPolicy, ...(arg('--notes') ? { notes: arg('--notes') as string } : {}),
        };
        const text = formatManifest(m);
        parseManifest(text);
        mkdirSync(out, { recursive: true });
        writeFileSync(path.join(out, MANIFEST_ASSET), text);
        copyFileSync(arg('--api-bundle') as string, path.join(out, API_BUNDLE_ASSET));
        console.log(describeRelease(m, newest));
        console.log(`\nwritten to ${out}; each signer runs: vault-custodian release sign --dir ${out} --key <their key file>`);
        return;
    }

    const dir = arg('--dir') as string;
    const text = readFileSync(path.join(dir, MANIFEST_ASSET), 'utf8');
    const m = parseManifest(text);
    const sigFile = path.join(dir, SIGNATURES_ASSET);
    const sigs = existsSync(sigFile) ? parseSignatures(readFileSync(sigFile, 'utf8')) : null;
    const previous = m.previous === null ? null : chain.releases.find(r => r.hash === m.previous) ?? null;
    const signers = previous ? previous.manifest.custodianKeys : trust.rootKeys;
    const problems: string[] = [];
    if (m.previous !== (chain.newest?.hash ?? null)) {
        problems.push(previous ? `it follows ${previous.manifest.version}, but the newest release is ${newest?.version}` : 'it follows no release in the feed');
    }
    if (newest && m.previous === chain.newest?.hash && compareVersions(m.version, newest.version) <= 0) problems.push('its version is not after the newest');
    const bundleFile = path.join(dir, API_BUNDLE_ASSET);
    if (existsSync(bundleFile) && sha256Hex(readFileSync(bundleFile)) !== m.apiBundleHash) problems.push(`${API_BUNDLE_ASSET} in ${dir} is not the bundle it names`);

    if (sub === 'verify') {
        console.log(describeRelease(m, previous?.manifest ?? null));
        const valid = sigs ? validSigners(text, sigs, signers) : [];
        console.log(`signed by ${valid.length} of the custodians who must sign it${valid.length ? `: ${valid.map(k => k.slice(0, 8)).join(', ')}` : ''}`);
        const taken = resolveChain([...files, { manifestText: text, signaturesText: sigs ? formatSignatures(sigs) : '{}', label: 'candidate' }], trust.rootKeys).newest?.hash === manifestHash(text);
        for (const p of problems) console.log(`problem: ${p}`);
        console.log(taken && !problems.length ? 'Published as it is, the vault would take it.' : 'Published as it is, the vault would NOT take it.');
        if (!taken || problems.length) process.exit(1);
        return;
    }

    // sign
    const key = await loadKey(arg('--key') as string);
    if (!signers.includes(key.publicKey)) stop(`Your key (${key.publicKey.slice(0, 8)}…) is not one of the custodians who sign the release after ${previous?.manifest.version ?? 'the root'}.`, 1);
    console.log(describeRelease(m, previous?.manifest ?? null));
    for (const p of problems) console.log(`problem: ${p}`);
    if (problems.length) stop('Not signed.', 1);
    if (!flag('--yes') && !(await confirmYes('\nYou are signing exactly this release. Check each line against what the other custodians see.'))) stop('Not signed.', 1);
    const next = addSignature(text, sigs, signRelease(text, key.seed, key.publicKey));
    writeFileSync(sigFile, formatSignatures(next));
    console.log(`signed: ${validSigners(text, next, signers).length} of 2 signatures from the custodians who must sign it (${sigFile})`);
}

// ─── Settings and the watcher ────────────────────────────────────────────────────────────────

/** A settings file, checked here before anything is sent (the vault checks it again). */
function readSettings(file: string): OperatorSettings {
    try {
        return parseSettings(JSON.parse(readFileSync(file, 'utf8')));
    } catch (e) {
        return stop(`${file}: ${(e as Error).message}`);
    }
}

async function watch(): Promise<void> {
    const alertsFile = arg('--alerts');
    let channels: AlertChannels | null = null;
    if (alertsFile) {
        try {
            channels = parseSettings({ v: 1, alerts: JSON.parse(readFileSync(alertsFile, 'utf8')) }).alerts;
        } catch (e) {
            stop(`${alertsFile}: ${(e as Error).message}`);
        }
    }
    const once = flag('--once');
    const watcher = new VaultWatcher({ url: arg('--url') as string, ticketKey: arg('--ticket-key') as string, channels: once ? null : channels });
    if (once) {
        const look = await watcher.check();
        const problems = [
            ...(!look.reachable ? ['unreachable'] : look.state !== 'open' ? ['locked'] : !look.reportOk ? ['report'] : []),
            ...look.problems.map(p => p.key),
        ];
        console.log(`${new Date(look.at).toISOString()} ${look.reachable ? look.state : 'unreachable'}${look.reportOk ? ', report signed' : ''}${problems.length ? `; problems: ${[...new Set(problems)].join(', ')}` : '; fine'}`);
        for (const p of look.problems) console.log(`  ${p.key}: ${p.detail}`);
        process.exit(problems.length ? 1 : 0);
    }
    if (!channels) console.error('warning: no --alerts file: problems are printed here and told to no one.');
    const everyArg = Number(arg('--every') ?? 60);
    if (!Number.isFinite(everyArg) || everyArg < 10) stop('--every is a number of seconds, 10 or more (for example --every 60).');
    const every = everyArg * 1000;
    let said = '';
    for (;;) {
        const look = await watcher.check().catch(e => ({ at: Date.now(), reachable: false, state: null, reportOk: false, problems: [{ key: 'unreachable', detail: (e as Error).message }] }));
        const now = look.problems.map(p => `${p.key}: ${p.detail}`).join('; ');
        if (now !== said) console.log(`${new Date(look.at).toISOString()} ${now || 'fine'}`);
        said = now;
        await new Promise(resolve => setTimeout(resolve, every));
    }
}

// ─── Ceremonies ──────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const command = process.argv[2] === 'release' || process.argv[2] === 'settings' ? `${process.argv[2]} ${process.argv[3] ?? ''}` : process.argv[2];
    const spec = COMMANDS[command];
    if (!spec) stop(`usage: vault-custodian ${Object.keys(COMMANDS).join(' | ')} ...`);
    const missing = spec.required.filter(f => !arg(f));
    if (missing.length) stop(`missing ${missing.join(', ')}`);

    if (command === 'new-key') {
        const out = arg('--out') as string;
        if (existsSync(out)) stop(`${out} exists: not overwritten.`);
        const pass = await passphrase('A passphrase for the new key file: ');
        if (!process.env.VAULT_CUSTODIAN_PASSPHRASE && (await passphrase('The same passphrase again: ')) !== pass) stop('The passphrases differ.');
        const key = newCustodianKey();
        writeFileSync(out, sealKeyFile(key.seed, pass), { mode: 0o600 });
        console.log(key.publicKey);
        return;
    }
    if (command === 'public-key') {
        console.log((JSON.parse(readFileSync(arg('--key') as string, 'utf8')) as { publicKey?: string }).publicKey
            ?? (await loadKey(arg('--key') as string)).publicKey);
        return;
    }
    if (command.startsWith('release ')) return release(command.slice('release '.length), trustFromFlags());
    if (command === 'settings hash') {
        const settings = readSettings(arg('--file') as string);
        console.log(`${settingsHash(settings)}  (the vault reports the first 16: ${settingsHash(settings).slice(0, 16)})`);
        return;
    }
    if (command === 'watch') return watch();

    // Everything read and checked here, before the first request.
    const url = arg('--url') as string;
    const share = spec.required.includes('--share') ? loadShare(arg('--share') as string) : null;
    const newCustodians = spec.required.includes('--new-custodians') ? keyList(arg('--new-custodians') as string, '--new-custodians') : [];
    const trust = spec.optional === CHECK_FLAGS ? trustFromFlags() : undefined;
    const key = await loadKey(arg('--key') as string);
    const out = spec.required.includes('--out') ? arg('--out') as string : null;
    if (out) mkdirSync(out, { recursive: true, mode: 0o700 });
    const opts: CallOptions = {
        trust, acceptRelease: arg('--accept-release'), acceptNoHardwareProof: flag('--no-hardware-proof'),
        confirm: async warning => confirmYes(`\n${warning}`),
    };
    if (trust) {
        // Read the releases once up front, so a broken feed stops us before the vault is contacted at all.
        const { newest } = await loadReleases(trust);
        console.log(`release in force: ${newest.manifest.version} (host policy: ${newest.manifest.hostPolicy.platform})`);
    }

    /** Saves new shares, then confirms this custodian's own, if one is among them. */
    const keep = async (shares: CustodianShare[]): Promise<CustodianCall | null> => {
        writeShares(out as string, shares);
        const own = shares.find(s => s.custodian === key.publicKey);
        return own ? confirmShare(url, key, own) : null;
    };

    let result: CustodianCall;
    let confirmed: CustodianCall | null = null;
    if (command === 'settings send') {
        const file = arg('--file') as string;
        const local = settingsHash(readSettings(file));
        result = await sendSettings(url, key, JSON.parse(readFileSync(file, 'utf8')), opts);
        print(result);
        if (result.status === 200) {
            console.log(result.body.hash === local ? 'The vault took your file as it is (the same hash).' : `The vault's hash is not your file's (${local.slice(0, 16)}): check the file.`);
            if (result.body.state === 'waiting') console.log('Waiting for a second custodian to send the same file (within an hour).');
        }
        if (result.status !== 200 || result.body.hash !== local) process.exit(1);
        return;
    }
    if (command === 'backups') {
        result = await listBackups(url, key);
        if (result.status === 200) {
            const b = result.body as { local: string[]; offsite: string[] | null; offsiteError: string | null };
            console.log(`on the vault (${b.local.length}): ${b.local.slice(-5).join(' ') || 'none'}${b.local.length > 5 ? ' …' : ''}`);
            console.log(b.offsite ? `off the box (${b.offsite.length}): ${b.offsite.slice(-5).join(' ') || 'none'}${b.offsite.length > 5 ? ' …' : ''}`
                : `off the box: ${b.offsiteError ? `can't be listed (${b.offsiteError})` : 'no store set'}`);
            return;
        }
        print(result);
        process.exit(1);
    }
    if (command === 'genesis') {
        result = await genesis(url, key, opts);
        if (result.status === 200) confirmed = await keep(result.body.custodianShares as CustodianShare[]);
    } else if (command === 'unlock') {
        result = await presentShare(url, key, share as CustodianShare, opts);
    } else if (command === 'reshare') {
        result = await presentShare(url, key, share as CustodianShare, { ...opts, purpose: 'reshare', newCustodians });
        if (result.status === 200 && result.body.custodianShares) confirmed = await keep(result.body.custodianShares as CustodianShare[]);
    } else if (command === 'fetch-share') {
        const fetched = await fetchPendingShare(url, key);
        result = fetched.call;
        if (result.status === 200 && !fetched.share) {
            console.error('The vault no longer has the new shares (it restarted). Use the copy you saved, or two current custodians cancel and start again.');
            process.exit(1);
        }
        if (fetched.share) confirmed = await keep([fetched.share]);
    } else if (command === 'confirm') {
        result = await confirmShare(url, key, share as CustodianShare);
    } else if (command === 'cancel') {
        result = await cancelPending(url, key, arg('--pending') as string);
    } else {
        result = await restoreFromBackup(url, key, arg('--backup') as string, opts);
    }
    print(result);
    if (confirmed) {
        process.stdout.write('confirmed: ');
        print(confirmed);
    }
    if (result.status !== 200 || (confirmed && confirmed.status !== 200)) process.exit(1);
}

// Raw mode never outlives the tool, however it ends.
process.on('exit', () => {
    if (rawMode) process.stdin.setRawMode(false);
});
// Every way main() settles calls process.exit, so the event loop can only empty while main() still waits on something that
// will never come. That is never a success: say so and exit non-zero (exit 0 would read as "done" to a custodian or a script).
process.on('beforeExit', () => {
    if (rawMode) setRaw(false);
    console.error('\nvault-custodian stopped before the command finished: it was waiting for something that will not come. The command did not complete; read what it printed above and run it again.');
    process.exit(1);
});

main().then(() => process.exit(0), e => {
    console.error(e instanceof CustodianRefusal ? `refused: ${e.message}` : (e as Error).message);
    process.exit(1);
});
