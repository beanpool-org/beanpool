/**
 * The first token at a community asks whether the account belongs there (utils/push-registrations.ts `belongsThere`).
 *
 * The token goes to every community the phone keeps, and every community it goes to keeps it and can put a line on the
 * lock screen. The guest mark alone can't say who belongs: four doors leave a community the member never joined on the
 * list with no mark, and each sent the token there at the next start or return (#2701, deciding review 4434518836):
 *
 *   - a restore from a copy with the list: a guest row goes into the copy, and its mark doesn't;
 *   - the look, then a restore: the restore clears the marks and leaves the saved row;
 *   - a failed invite: the phone opens the community to redeem, which saves it, and the row stays when the redeem fails;
 *   - Add & Connect with no answer to its probe: it saves first, and writes a mark only on a good probe.
 *
 * So before the first token at a community that isn't the one the phone is set to and isn't on the record, the community
 * is asked with the membership probe, and the token goes on only when it answers that the key is a member. No answer
 * leaves it for a later chance. The other way a community gets on the due list (no token to be had yet) asks the same.
 *
 * Real modules throughout: the doors, the phone's storage code, the registrations and the probe. Nothing contacts a node:
 * fetch is a fake community per address (fake-communities.ts), which answers the probe only to a request signed by the
 * key it asks about, as the server does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('../db', () => ({ clearDB: vi.fn(async () => {}), closeDB: vi.fn(async () => {}) }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));
vi.mock('../../services/pillar-sync', () => ({ resetSyncFingerprints: vi.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { forgetCommunityPush, signOutOfThisPhone } from '../account-leaves-phone';
import { communitiesOnPhoneForCopy, saveCommunitiesFromCopy } from '../copy-communities';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { joinAnotherCommunity, type JoinDeps } from '../join-another-community';
import { fetchMembership } from '../membership-probe';
import { addSavedNode, clearGuestNode, isGuestNode, markGuestNode, removeSavedNode } from '../nodes';
import {
    registerAccountForPush, registerWhereMissing, retryDueRegistrations, RETRY_FIRST_WAIT_MS, RETRY_LONGEST_WAIT_MS,
} from '../push-registrations';
import { saveRestoredAccount } from '../restore-account';
import { Communities, PHONE_TOKEN, type Sent } from './fake-communities';
import { PUSH_REGISTERED_AT_STORE_KEY, PUSH_REGISTRATIONS_DUE_STORE_KEY, PUSH_TOKEN_STORE_KEY } from '../storage-keys';

const MULLUM = 'https://mullum.beanpool.org';
const BYRON = 'https://byron.beanpool.org';
const CASTLEMAINE = 'https://castlemaine.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';

async function phoneToken(): Promise<string> {
    mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
    return PHONE_TOKEN;
}

let kim: BeanPoolIdentity;
let nodes: Communities;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    kim = await draftIdentity('Kim');
    nodes = new Communities();
    nodes.join(kim.publicKey, MULLUM);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** The app comes back, or the 5-minute sync runs (app/_layout.tsx `retryPushRegistrations`). */
const aReturn = () => registerWhereMissing(phoneToken, 'android');
/** The app starts with the account on it (app/_layout.tsx, services/push-notifications.ts `registerForPushNotifications`). */
const aStart = () => registerAccountForPush(kim.publicKey, phoneToken, 'android').then(() => {});
const ASKS: Array<[string, () => Promise<void>]> = [['at a return (registerWhereMissing)', aReturn], ['at a start (registerAccountForPush)', aStart]];

const at = (community: string, sent: Sent[] = nodes.sent) => sent.filter((s) => s.community === community);
const tokens = (community: string, from = 0) => at(community, nodes.sent.slice(from)).filter((s) => s.method === 'POST' && s.path === '/api/push-tokens');
const probes = (community: string, from = 0) => at(community, nodes.sent.slice(from)).filter((s) => s.path.startsWith('/api/community/membership/'));
const recorded = () => JSON.parse(mem.async.get(PUSH_REGISTERED_AT_STORE_KEY) ?? '[]') as string[];
const due = () => JSON.parse(mem.async.get(PUSH_REGISTRATIONS_DUE_STORE_KEY) ?? '[]') as Array<Record<string, unknown>>;

/** Kim on a phone set to Mullum. */
async function kimOnMullum(): Promise<void> {
    await importIdentity(kim);
    await addSavedNode(MULLUM);
    mem.async.set(ANCHOR, MULLUM);
}

const joinDeps = (redeemInvite: JoinDeps['redeemInvite']): JoinDeps => ({
    closeDB: async () => {},
    // db.ts getDb saves the address it opens (`initDB` opens it).
    initDB: async () => { await addSavedNode(mem.async.get(ANCHOR)!); },
    redeemInvite,
    addSavedNode,
    clearGuestNode,
    requestSync: async () => {},
});

const DOORS: Array<[string, () => Promise<void>]> = [
    ['a restore from a copy with the list', async () => {
        await kimOnMullum();
        await addSavedNode(BYRON);
        await markGuestNode(BYRON);
        const list = await communitiesOnPhoneForCopy();
        expect(list.map((c) => c.url)).toEqual([MULLUM, BYRON]);

        // A new phone, restored from that copy: the row comes across and the mark doesn't.
        mem.async.clear();
        mem.secure.clear();
        await saveRestoredAccount({ identity: kim, replacesAnother: false }, MULLUM);
        expect(await saveCommunitiesFromCopy(list, async () => {})).toBeGreaterThan(0);
    }],
    ['the look, then a restore', async () => {
        await addSavedNode(BYRON);
        mem.async.set(ANCHOR, BYRON);
        await markGuestNode(BYRON);
        await saveRestoredAccount({ identity: kim, replacesAnother: false }, MULLUM);
        await addSavedNode(MULLUM);
    }],
    ['a failed invite', async () => {
        await kimOnMullum();
        await expect(joinAnotherCommunity(
            { targetUrl: BYRON, code: 'SPENT', identity: kim, returnUrl: MULLUM },
            joinDeps(async () => { throw new Error('That invite has been used'); }),
        )).rejects.toThrow('That invite has been used');
        expect(mem.async.get(ANCHOR)).toBe(MULLUM);
    }],
    ['Add & Connect with no answer to its probe', async () => {
        await kimOnMullum();
        // app/(tabs)/settings.tsx: the phone is set there and it is saved, and only a good probe writes the mark.
        mem.async.set(ANCHOR, BYRON);
        await addSavedNode(BYRON);
        nodes.answer = () => 'down';
        await expect(fetchMembership(BYRON, kim)).rejects.toThrow();
        // Then she goes back to Mullum, and Byron is back up.
        nodes.answer = () => 'up';
        nodes.sent.length = 0;
        mem.async.set(ANCHOR, MULLUM);
    }],
];

describe.each(DOORS)('%s leaves a community she never joined on the list, unmarked', (_door, door) => {
    it.each(ASKS)('%s it is asked, says no, and gets no token', async (_how, ask) => {
        await door();
        expect(await isGuestNode(BYRON)).toBe(false);

        await ask();

        expect(tokens(BYRON).map((s) => s.community)).toEqual([]);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(recorded()).not.toContain(BYRON);
        expect(probes(BYRON)).toHaveLength(1);
        // Her own community is not held up, and is not asked.
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
        expect(probes(MULLUM)).toEqual([]);
    });
});

describe('a community that answers', () => {
    it.each(ASKS)('%s one she belongs to gets the token, once, and is not asked again', async (_how, ask) => {
        await kimOnMullum();
        await addSavedNode(BYRON);
        nodes.join(kim.publicKey, BYRON);

        await ask();
        expect(probes(BYRON)).toHaveLength(1);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);
        expect(recorded()).toContain(BYRON);

        const from = nodes.sent.length;
        await ask();
        expect(probes(BYRON, from)).toEqual([]);
    });

    it('the probe is signed by her key for that community, and carries no token', async () => {
        await kimOnMullum();
        await addSavedNode(BYRON);
        await aReturn();
        const [probe] = probes(BYRON);
        expect(probe.method).toBe('GET');
        expect(probe.headers['X-Public-Key']).toBe(kim.publicKey);
        expect(JSON.stringify(probe)).not.toContain(PHONE_TOKEN);
    });

    it('the community the phone is set to is not asked, as ever: a knock\'s answer reaches the phone that way', async () => {
        await kimOnMullum();
        mem.async.set(ANCHOR, BYRON);
        await addSavedNode(BYRON);
        await markGuestNode(BYRON);
        await aStart();
        expect(probes(BYRON)).toEqual([]);
        expect(tokens(BYRON)).toHaveLength(1);
    });

    it('a community already on the record is not asked: it holds the token already', async () => {
        await kimOnMullum();
        mem.async.set(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify([MULLUM, BYRON]));
        await addSavedNode(BYRON);
        await aStart();
        expect(probes(BYRON)).toEqual([]);
        expect(tokens(BYRON)).toHaveLength(1);
    });
});

describe('no answer waits for the next chance', () => {
    it.each([
        ['that drops the connection', 'down' as const],
        ['that answers 500', 500],
        ['behind a captive portal', 'portal' as const],
    ])('a community %s gets no token, and she is registered once it answers', async (_how, answer) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await kimOnMullum();
        await addSavedNode(BYRON);
        nodes.join(kim.publicKey, BYRON);
        nodes.answer = (s) => (s.community === BYRON ? answer : 'up');

        await aReturn();
        expect(probes(BYRON)).toHaveLength(1);
        expect(tokens(BYRON)).toEqual([]);
        expect(recorded()).not.toContain(BYRON);
        expect(due()).toMatchObject([{ community: BYRON }]);

        nodes.answer = () => 'up';
        vi.setSystemTime(Date.now() + RETRY_FIRST_WAIT_MS);
        await aReturn();
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);
        expect(due()).toEqual([]);
    });

    it('one that never answers gets no token, and holds up no other', async () => {
        await kimOnMullum();
        await addSavedNode(BYRON);
        await addSavedNode(CASTLEMAINE);
        nodes.join(kim.publicKey, CASTLEMAINE);
        nodes.answer = (s) => (s.community === BYRON ? 'silent' : 'up');

        await registerWhereMissing(phoneToken, 'android', AsyncStorage, loadIdentity, 50);

        expect(tokens(BYRON)).toEqual([]);
        expect(nodes.has(MULLUM, kim.publicKey) && nodes.has(CASTLEMAINE, kim.publicKey)).toBe(true);
    });

    it('a member\'s row with a token not to be had yet is asked too: a due list is no answer', async () => {
        await kimOnMullum();
        await addSavedNode(BYRON);
        await registerAccountForPush(kim.publicKey, async () => { throw new TypeError('Network request failed'); }, 'android');
        expect(due().map((d) => d.community).sort()).toEqual([BYRON, MULLUM]);

        await retryDueRegistrations(phoneToken, 'android');

        expect(probes(BYRON)).toHaveLength(1);
        expect(tokens(BYRON)).toEqual([]);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
    });
});

describe('a community that says no is left alone', () => {
    it('it is not asked at every return: the wait doubles, as it does for a refusal, up to an hour', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const t0 = Date.now();
        await kimOnMullum();
        await addSavedNode(BYRON);
        await aReturn();
        expect(probes(BYRON)).toHaveLength(1);

        for (let s = 1; s < 60; s += 5) {
            vi.setSystemTime(t0 + s * 1000);
            await aReturn();
            await aStart();
        }
        expect(probes(BYRON)).toHaveLength(1);

        vi.setSystemTime(t0 + RETRY_FIRST_WAIT_MS);
        await aReturn();
        expect(probes(BYRON)).toHaveLength(2);
        expect(due()).toMatchObject([{ community: BYRON, refusals: 2, retryAt: t0 + 3 * RETRY_FIRST_WAIT_MS }]);
        expect(RETRY_LONGEST_WAIT_MS).toBeGreaterThan(RETRY_FIRST_WAIT_MS);
    });

    it('joining it later lands at once: the wait was for a question, and the one she joined needs none', async () => {
        await kimOnMullum();
        await addSavedNode(BYRON);
        await aReturn();
        expect(due()).toMatchObject([{ community: BYRON, refusals: 1 }]);

        let registered: Promise<unknown> = Promise.resolve();
        await joinAnotherCommunity(
            { targetUrl: BYRON, code: 'GOOD', identity: kim, returnUrl: MULLUM },
            {
                ...joinDeps(async () => {
                    nodes.join(kim.publicKey, BYRON);
                    return { success: true, alreadyMember: false, nodeHasPhoto: false };
                }),
                registerPush: () => { registered = aReturn(); return registered; },
            },
        );
        await registered;

        expect(tokens(BYRON)).toHaveLength(1);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);
        expect(due()).toEqual([]);
    });

    it('a community the phone lets go is dropped from what is due, and asked no more', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await kimOnMullum();
        await addSavedNode(BYRON);
        await aReturn();
        const asked = probes(BYRON).length;

        await forgetCommunityPush(kim, BYRON, () => removeSavedNode(BYRON));
        vi.setSystemTime(Date.now() + 2 * RETRY_LONGEST_WAIT_MS);
        await aReturn();

        expect(probes(BYRON)).toHaveLength(asked);
        expect(due()).toEqual([]);
    });
});

describe('while the question is out', () => {
    /** Kim, a member at Byron, and the question to Byron out and unanswered. */
    const askingByron = async (): Promise<{ asking: Promise<void> }> => {
        await kimOnMullum();
        await addSavedNode(BYRON);
        nodes.join(kim.publicKey, BYRON);
        nodes.answer = (s) => (s.path.startsWith('/api/community/membership/') ? 'hold' : 'up');
        const asking = aReturn();
        await vi.waitFor(() => expect(nodes.held).toHaveLength(1));
        return { asking };
    };

    it('a community forgotten meanwhile gets no token, though it answers yes: it would keep it, and nothing would tell it', async () => {
        const { asking } = await askingByron();
        await forgetCommunityPush(kim, BYRON, () => removeSavedNode(BYRON));
        nodes.releaseHeld();
        await asking;
        expect(tokens(BYRON)).toEqual([]);
        expect(recorded()).not.toContain(BYRON);
    });

    it('a Sign Out meanwhile sends no token: the key is leaving', async () => {
        const { asking } = await askingByron();
        await signOutOfThisPhone(kim);
        nodes.releaseHeld();
        await asking;
        expect(tokens(BYRON)).toEqual([]);
    });
});
