// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import * as freshProofBox from './FreshProofBox';
import { FreshProofBox, useFreshProof } from './FreshProofBox';
import { FreshProofRequiredError, throwIfFreshProof } from '../../lib/fresh-proof';

// The old typed-code ask: the server never sends it (apps/server test-app-admin-handoff, test-security-followups-1001 and
// test-settings-qr-signin assert `totpRequired` is undefined), so an answer that carries it opens no box.
const OLD_CODE_ASK = { error: 'Enter a current code from your authenticator app (or a backup code) to change who is an owner or admin', totpRequired: true };
const STALE = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const PHONE = { error: 'Do this from your phone.', code: 'phone_required' };

/**
 * One screen with one action, as every screen wires it: send() → the node's answer → proof.check. `answers` is what the
 * node says to each request in turn; `sent` counts the requests.
 */
function Screen({ answers, sent, onCancel }: { answers: Array<{ status: number; body: unknown }>; sent: string[]; onCancel?: () => void }) {
    const proof = useFreshProof();
    const [done, setDone] = useState(0);
    const [stopped, setStopped] = useState('');
    const send = async () => {
        sent.push('request');
        const a = answers[sent.length - 1] ?? { status: 200, body: { success: true } };
        const res = new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
        if (await proof.check(res, () => send(), undefined)) return;
        if (res.ok) setDone((n) => n + 1);
        else setStopped(String((a.body as { error?: string }).error ?? ''));
    };
    return (
        <div>
            <button type="button" onClick={() => void send()}>Remove admin</button>
            <span data-testid="done">{done}</span>
            <span data-testid="stopped">{stopped}</span>
            <FreshProofBox proof={proof} testId="p" onCancel={onCancel} />
        </div>
    );
}

let scrolled: Array<{ el: Element; opts: unknown }>;
beforeEach(() => {
    scrolled = [];
    // jsdom has no layout: record what the box asks for.
    Element.prototype.scrollIntoView = vi.fn(function (this: Element, opts?: unknown) { scrolled.push({ el: this, opts }); });
});
afterEach(() => {
    cleanup();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
});

describe('FreshProofBox: the two asks the server makes', () => {
    it('a stale Manage unlock says to press Manage on the phone again, with no field to type in', async () => {
        render(<Screen sent={[]} answers={[{ status: 403, body: STALE }]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        const box = await screen.findByTestId('p-step-up');
        expect(box).toHaveTextContent('Press Manage on your phone again, then make this change within 90 seconds.');
        expect(box.querySelector('input')).toBeNull();
        expect(screen.queryByTestId('p-input')).toBeNull();
        expect(screen.queryByTestId('p-confirm')).toBeNull();
    });

    it('a computer key session says to do this from the phone, with no field to type in', async () => {
        render(<Screen sent={[]} answers={[{ status: 403, body: PHONE }]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        const box = await screen.findByTestId('p-phone');
        expect(box).toHaveTextContent('Do this from your phone: open BeanPool, press Manage, then make this change there.');
        expect(box.querySelector('input')).toBeNull();
    });

    it('Cancel closes the box and tells the screen; the next press asks again', async () => {
        const sent: string[] = [];
        const onCancel = vi.fn();
        render(<Screen sent={sent} onCancel={onCancel} answers={[{ status: 403, body: STALE }, { status: 403, body: STALE }]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        fireEvent.click(await screen.findByTestId('p-dismiss'));
        expect(screen.queryByTestId('p-step-up')).toBeNull();
        expect(onCancel).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByText('Remove admin'));
        await screen.findByTestId('p-step-up');
        expect(sent).toHaveLength(2);
    });

    it('a success after an ask closes the box', async () => {
        render(<Screen sent={[]} answers={[{ status: 403, body: STALE }, { status: 200, body: { success: true } }]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        await screen.findByTestId('p-step-up');
        fireEvent.click(screen.getByText('Remove admin'));
        await waitFor(() => expect(screen.getByTestId('done').textContent).toBe('1'));
        expect(screen.queryByTestId('p-step-up')).toBeNull();
    });

    it('a different ask replaces the first: a stale unlock, then a key session', async () => {
        render(<Screen sent={[]} answers={[{ status: 403, body: STALE }, { status: 403, body: PHONE }]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        await screen.findByTestId('p-step-up');
        fireEvent.click(screen.getByText('Remove admin'));
        await screen.findByTestId('p-phone');
        expect(screen.queryByTestId('p-step-up')).toBeNull();
    });
});

describe('FreshProofBox: the old typed-code ask opens nothing', () => {
    it('a 401 that carries totpRequired opens no box: the screen has the answer to deal with, and the request went once', async () => {
        const sent: string[] = [];
        render(<Screen sent={sent} answers={[{ status: 401, body: OLD_CODE_ASK }]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        await waitFor(() => expect(screen.getByTestId('stopped').textContent).toBe(OLD_CODE_ASK.error));
        expect(screen.queryByTestId('p-code')).toBeNull();
        expect(screen.queryByTestId('p-step-up')).toBeNull();
        expect(screen.queryByTestId('p-phone')).toBeNull();
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(sent).toHaveLength(1);
    });

    it('the words of the old ask are gone from the box', async () => {
        render(<Screen sent={[]} answers={[{ status: 403, body: STALE }]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        await screen.findByTestId('p-step-up');
        expect(document.body.textContent).not.toMatch(/authenticator|current code|backup code|Confirm/i);
    });
});

describe('FreshProofBox: it comes into view and takes focus when it opens (opus-2028 B1)', () => {
    it('the step-up sentence scrolls into view and is focused; a modal puts it at the top', async () => {
        render(<div data-bp-modal=""><Screen sent={[]} answers={[{ status: 403, body: STALE }]} /></div>);
        fireEvent.click(screen.getByText('Remove admin'));
        const box = await screen.findByTestId('p-step-up');
        await waitFor(() => expect(scrolled.map((s) => s.el)).toContain(box));
        expect(scrolled.find((s) => s.el === box)!.opts).toMatchObject({ block: 'start' });
        expect(document.activeElement).toBe(box);
    });

    it('on a page the box scrolls the least that shows it whole, and takes focus', async () => {
        render(<Screen sent={[]} answers={[{ status: 403, body: PHONE }]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        const box = await screen.findByTestId('p-phone');
        await waitFor(() => expect(scrolled.map((s) => s.el)).toContain(box));
        expect(scrolled.find((s) => s.el === box)!.opts).toMatchObject({ block: 'nearest' });
        expect(document.activeElement).toBe(box);
    });

    it("a second request's ask while the box is open brings it into view again", async () => {
        const sent: string[] = [];
        render(<Screen sent={sent} answers={[{ status: 403, body: STALE }, { status: 403, body: STALE }]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        await screen.findByTestId('p-step-up');
        const before = scrolled.length;
        // The person presses the screen's button again with the box still open.
        fireEvent.click(screen.getByText('Remove admin'));
        await waitFor(() => expect(sent).toHaveLength(2));
        await waitFor(() => expect(scrolled.length).toBeGreaterThan(before));
        expect(document.activeElement).toBe(screen.getByTestId('p-step-up'));
    });
});

describe('there is no fleet 2FA prompt any more', () => {
    it('the module offers no second-factor prompt context: a node has no 2FA session to end', () => {
        expect('SecondFactorPromptContext' in freshProofBox).toBe(false);
    });

    it('a node-client helper throws the two asks the server makes as FreshProofRequiredError, and not the old typed-code answer', () => {
        expect(() => throwIfFreshProof(403, STALE)).toThrow(FreshProofRequiredError);
        expect(() => throwIfFreshProof(403, PHONE)).toThrow(FreshProofRequiredError);
        expect(() => throwIfFreshProof(401, OLD_CODE_ASK)).not.toThrow();
        expect(() => throwIfFreshProof(401, { error: '2FA code required', totpRequired: true })).not.toThrow();
    });
});
