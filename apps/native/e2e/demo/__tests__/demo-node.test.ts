/**
 * The Riverbend demo node (e2e/demo/demo-node.ts, DESIGN-app-screenshots-fable.md §2, lane L1): the invented community the
 * store and website pictures are taken from. Starts the node on a fresh data dir, as the capture driver does, and reads what it
 * seeded: the counts the design promises, the books, the one open deal, and every line of the chat opened as Sam.
 *
 * Nothing leaves this machine: the node's socket guard refuses anything but loopback and its fetch guard logs BLOCKED-FETCH;
 * both are read from its output below.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)) }));

import { AVATAR_PRESETS, dmLineKind, isWellFormedRecoveryPhrase, openDmLine } from '@beanpool/core';
import { mnemonicToKeypair } from '../../../utils/crypto';
import riverbend from '../riverbend.json';

const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.resolve(DEMO_DIR, '../../../server');
const DAY = 86_400_000;

type World = {
    members: Record<string, string>; posts: Record<string, string>; events: Record<string, string>; poll: string;
    trades: string[]; openDeal: { transactionId: string; postId: string }; dm: string; sam: string;
};

let child: ChildProcess;
let dataDir = '';
let root = '';
let world: World;
let ready: { port: number; httpPort: number; sam: string };
const log: string[] = [];
const waiting = new Map<number, (a: { ok: boolean; result?: unknown; error?: string }) => void>();
let counter = 0;

const ask = (req: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const id = ++counter;
    waiting.set(id, (a) => (a.ok ? resolve(a.result) : reject(new Error(`node: ${a.error}`))));
    child.stdin!.write(`${JSON.stringify({ id, ...req })}\n`);
});
const rows = (sql: string, params: unknown[] = []) => ask({ op: 'sql', sql, params, all: true }) as Promise<Record<string, any>[]>;
const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];

beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-demo-test-data-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-demo-test-root-'));
    child = spawn(process.execPath, ['--import', 'tsx', path.join(DEMO_DIR, 'demo-node.ts')], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the demo node was not ready in 150 s:\n${log.slice(-30).join('\n')}`)), 150_000);
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the demo node exited (${code}) before it was ready:\n${log.slice(-30).join('\n')}`)); });
        readline.createInterface({ input: child.stdout! }).on('line', (line) => {
            if (line.startsWith('FIXTURE_READY ')) { clearTimeout(timer); ready = JSON.parse(line.slice('FIXTURE_READY '.length)); resolve(); }
            else if (line.startsWith('FIXTURE_ANSWER ')) {
                const a = JSON.parse(line.slice('FIXTURE_ANSWER '.length));
                waiting.get(a.id)?.(a);
                waiting.delete(a.id);
            } else log.push(line);
        });
        readline.createInterface({ input: child.stderr! }).on('line', (line) => log.push(line));
    });
    world = await ask({ op: 'world' });
}, 180_000);

afterAll(async () => {
    // Only the node this test started, by its own process.
    if (child && child.exitCode === null) {
        child.removeAllListeners('exit');
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
        if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
});

const PEOPLE = "m.is_treasury = 0 AND m.public_key != 'SYSTEM'";
const BOARD = "p.type IN ('offer', 'need') AND p.status = 'active' AND p.active = 1";

describe('Riverbend: the town (design §2)', () => {
    it('has 37 members: the 11 named and 26 with names only, all with a ready-made picture', async () => {
        expect((await one(`SELECT COUNT(*) AS n FROM members m WHERE ${PEOPLE}`)).n).toBe(37);
        expect(riverbend.people.length + 1 + riverbend.otherMembers.length).toBe(37);
        expect(riverbend.people.length + 1).toBe(11);
        const avatars = await rows(`SELECT m.callsign, m.avatar_ref FROM members m WHERE ${PEOPLE}`);
        const presets = new Set(AVATAR_PRESETS.map((p) => `bundled://${p.id}`));
        expect(avatars.filter((a) => !presets.has(a.avatar_ref)).map((a) => a.callsign)).toEqual([]);
    });

    it('has 14 listings on the board, each with a photograph of its own, and Beans prices', async () => {
        const board = await rows(`SELECT p.id, p.type, p.title, p.credits, p.price_type FROM posts p WHERE ${BOARD}`);
        expect(board).toHaveLength(14);
        expect(board.filter((p) => p.type === 'offer')).toHaveLength(11);
        expect(board.filter((p) => p.type === 'need')).toHaveLength(3);
        const photos = await rows(`SELECT p.id, ph.sha256 FROM posts p JOIN post_photos ph ON ph.post_id = p.id WHERE ${BOARD}`);
        expect(new Set(photos.map((p) => p.id)).size).toBe(14);
        // Two listings never show the same picture in one Market.
        const all = await rows("SELECT ph.sha256 FROM post_photos ph JOIN posts p ON p.id = ph.post_id WHERE p.status = 'active' AND p.active = 1 AND p.type != 'poll'");
        expect(new Set(all.map((p) => p.sha256)).size).toBe(all.length);
        expect(all.length).toBe(17);
    });

    it('has 3 events at Riverbend with their guests, and 1 poll with 9 votes that closes tomorrow', async () => {
        const events = await rows("SELECT p.id, p.title, p.event_start_at, p.event_place_name FROM posts p WHERE p.type = 'event' AND p.status = 'active' ORDER BY p.event_start_at");
        expect(events).toHaveLength(3);
        const seed = events.find((e) => e.title === 'Seed swap at the hall')!;
        expect(seed.event_place_name).toBe('Riverbend Hall');
        const going = await one("SELECT COUNT(*) AS n FROM event_rsvps WHERE post_id = ? AND status = 'going'", [seed.id]);
        const interested = await one("SELECT COUNT(*) AS n FROM event_rsvps WHERE post_id = ? AND status = 'interested'", [seed.id]);
        expect([going.n, interested.n]).toEqual([12, 4]);
        expect((await one("SELECT COUNT(*) AS n FROM event_rsvps WHERE post_id = ? AND member_pubkey = ? AND status = 'going'", [seed.id, world.sam])).n).toBe(1);
        for (const e of events) expect(Date.parse(e.event_start_at)).toBeGreaterThan(Date.now());
        const polls = await rows("SELECT p.id, p.poll_closes_at FROM posts p WHERE p.type = 'poll' AND p.status = 'active'");
        expect(polls).toHaveLength(1);
        expect((await one('SELECT COUNT(*) AS n FROM poll_votes WHERE post_id = ?', [polls[0].id])).n).toBe(9);
        expect((await one('SELECT COUNT(*) AS n FROM poll_votes WHERE post_id = ? AND voter_pubkey = ?', [polls[0].id, world.sam])).n).toBe(0);
        const closesIn = Date.parse(polls[0].poll_closes_at) - Date.now();
        expect(closesIn).toBeGreaterThan(0);
        expect(closesIn).toBeLessThan(DAY);
    });
});

describe('Riverbend: the books (design §2 "Ledger")', () => {
    it('sum to zero across every account, the Commons and the escrow included', async () => {
        const { s } = await one('SELECT ROUND(SUM(balance), 6) AS s FROM accounts');
        expect(s).toBe(0);
    });

    it('give Sam exactly +42 Beans, after 7 completed trades, within the design\'s range for everyone else', async () => {
        expect((await one('SELECT ROUND(balance, 6) AS b FROM accounts WHERE public_key = ?', [world.sam])).b).toBe(42);
        const samTrades = await one("SELECT COUNT(*) AS n FROM marketplace_transactions WHERE status = 'completed' AND (buyer_pubkey = ? OR seller_pubkey = ?)", [world.sam, world.sam]);
        expect(samTrades.n).toBe(7);
        const people = await rows(`SELECT m.callsign, a.balance FROM members m JOIN accounts a ON a.public_key = m.public_key WHERE ${PEOPLE}`);
        for (const p of people) {
            expect(p.balance, p.callsign).toBeGreaterThanOrEqual(-60);
            expect(p.balance, p.callsign).toBeLessThanOrEqual(85);
        }
        // The history reads as three weeks, oldest first, none in the future.
        const stamps = (await rows('SELECT timestamp FROM transactions ORDER BY rowid')).map((r) => Date.parse(r.timestamp));
        expect(Math.max(...stamps)).toBeLessThanOrEqual(Date.now());
        expect(Date.now() - Math.min(...stamps)).toBeLessThan(23 * DAY);
        expect(Date.now() - Math.min(...stamps)).toBeGreaterThan(14 * DAY);
    });

    it('has exactly one open deal: Sam holding 12 Beans for Amara\'s sourdough, in trust', async () => {
        const open = await rows("SELECT id, post_id, buyer_pubkey, seller_pubkey, credits FROM marketplace_transactions WHERE status IN ('requested', 'pending')");
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({ id: world.openDeal.transactionId, post_id: world.posts.sourdough, buyer_pubkey: world.sam, seller_pubkey: world.members.amara, credits: 12 });
        const held = await rows("SELECT public_key, balance FROM accounts WHERE public_key LIKE 'escrow_%' AND balance != 0");
        expect(held).toEqual([{ public_key: `escrow_${open[0].id}`, balance: 12 }]);
    });

    it('collects the 1.5% fee into the Commons', async () => {
        const fees = await one('SELECT ROUND(SUM(tax_fee), 4) AS f FROM transactions');
        expect(fees.f).toBeGreaterThan(0);
        const commons = await one("SELECT ROUND(balance, 4) AS b FROM accounts WHERE public_key = 'COMMONS_POOL'");
        expect(commons.b).toBeGreaterThan(0);
        expect(commons.b).toBeLessThanOrEqual(fees.f);
    });
});

describe('Riverbend: Sam and the chat (design §2 "DM")', () => {
    it('is Sam by the invented 12 words, derived exactly as the phone derives them', async () => {
        expect(isWellFormedRecoveryPhrase(riverbend.sam.words)).toBe(true);
        expect(riverbend.sam.words).toHaveLength(12);
        const { publicKeyHex } = await mnemonicToKeypair(riverbend.sam.words);
        expect(world.sam).toBe(publicKeyHex);
        expect((await one('SELECT callsign FROM members WHERE public_key = ?', [publicKeyHex])).callsign).toBe('Sam');
    });

    it('opens every line of the chat with openDmLine as Sam, in the order the data gives them', async () => {
        const { privateKeyHex } = await mnemonicToKeypair(riverbend.sam.words);
        const amara = world.members.amara;
        const lines = await rows('SELECT id, author_pubkey, ciphertext, nonce, type, metadata FROM messages WHERE conversation_id = ? ORDER BY timestamp, rowid', [world.dm]);
        // The node's own notices (the deal's "held in trust" line) are no member's words; every other line is sealed.
        const sealed = lines.filter((l) => dmLineKind({ authorPubkey: l.author_pubkey, nonce: l.nonce, type: l.type, metadata: l.metadata }) === 'encrypted');
        expect(sealed).toHaveLength(riverbend.dm.lines.length);
        expect(lines.length).toBeGreaterThan(sealed.length);
        const said = sealed.map((l) => {
            const opened = openDmLine(
                { ciphertext: l.ciphertext, nonce: l.nonce },
                { myEdPrivHex: privateKeyHex, peerEdPubHex: amara },
                { senderPubHex: l.author_pubkey, messageId: l.id, conversationId: world.dm, metadata: l.metadata },
            );
            return { by: l.author_pubkey === world.sam ? 'sam' : l.author_pubkey === amara ? 'amara' : 'other', text: opened.text };
        });
        expect(said).toEqual(riverbend.dm.lines.map((l) => ({ by: l.by, text: l.text })));
        expect(riverbend.dm.lines.map((l) => l.text)).toEqual(['Two loaves for Saturday?', 'Yes, after 10 at the hall', 'Perfect, see you there']);
    });
});

describe('Riverbend: how a phone joins it (the stdin ops and the plain-HTTP listener)', () => {
    it('says where it listens and who Sam is on its READY line', () => {
        expect(ready.port).toBeGreaterThan(0);
        expect(ready.httpPort).toBeGreaterThan(0);
        expect(ready.httpPort).not.toBe(ready.port);
        expect(ready.sam).toBe(world.sam);
    });

    it('gives a fresh invite code from its first member, which the plain-HTTP listener checks as valid', async () => {
        const { code } = await ask({ op: 'invite' });
        expect(code).toEqual(expect.any(String));
        const stored = await one('SELECT created_by, used_by FROM invite_codes WHERE code = ?', [code]);
        expect(stored).toEqual({ created_by: world.members.ingrid, used_by: null });
        // The route a phone calls first when it follows beanpool://welcome?invite=…&server=http://localhost:<httpPort> (adb reverse).
        await ask({ op: 'resetLimits' });
        const res = await fetch(`http://127.0.0.1:${ready.httpPort}/api/invite/check?code=${encodeURIComponent(code)}`);
        expect(res.status).toBe(200);
        expect((await res.json()).valid).toBe(true);
        // A code nobody issued is not valid there.
        const none = await fetch(`http://127.0.0.1:${ready.httpPort}/api/invite/check?code=NOPE-NOT-A-CODE`);
        expect((await none.json()).valid).toBe(false);
    });
});

describe('Riverbend: nothing real, nothing leaves the machine', () => {
    it('never made a request off this machine', () => {
        expect(log.filter((l) => /BLOCKED-FETCH|BLOCKED-CONNECT/.test(l))).toEqual([]);
    });

    it('refuses a data folder that already holds something, so it can never seed a real node', async () => {
        const used = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-demo-test-used-'));
        fs.writeFileSync(path.join(used, 'state.db'), 'not a database');
        try {
            const out = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
                const c = spawn(process.execPath, ['--import', 'tsx', path.join(DEMO_DIR, 'demo-node.ts')], {
                    cwd: SERVER_DIR, env: { ...process.env, BEANPOOL_DATA_DIR: used, FIXTURE_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'],
                });
                let stderr = '';
                c.stderr!.on('data', (d) => { stderr += String(d); });
                c.stdout!.resume();
                c.on('exit', (code) => resolve({ code, stderr }));
            });
            expect(out.code).toBe(1);
            expect(out.stderr).toContain('is not empty');
            expect(fs.readFileSync(path.join(used, 'state.db'), 'utf8')).toBe('not a database');
        } finally {
            fs.rmSync(used, { recursive: true, force: true });
        }
    }, 60_000);

    it('uses Beans only, and none of the words the audience rules forbid', async () => {
        const texts = await rows('SELECT title, description FROM posts');
        const words = JSON.stringify([texts, riverbend.dm, riverbend.poll]);
        expect(words).not.toMatch(/[Ʀ$€£¥₿]/);
        expect(words.toLowerCase()).not.toMatch(/resilien|surviv/);
    });

    it('sits in the Bellingen hinterland, far from every community that exists', async () => {
        const places = await rows(`SELECT m.callsign, m.area_lat, m.area_lng FROM members m WHERE ${PEOPLE}`);
        expect(places).toHaveLength(37);
        for (const p of places) {
            // Within about 6 km of −30.45, 152.90 (never Mullumbimby, Castlemaine, Byron).
            expect(Math.abs(p.area_lat - riverbend.community.centre.lat), p.callsign).toBeLessThan(0.06);
            expect(Math.abs(p.area_lng - riverbend.community.centre.lng), p.callsign).toBeLessThan(0.06);
        }
        const pins = await rows("SELECT lat, lng FROM posts WHERE lat IS NOT NULL AND type != 'poll'");
        for (const p of pins) {
            expect(Math.abs(p.lat - riverbend.community.centre.lat)).toBeLessThan(0.06);
            expect(Math.abs(p.lng - riverbend.community.centre.lng)).toBeLessThan(0.06);
        }
    });
});

describe('Riverbend: the photographs (CREDITS.md)', () => {
    const credits = fs.readFileSync(path.join(DEMO_DIR, 'CREDITS.md'), 'utf8');
    const files = fs.readdirSync(path.join(DEMO_DIR, 'photos')).filter((f) => f.endsWith('.jpg')).sort();

    /** A JPEG's width and height, from its first start-of-frame marker. */
    const jpegSize = (bytes: Buffer): { width: number; height: number } => {
        let i = 2;
        while (i + 9 < bytes.length) {
            if (bytes[i] !== 0xff) { i++; continue; }
            const marker = bytes[i + 1];
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
            }
            i += 2 + bytes.readUInt16BE(i + 2);
        }
        throw new Error('no frame header in a JPEG');
    };

    it('has 17 files, every one JPEG of 800 px on its longest side and of a size a repo carries', () => {
        expect(files).toHaveLength(17);
        for (const f of files) {
            const bytes = fs.readFileSync(path.join(DEMO_DIR, 'photos', f));
            expect(bytes.subarray(0, 3).toString('hex'), f).toBe('ffd8ff');
            const { width, height } = jpegSize(bytes);
            expect(Math.max(width, height), f).toBeLessThanOrEqual(800);
            expect(Math.max(width, height), f).toBeGreaterThanOrEqual(790);
            expect(bytes.length, f).toBeLessThan(120 * 1024);
            expect(bytes.length, f).toBeGreaterThan(15 * 1024);
        }
    });

    it('credits every file: its Commons page, its author and CC0', () => {
        for (const f of files) {
            const row = credits.split('\n').find((l) => l.startsWith(`| \`${f}\``));
            expect(row, f).toBeTruthy();
            expect(row, f).toMatch(/<https:\/\/commons\.wikimedia\.org\/wiki\/File:[^>]+>/);
            expect(row, f).toMatch(/CC0 1\.0 \|$/);
        }
        // No other licence is named for a photograph.
        expect(credits).not.toMatch(/CC[ -]BY|GFDL|Attribution|ShareAlike/i);
        // Every photograph the data names is a file here, and every file is named by the data.
        const named = new Set([...riverbend.listings.map((l) => l.photo), ...riverbend.pastOffers.map((o) => o.photo), ...riverbend.events.map((e) => e.photo)]);
        for (const n of named) expect(files, n).toContain(`${n}.jpg`);
        const used = new Set([...riverbend.listings, ...riverbend.events].map((x) => x.photo));
        expect(files.map((f) => f.replace(/\.jpg$/, '')).filter((n) => !used.has(n))).toEqual([]);
    });
});
