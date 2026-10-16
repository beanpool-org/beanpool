// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { FreshProofBox, SecondFactorPromptContext, useFreshProof } from './FreshProofBox';
import { FreshProofRequiredError, throwIfFreshProof } from '../../lib/fresh-proof';

const ASK = { error: 'Enter a current code from your authenticator app (or a backup code) to change who is an owner or admin', totpRequired: true };
const STALE = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };

/**
 * One screen with one action, as every screen wires it: send(code?) → the node's answer → proof.check. `answers` is what
 * the node says to each request in turn; `sent` records the code each request carried.
 */
function Screen({ answers, sent }: { answers: Array<{ status: number; body: unknown }>; sent: Array<string | undefined> }) {
    const proof = useFreshProof();
    const [done, setDone] = useState(0);
    const send = async (code?: string) => {
        sent.push(code);
        const a = answers[sent.length - 1] ?? { status: 200, body: { success: true } };
        const res = new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
        if (await proof.check(res, (c) => send(c), code)) return;
        if (res.ok) setDone((n) => n + 1);
    };
    return (
        <div>
            <button type="button" onClick={() => void send()}>Remove admin</button>
            <span data-testid="done">{done}</span>
            <FreshProofBox proof={proof} testId="p" />
        </div>
    );
}

const input = () => screen.getByTestId('p-input') as HTMLInputElement;
const confirm = () => screen.getByTestId('p-confirm') as HTMLButtonElement;

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

describe('FreshProofBox: a code once typed is never offered again (opus-2028 B4)', () => {
    it('a second refusal on the same screen opens an EMPTY field with Confirm disabled', async () => {
        const sent: Array<string | undefined> = [];
        render(<Screen sent={sent} answers={[
            { status: 401, body: ASK }, { status: 200, body: { success: true } },
            { status: 401, body: ASK },
        ]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        await screen.findByTestId('p-input');
        fireEvent.change(input(), { target: { value: '654321' } });
        fireEvent.click(confirm());
        await waitFor(() => expect(screen.getByTestId('done').textContent).toBe('1'));
        expect(screen.queryByTestId('p-code')).toBeNull();

        // The next change on the same screen: the box opens again, empty, and Confirm waits for a new code.
        fireEvent.click(screen.getByText('Remove admin'));
        await screen.findByTestId('p-input');
        expect(input().value).toBe('');
        expect(confirm().disabled).toBe(true);
        expect(sent).toEqual([undefined, '654321', undefined]);
    });

    it('Cancel empties the field: the box reopens empty', async () => {
        const sent: Array<string | undefined> = [];
        render(<Screen sent={sent} answers={[{ status: 401, body: ASK }, { status: 401, body: ASK }]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        await screen.findByTestId('p-input');
        fireEvent.change(input(), { target: { value: '111222' } });
        fireEvent.click(screen.getByTestId('p-cancel'));
        expect(screen.queryByTestId('p-code')).toBeNull();
        fireEvent.click(screen.getByText('Remove admin'));
        await screen.findByTestId('p-input');
        expect(input().value).toBe('');
        expect(confirm().disabled).toBe(true);
        expect(sent).toEqual([undefined, undefined]);
    });

    it('a wrong code keeps the box open with that code, and Confirm waits for a different one', async () => {
        const sent: Array<string | undefined> = [];
        render(<Screen sent={sent} answers={[
            { status: 401, body: ASK }, { status: 401, body: { error: 'Invalid 2FA code', totpRequired: true } },
        ]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        await screen.findByTestId('p-input');
        fireEvent.change(input(), { target: { value: '000000' } });
        fireEvent.click(confirm());
        expect(await screen.findByTestId('p-error')).toHaveTextContent('Invalid 2FA code');
        expect(input().value).toBe('000000');
        expect(confirm().disabled).toBe(true);
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

    it('on a page the code box scrolls the least that shows it whole, and its field takes focus', async () => {
        const sent: Array<string | undefined> = [];
        render(<Screen sent={sent} answers={[{ status: 401, body: ASK }, { status: 401, body: { error: 'Invalid 2FA code', totpRequired: true } }]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        const form = await screen.findByTestId('p-code');
        await waitFor(() => expect(scrolled.map((s) => s.el)).toContain(form));
        expect(scrolled.find((s) => s.el === form)!.opts).toMatchObject({ block: 'nearest' });
        expect(document.activeElement).toBe(input());
        // A wrong code's answer does not scroll again: the person is already there.
        const before = scrolled.length;
        fireEvent.change(input(), { target: { value: '000000' } });
        fireEvent.click(confirm());
        await screen.findByTestId('p-error');
        expect(scrolled.length).toBe(before);
    });
});

describe('FreshProofBox words (opus-2028 N2)', () => {
    it("the field's visible label is \"Current code\", its accessible name, under the server's sentence", async () => {
        render(<Screen sent={[]} answers={[{ status: 401, body: ASK }]} />);
        fireEvent.click(screen.getByText('Remove admin'));
        expect(await screen.findByLabelText('Current code')).toBe(input());
        expect(screen.getByTestId('p-code')).toHaveTextContent(ASK.error);
        expect(screen.getByTestId('p-code').textContent).not.toMatch(/Code from your authenticator app/);
    });
});

describe("checkAdminAuth's own 2FA ask is not the box (opus-2028 N4)", () => {
    it('a 401 "2FA code required" opens the 2FA prompt, not the code box', async () => {
        const prompt = vi.fn();
        render(
            <SecondFactorPromptContext.Provider value={prompt}>
                <Screen sent={[]} answers={[{ status: 401, body: { error: '2FA code required', totpRequired: true } }]} />
            </SecondFactorPromptContext.Provider>,
        );
        await act(async () => { fireEvent.click(screen.getByText('Remove admin')); });
        await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId('p-code')).toBeNull();
    });

    it("a node-client helper throws it as its own error (the sentence kept), never FreshProofRequiredError", () => {
        let thrown: unknown;
        try { throwIfFreshProof(401, { error: '2FA code required', totpRequired: true }); } catch (e) { thrown = e; }
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(FreshProofRequiredError);
        expect((thrown as Error).message).toBe('2FA code required');
        expect(() => throwIfFreshProof(401, ASK)).toThrow(FreshProofRequiredError);
    });
});
