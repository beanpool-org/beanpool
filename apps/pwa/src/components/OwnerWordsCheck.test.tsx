import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '@beanpool/core';
import { OwnerWordsCheck } from './OwnerWordsCheck';
import { OwnerWordsPrompt } from './OwnerWordsPrompt';
import { request } from '../lib/api';
import { forgetOwnerWordsStatus, laterKey } from '../lib/owner-words';

vi.mock('../lib/api', () => ({ request: vi.fn(), getNodeApiUrl: vi.fn(() => '') }));

const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
/** This browser's own format: 48-byte PKCS8. */
const PWA_ID = { publicKey: PUB, privateKey: bytesToHex(toEd25519Pkcs8(SEED)) };
/** An identity carried over from the phone: the raw 32-byte seed. */
const FROM_NATIVE = { publicKey: PUB, privateKey: bytesToHex(SEED) };
const WC = '/api/node/owner/words-check';

type Call = [string, string, unknown?];
function nodeSays(status: { owner: boolean; wordsCheckedAt: number | null } | 'not-owner' | 'offline', recordAt: number | null = 1_790_000_000_000) {
    vi.mocked(request).mockImplementation((async (method: string, path: string) => {
        if (path !== WC) throw new Error(`unexpected ${method} ${path}`);
        if (method === 'GET') {
            if (status === 'not-owner') throw new Error("Only this community's owners are asked to check their 12 words.");
            if (status === 'offline') throw new Error('Failed to fetch');
            return status;
        }
        if (recordAt === null) throw new Error('Request failed: 503');
        return { success: true, wordsCheckedAt: recordAt };
    }) as typeof request);
}

/** The floor the design holds to: 320px wide, 1.3× text. jsdom does no layout, so the layout contract is the classes. */
function renderAt320(ui: React.ReactElement) {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
    document.documentElement.style.fontSize = '130%';
    return render(<div style={{ width: 320 }}>{ui}</div>);
}

async function openAndType(identity: { publicKey: string; privateKey: string }, text: string) {
    renderAt320(<OwnerWordsCheck identity={identity} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    const box = screen.getByLabelText(/Your 12 words, in order/i) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: text } });
    return box;
}

describe('OwnerWordsCheck (Settings)', () => {
    beforeEach(() => { vi.mocked(request).mockReset(); forgetOwnerWordsStatus(); localStorage.clear(); });
    afterEach(() => { document.documentElement.style.fontSize = ''; vi.restoreAllMocks(); });

    it('shows nothing to someone who is not an owner, or when the node does not answer', async () => {
        nodeSays('not-owner');
        const a = renderAt320(<OwnerWordsCheck identity={PWA_ID} />);
        await waitFor(() => expect(request).toHaveBeenCalledWith('GET', WC));
        expect(a.container.textContent).toBe('');
        a.unmount();
        nodeSays('offline');
        const b = renderAt320(<OwnerWordsCheck identity={PWA_ID} />);
        await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        expect(b.container.textContent).toBe('');
    });

    it('an owner sees "not checked" or the date', async () => {
        nodeSays({ owner: true, wordsCheckedAt: null });
        const a = renderAt320(<OwnerWordsCheck identity={PWA_ID} />);
        expect(await screen.findByText(/Your 12 words aren't checked/)).toBeTruthy();
        a.unmount();
        nodeSays({ owner: true, wordsCheckedAt: Date.UTC(2026, 9, 3) });
        renderAt320(<OwnerWordsCheck identity={PWA_ID} />);
        expect(await screen.findByText(/^12 words checked /)).toBeTruthy();
    });

    it.each([['this browser (PKCS8)', PWA_ID], ['carried over from the phone (raw seed)', FROM_NATIVE]])(
        'the right words for an account from %s: "These are the right words", the box is emptied, one signed statement is sent',
        async (_label, identity) => {
            nodeSays({ owner: true, wordsCheckedAt: null });
            const box = await openAndType(identity, `  ${WORDS.join('  ').toUpperCase()} `);
            fireEvent.click(screen.getByRole('button', { name: 'Check my words' }));
            expect(await screen.findByText(/These are the right words\. Your community can see you checked them today\./)).toBeTruthy();
            expect(box.value).toBe('');
            const posts = (vi.mocked(request).mock.calls as Call[]).filter(([m]) => m === 'POST');
            expect(posts).toEqual([['POST', WC, { attestation: 'owner-12-words-checked' }]]);
            expect(await screen.findByText(/^12 words checked /)).toBeTruthy();
        },
    );

    it('the wrong words: "These aren\'t the words for this account", no hint which word, box emptied, nothing sent', async () => {
        nodeSays({ owner: true, wordsCheckedAt: null });
        const wrong = [...WORDS];
        wrong[5] = 'zoo';
        const box = await openAndType(PWA_ID, wrong.join(' '));
        fireEvent.click(screen.getByRole('button', { name: 'Check my words' }));
        const msg = await screen.findByRole('status');
        expect(msg.textContent).toBe("These aren't the words for this account.");
        expect(msg.textContent).not.toMatch(/zoo|word 6|sixth/i);
        expect(box.value).toBe('');
        expect((vi.mocked(request).mock.calls as Call[]).some(([m]) => m === 'POST')).toBe(false);
    });

    it('fewer than 12 words: says how many, keeps what was typed, checks nothing', async () => {
        nodeSays({ owner: true, wordsCheckedAt: null });
        const box = await openAndType(PWA_ID, WORDS.slice(0, 7).join(' '));
        expect(screen.getByText(/^7 of 12 words/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Check my words' }));
        expect((await screen.findByRole('status')).textContent).toBe("That's 7 words. Type all 12, in order.");
        expect(box.value).toBe(WORDS.slice(0, 7).join(' '));
    });

    it('a server that cannot be reached still says the words are right, and says it could not record it', async () => {
        nodeSays({ owner: true, wordsCheckedAt: null }, null);
        await openAndType(PWA_ID, WORDS.join(' '));
        fireEvent.click(screen.getByRole('button', { name: 'Check my words' }));
        expect(await screen.findByText(/These are the right words\. We couldn't tell/)).toBeTruthy();
    });

    it('the words are never stored anywhere, never sent, and gone from the page after the check', async () => {
        nodeSays({ owner: true, wordsCheckedAt: null });
        const lsSet = vi.spyOn(localStorage, 'setItem');
        const ssSet = vi.spyOn(Storage.prototype, 'setItem');
        const idbOpen = vi.fn();
        vi.stubGlobal('indexedDB', { open: idbOpen });
        await openAndType(PWA_ID, WORDS.join(' '));
        fireEvent.click(screen.getByRole('button', { name: 'Check my words' }));
        await screen.findByText(/Your community can see/);
        for (const call of [...lsSet.mock.calls, ...ssSet.mock.calls]) {
            for (const w of WORDS) expect(JSON.stringify(call)).not.toContain(w);
        }
        expect(idbOpen).not.toHaveBeenCalled();
        const sent = JSON.stringify(vi.mocked(request).mock.calls);
        for (const w of WORDS) expect(sent).not.toContain(w);
        expect(sent).not.toContain(bytesToHex(SEED));
        expect(document.body.innerHTML).not.toContain('abandon');
        vi.unstubAllGlobals();
    });

    it('hiding the tab empties the box', async () => {
        nodeSays({ owner: true, wordsCheckedAt: null });
        const box = await openAndType(PWA_ID, WORDS.join(' '));
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(box.value).toBe('');
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });

    it('closing empties the box; nothing is gated: Close is always there', async () => {
        nodeSays({ owner: true, wordsCheckedAt: null });
        await openAndType(PWA_ID, WORDS.join(' '));
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
        expect((screen.getByLabelText(/Your 12 words, in order/i) as HTMLTextAreaElement).value).toBe('');
    });

    it('"Can\'t find them?" sends an owner to View Recovery Phrase only when this browser has the words', async () => {
        nodeSays({ owner: true, wordsCheckedAt: null });
        const { unmount } = renderAt320(<OwnerWordsCheck identity={PWA_ID} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
        expect(screen.getByText("Can't find them? If this browser still has them, View Recovery Phrase (below) shows them.")).toBeInTheDocument();
        unmount();

        // Restored from a sign-in copy without them (web-restore.ts): View Recovery Phrase has nothing to show.
        renderAt320(<OwnerWordsCheck identity={PWA_ID} hasWords={false} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
        expect(screen.getByText("Can't find them? They aren't saved in this browser, so View Recovery Phrase can't show them.")).toBeInTheDocument();
        expect(screen.queryByText(/View Recovery Phrase \(below\) shows them/)).toBeNull();
        // The check itself is the same: typed from paper, it still works.
        expect(screen.getByLabelText(/Your 12 words, in order/i)).toBeInTheDocument();
    });

    it('the box turns off autocomplete, autocorrect, capitals and spellcheck', async () => {
        nodeSays({ owner: true, wordsCheckedAt: null });
        const box = await openAndType(PWA_ID, '');
        expect(box.getAttribute('autocomplete')).toBe('off');
        expect(box.getAttribute('autocorrect')).toBe('off');
        expect(box.getAttribute('autocapitalize')).toBe('none');
        expect(box.getAttribute('spellcheck')).toBe('false');
    });

    it('holds at 320px + 1.3× text: 48px targets that wrap, text that breaks, a full-width box; light and dark', async () => {
        nodeSays({ owner: true, wordsCheckedAt: null });
        const box = await openAndType(PWA_ID, 'a');
        const card = screen.getByTestId('owner-words-check');
        for (const b of Array.from(card.querySelectorAll('button'))) {
            expect(b.className, b.textContent || '').toMatch(/min-h-\[48px\]/);
        }
        const check = screen.getByRole('button', { name: 'Check my words' });
        expect(check.parentElement!.className).toMatch(/flex-wrap/);
        expect(check.className).toMatch(/flex-grow/);
        expect(box.className).toMatch(/w-full/);
        expect(card.innerHTML).not.toMatch(/\bw-\[\d|whitespace-nowrap|\btruncate\b/);
        // Every coloured surface and text has its dark counterpart.
        for (const el of Array.from(card.querySelectorAll('[class]'))) {
            const cls = (el as HTMLElement).className;
            if (/\b(bg|text)-(white|nature|red|emerald|amber)-?/.test(cls) && !/bg-emerald-700/.test(cls)) {
                expect(cls, cls).toMatch(/dark:/);
            }
        }
    });
});

describe('OwnerWordsPrompt (home)', () => {
    beforeEach(() => { vi.mocked(request).mockReset(); forgetOwnerWordsStatus(); localStorage.clear(); });
    afterEach(() => { document.documentElement.style.fontSize = ''; });

    it('a never-checked owner is asked; Later puts it away and it stays away', async () => {
        nodeSays({ owner: true, wordsCheckedAt: null });
        const a = renderAt320(<OwnerWordsPrompt publicKey={PUB} onCheckNow={() => {}} />);
        expect(await screen.findByText("Your 12 words aren't checked")).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Later' }));
        expect(a.container.textContent).toBe('');
        expect(localStorage.getItem(laterKey(PUB))).toBe('never');
        a.unmount();
        forgetOwnerWordsStatus();
        const b = renderAt320(<OwnerWordsPrompt publicKey={PUB} onCheckNow={() => {}} />);
        await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        expect(b.container.textContent).toBe('');
    });

    it('checked within the year: not asked. A year on: asked again', async () => {
        nodeSays({ owner: true, wordsCheckedAt: Date.now() - 1000 });
        const a = renderAt320(<OwnerWordsPrompt publicKey={PUB} onCheckNow={() => {}} />);
        await waitFor(() => expect(request).toHaveBeenCalled());
        expect(a.container.textContent).toBe('');
        a.unmount();
        forgetOwnerWordsStatus();
        nodeSays({ owner: true, wordsCheckedAt: Date.now() - 366 * 24 * 3600_000 });
        renderAt320(<OwnerWordsPrompt publicKey={PUB} onCheckNow={() => {}} />);
        expect(await screen.findByText('Time to check your 12 words')).toBeTruthy();
    });

    it('never shown to a member who is not an owner', async () => {
        nodeSays('not-owner');
        const a = renderAt320(<OwnerWordsPrompt publicKey={PUB} onCheckNow={() => {}} />);
        await waitFor(() => expect(request).toHaveBeenCalled());
        expect(a.container.textContent).toBe('');
    });

    it('Check now hands over to Settings; its buttons are 48px and wrap at 320px', async () => {
        nodeSays({ owner: true, wordsCheckedAt: null });
        const onCheckNow = vi.fn();
        renderAt320(<OwnerWordsPrompt publicKey={PUB} onCheckNow={onCheckNow} />);
        const btn = await screen.findByRole('button', { name: 'Check now' });
        for (const b of [btn, screen.getByRole('button', { name: 'Later' })]) {
            expect(b.className).toMatch(/min-h-\[48px\]/);
            expect(b.className).toMatch(/flex-grow/);
        }
        expect(btn.parentElement!.className).toMatch(/flex-wrap/);
        fireEvent.click(btn);
        expect(onCheckNow).toHaveBeenCalledTimes(1);
    });
});
