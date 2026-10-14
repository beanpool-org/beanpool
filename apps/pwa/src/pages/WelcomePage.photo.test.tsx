/**
 * Sign-up's photo step is never a gate (rehearsal 14 Oct S9; memory onboarding-no-hard-gates). Next was disabled until
 * a picture or an avatar was picked, with no Skip. Now Next works with none, and the step says what the node asks for:
 * where Beans are off (the worldwide community) a picture is optional; where Beans are on the node asks for one before
 * a first post (core postRulesFor, server engine/posts.ts assertProfileComplete), and sign-up still finishes.
 *
 * The node is a stubbed fetch, entered through the open door as WelcomePage.howItWorks.test.tsx does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { photoStepNote } from '@beanpool/core';
import { WelcomePage } from './WelcomePage';
import { generateIdentity, savePendingJoin, PENDING_JOIN_TTL_MS, type BeanPoolIdentity } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const calls: string[] = [];
function stubNode(info: unknown) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        calls.push(path);
        if (path === '/api/community/info') return json(200, info);
        if (path.startsWith('/api/join')) return json(200, { success: true, member: { callsign: 'Alice' } });
        return json(200, {});
    }));
}

const GLOBAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true, beans: false } };
const BEANS_ON = { ...GLOBAL, features: { openJoin: true } };

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let identity: BeanPoolIdentity;

beforeEach(async () => {
    calls.length = 0;
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
    identity = await generateIdentity('Alice');
    Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: vi.fn() }, configurable: true });
    Object.defineProperty(navigator, 'storage', { value: { persist: vi.fn(async () => true), persisted: vi.fn(async () => false) }, configurable: true });
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetCapturedAuthReturn();
    localStorage.clear();
});

/** Through the door with Google, to the photo step. */
async function toPhotoStep(info: unknown) {
    await savePendingJoin({ identity, provider: 'google', nonce: 'n1', startedAt: Date.now(), expiresAt: Date.now() + PENDING_JOIN_TTL_MS, restored: false });
    const token = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub: 'g1', nonce: 'n1' }))}.c2ln`;
    window.history.replaceState(null, '', `/app/auth/google#state=n1&id_token=${token}`);
    stubNode(info);
    render(<WelcomePage onComplete={vi.fn()} />);
    await screen.findByText(/Choose your look/);
}

describe('the photo step with no picture picked', () => {
    it('lets a stranger on with Next where Beans are off, and says a picture is optional', async () => {
        await toPhotoStep(GLOBAL);
        expect(screen.getByTestId('photo-step-note')).toHaveTextContent(photoStepNote(false));
        expect(photoStepNote(false)).toMatch(/optional/);
        const next = screen.getByRole('button', { name: 'Next →' });
        expect(next).not.toBeDisabled();
        fireEvent.click(next);
        expect(await screen.findByText(/Your Safety Backup/)).toBeInTheDocument();
        // No picture was sent for them.
        expect(calls.filter(c => c.includes('/api/profile'))).toEqual([]);
    });

    it('says plainly where Beans are on that a picture is asked for before posting, and still finishes sign-up', async () => {
        await toPhotoStep(BEANS_ON);
        expect(screen.getByTestId('photo-step-note')).toHaveTextContent(photoStepNote(true));
        expect(photoStepNote(true)).toMatch(/before you post/);
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        expect(await screen.findByText(/Your Safety Backup/)).toBeInTheDocument();
    });

    it('drops the note once an avatar is picked', async () => {
        await toPhotoStep(GLOBAL);
        fireEvent.click(screen.getByTitle('Green Bean'));
        expect(screen.queryByTestId('photo-step-note')).toBeNull();
    });
});
