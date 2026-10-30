// @vitest-environment jsdom
/**
 * People → Invites → "Wants to join" on the phone (components/WantsToJoin.tsx): a refused answer's words outlive the row
 * they are about (PR #2625 review, the web's twin is apps/pwa/src/components/WantsToJoin.test.tsx).
 *
 * After a refusal the list is read again, and the node lists only open requests (engine/knocks.ts: pending, inside 30 days,
 * not a member, key not replaced). So after "answered", "lapsed", "already_member", "key_invalidated" and "not_found" the
 * row is not in the list, and after "admins_only" the list is a 403 (no section). The sentence used to sit under the row,
 * and went with it. It is now one line above the list, with the name, until the next answer.
 *
 * The real utils/knock-inbox.ts reads and answers; the node is a stubbed fetch (GET) and a stubbed signedPost (POST).
 * React Native's host components are plain tags carrying their accessibility props (as showcase-render.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, disabled, accessibilityLabel, accessibilityRole, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (accessibilityRole === 'header') attrs.role = 'heading';
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, children as ReactNode);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        StyleSheet: { create: (s: unknown) => s },
    };
});
// Any colour the styles ask for is a colour: the tree is what's checked here, not the palette.
vi.mock('../../app/ThemeContext', () => {
    const colours: any = new Proxy({}, { get: () => colours });
    return { useTheme: () => ({ colors: colours }), useStyles: (make: (t: { colors: unknown }) => unknown) => make({ colors: colours }) };
});
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../crypto', () => ({ buildSignedHeaders: vi.fn(async () => ({})) }));
const post = vi.hoisted(() => ({ answer: (_path: string): Response => new Response('{}') }));
vi.mock('../node-post', () => ({ signedPost: vi.fn(async (_anchor: string, path: string) => post.answer(path)) }));

import { WantsToJoin } from '../../components/WantsToJoin';
import type { BeanPoolIdentity } from '../identity';

const ANCHOR = 'https://mullum.example.org';
const ME = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana' } as unknown as BeanPoolIdentity;
const TODAY = new Date().toISOString();
const RIVER = { id: 'k1', pubkey: 'b'.repeat(64), callsign: 'River', message: 'I grow tomatoes by the river.', avatar: null, fromNode: 'global.beanpool.org', createdAt: TODAY };
const SKY = { id: 'k2', pubkey: 'c'.repeat(64), callsign: 'Sky', message: 'New in town, I fix bikes.', avatar: null, fromNode: null, createdAt: TODAY };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let root: Root | null = null;
let host: HTMLElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
    vi.unstubAllGlobals();
});

/** The list the node answers on each read, in order; the last one repeats. */
function serveReads(reads: Response[]) {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => reads[Math.min(n++, reads.length - 1)].clone()));
    return () => n;
}

async function settle() {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

async function draw(onCount?: (n: number) => void) {
    root = createRoot(host);
    await act(async () => { root!.render(createElement(WantsToJoin, { anchorUrl: ANCHOR, identity: ME, onCount })); });
    await settle();
}

const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const button = (label: string) => host.querySelector(`[role="button"][aria-label="${label}"]`) as HTMLElement | null;
const heading = () => host.querySelector('[role="heading"]')?.textContent ?? null;
async function tap(label: string) {
    const b = button(label);
    if (!b) throw new Error(`no button "${label}": ${host.innerHTML}`);
    await act(async () => { b.click(); });
    await settle();
}

describe('Wants to join on the phone: a refusal is still said after the list is read again', () => {
    /** Each refusal, and what the node's list then says: the row gone, a 403, or (a standby) the row still listed. */
    const REFUSALS: Array<[string, number, string, string, 'gone' | 'hidden' | 'kept']> = [
        ['another member got there first', 409, 'answered', 'Another member has already answered this request.', 'gone'],
        ['it lapsed', 409, 'lapsed', 'This request is more than 30 days old and has lapsed. They can ask again.', 'gone'],
        ['they joined meanwhile', 409, 'already_member', 'They have already joined this community.', 'gone'],
        ['their key was replaced', 409, 'key_invalidated', 'This request came from a key that has since been replaced by a new one, so there is nothing to answer.', 'gone'],
        ['it is gone', 404, 'not_found', 'There’s no such request to join.', 'gone'],
        ['only admins answer here', 403, 'admins_only', 'Only an admin of this community can answer requests to join here.', 'hidden'],
        ['a standby copy', 503, 'standby', 'This server is a standby copy of the community, not its main server. Requests to join are answered on the main server.', 'kept'],
    ];
    for (const [why, status, code, words, after] of REFUSALS) {
        it(`${why}: the community's words, with the name, after the re-read has drawn`, async () => {
            post.answer = () => json(status, { error: words, code });
            const reads = serveReads([
                json(200, { knocks: [RIVER, SKY], total: 2 }),
                after === 'hidden' ? json(403, { error: words, code }) : json(200, after === 'kept' ? { knocks: [RIVER, SKY], total: 2 } : { knocks: [SKY], total: 1 }),
            ]);
            const onCount = vi.fn();
            await draw(onCount);
            await tap('Invite River');
            expect(reads()).toBe(2);
            expect(onCount).toHaveBeenLastCalledWith(after === 'kept' ? 2 : after === 'hidden' ? 0 : 1);
            const note = byTestId('wants-to-join-note-k1');
            expect(note?.textContent).toBe(`River · ${words}`);
            // One line, above the list: never also under a row.
            expect(host.textContent!.split(words).length).toBe(2);
            expect(host.textContent!.includes('I grow tomatoes by the river.')).toBe(after === 'kept');
            expect(host.textContent!.includes('New in town, I fix bikes.')).toBe(after !== 'hidden');
        });
    }

    it('the last row refused and gone: the section stays to say why', async () => {
        post.answer = () => json(409, { error: 'Another member has already answered this request.', code: 'answered' });
        serveReads([json(200, { knocks: [RIVER], total: 1 }), json(200, { knocks: [], total: 0 })]);
        await draw();
        await tap('Not now, River');
        expect(heading()).toBe('🚪 Wants to join (0)');
        expect(byTestId('wants-to-join-note-k1')?.textContent).toBe('River · Another member has already answered this request.');
    });

    it('the next answer replaces the refusal: one line says what the last answer did', async () => {
        post.answer = path => path.includes('/k1/')
            ? json(200, { knock: { id: 'k1', status: 'approved' }, invite: { code: 'BP-x', expiresAt: null } })
            : json(409, { error: 'They have already joined this community.', code: 'already_member' });
        serveReads([json(200, { knocks: [RIVER, SKY], total: 2 })]);
        await draw();
        await tap('Not now, Sky');
        expect(byTestId('wants-to-join-note-k2')?.textContent).toBe('Sky · They have already joined this community.');
        await tap('Invite River');
        expect(host.textContent).toContain('You invited River. Their app will find the invite by itself.');
        expect(byTestId('wants-to-join-note-k2')).toBeNull();
    });

    it('an answer that couldn\'t reach the community says so in the app\'s words, and the row stays', async () => {
        post.answer = () => { throw new TypeError('Network request failed'); };
        serveReads([json(200, { knocks: [RIVER], total: 1 })]);
        await draw();
        await tap('Not now, River');
        expect(byTestId('wants-to-join-note-k1')?.textContent).toBe("River · Couldn't reach your community. Check your connection and try again.");
        expect(host.textContent).toContain('I grow tomatoes by the river.');
    });
});
