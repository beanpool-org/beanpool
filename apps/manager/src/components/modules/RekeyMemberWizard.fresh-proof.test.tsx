import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RekeyMemberWizard, REKEY_PROPOSALS_POLL_MS } from './RekeyMemberWizard';

/**
 * Owner-delete S4a: making or using an owner's or admin's re-key code asks an owner's fresh proof (server rekeyProof,
 * #1984 confirmation R1): `code` in issue-code's body, the X-Fresh-Proof header to complete (its body's `code` is the
 * re-key code). Each viewer × the refusal → the box or the sentence, and the wizard keeps what was ticked, made and typed,
 * so the owner's second Manage press on the phone (S2-S4-must-include) is followed by the same press here.
 */
const NODE = 'https://riverbend.example.org';
const member = { publicKey: 'a'.repeat(64), callsign: 'anna', status: 'active' };
const phone = 'c'.repeat(64);
const RK = 'RK-AB12-CD34';
const CODE_ASK = { error: 'Enter a current code from your authenticator app (or a backup code) to re-key an owner or admin', totpRequired: true };
const WRONG = { error: 'Invalid 2FA code', totpRequired: true };
const STEP_UP = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const PHONE = { error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true };
const ISSUED = { success: true, code: RK, oldPubkey: member.publicKey, callsign: 'anna', expiresAt: new Date(Date.now() + 3600000).toISOString(), operator: 'b'.repeat(64) };
const pending = () => ({
    id: 9, code: RK, old_pubkey: member.publicKey, new_pubkey: null, operator_pubkey: 'b'.repeat(64),
    expires_at: new Date(Date.now() + 3600000).toISOString(), status: 'pending', created_at: new Date().toISOString(),
});
const BOUND = { success: true, oldPubkey: member.publicKey, newPubkey: phone, callsign: 'anna' };

type Sent = { body: Record<string, unknown>; headers: Record<string, string> };

/** A fake node: issue-code and complete answer in turn from their lists; the status read says whether a code is out. */
function mockNode(opts: { issue?: Array<[number, unknown]>; complete?: Array<[number, unknown]>; pendingFromStart?: boolean }) {
    const sent = { issue: [] as Sent[], complete: [] as Sent[] };
    let made = !!opts.pendingFromStart;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => json }) as Response;
        const record = (list: Sent[]) => list.push({ body: init?.body ? JSON.parse(String(init.body)) : {}, headers: (init?.headers || {}) as Record<string, string> });
        if (url.endsWith('/rekey/issue-code')) {
            record(sent.issue);
            const [status, json] = opts.issue![Math.min(sent.issue.length - 1, opts.issue!.length - 1)];
            if (status === 200) made = true;
            return reply(status, json);
        }
        if (url.endsWith('/rekey/complete')) {
            record(sent.complete);
            const [status, json] = opts.complete![Math.min(sent.complete.length - 1, opts.complete!.length - 1)];
            return reply(status, json);
        }
        if (url.endsWith('/rekey/status')) {
            return reply(200, made
                ? { isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(), proposals: [{ newPubkey: phone, proposedAt: new Date().toISOString() }], wrongNumbers: 0, history: [] }
                : { isInvalidated: false, invalidatedInfo: null, pendingRequest: null, proposals: [], history: [] });
        }
        return reply(200, {});
    }));
    return sent;
}

async function tickAndMake() {
    await screen.findByText(/Nothing changes until you press Make a re-key code/);
    screen.getAllByRole('checkbox').forEach((cb) => fireEvent.click(cb));
    fireEvent.click(screen.getByRole('button', { name: /Make a re-key code/ }));
}

async function typeNumberAndBind(n: string) {
    fireEvent.change(await screen.findByLabelText('The number on their phone'), { target: { value: n } });
    fireEvent.click(screen.getByRole('button', { name: 'Bind their phone' }));
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('RekeyMemberWizard: the fresh proof (S4a)', () => {
    it('password viewer: Make a re-key code opens the box; a wrong code stays; a new code re-sends issue-code once with `code`', async () => {
        const sent = mockNode({ issue: [[401, CODE_ASK], [401, WRONG], [200, ISSUED]] });
        render(<RekeyMemberWizard member={member} nodeUrl={NODE} adminPassword="pw" onClose={() => {}} />);
        await tickAndMake();
        expect(await screen.findByText(/to re-key an owner or admin/)).toBeInTheDocument();
        fireEvent.change(screen.getByTestId('rekey-proof-input'), { target: { value: '111111' } });
        fireEvent.click(screen.getByTestId('rekey-proof-confirm'));
        await waitFor(() => expect(screen.getByTestId('rekey-proof-error')).toHaveTextContent('Invalid 2FA code'));
        // The same code is never sent twice: Confirm waits for a different one.
        expect(screen.getByTestId('rekey-proof-confirm')).toBeDisabled();
        fireEvent.change(screen.getByTestId('rekey-proof-input'), { target: { value: '222222' } });
        fireEvent.click(screen.getByTestId('rekey-proof-confirm'));
        expect(await screen.findByText(RK)).toBeInTheDocument();
        expect(screen.queryByTestId('rekey-proof-code')).not.toBeInTheDocument();
        expect(sent.issue.map((s) => s.body.code)).toEqual([undefined, '111111', '222222']);
        expect(sent.issue.every((s) => s.headers['X-Fresh-Proof'] === undefined)).toBe(true);
    });

    it('password viewer: Bind their phone opens the box; the code goes as X-Fresh-Proof, the body keeps the re-key code and the number', async () => {
        const sent = mockNode({ pendingFromStart: true, complete: [[401, CODE_ASK], [200, BOUND]] });
        render(<RekeyMemberWizard member={member} nodeUrl={NODE} adminPassword="pw" onClose={() => {}} />);
        await typeNumberAndBind('47');
        expect(await screen.findByTestId('rekey-proof-code')).toBeInTheDocument();
        // Refused before the number was looked at: no try counted, and the number is still there for the same press.
        expect(screen.getByLabelText('The number on their phone')).toHaveValue('47');
        expect(screen.getByTestId('rekey-type-number').textContent).not.toMatch(/Wrong so far/);
        fireEvent.change(screen.getByTestId('rekey-proof-input'), { target: { value: '333333' } });
        fireEvent.click(screen.getByTestId('rekey-proof-confirm'));
        expect(await screen.findByText('Re-Keying Complete!')).toBeInTheDocument();
        expect(sent.complete).toHaveLength(2);
        expect(sent.complete[0].headers['X-Fresh-Proof']).toBeUndefined();
        expect(sent.complete[1].headers['X-Fresh-Proof']).toBe('333333');
        expect(sent.complete.map((s) => s.body)).toEqual([{ code: RK, match: '47' }, { code: RK, match: '47' }]);
    });

    it('password viewer, Paste a key instead: the same box; the pasted key and the re-key code stay in the body', async () => {
        const sent = mockNode({ pendingFromStart: true, complete: [[401, CODE_ASK], [200, BOUND]] });
        render(<RekeyMemberWizard member={member} nodeUrl={NODE} adminPassword="pw" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Paste a key instead' }));
        fireEvent.change(screen.getByPlaceholderText(/64 hex characters/), { target: { value: phone } });
        fireEvent.click(screen.getByRole('button', { name: /Complete Re-Keying/ }));
        fireEvent.change(await screen.findByTestId('rekey-proof-input'), { target: { value: '444444' } });
        fireEvent.click(screen.getByTestId('rekey-proof-confirm'));
        expect(await screen.findByText('Re-Keying Complete!')).toBeInTheDocument();
        expect(sent.complete.map((s) => [s.body, s.headers['X-Fresh-Proof']])).toEqual([
            [{ code: RK, newPubkey: phone }, undefined],
            [{ code: RK, newPubkey: phone }, '444444'],
        ]);
    });

    it('phone viewer, end to end across two Manage presses: each stale press is said, the wizard keeps its state, the next press goes through', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const sent = mockNode({ issue: [[403, STEP_UP], [200, ISSUED]], complete: [[403, STEP_UP], [200, BOUND]] });
        const onSuccess = vi.fn();
        render(<RekeyMemberWizard member={member} nodeUrl={NODE} onSuccess={onSuccess} onClose={() => {}} />);

        // The first Manage press is older than 90 s by the time the code is made.
        await tickAndMake();
        expect(await screen.findByTestId('rekey-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        expect(screen.queryByTestId('rekey-proof-input')).toBeNull();
        expect(sent.issue).toHaveLength(1);
        // Nothing was lost: the checklist is still ticked, so after Manage again the same button works.
        expect(screen.getAllByRole('checkbox').every((cb) => (cb as HTMLInputElement).checked)).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: /Make a re-key code/ }));
        expect(await screen.findByText(RK)).toBeInTheDocument();
        expect(screen.queryByTestId('rekey-proof-step-up')).toBeNull();

        // Their phone asks; by the time the owner binds it, that Manage press is stale too.
        await vi.advanceTimersByTimeAsync(REKEY_PROPOSALS_POLL_MS + 10);
        await typeNumberAndBind('47');
        expect(await screen.findByTestId('rekey-proof-step-up')).toBeInTheDocument();
        expect(screen.getByText(RK)).toBeInTheDocument();
        expect(screen.getByLabelText('The number on their phone')).toHaveValue('47');
        expect(sent.complete).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'Bind their phone' }));
        expect(await screen.findByText('Re-Keying Complete!')).toBeInTheDocument();
        expect(onSuccess).toHaveBeenCalledWith(phone);

        // One request per press, and a phone never sends a code of its own.
        expect(sent.issue).toHaveLength(2);
        expect(sent.complete).toHaveLength(2);
        expect([...sent.issue, ...sent.complete].every((s) => s.body.code !== '' && s.headers['X-Fresh-Proof'] === undefined)).toBe(true);
        expect(sent.issue.every((s) => s.body.code === undefined)).toBe(true);
    });

    it('computer viewer: the from-your-phone sentence; nothing re-sent and no code made', async () => {
        const sent = mockNode({ issue: [[403, PHONE]] });
        render(<RekeyMemberWizard member={member} nodeUrl={NODE} onClose={() => {}} />);
        await tickAndMake();
        expect(await screen.findByTestId('rekey-proof-phone')).toHaveTextContent('Do this from your phone');
        expect(sent.issue).toHaveLength(1);
        expect(screen.queryByText(RK)).toBeNull();
    });
});
