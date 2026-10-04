/**
 * "Sign out everywhere" from the app (utils/sign-out-everywhere.ts, NodeAdminEntry): the request the node's revoke-all
 * takes (signed with the member key over exactly the body sent, to the full URL fetched), the node's refusal passed on
 * in its own words, a network failure said plainly, success only when the node says so, and one ask at a time. The
 * screen cannot be rendered here (see vitest.config.ts): its wiring is read from the source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const signer = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../crypto', () => ({
    buildSignedHeaders: vi.fn(async (...args: unknown[]) => {
        signer.calls.push(args);
        return { 'Content-Type': 'application/json', 'X-Public-Key': 'ab'.repeat(32), 'X-Signature': 'sig', 'X-Timestamp': '1', 'X-Nonce': 'n1', 'X-Signed-For': 'mycommunity.example.org' };
    }),
}));

import { signOutEverywhere, signOutEverywhereOnce, signOutEverywhereWarning, signOutEverywhereDone } from '../sign-out-everywhere';

const identity = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32) } as any;
const NODE = 'https://mycommunity.example.org/';

beforeEach(() => {
    vi.restoreAllMocks();
    signer.calls = [];
});

describe('signOutEverywhere', () => {
    it('POSTs revoke-all to the full URL, signed by the member key over exactly the body it sends, naming nobody', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, breakGlassCodeRetired: true }), { status: 200 }));
        const r = await signOutEverywhere(NODE, identity);
        expect(r).toEqual({ ok: true, breakGlassCodeRetired: true });
        expect(signer.calls).toEqual([['POST', 'https://mycommunity.example.org/api/local/admin/auth/revoke-all', '{}', identity.privateKey, identity.publicKey]]);
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://mycommunity.example.org/api/local/admin/auth/revoke-all');
        expect(init.method).toBe('POST');
        expect(init.body).toBe('{}');
        const headers = init.headers as Record<string, string>;
        for (const h of ['X-Public-Key', 'X-Signature', 'X-Timestamp', 'X-Nonce', 'X-Signed-For']) expect(headers[h]).toBeTruthy();
    });

    it("the node's refusal comes back in its words, and is never a success", async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Missing or stale timestamp / nonce headers' }), { status: 401 }));
        expect(await signOutEverywhere(NODE, identity)).toEqual({ ok: false, reason: 'refused', message: 'Missing or stale timestamp / nonce headers' });
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('oops', { status: 500 }));
        expect(await signOutEverywhere(NODE, identity)).toEqual({ ok: false, reason: 'refused', message: 'The community did not sign you out (500).' });
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
        expect((await signOutEverywhere(NODE, identity)).ok).toBe(false);
    });

    it('a network failure says so plainly', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Network request failed'));
        const r = await signOutEverywhere(NODE, identity);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toBe('failed');
        expect(!r.ok && r.message).toMatch(/Could not reach the community, so you may still be signed in elsewhere/);
    });

    it('a double tap asks the node once', async () => {
        let release: (r: Response) => void = () => {};
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((res) => { release = res; }));
        const first = signOutEverywhereOnce(NODE, identity);
        const second = await signOutEverywhereOnce(NODE, identity);
        expect(second).toEqual({ ok: false, reason: 'busy', message: 'Already signing you out everywhere.' });
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        release(new Response(JSON.stringify({ success: true, breakGlassCodeRetired: false }), { status: 200 }));
        expect(await first).toEqual({ ok: true, breakGlassCodeRetired: false });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('says what it does before, and what happened after, in plain words', () => {
        expect(signOutEverywhereWarning('Mullum', true)).toBe("This signs you out of Mullum's Settings on every computer and phone, and retires your break-glass code. Your key stays on this phone: Manage signs you in again. Automation tokens keep working: press Manage, then Automation tokens under Access & Security, and revoke any you didn't make.");
        expect(signOutEverywhereWarning('Mullum', false)).not.toMatch(/Automation tokens/);
        expect(signOutEverywhereWarning('Mullum', false)).not.toMatch(/break-glass/);
        expect(signOutEverywhereDone({ breakGlassCodeRetired: true })).toMatch(/break-glass code no longer works/);
        expect(signOutEverywhereDone({ breakGlassCodeRetired: false })).toBe('Every Settings sign-in of yours has ended.');
    });
});

describe('NodeAdminEntry wiring', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../components/NodeAdminEntry.tsx'), 'utf-8');

    it('the row asks first, then sends; labelled as it reads', () => {
        expect(src).toContain('onPress={() => confirmSignOutAll(name)}');
        expect(src).toContain('accessibilityLabel="Sign out everywhere"');
        expect(src).toContain('<Text style={styles.menuText}>Sign out everywhere</Text>');
        expect(src).toMatch(/Alert\.alert\('Sign out everywhere\?'[\s\S]*?text: 'Cancel'[\s\S]*?onPress: \(\) => \{ signOutAll\(\)/);
    });

    it("a second tap can't clear the first one's spinner (#1548 NB2): both rows return at once while one runs", () => {
        expect(src).toMatch(/if \(issuingRef\.current\) return;\s*issuingRef\.current = true;\s*setIssuing\(true\);/);
        expect(src).toMatch(/if \(signingOutRef\.current\) return;\s*signingOutRef\.current = true;\s*setSigningOut\(true\);/);
        expect(src).toMatch(/finally \{\s*issuingRef\.current = false;\s*setIssuing\(false\);/);
    });
});
