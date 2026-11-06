/**
 * Three small caches on the request path answer what they answered, and are never behind a write.
 *
 * From the global node's load rehearsal of 7 Nov 2026 (scratch/global-node/REPORT-global-load-rehearsal-2026-11-07.md §7-8,
 * fixes 4, 5 and 7). Each was a few percent of the launch mix's busy time on the one core:
 *   1. local-config.json read, opened and parsed on every request (the gateway asks twice): its text is kept while the file
 *      is the same file (config/local-config.ts);
 *   2. the profile's switch overrides read from node_config for every listing of a page (the known floor's "are Beans on"):
 *      kept while the database is unwritten (engine statements.ts readWhileUnchanged; config/node-profile.ts); and the
 *      known floor's dial, which on a node without Beans is no longer read from its row at all;
 *   3. a signer's public key built into a KeyObject for every signed request: the last 1,024 are kept
 *      (engine/member-signature.ts).
 *
 * What these pin, for each: the answer after a write by ANY path (the owner console's setters, a standby's copy, raw SQL, a
 * second connection standing for the command line, a transaction that commits or rolls back, a file edited in place or
 * replaced), that no caller can change what the next one gets, that what is kept is bounded, and that a warm read does the
 * work it was kept to save no more than once. Sections 1-3 count a warm read's work, so they fail on origin/main; every
 * answer they check is the one origin/main gives.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-capacity-caches.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.PRIVATE_PREVIEW;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs fn with console.error silenced (the restore from the last good copy shouts, on purpose), and returns what it wrote. */
function quiet<T>(fn: () => T): { result: T; errors: string[] } {
    const errors: string[] = [];
    const err = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    try { return { result: fn(), errors }; } finally { console.error = err; }
}

async function main() {
    console.log('Three caches on the request path answer what they answered...\n');
    const DATA_DIR = process.env.BEANPOOL_DATA_DIR!;
    const CONFIG = path.join(DATA_DIR, 'local-config.json');

    const lc = await import('./config/local-config.js');
    const np = await import('./config/node-profile.js');
    const kf = await import('./config/known-floor.js');
    const se: any = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const engine: any = await import('@beanpool/engine');
    const ms: any = await import('./engine/member-signature.js');
    se.initStateEngine();

    // ── 1. local-config.json ────────────────────────────────────────────────────────────────────────────────────────
    console.log('— 1. local-config.json: read when the file changes —');
    const realRead = fs.readFileSync;
    let configReads = 0;
    (fs as any).readFileSync = function (this: unknown, p: unknown, ...rest: unknown[]) {
        if (String(p) === CONFIG) configReads++;
        return (realRead as any).call(this, p, ...rest);
    };
    const reads = <T>(fn: () => T): { result: T; n: number } => { const before = configReads; const result = fn(); return { result, n: configReads - before }; };
    const age = () => { const past = new Date(Date.now() - 60_000); fs.utimesSync(CONFIG, past, past); };

    lc.saveLocalConfig({ ...lc.getLocalConfig(), communityName: 'Alpha' });
    age();
    {
        const { result, n } = reads(() => { let last = ''; for (let i = 0; i < 50; i++) last = String(lc.getLocalConfig().communityName); return last; });
        assert(result === 'Alpha', '50 reads of a settled file all say what it says');
        assert(n <= 1, `…and the file is read at most once for the 50 (read ${n} times)`);
    }
    {
        const { n } = reads(() => { for (let i = 0; i < 50; i++) lc.getGatewayConfig(); });
        assert(n === 0, `the gateway's per-request read of a settled file reads no file (${n})`);
    }
    // The same size, edited in place: the next read says the edit.
    await sleep(30);
    const inPlace = fs.readFileSync(CONFIG, 'utf8').replace('Alpha', 'Omega');
    fs.writeFileSync(CONFIG, inPlace);
    assert(lc.getLocalConfig().communityName === 'Omega', 'a file edited in place, to text of the same size, is read at once');
    // A file changed a moment ago is read every time, so an edit in the same instant can never be missed.
    {
        let seen = true;
        const a = fs.readFileSync(CONFIG, 'utf8');
        for (let i = 0; i < 60 && seen; i++) {
            const word = i % 2 ? 'Omega' : 'Delta';
            fs.writeFileSync(CONFIG, a.replace('Omega', word));
            seen = lc.getLocalConfig().communityName === word;
        }
        assert(seen, '60 edits in a row with no pause between (the same size, inside one clock tick) are each read');
    }
    // A save is read at once.
    age();
    lc.getLocalConfig();
    lc.saveLocalConfig({ ...lc.getLocalConfig(), communityName: 'Sigma' });
    assert(lc.getLocalConfig().communityName === 'Sigma', 'a save through saveLocalConfig is the next read');
    lc.updateLocalConfig({ communityName: 'Tau' });
    assert(lc.getLocalConfig().communityName === 'Tau', '…and one through updateLocalConfig');
    // A file replaced by another (a restore, another process's save), of the same size and stamped with the old mtime.
    age();
    lc.getLocalConfig();
    {
        const st = fs.statSync(CONFIG);
        const other = fs.readFileSync(CONFIG, 'utf8').replace('Tau', 'Rho');
        const tmp = `${CONFIG}.replacing`;
        fs.writeFileSync(tmp, other);
        fs.utimesSync(tmp, st.atime, st.mtime);
        fs.renameSync(tmp, CONFIG);
        assert(lc.getLocalConfig().communityName === 'Rho', 'a file replaced by one of the same size and mtime is read (its inode and change time differ)');
    }
    // Gone, and back.
    fs.rmSync(CONFIG);
    assert(lc.getLocalConfig().communityName === null && lc.getLocalConfig().adminHash === null, 'a missing file reads as a new install, as before');
    lc.saveLocalConfig({ ...lc.getLocalConfig(), communityName: 'Back' });
    age();
    assert(lc.getLocalConfig().communityName === 'Back', 'and the file written again is read');
    // Nobody who changes a config changes the next.
    {
        const a = lc.getLocalConfig();
        a.communityName = 'Mutated';
        (a as any).extra = { deep: true };
        const g = lc.getGatewayConfig();
        g.rateLimiting.maxRequestsPerMinute = 1;
        g.rateLimiting.enabled = !g.rateLimiting.enabled;
        const b = lc.getLocalConfig();
        assert(b.communityName === 'Back' && !('extra' in b), 'a caller that changes the config it was handed changes nothing for the next read');
        assert(lc.getGatewayConfig().rateLimiting.maxRequestsPerMinute !== 1, '…nor the gateway config');
        assert(a !== b, 'each read is a new object');
    }
    // A broken file is never kept: the last good copy takes over, every time it is read.
    lc.saveLocalConfig({ ...lc.getLocalConfig(), communityName: 'Good' });
    age();
    lc.getLocalConfig();
    await sleep(30);
    fs.writeFileSync(CONFIG, '{"communityName": "Brok');
    {
        const { result, errors } = quiet(() => lc.getLocalConfig().communityName);
        assert(result === 'Good', 'a file broken after it was kept is read as broken, and the last good copy answers');
        assert(errors.some((e) => /unreadable/.test(e)), '…saying so loudly, as before');
    }
    assert(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).communityName === 'Good', '…and the good copy is put back in place');
    (fs as any).readFileSync = realRead;

    // ── 2. the profile's switch overrides ──────────────────────────────────────────────────────────────────────────
    console.log('\n— 2. the profile\'s switch overrides: kept until the database is written —');
    const defaults = np.profileDefaults('local') as unknown as Record<string, unknown>;
    const names = Object.keys(defaults).filter((k) => typeof defaults[k] === 'boolean');
    const [swA, swB] = [names[0], names[1]] as [keyof typeof defaults & string, keyof typeof defaults & string];
    const configured = () => np.getConfiguredSwitches() as unknown as Record<string, boolean>;
    const OVERRIDE = (n: string) => `nodeProfile.${n}`;
    const flipped = (n: string) => !defaults[n];

    const stmtProto = Object.getPrototypeOf(db.prepare('SELECT 1')) as { all: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown };
    const realAll = stmtProto.all;
    let overrideSelects = 0;
    stmtProto.all = function (this: { source: string }, ...a: unknown[]) {
        if (/substr\(key, 1, \?\) = \?/.test(this.source) && /ORDER BY key/.test(this.source)) overrideSelects++;
        return realAll.apply(this, a);
    };
    const selects = <T>(fn: () => T): { result: T; n: number } => { const before = overrideSelects; const result = fn(); return { result, n: overrideSelects - before }; };

    assert(configured()[swA] === defaults[swA], 'no override: the profile\'s default');
    {
        const { n } = selects(() => { for (let i = 0; i < 200; i++) { np.getProfileSwitches(); np.getConfiguredSwitches(); np.readProfileOverrides(); } });
        assert(n <= 1, `600 reads with nothing written read the overrides at most once (read ${n} times)`);
    }

    np.setSwitchOverride(swA as any, flipped(swA));
    assert(configured()[swA] === flipped(swA), 'setSwitchOverride (the owner console, an MCP tool): the next read');
    assert((np.readProfileOverrides() as any)[swA] === flipped(swA) && Object.keys(np.readProfileOverrides()).length === 1, '…readProfileOverrides too');
    np.setSwitchOverride(swA as any, defaults[swA] as boolean);
    assert(configured()[swA] === defaults[swA] && Object.keys(np.readProfileOverrides()).length === 0, 'set back to the default: the override is gone');

    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(OVERRIDE(swB), String(flipped(swB)));
    assert(configured()[swB] === flipped(swB), 'raw SQL that inserts a row: the next read');
    db.prepare('UPDATE node_config SET value = ? WHERE key = ?').run(String(defaults[swB]), OVERRIDE(swB));
    assert(configured()[swB] === defaults[swB], '…that updates it');
    db.prepare('UPDATE node_config SET value = ? WHERE key = ?').run(String(flipped(swB)), OVERRIDE(swB));
    assert(configured()[swB] === flipped(swB), '…and again');
    db.prepare('DELETE FROM node_config WHERE substr(key, 1, ?) = ?').run('nodeProfile.'.length, 'nodeProfile.');
    assert(configured()[swB] === defaults[swB], '…that removes every override at once (a take-over\'s clear)');

    assert(np.writeProfileRecord({ profile: null, overrides: { [swA]: String(flipped(swA)), [swB]: String(flipped(swB)) } }) === true
        && configured()[swA] === flipped(swA) && configured()[swB] === flipped(swB), 'writeProfileRecord (a standby\'s copy, a take-over): the next read');
    np.writeProfileRecord({ profile: null, overrides: { [swB]: String(flipped(swB)) } });
    assert(configured()[swA] === defaults[swA] && configured()[swB] === flipped(swB), '…and a record without one drops it');
    np.writeProfileRecord({ profile: null, overrides: {} });
    assert(configured()[swB] === defaults[swB], '…and an empty record drops the rest');

    // The command line: another connection to the same file.
    const cli = new Database(path.join(DATA_DIR, 'state.db'));
    configured();
    cli.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(OVERRIDE(swA), String(flipped(swA)));
    assert(configured()[swA] === flipped(swA), 'a row written by ANOTHER connection (the command line) is the next read');
    cli.prepare('UPDATE node_config SET value = ? WHERE key = ?').run(String(defaults[swA]), OVERRIDE(swA));
    assert(configured()[swA] === defaults[swA], '…an update by it');
    cli.prepare('DELETE FROM node_config WHERE key = ?').run(OVERRIDE(swA));
    assert(Object.keys(np.readProfileOverrides()).length === 0, '…and its delete');

    // A transaction.
    {
        let inside: boolean | null = null;
        try {
            db.transaction(() => {
                np.setSwitchOverride(swA as any, flipped(swA));
                inside = configured()[swA];
                throw new Error('refused after the write');
            })();
        } catch { /* rolled back */ }
        assert(inside === flipped(swA), 'inside a transaction, the read sees what the transaction wrote');
        assert(configured()[swA] === defaults[swA] && Object.keys(np.readProfileOverrides()).length === 0, 'after it rolls back, nothing it wrote is left in the next read');
        db.transaction(() => { np.setSwitchOverride(swA as any, flipped(swA)); configured(); })();
        assert(configured()[swA] === flipped(swA), 'and one that commits is the next read');
        np.setSwitchOverride(swA as any, defaults[swA] as boolean);
    }

    // Bad rows are still ignored with a line, once; the good one beside them still counts.
    {
        const warns: string[] = [];
        const warn = console.warn;
        console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
        try {
            db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run('nodeProfile.notASwitch', 'true');
            db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(OVERRIDE(swA), 'maybe');
            db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(OVERRIDE(swB), ' TRUE ');
            for (let i = 0; i < 5; i++) np.readProfileOverrides();
        } finally { console.warn = warn; }
        const o = np.readProfileOverrides() as Record<string, boolean>;
        assert(Object.keys(o).length === 1 && o[swB] === true, 'a bad row is ignored, a good one beside it counts (" TRUE " is true)');
        assert(warns.filter((w) => /notASwitch/.test(w)).length === 1 && warns.filter((w) => /"maybe"/.test(w)).length === 1, '…each bad row says so once however often it is read');
        db.prepare('DELETE FROM node_config WHERE substr(key, 1, ?) = ?').run('nodeProfile.'.length, 'nodeProfile.');
    }

    // Nobody who changes what they were handed changes the next read.
    {
        np.setSwitchOverride(swA as any, flipped(swA));
        const o = np.readProfileOverrides() as Record<string, boolean>;
        o[swA] = !o[swA];
        (o as any).injected = true;
        const c = np.getConfiguredSwitches() as unknown as Record<string, boolean>;
        c[swA] = !c[swA];
        const p = np.getProfileSwitches() as unknown as Record<string, boolean>;
        p[swA] = !p[swA];
        assert(configured()[swA] === flipped(swA) && !('injected' in np.readProfileOverrides()) && (np.readProfileOverrides() as any)[swA] === flipped(swA),
            'a caller that changes the overrides it was handed changes nothing for the next read');
        np.setSwitchOverride(swA as any, defaults[swA] as boolean);
    }
    stmtProto.all = realAll;

    // ── 3. the known floor's dial ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 3. the known floor\'s dial —');
    const realGet = stmtProto.get;
    let dialReads = 0;
    stmtProto.get = function (this: { source: string }, ...a: unknown[]) {
        if (/SELECT value FROM node_config WHERE key = \?/.test(this.source) && a[0] === engine.CONFIRMATION_DIAL_KEY) dialReads++;
        return realGet.apply(this, a);
    };
    process.env.NODE_PROFILE = 'global';
    {
        const before = dialReads;
        let all = true;
        for (let i = 0; i < 100; i++) all = all && engine.confirmationDialOn(db) === false;
        assert(all, 'a node without Beans (the global profile) reads the dial off');
        assert(dialReads - before === 0, `…without reading its row (read ${dialReads - before} times in 100 asks)`);
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(engine.CONFIRMATION_DIAL_KEY, 'on');
        assert(engine.confirmationDialOn(db) === false, '…whatever the row says');
        db.prepare('DELETE FROM node_config WHERE key = ?').run(engine.CONFIRMATION_DIAL_KEY);
    }
    delete process.env.NODE_PROFILE;
    {
        assert(engine.confirmationDialOn(db) === true, 'a node with Beans: the dial is on unless the owner switched it off');
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(engine.CONFIRMATION_DIAL_KEY, 'off');
        assert(engine.confirmationDialOn(db) === false, '…raw SQL that switches it off is the next read');
        db.prepare('DELETE FROM node_config WHERE key = ?').run(engine.CONFIRMATION_DIAL_KEY);
        assert(engine.confirmationDialOn(db) === true, '…and its removal');
        const shown = kf.setKnownFloorSettings('owner', { confirmation: false, creditCap: 3000, knownFloor: 1500 });
        assert(shown.confirmation === false && shown.creditCap === 3000 && shown.knownFloor === 1500, 'the owner console\'s setter: the next read says what was set');
        assert(engine.confirmationDialOn(db) === false && engine.savedCreditCap(db) === 3000 && engine.knownFloor(db) === 1500, '…through the engine\'s reads too');
        const back = kf.setKnownFloorSettings('owner', { confirmation: true, creditCap: 2000, knownFloor: 1000 });
        assert(back.confirmation === true && engine.confirmationDialOn(db) === true, 'switched back on: the next read');
        cli.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(engine.CONFIRMATION_DIAL_KEY, 'off');
        assert(engine.confirmationDialOn(db) === false, 'the dial switched off by another connection is the next read');
        cli.prepare('DELETE FROM node_config WHERE key = ?').run(engine.CONFIRMATION_DIAL_KEY);
        assert(engine.confirmationDialOn(db) === true, '…and on again');
        // Beans switched off by an override on a node that had them: the dial follows at once.
        np.setSwitchOverride('beans' as any, false);
        assert(np.getProfileSwitches().beans === false && engine.confirmationDialOn(db) === false, 'Beans switched off by an override: the dial reads off at once');
        np.setSwitchOverride('beans' as any, true);
        assert(np.getProfileSwitches().beans === true && engine.confirmationDialOn(db) === true, '…and on again');
    }
    stmtProto.get = realGet;

    // ── 4. a signer's key ──────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 4. a signer\'s key: built once, the last 1,024 kept —');
    const realCreate = crypto.createPublicKey;
    let created = 0;
    (crypto as any).createPublicKey = function (...a: unknown[]) { created++; return (realCreate as any).apply(crypto, a); };
    const size = (): number => (typeof ms.signerKeyCacheSize === 'function' ? ms.signerKeyCacheSize() : -1);
    const signer = () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        return { hex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
    };
    const TEXT = 'a fixed statement';
    /** Whether verifyStatementSignature accepts `sig` as `hex`'s signature of TEXT (the old form, accepted until the switch day). */
    const accepts = (hex: string, sig: string): boolean =>
        ms.verifyStatementSignature({ signature: sig, pubKeyHex: hex, boundText: () => '', oldTexts: [TEXT] }).ok === true;
    const signOf = (s: { privateKey: crypto.KeyObject }, text = TEXT): string => crypto.sign(null, Buffer.from(text, 'utf-8'), s.privateKey).toString('base64');

    {
        const s = signer();
        const good = signOf(s);
        const before = created;
        const verdicts = Array.from({ length: 30 }, () => accepts(s.hex, good));
        assert(verdicts.every(Boolean), 'a good signature is accepted every time');
        assert(created - before <= 1, `…and its key is built at most once for 30 requests (built ${created - before} times)`);
        assert(!accepts(s.hex, signOf(s, 'another text')) && !accepts(s.hex, good.slice(0, -4) + 'AAAA') && !accepts(s.hex, ''), '…a signature of another text, a damaged one and an empty one are refused with the key kept');
        assert(accepts(s.hex, Buffer.from(good, 'base64').toString('hex')) === true, '…its hex spelling is accepted too (statements allow either)');
        assert(accepts(s.hex.toUpperCase(), good) === true, '…and the key spelled in capitals (the same key)');
        const other = signer();
        assert(!accepts(other.hex, good), 'the same signature under another key is refused');
        assert(accepts(other.hex, signOf(other)) && !accepts(s.hex, signOf(other)), 'each key verifies its own signatures only');
        assert(!accepts('00'.repeat(32), good) && !accepts('zz'.repeat(32), good) && !accepts('ab', good), 'a key that is no key, or that cannot be built, is refused without an error');
        assert(!accepts('00'.repeat(32), good) && !accepts('00'.repeat(32), good), '…every time it is presented');
    }
    {
        // 1,100 distinct keys: at most 1,024 are kept, the last ones used.
        const keys = Array.from({ length: 1100 }, () => { const s = signer(); return { ...s, sig: '' }; });
        let everyOwnSignatureAccepted = true;
        for (const k of keys) { k.sig = signOf(k); everyOwnSignatureAccepted = accepts(k.hex, k.sig) && everyOwnSignatureAccepted; }
        assert(everyOwnSignatureAccepted, 'each of 1,100 keys has its own signature accepted');
        assert(size() === -1 || (size() > 0 && size() <= 1024), `1,100 distinct keys keep at most 1,024 (kept ${size()})`);
        let before = created;
        let recentAccepted = true;
        for (const k of keys.slice(-1000)) recentAccepted = accepts(k.hex, k.sig) && recentAccepted;
        const recent = created - before;
        before = created;
        let oldAccepted = true;
        for (const k of keys.slice(0, 20)) oldAccepted = accepts(k.hex, k.sig) && oldAccepted;
        const old = created - before;
        assert(recentAccepted && oldAccepted, 'a key kept, and one pushed out and built again, both verify');
        assert(recent === 0, `the 1,000 used last are still kept (rebuilt ${recent})`);
        assert(old === 20, `the first 20 were pushed out and are built again (rebuilt ${old} of 20)`);
        assert(size() === -1 || size() <= 1024, `…and the cache is still within its bound (${size()})`);
    }
    (crypto as any).createPublicKey = realCreate;

    cli.close();
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
