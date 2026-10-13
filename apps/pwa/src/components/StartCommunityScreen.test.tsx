/**
 * Start a community on the web (components/StartCommunityScreen.tsx, lib/start-community.ts; design §3): the phone's
 * words, the four things to know before the link, the node's own start link and the setup chapter, and the details
 * copied to this device only. The node is asked for its info and nothing else.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { START_COMMUNITY_URL_DEFAULT } from '@beanpool/core';
import { StartCommunityScreen } from './StartCommunityScreen';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';
import { START_COMMUNITY_COPY, START_COMMUNITY_KNOW, SETUP_CHAPTER_URL, communityDetailsText, canCopyDetails } from '../lib/start-community';

/** The phone's file, loaded at run time (it lives outside this app's TypeScript project). */
type Phone = {
    START_COMMUNITY_COPY: unknown;
    communityDetailsText: (d: { name: string; place: string; contact: string; organiser?: string | null }) => string;
    canCopyDetails: (d: { name: string; place: string; contact: string }) => boolean;
};
const PHONE_FILE = '../../../native/utils/start-community';

let calls: { path: string; method: string }[] = [];
let info: Record<string, unknown>;

beforeEach(() => {
    calls = [];
    info = { profile: 'global', features: { beans: false, showcase: true }, startCommunityUrl: 'https://example.org/start' };
    resetCommunityInfoOnce();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push({ path: new URL(url, 'http://x').pathname, method: (init?.method ?? 'GET').toUpperCase() });
        return new Response(JSON.stringify(info), { status: 200 });
    }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Start a community (web)', () => {
    it('says what the phone says, word for word, and the details copy as the phone copies them', async () => {
        const phone = await import(/* @vite-ignore */ PHONE_FILE) as Phone;
        expect(START_COMMUNITY_COPY).toEqual(phone.START_COMMUNITY_COPY);
        const d = { name: '  Riverbend ', place: 'Lower  Valley', contact: '', organiser: 'Ana' };
        expect(communityDetailsText(d)).toBe(phone.communityDetailsText(d));
        expect(canCopyDetails({ name: 'R', place: '', contact: '' })).toBe(phone.canCopyDetails({ name: 'R', place: '', contact: '' }));
    });

    it('the four things to know before the link, then the node\'s own start link and the setup chapter', async () => {
        const onClose = vi.fn();
        render(<StartCommunityScreen onClose={onClose} />);
        const know = screen.getByTestId('start-community-know');
        for (const l of START_COMMUNITY_KNOW.lines) expect(know).toHaveTextContent(l.body);
        expect(know).toHaveTextContent('beanpool claim');
        await waitFor(() => expect(screen.getByTestId('start-community-run-a-node')).toHaveAttribute('href', 'https://example.org/start'));
        expect(screen.getByTestId('start-community-setup')).toHaveAttribute('href', SETUP_CHAPTER_URL);
        for (const id of ['start-community-run-a-node', 'start-community-setup']) {
            expect(screen.getByTestId(id)).toHaveAttribute('target', '_blank');
            expect(screen.getByTestId(id)).toHaveAttribute('rel', 'noopener noreferrer');
        }
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(onClose).toHaveBeenCalled();
        expect(calls).toEqual([{ path: '/api/community/info', method: 'GET' }]);
    });

    it('a node that names no start link: beanpool.org\'s', async () => {
        info = { profile: 'global', features: { beans: false, showcase: true } };
        render(<StartCommunityScreen onClose={() => {}} />);
        await waitFor(() => expect(screen.getByTestId('start-community-run-a-node')).toHaveAttribute('href', START_COMMUNITY_URL_DEFAULT));
    });

    it('Copy puts the details on this device\'s clipboard and sends nothing to the node', async () => {
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        render(<StartCommunityScreen onClose={() => {}} />);
        const copy = screen.getByTestId('start-community-copy');
        expect(copy).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Community name'), { target: { value: 'Riverbend' } });
        fireEvent.change(screen.getByLabelText('Place'), { target: { value: 'Lower Valley' } });
        fireEvent.click(copy);
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(START_COMMUNITY_COPY.copied));
        expect(writeText).toHaveBeenCalledWith('Community name: Riverbend\nPlace: Lower Valley');
        expect(calls.every((c) => c.method === 'GET' && c.path === '/api/community/info')).toBe(true);
    });
});
