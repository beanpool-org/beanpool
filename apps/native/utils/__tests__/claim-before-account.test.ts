/**
 * The `beanpool claim` QR scanned on a phone with no BeanPool account yet (Dax, 23 Oct 2026: "The QR code took me to the
 * front page of the app… a noob might give up"). #2412 kept the claim on the phone and sent the member to make an account
 * elsewhere first, and with no invite the only account the first screen offered was the global community's: a
 * self-hosted community's first owner depended on us (DESIGN-account-without-global-fable.md §1, the no-domain-lock-in
 * breach). Now the claim makes the account (§2.2):
 *   1. the claim screen stays with no account (utils/auth-return.ts setupRedirect), and its tap makes the key and writes
 *      it, with the wizard's record (flow `claim`, step `claim`), just before the claim goes (utils/claim-key.ts);
 *   2. while that claim's answer is not in, a restart comes back to the claim screen: the guard leaves it be for that
 *      record (`claimOut`), and welcome hands the record back to it at its address and code id, never with the code;
 *   3. once the claim is in, the record is the wizard's (Your Photo, Safety Backup, How it Works, the owner's card), which
 *      welcome resumes, and the guard holds the phone there as for every join;
 *   4. nothing waits beside the record any more: an older build's kept claim (and its code) is taken off at every start
 *      and by a wipe.
 * The screen's own taps are claim-screen-render.test.ts's, the claim's key rule node-claim.test.ts's, and the claim end to
 * end against a real node claim-account-e2e.test.ts's; the chain here runs the real modules the root layout and the
 * welcome screen run, with AsyncStorage as a map.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => disk.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { disk.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { disk.delete(k); }),
    },
}));

import {
    claimInFlight, clearPendingOnboarding, forgetOldPendingClaim, getPendingOnboarding, resumePlan, setPendingOnboarding,
    type PendingOnboarding,
} from '../onboarding-state';
import { memberRedirect } from '../member-landing';
import { setupRedirect } from '../auth-return';
import { claimRouteFor, claimRouteFromSystemPath, parseClaimLink } from '../claim-link';

const NODE = 'https://beans.example.org';
const ID = '0a1b2c3d';
// Shaped like a claim code; not one any server made.
const CODE = 'claim-a1b2-c3d4-e5f6-7890';
const QR = `beanpool://claim?node=${encodeURIComponent(NODE)}&id=${ID}&code=${CODE}`;
const KEY = 'ab'.repeat(32);
const STORED = { publicKey: KEY, privateKey: '07'.repeat(32), callsign: 'Dax', createdAt: '2026-10-24T00:00:00Z' } as any;

/** app/_layout.tsx's refresh: the guard's flag, from the wizard's record. */
async function guardFlag(): Promise<false | 'wizard' | 'claim'> {
    const p = await getPendingOnboarding();
    return !p ? false : claimInFlight(p) ? 'claim' : 'wizard';
}
/** The guard's first two checks, as app/_layout.tsx calls them. */
async function guard(segments: string[], hasIdentity: boolean): Promise<'/welcome' | null> {
    if (!hasIdentity) return setupRedirect(segments, { hasIdentity: false, pendingOnboarding: false });
    const flag = await guardFlag();
    return flag ? setupRedirect(segments, { hasIdentity: true, pendingOnboarding: true, claimOut: flag === 'claim' }) : null;
}

/** What the claim's tap leaves on the phone just before the POST (utils/claim-key.ts claimWithKey, door-key.ts commitDoorKey). */
const CLAIM_OUT: PendingOnboarding = {
    step: 'claim', flow: 'claim', inviteCode: '', anchorUrl: NODE, callsign: 'Dax', redeemed: false,
    claimCodeId: ID, freshKey: KEY, joinsOut: 1,
};
/** What finishClaim leaves once the claim is in. */
const CLAIM_IN: PendingOnboarding = {
    step: 'profileSetup', flow: 'claim', inviteCode: '', anchorUrl: NODE, callsign: 'Dax', redeemed: true,
    newKey: KEY, joinDoor: 'words', communityName: 'Beans Town',
};

beforeEach(() => { disk.clear(); });

describe('the QR on a phone with no account: the claim screen, which makes the account', () => {
    it('cold start: the camera opens the claim screen with the checked fields, and the guard leaves it be', async () => {
        const opened = claimRouteFromSystemPath(QR)!;
        expect(opened).toBe(`/claim-community?node=${encodeURIComponent(NODE)}&id=${ID}&code=${CODE}`);
        // No account and no record: the guard leaves the claim screen where it is (before #2412, it sent it to welcome).
        expect(await guard(['claim-community'], false)).toBeNull();
        // Nothing is kept on the phone by opening it: the code lives in the screen's route.
        expect([...disk.keys()]).toEqual([]);
    });

    it('the claim out and the app restarted: the claim screen stays, welcome hands the record back to it, everything else goes to welcome', async () => {
        await setPendingOnboarding(CLAIM_OUT);
        // The app loads the key the tap wrote (IdentityContext), and the guard reads the record.
        expect(await guardFlag()).toBe('claim');
        expect(await guard(['claim-community'], true)).toBeNull();
        expect(await guard(['welcome'], true)).toBeNull();
        for (const root of [[], ['(tabs)'], ['find-community'], ['node-mismatch'], ['recover-identity']]) {
            expect(await guard(root, true), root.join('/') || '(root)').toBe('/welcome');
        }
        // Welcome (app/welcome.tsx resume) replaces itself with the claim screen at the record's address and code id.
        const plan = resumePlan(await getPendingOnboarding(), STORED);
        expect(plan).toMatchObject({ action: 'resume', mode: 'claim', anchorUrl: NODE, claimCodeId: ID });
        if (plan.action !== 'resume') throw new Error('expected resume');
        const route = claimRouteFor({ node: plan.anchorUrl, nodeRefused: false, codeId: plan.claimCodeId, code: null });
        expect(route).toBe(`/claim-community?node=${encodeURIComponent(NODE)}&id=${ID}`);
        // Never the code: it is typed again, from the QR or claim-code.txt.
        expect(parseClaimLink(`beanpool://claim?${route.split('?')[1]}`)).toEqual({ node: NODE, nodeRefused: false, codeId: ID, code: null });
        expect(JSON.stringify([...disk.values()])).not.toContain(CODE.slice(6));
    });

    it('the claim in: the wizard\'s steps are welcome\'s alone, as every join\'s, and its end lands on the tabs', async () => {
        await setPendingOnboarding(CLAIM_IN);
        expect(await guardFlag()).toBe('wizard');
        expect(await guard(['claim-community'], true)).toBe('/welcome');
        expect(await guard(['welcome'], true)).toBeNull();
        expect(resumePlan(await getPendingOnboarding(), STORED)).toMatchObject({ action: 'resume', mode: 'profileSetup', flow: 'claim', newKey: true });
        // The wizard's end (welcome.tsx handleConfirmSeed): no record, and the guard's landing is the tabs.
        await clearPendingOnboarding();
        expect(await guard(['welcome'], true)).toBeNull();
        expect(memberRedirect(['welcome'], KEY)).toBe('/(tabs)');
    });

    it('an older build\'s kept claim, with its one-time code, is taken off at every start and by a wipe', async () => {
        disk.set('beanpool_pending_claim', JSON.stringify({ node: NODE, codeId: ID, code: CODE, savedAt: Date.now() }));
        await forgetOldPendingClaim();
        expect(disk.has('beanpool_pending_claim')).toBe(false);
        const identity = fs.readFileSync(path.resolve(__dirname, '../identity.ts'), 'utf8');
        const wipe = identity.slice(identity.indexOf('export async function wipeIdentity('));
        expect(wipe.slice(0, wipe.indexOf('wipeIdentityScopedStorage('))).toMatch(/await clearPendingOnboarding\(\);\s*await forgetOldPendingClaim\(\);/);
    });
});

describe('the model is the app', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

    it('app/_layout.tsx reads the claim from the wizard\'s record into the guard\'s flag, and sweeps the old kept claim', () => {
        const layout = read('../../app/_layout.tsx');
        const at = layout.indexOf('const [pendingOnboarding, setPendingOnboardingFlag] = useState<false | \'wizard\' | \'claim\' | null>(null);');
        expect(at).toBeGreaterThan(0);
        const effect = layout.slice(at, layout.indexOf('}, []);', at));
        expect(effect).toMatch(/getPendingOnboarding\(\)\.then\(\(p\) => \{\s*if \(!mounted\) return;\s*setPendingOnboardingFlag\(!p \? false : claimInFlight\(p\) \? 'claim' : 'wizard'\);/);
        expect(effect).toContain('void forgetOldPendingClaim();');
        expect(effect).toContain('subscribePendingOnboarding(refresh)');
    });

    it('the detour is gone: no Make my account, no waiting note, no claim beside the record', () => {
        const welcome = read('../../app/welcome.tsx');
        const claim = read('../../app/claim-community.tsx');
        const state = read('../onboarding-state.ts');
        expect(fs.existsSync(path.resolve(__dirname, '../../components/ClaimWaitingNote.tsx'))).toBe(false);
        expect(welcome).not.toMatch(/ClaimWaitingNote|claimWaitingNote/);
        expect(claim).not.toMatch(/Make my account|claim-make-account|setPendingClaim|handOverPendingClaim/);
        expect(state).not.toMatch(/interface PendingClaim|setPendingClaim|getPendingClaim|handOverPendingClaim|PENDING_CLAIM_TTL_MS/);
    });

    it('app/welcome.tsx offers the claim as one quiet link below the fold, after Restore, never between the title and the doors', () => {
        const welcome = read('../../app/welcome.tsx');
        const doors = welcome.indexOf('<WelcomeDoors door={globalDoor}');
        const about = welcome.indexOf('<Text style={styles.homeAbout}>');
        const restore = welcome.indexOf("{t('🔑 Already a Member? Restore Account →')}");
        const claim = welcome.indexOf("{t('Installed BeanPool on a server? Claim it →')}");
        expect(doors).toBeGreaterThan(0);
        expect(about).toBeGreaterThan(doors);
        expect(restore).toBeGreaterThan(about);
        expect(claim).toBeGreaterThan(restore);
        // It opens the claim screen with no server, which scans the server's QR or takes its address.
        expect(welcome.slice(restore, claim)).toMatch(/onPress=\{\(\) => router\.push\(CLAIM_NEW_SERVER_ROUTE\)\}/);
    });
});
