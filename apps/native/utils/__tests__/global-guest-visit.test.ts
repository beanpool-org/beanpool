/**
 * Guest view first (utils/global-guest-visit.ts; Marty, board 21 Oct 2026): what a visit to the global community asks, in
 * what order it writes, and that it moves the phone only for an answer that lets it look. Every dependency is injected and
 * recorded, so each case shows every call it made: nothing here signs, sends or stores anything for real.
 *
 * The sheet's render test (beanpool-global-row-render.test.ts) runs the same function with its real dependencies (the door
 * check, the probe, the guest mark and the saved list) behind a mocked switch.
 */
import { describe, expect, it } from 'vitest';
import { visitGlobalAsGuest, type GuestVisitDeps } from '../global-guest-visit';
import type { AskedStanding } from '../global-entry';
import type { GlobalDoorCheck, NodeProfile } from '../node-profile';

const GLOBAL = 'https://global.beanpool.org';
const ME = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64) };
const OPEN: GlobalDoorCheck = { ok: true, profile: { profile: 'global', features: { openJoin: true } } as unknown as NodeProfile };

function deps(door: GlobalDoorCheck | Error, standing: AskedStanding | Error, switchFails = false) {
    const calls: string[] = [];
    const asked: { publicKey: string; privateKey: string }[] = [];
    const d: GuestVisitDeps = {
        checkDoor: async (url) => { calls.push(`door ${url}`); if (door instanceof Error) throw door; return door; },
        askStanding: async (identity, url) => { calls.push(`ask ${url}`); asked.push(identity); if (standing instanceof Error) throw standing; return standing; },
        markGuestNode: async (url) => { calls.push(`mark ${url}`); },
        clearGuestNode: async (url) => { calls.push(`clear ${url}`); },
        addSavedNode: async (url, alias) => { calls.push(`save ${url} ${alias}`); },
        switchTo: async (url) => { calls.push(`switch ${url}`); if (switchFails) throw new Error('disk full'); },
    };
    return { d, calls, asked };
}
const stranger: AskedStanding = { standing: 'stranger', closed: false, answered: true };
const member: AskedStanding = { standing: 'member', closed: false, answered: true };

describe('visitGlobalAsGuest', () => {
    it('a stranger: the guest mark first, then the saved list, then the switch; a guest', async () => {
        const { d, calls, asked } = deps(OPEN, stranger);
        expect(await visitGlobalAsGuest(ME, GLOBAL, d)).toEqual({ kind: 'guest' });
        expect(calls).toEqual([`door ${GLOBAL}`, `ask ${GLOBAL}`, `mark ${GLOBAL}`, `save ${GLOBAL} Global community`, `switch ${GLOBAL}`]);
        // The key the phone holds, as it holds it: never another, never a new one.
        expect(asked).toEqual([ME]);
    });

    it('a member: no guest mark (any it had goes), saved, switched; a member', async () => {
        const { d, calls } = deps(OPEN, member);
        expect(await visitGlobalAsGuest(ME, GLOBAL, d)).toEqual({ kind: 'member' });
        expect(calls).toEqual([`door ${GLOBAL}`, `ask ${GLOBAL}`, `clear ${GLOBAL}`, `save ${GLOBAL} Global community`, `switch ${GLOBAL}`]);
        expect(calls.some((c) => c.startsWith('mark'))).toBe(false);
    });

    for (const reason of ['unreachable', 'not_global', 'door_closed', 'private_preview'] as const) {
        it(`the door ${reason}: nothing asked about the key, nothing written, nothing moved; the door's page`, async () => {
            const { d, calls } = deps({ ok: false, reason }, stranger);
            expect(await visitGlobalAsGuest(ME, GLOBAL, d)).toEqual({ kind: 'door' });
            expect(calls).toEqual([`door ${GLOBAL}`]);
        });
    }

    it('the door check throws: read as no answer, nothing moved', async () => {
        const { d, calls } = deps(new TypeError('Network request failed'), stranger);
        expect(await visitGlobalAsGuest(ME, GLOBAL, d)).toEqual({ kind: 'door' });
        expect(calls).toEqual([`door ${GLOBAL}`]);
    });

    it('no answer about the key (kept or not): nothing written, nothing moved; the door asks again', async () => {
        for (const standing of [
            { standing: 'unknown', closed: false, answered: false },
            // A kept answer from earlier is not this time's: the phone moves only on a fresh one.
            { standing: 'stranger', closed: false, answered: false },
            { standing: 'member', closed: false, answered: false },
            new Error('boom'),
        ] as (AskedStanding | Error)[]) {
            const { d, calls } = deps(OPEN, standing);
            expect(await visitGlobalAsGuest(ME, GLOBAL, d)).toEqual({ kind: 'door' });
            expect(calls).toEqual([`door ${GLOBAL}`, `ask ${GLOBAL}`]);
        }
    });

    it('its account there closed: nothing written, nothing moved', async () => {
        const { d, calls } = deps(OPEN, { standing: 'unknown', closed: true, answered: true });
        expect(await visitGlobalAsGuest(ME, GLOBAL, d)).toEqual({ kind: 'closed' });
        expect(calls).toEqual([`door ${GLOBAL}`, `ask ${GLOBAL}`]);
    });

    it('the switch fails: it throws, as any switch, after the mark and the list (a guest mark for a community the phone isn\'t on does nothing)', async () => {
        const { d, calls } = deps(OPEN, stranger, true);
        await expect(visitGlobalAsGuest(ME, GLOBAL, d)).rejects.toThrow('disk full');
        expect(calls.at(-1)).toBe(`switch ${GLOBAL}`);
    });

    it('asks and moves at the address it is given (the phone\'s saved spelling of the global community)', async () => {
        const saved = 'https://global.beanpool.org:443';
        const { d, calls } = deps(OPEN, stranger);
        await visitGlobalAsGuest(ME, saved, d);
        expect(calls.every((c) => c.includes(saved))).toBe(true);
    });
});
