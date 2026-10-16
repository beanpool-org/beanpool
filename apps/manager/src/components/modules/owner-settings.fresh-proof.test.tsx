import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { GatewayModule } from './GatewayModule';
import { OffboxBackupsPanel } from './OffboxBackupsPanel';
import { AutomationTokensPanel } from './AutomationTokensPanel';
import { RetirePasswordPanel } from './RetirePasswordPanel';
import { ApplianceSection } from './ApplianceSection';
import { updateGatewayConfig, type GatewayConfig, type OffboxStatus } from '../../lib/node-client';
import { FreshProofRequiredError } from '../../lib/fresh-proof';
import { answerInPageConfirm } from '../common/__tests__/in-page-confirm-helpers';
import type { NodeProfile } from '../../lib/profiles';

/**
 * Owner-delete S4a: the owner's settings whose routes call requireFreshProof: the gateway (amendment 1), off-box
 * destinations removed, changed or kept fewer days, a break-glass code made (C7), an automation token made (C10, key
 * sessions only) and the password retired (C4, Manage within 90 s). Each viewer × the refusal → the box or the sentence;
 * the code is re-sent once with the same request; nothing is re-sent without one.
 */
const node: NodeProfile = { id: 'n1', name: 'Riverbend', url: 'https://riverbend.example.org', adminPassword: 'pw' };
const CODE_ASK = (what: string) => ({ error: `Enter a current code from your authenticator app (or a backup code) to ${what}`, totpRequired: true });
const STEP_UP = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const PHONE = { error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true };
const OWNER_KEY = { kind: 'key' as const, memberPubkey: 'a'.repeat(64), role: 'owner' as const };
const gateway: GatewayConfig = {
    features: { marketplace: true, messaging: true, federation: true, invites: true, servePwa: true },
    corsAllowedOrigins: ['*'], rateLimiting: { enabled: true, maxRequestsPerMinute: 60 }, adminIpAllowlist: [],
};

type Sent = { body: Record<string, unknown> };

/** A fake node: POSTs to `route` answer from `answers` in turn; reads of other routes answer from `reads`, else 200 {}. */
function mockNode(route: string, answers: Array<[number, unknown]>, reads: Record<string, unknown> = {}) {
    const sent: Sent[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => json, clone() { return this; } }) as unknown as Response;
        if (url.endsWith(route) && init?.method === 'POST') {
            sent.push({ body: init?.body ? JSON.parse(String(init.body)) : {} });
            const [status, json] = answers[Math.min(sent.length - 1, answers.length - 1)];
            return reply(status, json);
        }
        for (const [suffix, json] of Object.entries(reads)) if (url.endsWith(suffix)) return reply(200, json);
        return reply(200, {});
    }));
    return sent;
}

async function enterCode(testId: string, code: string) {
    fireEvent.change(await screen.findByTestId(`${testId}-input`), { target: { value: code } });
    fireEvent.click(screen.getByTestId(`${testId}-confirm`));
}

beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());

describe('Gateway save (S4a; opus-1984 N4)', () => {
    /** As App's handleSaveGateway: the proof is the screen's to ask; anything else it says itself. */
    const onSave = (code?: string) => updateGatewayConfig(node.url, gateway, 'pw', undefined, code).then(() => {});

    it('password viewer: the box; a wrong code stays; a new code re-sends the same settings once with `code`', async () => {
        const sent = mockNode('/api/local/admin/gateway', [[401, CODE_ASK('change the gateway settings')], [401, { error: 'Invalid 2FA code', totpRequired: true }], [200, { success: true, gateway }]]);
        render(<GatewayModule gateway={gateway} gatewayLoading={false} gatewaySuccess={null} onChangeGateway={vi.fn()} onSaveGateway={onSave} />);
        fireEvent.click(screen.getByRole('button', { name: /Save Gateway Config/ }));
        await enterCode('gateway-proof', '111111');
        await waitFor(() => expect(screen.getByTestId('gateway-proof-error')).toHaveTextContent('Invalid 2FA code'));
        await enterCode('gateway-proof', '222222');
        await waitFor(() => expect(screen.queryByTestId('gateway-proof-code')).toBeNull());
        expect(sent.map((s) => s.body.code)).toEqual([undefined, '111111', '222222']);
        expect(sent.every((s) => (s.body.features as Record<string, boolean>).marketplace === true)).toBe(true);
    });

    it('computer viewer: the from-your-phone sentence, not "HTTP 403"; nothing re-sent', async () => {
        const sent = mockNode('/api/local/admin/gateway', [[403, PHONE]]);
        render(<GatewayModule gateway={gateway} gatewayLoading={false} gatewaySuccess={null} onChangeGateway={vi.fn()} onSaveGateway={onSave} />);
        fireEvent.click(screen.getByRole('button', { name: /Save Gateway Config/ }));
        expect(await screen.findByTestId('gateway-proof-phone')).toHaveTextContent('Do this from your phone');
        expect(sent).toHaveLength(1);
    });

    it('any other refusal says what happened in words, never a bare HTTP status', async () => {
        mockNode('/api/local/admin/gateway', [[400, { error: 'The new allow-list leaves out the address you are on.' }]]);
        await expect(updateGatewayConfig(node.url, gateway, 'pw')).rejects.toThrow('The new allow-list leaves out the address you are on.');
        mockNode('/api/local/admin/gateway', [[500, null]]);
        await expect(updateGatewayConfig(node.url, gateway, 'pw')).rejects.toThrow('The server had a problem. Nothing was changed. Try again in a minute.');
        mockNode('/api/local/admin/gateway', [[403, STEP_UP]]);
        await expect(updateGatewayConfig(node.url, gateway, 'pw')).rejects.toBeInstanceOf(FreshProofRequiredError);
    });
});

describe('Off-box destination removed (S4a)', () => {
    const dest = {
        id: 'd-1', name: 'R2', source: 'settings', endpoint: 'https://acct.r2.example.com', bucket: 'bp-backups', region: 'auto',
        prefix: '', accessKeyId: 'AKID…01', secretSet: true, problems: [], health: 'ok', lastSuccessAt: Date.UTC(2026, 9, 1, 2), lastSuccessBytes: 5_000_000,
        lastAttemptAt: Date.UTC(2026, 9, 1, 2), lastError: null, failures: 0, nextAttemptAt: Date.UTC(2026, 9, 2, 2), lastPruneAt: null, lastPruneError: null,
    };
    const status = (destinations: unknown[]): OffboxStatus => ({
        state: 'sending', message: 'Locked backups go off the box every 24 hours.', intervalHours: 24, intervalFrom: 'default',
        retentionDays: 30, retentionFrom: 'default', maxRetentionDays: 30, maxIntervalHours: 168, running: false, destinations,
    } as unknown as OffboxStatus);

    it('password viewer: Remove opens the box; the code re-sends the same removeId once', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const sent = mockNode('/offbox-backups/settings', [[401, CODE_ASK('remove, change or shorten where backups go off the box')], [200, { success: true, status: status([]) }]],
            { '/offbox-backups/status': status([dest]) });
        render(<OffboxBackupsPanel activeNode={node} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
        await answerInPageConfirm('Stop sending'); // S4b (#2029): Remove asks in the page first
        await enterCode('offbox-proof', '135790');
        expect(await screen.findByText('Destination removed. What it holds stays there.')).toBeInTheDocument();
        expect(sent.map((s) => [s.body.removeId, s.body.code])).toEqual([['d-1', undefined], ['d-1', '135790']]);
    });

    it('phone viewer, hand-off stale: the Manage-again sentence; nothing re-sent', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const sent = mockNode('/offbox-backups/settings', [[403, STEP_UP]], { '/offbox-backups/status': status([dest]) });
        render(<OffboxBackupsPanel activeNode={node} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
        await answerInPageConfirm('Stop sending'); // S4b (#2029): Remove asks in the page first
        expect(await screen.findByTestId('offbox-proof-step-up')).toBeInTheDocument();
        expect(sent).toHaveLength(1);
    });
});

describe('Break-glass code made (S4a, C7)', () => {
    it('password viewer: the box; the code re-sent once with the same owner key', async () => {
        const sent = mockNode('/auth/break-glass/issue', [[401, CODE_ASK('make a break-glass code')], [200, { breakGlassCode: 'BG-TEST-0000' }]]);
        await act(async () => {
            render(
                <ApplianceSection activeNode={node} diag={null} gateway={null} gatewayLoading={false} gatewaySuccess={null} gatewaySaving={false}
                    nodeLogs={[]} onChangeGateway={vi.fn()} onSaveGateway={vi.fn()} onRefreshDiag={vi.fn()} onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()} onRunLedgerAudit={vi.fn()} auditState={{ running: false, result: null }} initialSubTab="access" />
            );
        });
        fireEvent.change(screen.getByLabelText("Owner's member key"), { target: { value: 'b'.repeat(64) } });
        fireEvent.click(screen.getByRole('button', { name: 'Make a break-glass code' }));
        await enterCode('break-glass-proof', '864200');
        expect(await screen.findByText('BG-TEST-0000')).toBeInTheDocument();
        expect(sent.map((s) => [s.body.memberPubkey, s.body.code])).toEqual([['b'.repeat(64), undefined], ['b'.repeat(64), '864200']]);
    });
});

describe('Automation token made and the password retired: key sessions only (S4a, C10, C4)', () => {
    it('token, computer viewer: the from-your-phone sentence; one request; no token shown', async () => {
        const sent = mockNode('/api/local/admin/automation-tokens', [[403, PHONE]]);
        render(<AutomationTokensPanel activeNode={{ ...node, adminPassword: undefined }} viewer={OWNER_KEY} />);
        fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Dash' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Make token' })); });
        expect(await screen.findByTestId('token-proof-phone')).toHaveTextContent('Do this from your phone');
        expect(sent).toHaveLength(1);
        expect(screen.queryByTestId('automation-token-value')).toBeNull();
    });

    it('retire, phone viewer with a stale hand-off: the Manage-again sentence; one request; still not retired', async () => {
        const state = { passwordRetired: false, owners: 2, hasBreakGlassCode: true };
        const sent = mockNode('/auth/retire-password', [[403, STEP_UP]], { '/auth/password-retirement': state });
        render(<RetirePasswordPanel activeNode={{ ...node, adminPassword: undefined }} viewer={OWNER_KEY} />);
        const confirmBox = await screen.findByLabelText('Type RETIRE to confirm');
        fireEvent.change(confirmBox, { target: { value: 'RETIRE' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retire the admin password' })); });
        expect(await screen.findByTestId('retire-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        expect(sent).toHaveLength(1);
    });
});
