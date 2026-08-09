import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Expo and React Native modules are mocked at the boundary — they do not load off a device, and
 * dragging in a transform pipeline to pretend otherwise would buy nothing. What is under test is
 * the ordering and the counting, which is where this can go quietly wrong.
 */
const writes: { path: string; contents: string }[] = [];
const calls: string[] = [];

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => 'https://test.beanpool.org') },
}));

vi.mock('expo-file-system/legacy', () => ({
    documentDirectory: 'file:///docs/',
    EncodingType: { UTF8: 'utf8' },
    writeAsStringAsync: vi.fn(async (path: string, contents: string) => {
        calls.push('write-device-fragment');
        writes.push({ path, contents });
    }),
}));

vi.mock('../crypto', () => ({
    buildSignedHeaders: vi.fn(async () => ({ 'Content-Type': 'application/json' })),
    encodeBase64: (b: Uint8Array) => Buffer.from(b).toString('base64'),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { enrolKeepers, DEVICE_FRAGMENT_FILE } from '../keeper-enrolment';

const IDENTITY = {
    publicKey: 'aa'.repeat(32),
    privateKey: 'bb'.repeat(32),
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '),
} as any;

/** A real Ed25519 public key, so sealing to the inviter exercises the actual curve maths. */
const INVITER_PUBKEY = '3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29';

interface RouteStub { status?: number; body?: unknown; text?: string; }

/** Wire up fetch for the two endpoints enrolment touches, recording the order they are hit in. */
function stubNode(routes: { candidates?: RouteStub; shares?: RouteStub }): void {
    global.fetch = vi.fn(async (url: string) => {
        const route = String(url).includes('keeper-candidates')
            ? { name: 'keeper-candidates', stub: routes.candidates }
            : { name: 'deposit-shares', stub: routes.shares };
        calls.push(route.name);
        const stub = route.stub ?? {};
        return {
            ok: (stub.status ?? 200) < 400,
            status: stub.status ?? 200,
            json: async () => stub.body ?? {},
            text: async () => stub.text ?? '',
        };
    }) as any;
}

const ELIGIBLE_INVITER = {
    body: { inviter: { eligible: true, publicKey: INVITER_PUBKEY, callsign: 'kim' } },
};
const NO_INVITER = { body: { inviter: { eligible: false, reason: 'admin' } } };

beforeEach(() => {
    writes.length = 0;
    calls.length = 0;
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('https://test.beanpool.org');
    vi.mocked(FileSystem.writeAsStringAsync).mockClear();
});

describe('enrolling keepers', () => {
    it('gives a piece to the phone, the hub and the inviter', async () => {
        stubNode({ candidates: ELIGIBLE_INVITER, shares: { body: { generation: 1 } } });
        const result = await enrolKeepers(IDENTITY);
        expect(result.error).toBeUndefined();
        expect(result.enrolled).toEqual(['device', 'hub', 'member']);
        expect(result.generation).toBe(1);
    });

    it('writes the phone\'s piece BEFORE telling the node the keeper exists', async () => {
        // The ordering that matters. K1's bytes live on the phone and nowhere else, so a failed
        // local write alongside a successful upload leaves a member counted as 3-of-N while
        // actually holding 2 — the one arrangement nobody can detect afterwards.
        stubNode({ candidates: ELIGIBLE_INVITER, shares: { body: { generation: 1 } } });
        await enrolKeepers(IDENTITY);
        expect(calls).toEqual(['keeper-candidates', 'write-device-fragment', 'deposit-shares']);
    });

    it('uploads nothing at all when the phone cannot store its piece', async () => {
        stubNode({ candidates: ELIGIBLE_INVITER, shares: { body: { generation: 1 } } });
        vi.mocked(FileSystem.writeAsStringAsync).mockRejectedValueOnce(new Error('disk full'));
        const result = await enrolKeepers(IDENTITY);
        expect(result.enrolled).toEqual([]);
        expect(result.error).toMatch(/could not store this phone's piece/);
        expect(calls).not.toContain('deposit-shares');
    });

    it('sends the device fragment with empty ciphertext, which is what the node accepts', async () => {
        // POST /api/recovery/shares REFUSES a device fragment carrying ciphertext — sending one
        // would mean the node had become a second holder of the piece that is meant to be the
        // phone's alone. Refused rather than dropped, so getting this wrong is a 400, not a
        // silent downgrade.
        let sent: any;
        global.fetch = vi.fn(async (url: string, init: any) => {
            if (String(url).includes('shares')) sent = JSON.parse(init.body);
            return {
                ok: true, status: 200,
                json: async () => (String(url).includes('candidates') ? ELIGIBLE_INVITER.body : { generation: 1 }),
                text: async () => '',
            };
        }) as any;

        await enrolKeepers(IDENTITY);
        const device = sent.shares.find((s: any) => s.holderType === 'device');
        expect(device).toMatchObject({ encryptedShare: '', shareIv: '', shareTag: '', holderRef: 'self' });

        // ...and every other keeper must carry real ciphertext, or the piece was never sealed.
        for (const share of sent.shares.filter((s: any) => s.holderType !== 'device')) {
            expect(share.encryptedShare.length).toBeGreaterThan(0);
        }
    });

    it('gives each keeper a distinct share index', async () => {
        // The index says which fragment this is. Two keepers on one index means one fragment was
        // never handed out, and the split silently needs a keeper who does not exist.
        let sent: any;
        global.fetch = vi.fn(async (url: string, init: any) => {
            if (String(url).includes('shares')) sent = JSON.parse(init.body);
            return {
                ok: true, status: 200,
                json: async () => (String(url).includes('candidates') ? ELIGIBLE_INVITER.body : { generation: 1 }),
                text: async () => '',
            };
        }) as any;

        await enrolKeepers(IDENTITY);
        const indexes = sent.shares.map((s: any) => s.shareIndex);
        expect(new Set(indexes).size).toBe(indexes.length);
    });
});

describe('declining to enrol', () => {
    it('enrols nobody when there is no third keeper to split across', async () => {
        // Three is the requirement and always has been. Two holders cannot hold a 3-of-N split,
        // so there is nothing to write — the member stays on their twelve words, exactly as
        // protected as every member is today, and the screen says so plainly.
        stubNode({ candidates: NO_INVITER });
        const result = await enrolKeepers(IDENTITY);
        expect(result.enrolled).toEqual([]);
        expect(result.error).toMatch(/only 2 keepers available/);
        expect(calls).not.toContain('deposit-shares');
        expect(writes).toHaveLength(0);
    });

    it('records WHY the inviter was skipped, so the screen can offer the right next step', async () => {
        stubNode({ candidates: NO_INVITER });
        const result = await enrolKeepers(IDENTITY);
        expect(result.skipped).toContainEqual({ keeper: 'member', reason: 'admin' });
    });

    it('enrols nobody on an identity with no words to split', async () => {
        stubNode({ candidates: ELIGIBLE_INVITER });
        const result = await enrolKeepers({ ...IDENTITY, mnemonic: [] });
        expect(result.error).toMatch(/no recovery words/);
        expect(calls).toHaveLength(0);
    });

    it('enrols nobody before a node is configured', async () => {
        vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);
        stubNode({ candidates: ELIGIBLE_INVITER });
        const result = await enrolKeepers(IDENTITY);
        expect(result.error).toMatch(/no node configured/);
        expect(writes).toHaveLength(0);
    });
});

describe('when things go wrong', () => {
    it('reports a node refusal without throwing', async () => {
        stubNode({ candidates: ELIGIBLE_INVITER, shares: { status: 400, text: 'nope' } });
        const result = await enrolKeepers(IDENTITY);
        expect(result.error).toMatch(/node refused the fragments \(400\)/);
        expect(result.enrolled).toEqual([]);
    });

    it('reports an unreachable node without throwing', async () => {
        // This runs in the background of a wizard step. An exception escaping would break signup
        // over a feature that is meant to be an improvement layered on top.
        global.fetch = vi.fn(async (url: string) => {
            if (String(url).includes('candidates')) {
                return { ok: true, status: 200, json: async () => ELIGIBLE_INVITER.body, text: async () => '' };
            }
            throw new Error('network down');
        }) as any;
        await expect(enrolKeepers(IDENTITY)).resolves.toMatchObject({ enrolled: [] });
    });

    it('treats an unreachable candidates endpoint as no inviter, not as a crash', async () => {
        global.fetch = vi.fn(async () => { throw new Error('network down'); }) as any;
        const result = await enrolKeepers(IDENTITY);
        expect(result.skipped[0].keeper).toBe('member');
        expect(result.error).toMatch(/only 2 keepers available/);
    });

    it('writes the fragment where the restore flow will look for it', async () => {
        stubNode({ candidates: ELIGIBLE_INVITER, shares: { body: { generation: 1 } } });
        await enrolKeepers(IDENTITY);
        expect(writes[0].path).toBe(`file:///docs/${DEVICE_FRAGMENT_FILE}`);
        expect(writes[0].contents.length).toBeGreaterThan(0);
    });
});
