#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { confirmShare, custodianKey, genesis, sendSettings, type CallOptions, type CustodianKey } from '../custodian/lib.js';
import { EGRESS_CONF } from '../egress/egress.js';
import type { CustodianShare } from '../shared/ceremony.js';
import { API_BUNDLE_ASSET, LocalDirectoryFeed, MANIFEST_ASSET, ROOT_ASSET, SIGNATURES_ASSET, UKI_ASSET, VERITY_ASSET } from '../shared/release-feed.js';
import {
    addSignature, formatManifest, formatSignatures, imageHashOf, manifestHash, sha256Hex, signRelease, type ReleaseImage, type ReleaseManifest, type ReleaseSignatures,
} from '../shared/release.js';
import { IMAGE_INBOX, IMAGE_TRANSFER, IMAGE_WORK, INSTALL_RESULT_FILE, stagedNames } from '../shared/staged-image.js';
import { unixFetch } from './unix-fetch.js';

/**
 * The boot test's driver, inside a TEST build of the vault's image (image/test-image/make.mjs; never in a release
 * image), booted under QEMU by image/boot-test.sh. It runs as root once the vault is up, with the three throwaway
 * custodian keys the test image was built with (made at run time, their seeds in the test image alone), talks to the
 * API through its Unix socket as Caddy does, and prints each check on the serial port; the last line is
 * `vault-test: ALL PASS` or `vault-test: <n> FAILED`.
 *
 * What the programs' own tests can't see, because it is the image's units and files that decide it:
 *
 *   - a genesis, and the vault then opens: the data partition is mounted where the API sees it (#1314 BLOCKING 1);
 *   - files the API's user stages that no release signs are not installed by the monthly restart's install step, and
 *     that user can't write where root installs from (BLOCKING 2);
 *   - the API knows which image booted (from the file root leaves in /run; the ESP is root's alone): /v1/report's
 *     `update.image` is it (BLOCKING 3);
 *   - UDP to the DHCP ports only from networkd's client: the API's user (and nobody) gets EPERM, and a lease
 *     renewal still passes the firewall, counted by its rule (NON-BLOCKING, nftables.conf);
 *   - (round 2) the state partition has room for the monthly restart: two copies of an image, the journal and the
 *     local backups;
 *   - (round 2, BLOCKING) a new image's release, then an API-only release after it: the API, reading the test image's
 *     directory feed, stages the image from the release that brought it and keeps it staged; root's install step
 *     installs it (systemd-sysupdate into the other slot and the ESP), and /v1/report says so. The new image is small
 *     (a 16 MiB system partition with a real verity tree, and a UKI never booted): every check root makes is real,
 *     but nothing reboots into it.
 *   - (round 3, BLOCKING) the launcher lives through its API's exits: a two-signed API-only release whose API listens
 *     and then keeps exiting is started again by the launcher, which then steps back to the image's own API, with no
 *     restart of the unit (on the image the launcher used to exit with its child, and systemd started it afresh);
 *   - (round 3) the API's user filling the state partition (fallocate, as the review did) denies staging until the
 *     monthly restart's root step, which stops the API and removes what its user left there; then staging works again.
 *     The data partition's mount point underneath is root's, so nothing lands under it before an unlock.
 *
 * Root's install step stops the API (the machine restarts next on the vault); here the driver starts it again after.
 */

const SERIAL = '/dev/ttyS0';
const API_SOCKET = '/run/beanpool-vault/api/api.sock';
const IDENTITY_FILE = '/run/beanpool-vault-image.json';
const SEEDS_FILE = '/etc/beanpool-vault-test/custodians.json';
const API_BUNDLE = '/usr/lib/beanpool-vault/vault-api.mjs';
const DATA_MOUNT = '/var/lib/beanpool-vault/data';
const SETTINGS_FILE = '/var/lib/beanpool-vault/settings/settings.json';
const WORK = '/run/beanpool-vault-test';
/** The API's release feed in the test image (make.mjs writes its api.json): on the state partition, readable by it. */
const FEED = '/var/lib/beanpool-vault-test/feed';
/** Root's scratch space for the next image's files (the API's user reads only the feed). */
const NEXT = '/run/beanpool-vault-test/next';
const BASE = 'http://vault.beanpool.org';
const GIB = 1024 * 1024 * 1024;
/**
 * Appended to a copy of the image's API bundle: it passes its self-test and listens as the real one does, and exits 3 s
 * after it tells the launcher it listens, every time it is started.
 */
const EXIT_AFTER_READY = `
;if (typeof process.send === 'function' && !process.argv.includes('--self-test')) {
    const send = process.send.bind(process);
    process.send = (m, ...rest) => {
        if (m && m.type === 'ready') setTimeout(() => process.exit(3), 3000);
        return send(m, ...rest);
    };
}
`;

let failed = 0;

function say(line: string): void {
    const text = `vault-test: ${line}`;
    console.log(text);
    try {
        appendFileSync(SERIAL, `${text}\n`);
    } catch {
        // No serial port: the journal has it.
    }
}

function check(what: string, ok: boolean, detail = ''): boolean {
    say(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
    return ok;
}

/** A command's status and output (stdout and stderr together). */
function sh(cmd: string, args: string[]): { status: number | null; out: string } {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, seconds: number): Promise<{ value: T | null; after: number }> {
    const start = Date.now();
    for (;;) {
        const value = await fn().catch(() => null);
        if (value) return { value, after: Math.round((Date.now() - start) / 1000) };
        if (Date.now() - start > seconds * 1000) return { value: null, after: seconds };
        await new Promise(r => setTimeout(r, 2000));
    }
}

const fetchApi = unixFetch(API_SOCKET);

async function getJson(p: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetchApi(`${BASE}${p}`);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** The API's unit started again after root's install step stopped it, and answering. */
async function restartApi(): Promise<{ active: string; open: boolean; after: number }> {
    const active = sh('systemctl', ['is-active', 'beanpool-vault-api.service']).out;
    sh('systemctl', ['start', 'beanpool-vault-api.service']);
    const up = await until(async () => (await getJson('/v1/health')).body.state === 'open', 180);
    return { active, open: !!up.value, after: up.after };
}

/** `node -e <script> <args>` as the API's user, as a compromised API would run it. */
function asApi(script: string, ...args: string[]): string {
    return sh('setpriv', ['--reuid=vault-api', '--regid=vault-api-socket', '--init-groups', '/opt/node/bin/node', '-e', script, ...args]).out;
}

/**
 * A release signed by two of the test custodians, into a directory feed (readable by the API's user), with its assets.
 * Returns its manifest's hash (the next one's `previous`).
 */
function publish(feedDir: string, custodians: CustodianKey[], version: string, previous: string | null, image: ReleaseImage, apiBundleHash: string,
    assets: Record<string, Buffer> = {}): string {
    const manifest: ReleaseManifest = {
        v: 1, version, previous, imageHash: imageHashOf(image), image: { ukiSha256: image.ukiSha256, roothash: image.roothash },
        apiBundleHash, custodianKeys: custodians.map(c => c.publicKey), hostPolicy: { platform: 'none' },
    };
    const text = formatManifest(manifest);
    let sigs: ReleaseSignatures | null = null;
    for (const c of custodians.slice(0, 2)) sigs = addSignature(text, sigs, signRelease(text, c.seed, c.publicKey));
    const dir = path.join(feedDir, `vault-v${version}`);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    // The assets first: the feed lists a release once its manifest and signatures are there.
    for (const [name, bytes] of Object.entries(assets)) writeFileSync(path.join(dir, name), bytes, { mode: 0o644 });
    writeFileSync(path.join(dir, SIGNATURES_ASSET), formatSignatures(sigs as ReleaseSignatures), { mode: 0o644 });
    writeFileSync(path.join(dir, MANIFEST_ASSET), text, { mode: 0o644 });
    return manifestHash(text);
}

/** Bytes free on /var for the vault's users (ext4 keeps 5% for root), and its size. */
function varSpace(): { avail: number; size: number } {
    const s = statfsSync('/var');
    return { avail: s.bavail * s.bsize, size: s.blocks * s.bsize };
}

const gib = (bytes: number) => `${(bytes / GIB).toFixed(2)} GiB`;

type Update = {
    error?: string | null;
    newest?: { version: string } | null;
    checkedAt?: number;
    imageWaiting?: { version: string; staged: boolean; error?: string } | null;
    lastInstall?: { installed: boolean; version?: string; reason?: string } | null;
};

async function readUpdate(): Promise<Update> {
    const r = await getJson('/v1/report');
    return (JSON.parse((r.body.report as { text?: string } | undefined)?.text ?? '{}') as { update?: Update }).update ?? {};
}

async function main(): Promise<void> {
    const seeds = (JSON.parse(readFileSync(SEEDS_FILE, 'utf8')) as { seeds: string[] }).seeds;
    const custodians = seeds.map(s => custodianKey(Buffer.from(s, 'hex')));
    const up = await until(async () => (await getJson('/v1/health')).body, 180);
    if (!check('the API answers /v1/health', !!up.value, `after ${up.after} s`)) return;
    const identity = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8')) as { ok: boolean; image?: { ukiSha256: string; roothash: string; imageHash: string } };
    if (!check('root identified the booted image', identity.ok && !!identity.image, identity.image?.imageHash ?? JSON.stringify(identity))) return;
    const image = identity.image as { ukiSha256: string; roothash: string; imageHash: string };

    const feedDir = path.join(WORK, 'feed');
    const ownBundle = sha256Hex(readFileSync(API_BUNDLE));
    publish(feedDir, custodians, '0.0.1', null, image, ownBundle);
    const opts: CallOptions = { fetch: fetchApi, acceptNoHardwareProof: true, trust: { feed: new LocalDirectoryFeed(feedDir), rootKeys: custodians.map(c => c.publicKey) } };

    // A genesis, and two custodians confirm their shares: the keyholder is open.
    const g = await genesis(BASE, custodians[0], opts);
    if (!check('genesis', g.status === 200, `${g.status}${g.status === 200 ? '' : ` ${JSON.stringify(g.body).slice(0, 200)}`}`)) return;
    const shares = g.body.custodianShares as CustodianShare[];
    const share = (c: CustodianKey) => shares.find(s => s.custodian === c.publicKey) as CustodianShare;
    await confirmShare(BASE, custodians[0], share(custodians[0]), opts);
    const confirmed = await confirmShare(BASE, custodians[1], share(custodians[1]), opts);
    if (!check('two custodians confirm: the keyholder is open', confirmed.body.state === 'open', JSON.stringify(confirmed.body).slice(0, 200))) return;

    // BLOCKING 1: the data partition is mounted where the API sees it, and the vault opens.
    const open = await until(async () => (await getJson('/v1/health')).body.state === 'open', 300);
    check('the vault opens: /v1/health says open', !!open.value, `after ${open.after} s`);
    const source = sh('findmnt', ['-n', '-o', 'SOURCE', DATA_MOUNT]).out;
    check('the data partition is mounted in the machine\'s namespace', source === '/dev/mapper/vault-data', source || 'not mounted');
    const report = await getJson('/v1/report');
    check('the database opens on it: /v1/report answers', report.status === 200, `${report.status}`);

    // BLOCKING 3: the API, not root, knows the image it runs on (its release check needs it to hand over or stage).
    const text = (report.body.report as { text?: string } | undefined)?.text ?? '{}';
    const update = (JSON.parse(text) as { update?: { image?: string | null; error?: string | null } }).update;
    check('/v1/report names the booted image: the API knows it', update?.image === image.imageHash, `update.image ${update?.image ?? 'missing'}; ${update?.error ?? ''}`);

    // The custodians' settings (an off-box store, a webhook, a mail server: none reachable from here) reach root's
    // egress step: the path unit fires on the API's write, root writes their names (and no secret) for the resolver,
    // which restarts and runs, and the firewall has the mail sets the names go into.
    const dnsStarted = () => sh('systemctl', ['show', '-p', 'ActiveEnterTimestampMonotonic', '--value', 'beanpool-vault-dns.service']).out;
    const dnsBefore = dnsStarted();
    const settings = {
        v: 1,
        offsite: { kind: 's3', endpoint: 'https://store.example.org', bucket: 'vault-test', accessKeyId: 'AK-TEST', secretAccessKey: 'SK-TEST-SECRET' },
        alerts: {
            webhook: { url: 'https://hooks.example.org/topic-secret' },
            email: { host: 'smtp.example.org', port: 465, username: 'u', password: 'PW-TEST-SECRET', from: 'vault@example.org', to: ['c@example.org'] },
        },
    };
    const sent = [await sendSettings(BASE, custodians[0], settings, opts), await sendSettings(BASE, custodians[1], settings, opts)];
    check('two custodians set the settings', sent[1].body.state === 'in_force', JSON.stringify(sent.map(s => s.body)).slice(0, 300));
    const settingsStat = sh('stat', ['-c', '%U %a', SETTINGS_FILE]).out;
    check('the settings file is the API\'s alone', settingsStat === 'vault-api 600', settingsStat);
    const egress = await until(async () => {
        const t = readFileSync(EGRESS_CONF, 'utf8');
        return t.includes('nftset=/hooks.example.org/store.example.org/4#inet#vault#egress4,6#inet#vault#egress6') && t.includes('nftset=/smtp.example.org/4#inet#vault#smtp4,6#inet#vault#smtp6') && t;
    }, 60);
    check('root\'s egress step writes their names for the resolver (the path unit fired)', !!egress.value,
        `after ${egress.after} s: ${readFileSync(EGRESS_CONF, 'utf8').replace(/\s+/g, ' ').slice(0, 300)}`);
    check('and no secret, path or address goes there', !/SECRET|topic-secret|c@example\.org|vault-test\//.test(readFileSync(EGRESS_CONF, 'utf8')));
    const dnsAgain = await until(async () => dnsStarted() !== dnsBefore && sh('systemctl', ['is-active', 'beanpool-vault-dns.service']).out === 'active', 60);
    check('the resolver restarted to read them, and runs', !!dnsAgain.value, `${dnsBefore} -> ${dnsStarted()}; ${sh('systemctl', ['is-active', 'beanpool-vault-dns.service']).out}`);
    check('the firewall has the mail sets', sh('nft', ['list', 'set', 'inet', 'vault', 'smtp4']).status === 0 && sh('nft', ['list', 'set', 'inet', 'vault', 'smtp6']).status === 0);

    // BLOCKING 2: as the API's user, stage a boot file and partitions no release signs (as the review did), then run
    // the monthly restart's install step (without its reboot). Nothing may be installed.
    const fake = stagedNames('9.9.9', sha256Hex('not a root hash') + sha256Hex('nor this'));
    const staged = asApi(`const fs = require('fs'), [d, u, r, v] = process.argv.slice(1);
        fs.writeFileSync(d + '/' + u, Buffer.concat([Buffer.from('NOT-A-SIGNED-RELEASE'), Buffer.alloc(1 << 20)]));
        fs.writeFileSync(d + '/' + r, Buffer.alloc(1 << 20));
        fs.writeFileSync(d + '/' + v, Buffer.alloc(4096));
        console.log('staged');`, IMAGE_INBOX, fake.uki, fake.root, fake.verity);
    check('the API\'s user can stage files in its inbox', staged === 'staged' && readdirSync(IMAGE_INBOX).length === 3, staged);
    for (const target of [IMAGE_TRANSFER, IMAGE_WORK, '/usr/lib/beanpool-vault']) {
        const wrote = asApi('try { require("fs").writeFileSync(process.argv[1], "x"); console.log("written"); } catch (e) { console.log(e.code); }', `${target}/planted`);
        check(`the API's user can't write ${target}`, wrote !== 'written', wrote);
    }
    const install = sh('/opt/node/bin/node', ['/usr/lib/beanpool-vault/vault-install.mjs']);
    check('the install step refuses them', install.status === 1 && /nothing installed/.test(install.out), install.out.split('\n').pop());
    const back = await restartApi();
    check('the install step stopped the API first; started again, it opens', back.active === 'inactive' && back.open, `${back.active}; after ${back.after} s`);
    check('and empties the inbox; nothing reaches the transfer source', readdirSync(IMAGE_INBOX).length === 0 && readdirSync(IMAGE_TRANSFER).length === 0,
        `inbox ${readdirSync(IMAGE_INBOX).join(' ')}; install ${readdirSync(IMAGE_TRANSFER).join(' ')}`);
    const list = sh('/usr/lib/systemd/systemd-sysupdate', ['--definitions=/usr/lib/sysupdate.d', 'list']).out;
    check('systemd-sysupdate lists the running release as current, and no 9.9.9',
        list.split('\n').some(l => l.includes('0.0.1') && l.includes('current')) && !list.includes('9.9.9'), list.replace(/\s+/g, ' '));
    const ukis = readdirSync('/boot/EFI/Linux');
    check('the ESP holds the running boot file alone', ukis.length === 1 && ukis[0].startsWith('beanpool-vault_0.0.1'), ukis.join(' '));
    const labels = sh('lsblk', ['-rno', 'PARTLABEL']).out;
    check('no partition is labelled 9.9.9', !labels.includes('9.9.9'), labels.replace(/\s+/g, ' '));

    // NON-BLOCKING: the DHCP ports, only for networkd's DHCP client. Any other user's UDP to them is refused (EPERM:
    // dropped on the way out). QEMU's restricted network gives no default route, so a route to a documentation range
    // (203.0.113.0/24) is added for the test, as the review did: each packet then reaches the output chain.
    const lease = () => sh('ip', ['-o', '-4', 'addr', 'show', 'scope', 'global']).out.split('\n').find(l => / dynamic /.test(l)) ?? '';
    const link = lease().split(/\s+/)[1] ?? '';
    check('a DHCP lease was obtained', !!link, lease() || sh('ip', ['-o', 'addr']).out.replace(/\s+/g, ' '));
    const route = sh('ip', ['route', 'add', '203.0.113.0/24', 'dev', link]);
    const udp = 'const s = require("dgram").createSocket("udp4"); s.send(Buffer.from("x"), Number(process.argv[1]), "203.0.113.5", e => { console.log(e ? e.code : "sent"); s.close(); });';
    for (const [user, group] of [['vault-api', 'vault-api-socket'], ['nobody', 'nogroup']]) {
        for (const port of ['67', '547']) {
            const sent = sh('setpriv', [`--reuid=${user}`, `--regid=${group}`, '--init-groups', '/opt/node/bin/node', '-e', udp, port]).out;
            check(`UDP to :${port} as ${user} is refused`, sent === 'EPERM', `${sent}${route.status === 0 ? '' : `; no test route: ${route.out}`}`);
        }
    }
    sh('ip', ['route', 'del', '203.0.113.0/24', 'dev', link]);
    const counted = () => Number(/packets (\d+)/.exec(sh('nft', ['list', 'counter', 'inet', 'vault', 'dhcp4']).out)?.[1] ?? NaN);
    const before = counted();
    const renew = sh('networkctl', ['renew', link]);
    const passed = await until(async () => counted() > before, 60);
    check('a DHCP renewal from networkd\'s client passes the firewall', !!passed.value && renew.status === 0, `${before} -> ${counted()} packets; ${renew.out}`);
    check('and the lease stands', !!lease(), lease());

    // Round 2: room on the state partition for the monthly restart's worst moment: a new image (1.11 GiB on a build)
    // twice (the API's inbox and root's copies), the journal (200 MiB) and the local backups (1 GiB).
    const space = varSpace();
    check('the state partition has room for two images, the journal and the local backups', space.avail >= 2 * 1.11 * GIB + 0.2 * GIB + 1 * GIB,
        `${gib(space.size)}, ${gib(space.avail)} free for the vault's users`);

    // Round 3, BLOCKING: 0.0.2, two-signed for the booted image, has an API that passes its self-test, listens, and exits
    // 3 s later, each time. The launcher starts it again, and after three exits steps back to the image's own API: all in
    // one launcher process, which systemd never sees exit.
    const unit = () => {
        const o = sh('systemctl', ['show', '-p', 'MainPID', '-p', 'NRestarts', 'beanpool-vault-api.service']).out;
        return `MainPID ${/MainPID=(\d+)/.exec(o)?.[1] ?? '?'}, NRestarts ${/NRestarts=(\d+)/.exec(o)?.[1] ?? '?'}`;
    };
    const unitBefore = unit();
    const journal = () => sh('journalctl', ['-u', 'beanpool-vault-api.service', '-o', 'cat', '--no-pager']).out;
    const exiting = Buffer.concat([readFileSync(API_BUNDLE), Buffer.from(EXIT_AFTER_READY)]);
    mkdirSync(FEED, { recursive: true, mode: 0o755 });
    const r1 = publish(FEED, custodians, '0.0.1', null, image, ownBundle);
    const r2 = publish(FEED, custodians, '0.0.2', r1, image, sha256Hex(exiting), { [API_BUNDLE_ASSET]: exiting });
    const stepped = await until(async () => journal().includes('release 0.0.2 keeps failing: back to the image\'s own API'), 300);
    const lines = journal().split('\n');
    check('the launcher switches to 0.0.2, whose API then keeps exiting', lines.some(l => /switching: started \/var\/lib\/beanpool-vault\/releases\/.* as pid/.test(l)),
        lines.filter(l => /switching|serving/.test(l)).join(' | ').slice(0, 300));
    check('the launcher, still running, starts it again and then steps back to the image\'s own API', !!stepped.value,
        `after ${stepped.after} s: ${lines.filter(l => /exited|keeps failing/.test(l)).join(' | ').slice(0, 500)}`);
    check('systemd never restarted the unit: the same launcher throughout', unit() === unitBefore, `${unitBefore} -> ${unit()}`);
    const served = await until(async () => {
        const r = await getJson('/v1/report');
        return r.status === 200 && (JSON.parse((r.body.report as { text: string }).text) as { api?: string }).api === ownBundle;
    }, 60);
    check('the image\'s own API serves', !!served.value, `after ${served.after} s`);
    // Withdrawn (its bundle), so a launcher started afresh below doesn't switch to it again.
    rmSync(path.join(FEED, 'vault-v0.0.2', API_BUNDLE_ASSET));

    // Round 3: the data partition's mount point, under the mount, is root's (0700): the API's user can't write there
    // before an unlock. A plain bind mount of its parent shows what the mount hides.
    const under = '/run/beanpool-vault-test/under';
    mkdirSync(under, { recursive: true });
    const bound = sh('mount', ['--bind', '/var/lib/beanpool-vault', under]);
    const st = sh('stat', ['-c', '%U %a', path.join(under, 'data')]).out;
    const wroteUnder = asApi('try { require("fs").writeFileSync(process.argv[1], "x"); console.log("written"); } catch (e) { console.log(e.code); }', path.join(under, 'data', 'planted'));
    sh('umount', [under]);
    check('the data mount point under the mount is root\'s, and the API\'s user can\'t write there', bound.status === 0 && st === 'root 700' && wroteUnder === 'EACCES',
        `${bound.out} ${st}; ${wroteUnder}`);

    // Round 2, BLOCKING: 0.0.3 brings a new image; 0.0.4, an API-only release after it, names the same image and carries
    // none of its files. The API stages 0.0.3's files and keeps them staged; root's step installs 0.0.3.
    mkdirSync(NEXT, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(NEXT, 'root.raw'), crypto.randomBytes(16 << 20));
    writeFileSync(path.join(NEXT, 'verity.raw'), '');
    const format = sh('veritysetup', ['format', path.join(NEXT, 'root.raw'), path.join(NEXT, 'verity.raw')]);
    const roothash = /Root hash:\s+([0-9a-f]{64})/.exec(format.out)?.[1];
    if (!check('a next image\'s system partition, with its verity tree', !!roothash, roothash ?? format.out.slice(-200))) return;
    const uki = Buffer.concat([Buffer.from('beanpool-vault boot test: a UKI that is never booted\n'), crypto.randomBytes(4096)]);
    const nextImage: ReleaseImage = { ukiSha256: sha256Hex(uki), roothash: roothash as string };
    const names = stagedNames('0.0.3', nextImage.roothash);
    const stagedNow = () => readdirSync(IMAGE_INBOX).sort().join(' ');

    // Round 3: before 0.0.3 is published, the API's user fills the state partition (fallocate in its releases
    // directory, as the review did) and leaves junk in its backups and its inbox. Staging 0.0.3 is refused for room.
    // (0.0.3's files are written first, beside the feed on the same file system, and moved into it after: the state
    // partition keeps no blocks back for root either.)
    const pending = '/var/lib/beanpool-vault-test/pending';
    const r3 = publish(pending, custodians, '0.0.3', r2, nextImage, ownBundle, {
        [UKI_ASSET]: uki, [ROOT_ASSET]: readFileSync(path.join(NEXT, 'root.raw')), [VERITY_ASSET]: readFileSync(path.join(NEXT, 'verity.raw')),
    });
    const RELEASES = '/var/lib/beanpool-vault/releases';
    const BACKUPS = '/var/lib/beanpool-vault/backups';
    const RESTORE = '/var/lib/beanpool-vault/restore';
    // The keyholder's marker of a pending restore from backup (keyholder.json's stateDir): root plants it here, as a
    // custodians' restore would, to see root's step keep the restore's files while it is there (verify 4, NB-1).
    const MARKER = '/var/lib/beanpool-vault/keyholder/restore-pending.json';
    // Confirm 5, NB-1: a one-byte "backup" holding 1.1 GiB of blocks preallocated past its end (fallocate --keep-size;
    // it stays through a remount), which the budget must count by its blocks.
    const keepSizeFile = path.join(BACKUPS, 'bv-20260101T000000Z.bin');
    asApi(`require('fs').writeFileSync(process.argv[1], 'x')`, keepSizeFile);
    const keptSize = sh('setpriv', ['--reuid=vault-api', '--regid=vault-api-socket', '--init-groups', 'fallocate', '--keep-size', '-o', '0', '-l', String(1100 << 20), keepSizeFile]);
    const fill = varSpace().avail - (12 << 20);
    const filled = sh('setpriv', ['--reuid=vault-api', '--regid=vault-api-socket', '--init-groups', 'fallocate', '-l', String(fill), path.join(RELEASES, 'junk')]);
    asApi(`const fs = require('fs'), [b, s, r, t] = process.argv.slice(1);
        fs.writeFileSync(b + '/junk', 'x');
        fs.writeFileSync(b + '/bv-20260102T000000Z.bin', '');
        fs.truncateSync(b + '/bv-20260102T000000Z.bin', 1073741825);
        for (let i = 1; i <= 1002; i++) fs.writeFileSync(b + '/bv-20260103T000000Z-' + i + '.bin', '');
        fs.mkdirSync(s + '/beanpool-vault_9.9.9.efi');
        fs.writeFileSync(s + '/beanpool-vault_9.9.9.efi/x', 'x');
        fs.mkdirSync(r, { recursive: true });
        for (const f of ['restore-pending.bin', 'restore-pending.bin.part', 'junk']) fs.writeFileSync(r + '/' + f, 'x');
        fs.writeFileSync(t + '/settings.json.4242.part', 'x');
        fs.mkdirSync(t + '/junk');`, BACKUPS, IMAGE_INBOX, RESTORE, path.dirname(SETTINGS_FILE));
    writeFileSync(MARKER, '{}', { mode: 0o600 });
    check('the API\'s user fills the state partition', filled.status === 0 && varSpace().avail < (16 << 20), `${filled.out}; ${(varSpace().avail / (1 << 20)).toFixed(1)} MiB free for the vault's users`);
    renameSync(path.join(pending, 'vault-v0.0.3'), path.join(FEED, 'vault-v0.0.3'));
    const noRoom = await until(async () => {
        const u = await readUpdate();
        return u.newest?.version === '0.0.3' && /no room for the image/.test(u.imageWaiting?.error ?? '') && u;
    }, 180);
    check('staging 0.0.3 is refused for room, and /v1/report says so', !!noRoom.value, JSON.stringify((await readUpdate()).imageWaiting ?? null));
    const tidy = sh('/opt/node/bin/node', ['/usr/lib/beanpool-vault/vault-install.mjs']);
    const cleanup = (JSON.parse(readFileSync(INSTALL_RESULT_FILE, 'utf8')) as { cleanup?: string }).cleanup ?? '';
    check('the monthly restart\'s root step removes what the API\'s user left: its releases, the junk in its backups and inbox',
        readdirSync(RELEASES).length === 0 && !readdirSync(BACKUPS).includes('junk') && readdirSync(IMAGE_INBOX).length === 0 && /in releases/.test(cleanup),
        `${tidy.out.split('\n').filter(l => /removed|nothing/.test(l)).join(' | ')}; releases ${readdirSync(RELEASES).join(' ')}; inbox ${stagedNow()}`);
    // A newest "backup" past api.json's backupMaxBytes (1 GiB; sparse here, its size is what counts): the API never
    // writes one, and root removes it (verify 4, the director's hard cap).
    const backupsLeft = readdirSync(BACKUPS);
    check('root removes a backup longer than the budget, one holding more blocks than the budget (fallocate --keep-size), and empty ones past 1,000 files',
        keptSize.status === 0 && !backupsLeft.includes('bv-20260102T000000Z.bin') && !backupsLeft.includes('bv-20260101T000000Z.bin')
            && backupsLeft.length <= 1000 && !backupsLeft.includes('bv-20260103T000000Z-1.bin') && /backups past the budget/.test(cleanup),
        `fallocate --keep-size: ${keptSize.status} ${keptSize.out}; ${backupsLeft.length} left in backups; ${cleanup}`);
    const restoreKept = readdirSync(RESTORE).sort().join(' ');
    check('while the keyholder marks a restore from backup pending, root keeps its file and partial file, and nothing else in restore/',
        restoreKept === 'restore-pending.bin restore-pending.bin.part', restoreKept);
    const settingsKept = readdirSync(path.dirname(SETTINGS_FILE)).sort().join(' ');
    check('root keeps the custodians\' settings file, and nothing else in settings/', settingsKept === 'settings.json' && /in settings that/.test(cleanup), `${settingsKept}; ${cleanup}`);
    rmSync(MARKER);
    const tidied = sh('/opt/node/bin/node', ['/usr/lib/beanpool-vault/vault-install.mjs']);
    check('with no marker, root empties restore/', readdirSync(RESTORE).length === 0,
        `${tidied.out.split('\n').filter(l => /removed/.test(l)).join(' | ')}; restore ${readdirSync(RESTORE).join(' ')}`);
    check('and the room is back', varSpace().avail > GIB, `${gib(varSpace().avail)} free for the vault's users`);
    const again = await restartApi();
    check('the API, started again, opens', again.open, `after ${again.after} s`);

    // Staging works again: 0.0.3's files, checked, in the inbox.
    const nextStaged = await until(async () => {
        const u = await readUpdate();
        return u.newest?.version === '0.0.3' && u.imageWaiting?.staged && u;
    }, 180);
    check('the API stages 0.0.3 again, a new image', !!nextStaged.value && stagedNow() === Object.values(names).sort().join(' '),
        `after ${nextStaged.after} s: ${JSON.stringify(await readUpdate()).slice(0, 600)}; inbox ${stagedNow()}`);
    const whileStaged = varSpace();
    publish(FEED, custodians, '0.0.4', r3, nextImage, sha256Hex('an API-only release: 0.0.3\'s image, no image files'));
    const since = Date.now();
    const kept = await until(async () => {
        const u = await readUpdate();
        return u.newest?.version === '0.0.4' && (u.checkedAt ?? 0) > since && u;
    }, 120);
    check('then 0.0.4, API-only for that image: 0.0.3 stays staged, from the release that brought it',
        kept.value?.imageWaiting?.version === '0.0.3' && kept.value.imageWaiting.staged && stagedNow() === Object.values(names).sort().join(' '),
        `${JSON.stringify(kept.value?.imageWaiting ?? null)}; inbox ${stagedNow()}`);
    const installed = sh('/opt/node/bin/node', ['/usr/lib/beanpool-vault/vault-install.mjs']);
    check('root\'s install step installs 0.0.3', installed.status === 0 && installed.out.includes('release 0.0.3 is installed'), installed.out.split('\n').slice(-3).join(' | '));
    const third = await restartApi();
    check('the API, started again, opens', third.open, `after ${third.after} s`);
    const listed = sh('/usr/lib/systemd/systemd-sysupdate', ['--definitions=/usr/lib/sysupdate.d', 'list']).out;
    // It calls the newest installed version current, and keeps the running one (ProtectVersion=%A) to fall back to.
    const line = (v: string) => listed.split('\n').find(l => l.includes(` ${v} `)) ?? '';
    check('systemd-sysupdate lists 0.0.3 installed, and the running 0.0.1 kept', /✓\s+current/.test(line('0.0.3')) && /✓\s+protected/.test(line('0.0.1')),
        listed.replace(/\s+/g, ' '));
    const partitions = sh('lsblk', ['-rno', 'PARTLABEL']).out;
    check('its system partition and verity tree are in the other slot', partitions.includes('beanpool-vault_0.0.3') && partitions.includes('beanpool-vault_0.0.3_verity'),
        partitions.replace(/\s+/g, ' '));
    const esp = readdirSync('/boot/EFI/Linux');
    check('its boot file is on the ESP beside the running one', esp.some(f => f.startsWith('beanpool-vault_0.0.3')) && esp.some(f => f.startsWith('beanpool-vault_0.0.1')), esp.join(' '));
    const record = JSON.parse(readFileSync(INSTALL_RESULT_FILE, 'utf8')) as { installed?: boolean; version?: string };
    const reported = await until(async () => {
        const u = await readUpdate();
        return u.lastInstall?.installed && u.lastInstall.version === '0.0.3' && u;
    }, 60);
    check('what root did is left for the report, and /v1/report says it', record.installed === true && record.version === '0.0.3' && !!reported.value,
        JSON.stringify((await readUpdate()).lastInstall ?? null));
    check('free on the state partition, before, with an image staged, and after (this image is small)', true,
        `${gib(space.avail)}, ${gib(whileStaged.avail)}, ${gib(varSpace().avail)}`);
}

main().catch(e => {
    check('the driver ran to the end', false, (e as Error).message);
}).finally(() => {
    say(failed ? `${failed} FAILED` : 'ALL PASS');
    process.exit(failed ? 1 : 0);
});
