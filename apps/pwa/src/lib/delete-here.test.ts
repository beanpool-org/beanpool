/**
 * The web app's Delete account follows the phone's rule (Marty, 2026-09-29; lib/delete-here.ts): the key leaves this
 * browser only when no other community it serves keeps it.
 *
 * The web app's copy of the key is kept per web address, so the only other community it can serve is the page's own
 * node, while Advanced → Sovereign Node Connection points the web app at another. Nothing here contacts a node: fetch is
 * a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    leaveThisCommunity, membershipAt, otherCommunityOfThisBrowser, planWebDelete, webDeleteFailedLine, webKeepsKeyLine,
    webLastCommunityLine,
} from './delete-here';

const KEY = 'a'.repeat(64);
const CASTLEMAINE = 'https://castlemaine.beanpool.org';

type Answer = 'member' | 'stranger' | 'recovering' | 'down' | 'refused' | 'not-json' | 'odd' | 'silent';

function pageNodeAnswers(answer: Answer) {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        asked.push(url);
        if (answer === 'down') throw new TypeError('Failed to fetch');
        if (answer === 'silent') {
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
        }
        if (answer === 'refused') return new Response('{}', { status: 503 });
        if (answer === 'not-json') return new Response('<html>Sign in to the Wi-Fi</html>', { status: 200 });
        if (answer === 'odd') return new Response('{}', { status: 200 });
        const body = answer === 'member' ? { isMember: true, callsign: 'Kim' }
            : answer === 'recovering' ? { isMember: false, isRecovering: true }
                : { isMember: false, callsign: null, isRecovering: false, recoveryStatus: null };
        return new Response(JSON.stringify(body), { status: 200 });
    }));
    return asked;
}

beforeEach(() => {
    localStorage.clear();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the one other community this browser\'s key can serve', () => {
    it('none while the web app talks to the node that served the page', () => {
        expect(otherCommunityOfThisBrowser()).toBeNull();
        localStorage.setItem('bp_node_url', `${window.location.origin}/`);
        expect(otherCommunityOfThisBrowser()).toBeNull();
        localStorage.setItem('bp_node_url', 'not an address');
        expect(otherCommunityOfThisBrowser()).toBeNull();
    });

    it('the page\'s own node, while Sovereign Node Connection points the web app at another', () => {
        localStorage.setItem('bp_node_url', CASTLEMAINE);
        expect(otherCommunityOfThisBrowser()).toBe(window.location.origin);
    });
});

describe('the plan', () => {
    it('talking to the page\'s own node: the last community, and no node is asked', async () => {
        const asked = pageNodeAnswers('member');
        expect(await planWebDelete(KEY)).toEqual({ kind: 'last', here: window.location.origin });
        expect(asked).toEqual([]);
    });

    it('pointed at Castlemaine, and the page\'s own node says the key is a member there: the key stays', async () => {
        localStorage.setItem('bp_node_url', CASTLEMAINE);
        const asked = pageNodeAnswers('member');

        const plan = await planWebDelete(KEY);

        expect(plan).toEqual({ kind: 'this-one', here: CASTLEMAINE, keeps: { url: window.location.origin, membership: 'member' } });
        expect(asked).toEqual([`${window.location.origin}/api/community/membership/${KEY}`]);
        if (plan.kind !== 'this-one') return;
        const home = window.location.host;
        expect(webKeepsKeyLine(plan, true)).toBe(
            `Your key and 12 words stay in this browser, for ${home}, the community this web address belongs to. ` +
            `After the delete at castlemaine.beanpool.org, the web app goes back to ${home}.`);
    });

    it('the page\'s own node says the key is no member there: the last community', async () => {
        localStorage.setItem('bp_node_url', CASTLEMAINE);
        pageNodeAnswers('stranger');
        expect(await planWebDelete(KEY)).toEqual({ kind: 'last', here: CASTLEMAINE });
    });

    for (const answer of ['down', 'refused', 'not-json', 'odd', 'silent'] as const) {
        it(`the page's own node ${answer}: it counts as one the key is still in, so the key stays`, async () => {
            localStorage.setItem('bp_node_url', CASTLEMAINE);
            pageNodeAnswers(answer);

            const plan = await planWebDelete(KEY, 50);

            expect(plan).toEqual({ kind: 'this-one', here: CASTLEMAINE, keeps: { url: window.location.origin, membership: 'unreachable' } });
            if (plan.kind === 'this-one') expect(webKeepsKeyLine(plan, false)).toContain('couldn\'t be reached, so it counts as a community you are still in.');
        });
    }

    it('a recovering key is a member', async () => {
        pageNodeAnswers('recovering');
        expect(await membershipAt(window.location.origin, KEY)).toBe('member');
    });
});

describe('leaving the community the web app was pointed at', () => {
    it('goes back to the page\'s own node, and keeps every other setting', () => {
        localStorage.setItem('bp_node_url', CASTLEMAINE);
        localStorage.setItem('beanpool-theme-mode', 'dark');
        localStorage.setItem(`beanpool_seed_viewed_${KEY}`, 'true');

        leaveThisCommunity();

        expect(localStorage.getItem('bp_node_url')).toBeNull();
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('dark');
        expect(localStorage.getItem(`beanpool_seed_viewed_${KEY}`)).toBe('true');
    });
});

describe('what the web app says', () => {
    it('at the last community: the key leaves this browser only; other copies stay', () => {
        expect(webLastCommunityLine(true)).toBe(
            "Your key and 12 words leave this browser, for this web address. The phone app, and other communities' web " +
            'addresses, keep their own copy. Write your 12 words down first if you use them anywhere else.');
        expect(webLastCommunityLine(false)).toBe(
            "Your key leaves this browser, for this web address. The phone app, and other communities' web addresses, " +
            'keep their own copy.');
    });

    it('a delete the node refused says the key is still here', () => {
        expect(webDeleteFailedLine('You have a deal under way.')).toBe(
            'You have a deal under way. Nothing was removed from this browser: your key is still here.');
    });
});
