/**
 * ProfileSetup's name goes to the node as a register (/api/community/register), which numbers a name another member holds
 * ("Sam" becomes "Sam2", engine/members.ts registerMemberInternal) and answers with the member's row. This browser keeps
 * the name the node answers for this key, so it says what everyone else sees (#1231's confirmation, 4113964261).
 *
 * The stored identity is real (an in-memory IndexedDB); the node's routes are mocked at lib/api.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ProfileSetup } from './ProfileSetup';
import * as api from '../lib/api';
import { generateIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

vi.mock('./OnboardingGuide', () => ({ OnboardingGuide: () => null }));
vi.mock('../lib/api', () => ({
    updateMemberProfile: vi.fn(async () => ({ success: true, profile: {} })),
    // A photo is there already, so the steps are the name, then on.
    getMemberProfile: vi.fn(async () => ({ avatar: 'data:image/jpeg;base64,AAAA', bio: '', contact: null })),
    registerMember: vi.fn(),
}));

let saved: BeanPoolIdentity;

beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    saved = await generateIdentity('Rowan');
    await importIdentity(saved);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

/** The name `name`, then Next, Next and Done. */
async function setName(name: string, onIdentityUpdated: (i: BeanPoolIdentity) => void) {
    render(<ProfileSetup identity={saved} onDone={vi.fn()} onIdentityUpdated={onIdentityUpdated} />);
    const field = await screen.findByLabelText('Your name');
    fireEvent.change(field, { target: { value: name } });
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next →' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Done ✓' }));
}

describe("ProfileSetup's name is the one the node keeps", () => {
    it('the register numbers a name another member has (Sam → Sam2): this browser keeps Sam2, and the app is handed it', async () => {
        vi.mocked(api.registerMember).mockImplementation(async (publicKey) => ({ success: true, member: { publicKey, callsign: 'Sam2' } as any }));
        const onIdentityUpdated = vi.fn();
        await setName('Sam', onIdentityUpdated);

        await waitFor(() => expect(onIdentityUpdated).toHaveBeenCalledTimes(1));
        expect(api.registerMember).toHaveBeenCalledWith(saved.publicKey, 'Sam');
        expect(onIdentityUpdated.mock.calls[0][0]).toEqual({ ...saved, callsign: 'Sam2' });
        expect(await loadIdentity()).toEqual({ ...saved, callsign: 'Sam2' });
    });

    it('an answer about another key changes nothing: this browser keeps the name it sent', async () => {
        vi.mocked(api.registerMember).mockResolvedValue({ success: true, member: { publicKey: 'a-neighbour', callsign: 'Sam' } as any });
        const onIdentityUpdated = vi.fn();
        await setName('Sam', onIdentityUpdated);

        await waitFor(() => expect(onIdentityUpdated).toHaveBeenCalledTimes(1));
        expect(onIdentityUpdated.mock.calls[0][0]).toEqual({ ...saved, callsign: 'Sam' });
        expect(await loadIdentity()).toEqual({ ...saved, callsign: 'Sam' });
    });
});
