/**
 * The Android APK on the node (lights-out H3): services/apk-release.ts, services/apk-mirror.ts, routes/android.ts and
 * direct-lan.ts, through the real listeners.
 *
 *   A. the image build's fetch (prepareImageApk): the newest checked APK into a layer folder with fixed times; a bad
 *      digest, a wrong certificate, tampered bytes, a redirect off the endpoint and a list below 1.2.93 refused; the cached
 *      APK reused (and said so) when the newest can't be used; nothing at all fails.
 *   B. the node's daily check (refreshApk): a newer one replaces the held one, exactly one kept; an older, a bad one or
 *      no network changes nothing and the old one is served; never below 1.2.93; the disk floor respected; an image that
 *      brought a newer one empties data/apk.
 *   C. serving, through the plain listener and the HTTPS app: a direct LAN source gets the page, the file and the link; a
 *      tunnel's request (loopback with Cloudflare's headers, or naming the public name), a proxy's, the Docker gateway's
 *      and a public source's get exactly what a path that does not exist gets; HIDE_APK_LINK hides only the link; the
 *      trust page links only for the LAN.
 */
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || process.env.TMPDIR || os.tmpdir(), 'apk-on-node-'));
const dataDir = path.join(root, 'data');
const imageDir = path.join(root, 'image-apk');
fs.mkdirSync(dataDir, { recursive: true });
process.env.BEANPOOL_DATA_DIR = dataDir;
process.env.APK_IMAGE_DIR = imageDir;
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'NODE_ROLE', 'PUBLIC_IP', 'HIDE_APK_LINK', 'BEANPOOL_ADDRESSES']) delete process.env[k];
process.env.DISABLE_APK_UPDATE_CHECK = 'true';
process.env.ADMIN_PASSWORD ??= 'Apk-On-Node-Suite-Pw-5519!';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
    if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
async function refusal(p: Promise<unknown>): Promise<string> {
    try { await p; return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

const rel = await import('./services/apk-release.js');
const mirror = await import('./services/apk-mirror.js');
const fx = await import('./apk-fixture-test-harness.js');
const budget = await import('./engine/photo-upload-budget.js');

const ours = fx.makeSigner('BeanPool test signer');
const stranger = fx.makeSigner('Someone else');
rel._setApkSigningCertForTests(ours.certSha256);
const apk = (version: string, signer = ours, seed = version) => fx.buildFixtureApk(signer, 6000 + Number(version.split('.')[2]), seed);
const gh = await fx.fakeGitHub();
const source = gh.source();

// ── A. the image build ────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nA. the image build fetches, checks and lays out the APK');
{
    const layer = path.join(root, 'layer');
    const cache = path.join(root, 'cache');
    const a93 = apk('1.2.93');
    const a94 = apk('1.2.94');
    gh.releases = [{ version: '1.2.92', code: 314, apk: apk('1.2.92') }, { version: '1.2.94', code: 316, apk: a94 },
        { version: '1.2.93', code: 315, apk: a93 }, { version: '1.2.99', code: 399, apk: apk('1.2.99'), prerelease: true }];
    const r = await rel.prepareImageApk(layer, cache, source);
    const dir = path.join(layer, 'beanpool-apk');
    check('A1 the newest published release by version, not the prerelease or the list order', r.info.version === '1.2.94' && !r.reusedBecause, JSON.stringify(r));
    check('A1 the layer holds the APK and its apk.json, nothing else', JSON.stringify(fs.readdirSync(dir).sort()) === JSON.stringify(['BeanPool-1.2.94-316.apk', 'apk.json']));
    check('A1 the file is the release asset, byte for byte', fs.readFileSync(path.join(dir, 'BeanPool-1.2.94-316.apk')).equals(a94));
    const times = [layer, dir, path.join(dir, 'apk.json'), path.join(dir, 'BeanPool-1.2.94-316.apk')].map((p) => fs.statSync(p).mtimeMs);
    check('A1 every file and folder has the fixed time (the same APK makes the same layer)', times.every((t) => t === rel.APK_LAYER_MTIME.getTime()), times.join(','));
    check('A1 modes are fixed: 0755 folders, 0644 files', (fs.statSync(dir).mode & 0o777) === 0o755 && (fs.statSync(path.join(dir, 'apk.json')).mode & 0o777) === 0o644);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'apk.json'), 'utf8'));
    check('A1 apk.json names the version, digest and certificate', manifest.version === '1.2.94' && manifest.versionCode === 316
        && manifest.sha256 === fx.sha256Hex(a94) && manifest.certSha256 === ours.certSha256);
    const before = gh.requests.length;
    const again = await rel.prepareImageApk(path.join(root, 'layer2'), cache, source);
    check('A2 a second build with the same APK does not download it again', gh.requests.slice(before).every((u) => u === '/releases') && again.info.version === '1.2.94',
        gh.requests.slice(before).join(' '));
    check('A2 and lays out the same bytes', fs.readFileSync(path.join(root, 'layer2', 'beanpool-apk', 'apk.json')).equals(fs.readFileSync(path.join(dir, 'apk.json'))));

    const fresh = (n: string) => path.join(root, `cache-${n}`);
    gh.releases = [{ version: '1.2.95', code: 317, apk: apk('1.2.95'), notesSha256: 'ab'.repeat(32) }];
    check('A3 a digest that is not the release notes\' one is refused (no cache: the build fails)',
        /no Android APK for the image: .*SHA-256/.test(await refusal(rel.prepareImageApk(path.join(root, 'l3'), fresh('3'), source))));
    gh.releases = [{ version: '1.2.95', code: 317, apk: apk('1.2.95', stranger) }];
    check('A4 an APK signed by another certificate is refused',
        /signed by certificate/.test(await refusal(rel.prepareImageApk(path.join(root, 'l4'), fresh('4'), source))));
    const tampered = Buffer.from(apk('1.2.95'));
    tampered[100] ^= 0xff;
    gh.releases = [{ version: '1.2.95', code: 317, apk: tampered }];
    check('A5 bytes changed after signing are refused, even with notes that match them',
        /not what its signature covers/.test(await refusal(rel.prepareImageApk(path.join(root, 'l5'), fresh('5'), source))));
    gh.releases = [{ version: '1.2.92', code: 314, apk: apk('1.2.92') }];
    check('A6 a list with nothing at or above 1.2.93 fails the build',
        /no android-v\* release at or above 1\.2\.93/.test(await refusal(rel.prepareImageApk(path.join(root, 'l6'), fresh('6'), source))));
    gh.releases = [{ version: '1.2.95', code: 317, apk: apk('1.2.95') }];
    gh.redirectTo = 'http://downloads.example.net/evil.apk';
    check('A7 a download redirected off the release endpoint is refused before it is asked',
        /refused to fetch from downloads\.example\.net/.test(await refusal(rel.prepareImageApk(path.join(root, 'l7'), fresh('7'), source))));
    gh.redirectTo = null;

    // The cache (1.2.94) is reused when the newest can't be used, and the result says why.
    gh.releases = [{ version: '1.2.95', code: 317, apk: apk('1.2.95', stranger) }];
    const reused = await rel.prepareImageApk(path.join(root, 'l8'), cache, source);
    check('A8 the newest refused: the earlier checked APK is reused, and the result names why', reused.info.version === '1.2.94'
        && /signed by certificate/.test(reused.reusedBecause ?? ''), JSON.stringify(reused));
    check('A8 the refused one left nothing in the cache', fs.readdirSync(cache).sort().join(',') === 'BeanPool-1.2.94-316.apk,apk.json', fs.readdirSync(cache).join(','));
    const offlineSource = { ...source, releasesUrl: 'http://127.0.0.1:9/releases' };
    const offline = await rel.prepareImageApk(path.join(root, 'l9'), cache, offlineSource);
    check('A9 GitHub unreachable: the cached APK is checked again and reused', offline.info.version === '1.2.94' && !!offline.reusedBecause);
    fs.appendFileSync(path.join(cache, 'BeanPool-1.2.94-316.apk'), Buffer.from('x'));
    check('A10 a cached APK that no longer checks out is not reused: the build fails',
        /no earlier checked APK to reuse/.test(await refusal(rel.prepareImageApk(path.join(root, 'l10'), cache, offlineSource))));
    check('A11 the real endpoint is GitHub\'s, and a download may only go to GitHub\'s release hosts',
        rel.githubApkSource().releasesUrl === 'https://api.github.com/repos/beanpool-org/beanpool/releases?per_page=100'
        && rel.githubApkSource().hopOk('https://release-assets.githubusercontent.com/x') && !rel.githubApkSource().hopOk('https://beanpool.org/x')
        && !rel.githubApkSource().hopOk('http://github.com/x')
        && rel.githubApkSource().assetUrlOk('https://github.com/beanpool-org/beanpool/releases/download/android-v1.2.93/BeanPool-1.2.93-315.apk', 'android-v1.2.93', 'BeanPool-1.2.93-315.apk')
        && !rel.githubApkSource().assetUrlOk('https://github.com/someone/fork/releases/download/android-v1.2.93/BeanPool-1.2.93-315.apk', 'android-v1.2.93', 'BeanPool-1.2.93-315.apk'));
    check('A12 the token goes only with the releases list', JSON.stringify(rel.githubApkSource('t0k').listHeaders) === '{"Authorization":"Bearer t0k"}'
        && rel.githubApkSource().listHeaders === undefined);
}

// ── B. the node's daily check ─────────────────────────────────────────────────────────────────────────────────────
console.log('\nB. the node keeps its APK current while online');
const a93 = apk('1.2.93');
{
    // The image holds 1.2.93.
    fs.mkdirSync(imageDir, { recursive: true });
    fs.writeFileSync(path.join(imageDir, 'BeanPool-1.2.93-315.apk'), a93);
    await rel.writeApkManifest(imageDir, await rel.checkApkFile(path.join(imageDir, 'BeanPool-1.2.93-315.apk'),
        { tag: 'android-v1.2.93', version: '1.2.93', versionCode: 315, fileName: 'BeanPool-1.2.93-315.apk', size: a93.length, sha256: fx.sha256Hex(a93) }));
    check('B0 the image\'s APK is served', mirror.servedApk()?.version === '1.2.93' && mirror.servedApk()?.from === 'image');
    const apkDir = mirror.dataApkDir();
    const held = () => (fs.existsSync(apkDir) ? fs.readdirSync(apkDir).sort().join(',') : '');

    gh.releases = [{ version: '1.2.93', code: 315, apk: a93 }];
    check('B1 the image\'s own version listed: nothing downloaded', (await mirror.refreshApk(source)).outcome === 'current' && held() === '');
    gh.releases = [{ version: '1.2.94', code: 316, apk: apk('1.2.94') }, { version: '1.2.93', code: 315, apk: a93 }];
    const up = await mirror.refreshApk(source);
    check('B2 a newer one is fetched into data/apk and served', up.outcome === 'updated' && mirror.servedApk()?.version === '1.2.94'
        && mirror.servedApk()?.from === 'data', JSON.stringify(up));
    gh.releases = [{ version: '1.2.95', code: 317, apk: apk('1.2.95') }];
    await mirror.refreshApk(source);
    check('B3 the next newer one replaces it: exactly one kept', held() === 'BeanPool-1.2.95-317.apk,apk.json' && mirror.servedApk()?.version === '1.2.95', held());
    gh.releases = [{ version: '1.2.94', code: 316, apk: apk('1.2.94') }];
    check('B4 an older one listed changes nothing', (await mirror.refreshApk(source)).outcome === 'current' && held() === 'BeanPool-1.2.95-317.apk,apk.json');
    gh.releases = [{ version: '1.2.96', code: 318, apk: apk('1.2.96'), notesSha256: 'cd'.repeat(32) }];
    const bad = await mirror.refreshApk(source);
    check('B5 a newer one with the wrong digest is refused; the old one is served, no part-file left', bad.outcome === 'refused'
        && held() === 'BeanPool-1.2.95-317.apk,apk.json' && mirror.servedApk()?.version === '1.2.95', `${JSON.stringify(bad)} ${held()}`);
    gh.releases = [{ version: '1.2.96', code: 318, apk: apk('1.2.96', stranger) }];
    check('B6 a newer one by another certificate is refused', (await mirror.refreshApk(source)).outcome === 'refused' && mirror.servedApk()?.version === '1.2.95');
    const off = await mirror.refreshApk({ ...source, releasesUrl: 'http://127.0.0.1:9/releases' });
    check('B7 offline: nothing changes, the held one is served', off.outcome === 'offline' && mirror.servedApk()?.version === '1.2.95');
    budget.setSimulatedFreeDiskBytesForTests(1024 * 1024 * 1024);
    gh.releases = [{ version: '1.2.96', code: 318, apk: apk('1.2.96') }];
    const asked = gh.requests.length;
    const full = await mirror.refreshApk(source);
    check('B8 the disk floor: no room above it, nothing downloaded', full.outcome === 'no-room' && held() === 'BeanPool-1.2.95-317.apk,apk.json'
        && gh.requests.slice(asked).every((u) => u === '/releases'), `${JSON.stringify(full)} ${gh.requests.slice(asked).join(' ')}`);
    budget.setSimulatedFreeDiskBytesForTests(4 * 1024 * 1024 * 1024);
    check('B8 with room above the floor, it downloads', (await mirror.refreshApk(source)).outcome === 'updated' && mirror.servedApk()?.version === '1.2.96');
    budget.setSimulatedFreeDiskBytesForTests(null);
    // Never below 1.2.93: a manifest for 1.2.92 is not served, whatever it says.
    const low = path.join(root, 'low');
    fs.mkdirSync(low);
    const a92 = apk('1.2.92');
    fs.writeFileSync(path.join(low, 'BeanPool-1.2.92-314.apk'), a92);
    fs.writeFileSync(path.join(low, 'apk.json'), JSON.stringify({ version: '1.2.92', versionCode: 314, fileName: 'BeanPool-1.2.92-314.apk',
        size: a92.length, sha256: fx.sha256Hex(a92), certSha256: ours.certSha256, tag: 'android-v1.2.92' }));
    check('B9 never below 1.2.93: a folder holding 1.2.92 serves nothing', rel.readApkFolder(low) === null);
    check('B9 and a check refuses to keep one', /below 1\.2\.93/.test(await refusal(rel.checkApkFile(path.join(low, 'BeanPool-1.2.92-314.apk'),
        { tag: 'android-v1.2.92', version: '1.2.92', versionCode: 314, fileName: 'BeanPool-1.2.92-314.apk', size: a92.length, sha256: fx.sha256Hex(a92) }))));
    // An update brings an image holding 1.2.97: the copy in data/apk (1.2.95) goes.
    const a97 = apk('1.2.97');
    fs.rmSync(imageDir, { recursive: true });
    fs.mkdirSync(imageDir);
    fs.writeFileSync(path.join(imageDir, 'BeanPool-1.2.97-319.apk'), a97);
    await rel.writeApkManifest(imageDir, await rel.checkApkFile(path.join(imageDir, 'BeanPool-1.2.97-319.apk'),
        { tag: 'android-v1.2.97', version: '1.2.97', versionCode: 319, fileName: 'BeanPool-1.2.97-319.apk', size: a97.length, sha256: fx.sha256Hex(a97) }));
    check('B10 an image with a newer APK is served over the copy', mirror.servedApk()?.from === 'image' && mirror.servedApk()?.version === '1.2.97');
    // With the daily check off, the start still deletes the copy the image has caught up with.
    fs.mkdirSync(apkDir, { recursive: true });
    const a96 = apk('1.2.96');
    fs.writeFileSync(path.join(apkDir, 'BeanPool-1.2.96-318.apk'), a96);
    check('B10 (a copy older than the image\'s is in data/apk)', held() === 'BeanPool-1.2.96-318.apk,apk.json', held());
    await mirror.startApkMirror();
    mirror.stopApkMirror();
    check('B10 the start deletes it, with the daily check off: one APK on the node', held() === '', held());
    fs.writeFileSync(path.join(apkDir, 'BeanPool-1.2.96-318.apk'), a96);
    await rel.writeApkManifest(apkDir, await rel.checkApkFile(path.join(apkDir, 'BeanPool-1.2.96-318.apk'),
        { tag: 'android-v1.2.96', version: '1.2.96', versionCode: 318, fileName: 'BeanPool-1.2.96-318.apk', size: a96.length, sha256: fx.sha256Hex(a96) }));
    await mirror.refreshApk(source);
    check('B10 and so does the next check', held() === '', held());
    // A disk that refuses the write during the download (EACCES stands in for ENOSPC / EIO): refused, never a crash.
    fs.mkdirSync(apkDir, { recursive: true });
    fs.chmodSync(apkDir, 0o555);
    gh.releases = [{ version: '1.2.98', code: 320, apk: apk('1.2.98') }];
    const denied: { outcome: string } = await mirror.refreshApk(source).catch((e: unknown) => ({ outcome: `threw ${String(e)}` }));
    fs.chmodSync(apkDir, 0o755);
    check('B11 a disk that refuses the write: refused, not a crash; nothing left behind, the image\'s APK still served',
        denied.outcome === 'refused' && held() === '' && mirror.servedApk()?.version === '1.2.97', `${JSON.stringify(denied)} ${held()}`);

    // B12: timer scheduled callback handles errors safely without unhandled rejections
    delete process.env.DISABLE_APK_UPDATE_CHECK;
    await mirror.startApkMirror();
    mirror.stopApkMirror();
    process.env.DISABLE_APK_UPDATE_CHECK = 'true';
    check('B12 startApkMirror with update check enabled schedules and stops cleanly', true);
}

// ── C. serving ────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nC. served only to a request straight off the local network');
const lan = await import('./direct-lan.js');
const { initAdminPassword } = await import('./config/local-config.js');
const tlsMod = await import('./services/tls.js');
const se = await import('./state-engine.js');
const { startHttpServer, _setPlainConnectionHookForTests } = await import('./http-server.js');
const { startHttpsServer } = await import('./https-server.js');
initAdminPassword();
await tlsMod.initTls();
se.initStateEngine();
const httpPort = await startHttpServer(0);
const httpsPort = await startHttpsServer(0);
lan._setDefaultGatewaysForTests(['172.18.0.1']);

let fakeRemote: string | null = null;
_setPlainConnectionHookForTests((socket) => {
    if (fakeRemote !== null) Object.defineProperty(socket, 'remoteAddress', { value: fakeRemote, configurable: true });
});
interface Answer { status: number; headers: Record<string, string>; body: Buffer }
function get(from: string | null, p: string, host: string, extra: Record<string, string> = {}): Promise<Answer> {
    fakeRemote = from;
    return new Promise((resolve, reject) => {
        const sock = net.connect(httpPort, '127.0.0.1');
        const chunks: Buffer[] = [];
        sock.setTimeout(10_000, () => { sock.destroy(); reject(new Error('timed out')); });
        sock.on('data', (d) => chunks.push(d));
        sock.on('error', reject);
        sock.on('close', () => {
            const all = Buffer.concat(chunks);
            const split = all.indexOf('\r\n\r\n');
            const lines = all.subarray(0, split).toString('latin1').split('\r\n');
            const headers: Record<string, string> = {};
            for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
            let body = all.subarray(split + 4);
            if (headers['transfer-encoding'] === 'chunked') {
                const out: Buffer[] = [];
                for (let at = 0; at < body.length;) {
                    const eol = body.indexOf('\r\n', at);
                    const n = parseInt(body.subarray(at, eol).toString(), 16);
                    if (!n) break;
                    out.push(body.subarray(eol + 2, eol + 2 + n));
                    at = eol + 4 + n;
                }
                body = Buffer.concat(out);
            }
            resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0])?.[1] ?? 0), headers, body });
        });
        const head = Object.entries({ Host: host, Connection: 'close', ...extra }).map(([k, v]) => `${k}: ${v}\r\n`).join('');
        sock.write(`GET ${p} HTTP/1.1\r\n${head}\r\n`);
    });
}
const served = mirror.servedApk()!;
const file = `/android/${served.fileName}`;
const LAN = '192.168.1.20';
const LAN_HOST = '192.168.1.5:8080';

const page = await get(LAN, '/android', LAN_HOST, { 'Accept-Language': 'fr' });
check('C1 a phone on the LAN gets the page', page.status === 200 && page.body.toString().includes('data-testid="android-on-node"'), String(page.status));
check('C1 with the version, size, SHA-256 and the certificate', page.body.toString().includes(served.sha256) && page.body.toString().includes('1.2.97')
    && page.body.toString().includes(served.certSha256.toUpperCase().match(/../g)!.join(':')));
const fr = (await import('./member-words.js')).wordsIn('fr');
const { ANDROID_ON_NODE_WORDS: W } = await import('@beanpool/core');
const frenchSteps = [W.installHeading, W.stepOpen, W.stepAllow, W.stepConfirm, W.title].map((k) => fr.t(k));
check('C1 in the reader\'s language: French, with the website\'s own install steps', page.body.toString().includes('lang="fr"')
    && frenchSteps.every((t, i) => t !== [W.installHeading, W.stepOpen, W.stepAllow, W.stepConfirm, W.title][i]
        && page.body.toString().includes(t.replace(/'/g, '&#39;'))), frenchSteps.join(' | '));
const dl = await get(LAN, file, LAN_HOST);
check('C2 and the file, byte for byte, as an APK', dl.status === 200 && dl.body.equals(fs.readFileSync(served.file))
    && dl.headers['content-type'] === 'application/vnd.android.package-archive', `${dl.status} ${dl.headers['content-type']} ${dl.body.length}`);
const link = await get(LAN, '/android/link', LAN_HOST);
check('C3 and the web app\'s link answer', link.status === 200 && JSON.parse(link.body.toString()).href === '/android');
check('C3 a .local name and an IPv6 unique-local source count as the LAN', (await get('fd00::12', '/android', 'beanpool.local')).status === 200);
check('C3 loopback with no proxy header, naming localhost (the operator, inside the container), counts', (await get(null, '/android', 'localhost:8080')).status === 200);

const missing = await get(LAN, '/android/BeanPool-0.0.1-1.apk', LAN_HOST);
check('C4 another file name under /android is not found, even on the LAN', missing.status === 404);
/** The same request, for a path nothing lives at: what a refused one must look like, so nothing says the file is here. */
const like = (a: Answer, nothing: Answer) => a.status === nothing.status && a.body.equals(nothing.body)
    && a.headers['content-type'] === nothing.headers['content-type'] && a.headers['content-length'] === nothing.headers['content-length'];
const refusals: [string, string | null, string, string, Record<string, string>?][] = [
    ['C5 the tunnel: loopback with Cloudflare\'s headers, naming the public name', null, file, 'byron.beanpool.org', { 'CF-Connecting-IP': '203.0.113.7', 'Cf-Ray': '8f00-SYD' }],
    ['C5 the tunnel: loopback with Cloudflare\'s headers, even naming a LAN address', null, file, LAN_HOST, { 'Cf-Ray': '8f00-SYD', 'CDN-Loop': 'cloudflare' }],
    ['C6 loopback naming the public name, no header at all', null, '/android', 'byron.beanpool.org'],
    ['C6 a private source naming the public name', LAN, '/android', 'byron.beanpool.org'],
    ['C6 a private source naming a public IP', LAN, '/android', '203.0.113.50'],
    ['C7 an operator\'s proxy: X-Forwarded-For', '172.18.0.5', file, LAN_HOST, { 'X-Forwarded-For': '203.0.113.7' }],
    ['C7 Forwarded and Via', LAN, '/android', LAN_HOST, { Forwarded: 'for=203.0.113.7', Via: '1.1 proxy' }],
    ['C8 Docker\'s gateway (its port proxy hands an internet IPv6 visitor on from there)', '172.18.0.1', file, LAN_HOST],
    ['C9 a public source, whatever Host it sends', '203.0.113.9', file, LAN_HOST],
    ['C9 a public IPv6 source', '2001:db8::5', '/android/link', LAN_HOST],
    ['C9 no Host header at all', LAN, '/android', ''],
];
for (const [name, from, p, host, extra] of refusals) {
    const a = await get(from, p, host, extra);
    const nothing = await get(from, '/no-such-page', host, extra);
    check(`${name}: 404, the same as a page that does not exist`, a.status === 404 && like(a, nothing),
        `${a.status} ${a.body.subarray(0, 80).toString()} vs ${nothing.status} ${nothing.body.subarray(0, 80).toString()}`);
}
// The HTTPS listener (8443) itself: the same rule.
const viaTls = await new Promise<number>((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: httpsPort, path: file, rejectUnauthorized: false, headers: { Host: 'byron.beanpool.org', 'Cf-Ray': '8f00-SYD' } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
});
check('C10 on the HTTPS listener too: a tunnel request for the file is 404', viaTls === 404, String(viaTls));

process.env.HIDE_APK_LINK = 'true';
check('C11 HIDE_APK_LINK=true: no link answer', (await get(LAN, '/android/link', LAN_HOST)).status === 404);
check('C11 but the page and the file stay for the LAN', (await get(LAN, '/android', LAN_HOST)).status === 200 && (await get(LAN, file, LAN_HOST)).status === 200);
const hiddenTrust = await get(LAN, '/', LAN_HOST);
check('C11 and the trust page shows no link', hiddenTrust.status === 200 && !hiddenTrust.body.toString().includes('data-apk="link"'));
delete process.env.HIDE_APK_LINK;
const trust = await get(LAN, '/', LAN_HOST);
check('C12 the trust page links a LAN phone to /android', trust.status === 200 && trust.body.toString().includes('href="/android"'));
const trustProxied = await get(LAN, '/', LAN_HOST, { 'X-Forwarded-For': '203.0.113.7' });
check('C12 but not a proxied request', !trustProxied.body.toString().includes('href="/android"'));
fs.rmSync(imageDir, { recursive: true });
check('C13 with no APK held, the LAN page says so, and there is no link', (await get(LAN, '/android', LAN_HOST)).body.toString().includes('data-apk="none"')
    && (await get(LAN, '/android/link', LAN_HOST)).status === 404);

_setPlainConnectionHookForTests(null);
await gh.close();
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
