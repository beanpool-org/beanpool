import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OwnerWordsChecksPanel } from './OwnerWordsChecksPanel';
import * as nodeClient from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';

vi.mock('../../lib/node-client', async () => {
    const actual = await vi.importActual('../../lib/node-client');
    return { ...actual, getOwnerWordsChecks: vi.fn(), getTfaSessionToken: vi.fn(() => undefined) };
});

const node: NodeProfile = { id: 'n1', name: 'Test', url: 'https://test.beanpool.org', adminPassword: 'pw' };
const NOW = Date.UTC(2026, 8, 20);
const DAY = 24 * 3600_000;

describe('OwnerWordsChecksPanel (Settings → Backups & Restore)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('lists each owner with "12 words checked: <date>" or "not yet", and a plain summary', async () => {
        vi.mocked(nodeClient.getOwnerWordsChecks).mockResolvedValue({
            owners: [
                { pubkey: 'a', callsign: 'anna', wordsCheckedAt: NOW - 3 * DAY },
                { pubkey: 'b', callsign: 'ben', wordsCheckedAt: null },
                { pubkey: 'c', callsign: 'cleo', wordsCheckedAt: NOW - 400 * DAY },
            ],
        });
        render(<OwnerWordsChecksPanel activeNode={node} now={NOW} />);
        const panel = await screen.findByTestId('owner-words-checks');
        const rows = Array.from(panel.querySelectorAll('li')).map((li) => li.textContent);
        expect(rows[0]).toMatch(/^👑 @anna · 12 words checked: .*2026$/);
        expect(rows[1]).toBe('👑 @ben · 12 words checked: not yet');
        expect(rows[2]).toMatch(/@cleo · 12 words checked: .*\(over a year ago\)$/);
        expect(screen.getByTestId('owner-words-summary').textContent)
            .toBe('1 of 3 owners have checked their 12 words in the last year. The app asks the others; nothing is blocked.');
        // Self-attested, and says so: never that the server checked anything.
        expect(panel.textContent).toMatch(/this shows what they\s+reported/);
        expect(panel.textContent).toMatch(/The words never reach this server/);
        expect(nodeClient.getOwnerWordsChecks).toHaveBeenCalledWith('https://test.beanpool.org', 'pw', undefined);
    });

    it('all checked reads green; no owner says so', async () => {
        vi.mocked(nodeClient.getOwnerWordsChecks).mockResolvedValue({ owners: [{ pubkey: 'a', callsign: 'anna', wordsCheckedAt: NOW - DAY }] });
        const a = render(<OwnerWordsChecksPanel activeNode={node} now={NOW} />);
        const summary = await screen.findByTestId('owner-words-summary');
        expect(summary.textContent).toBe('1 of 1 owner has checked their 12 words in the last year.');
        expect(summary.className).toMatch(/emerald/);
        a.unmount();
        vi.mocked(nodeClient.getOwnerWordsChecks).mockResolvedValue({ owners: [] });
        render(<OwnerWordsChecksPanel activeNode={node} now={NOW} />);
        expect(await screen.findByText('This community has no owner yet.')).toBeTruthy();
    });

    it('an older server (404) or a refused session shows nothing rather than an alarm', async () => {
        vi.mocked(nodeClient.getOwnerWordsChecks).mockRejectedValue(new Error('HTTP 404: Not Found'));
        const { container } = render(<OwnerWordsChecksPanel activeNode={node} now={NOW} />);
        await waitFor(() => expect(nodeClient.getOwnerWordsChecks).toHaveBeenCalled());
        expect(container.textContent).toBe('');
    });

    it('holds at phone width: long callsigns wrap, nothing is fixed-width', async () => {
        vi.mocked(nodeClient.getOwnerWordsChecks).mockResolvedValue({ owners: [{ pubkey: 'a', callsign: 'a'.repeat(60), wordsCheckedAt: null }] });
        render(<div style={{ width: 320 }}><OwnerWordsChecksPanel activeNode={node} now={NOW} /></div>);
        const panel = await screen.findByTestId('owner-words-checks');
        expect(panel.querySelector('li')!.className).toMatch(/break-words/);
        expect(panel.innerHTML).not.toMatch(/whitespace-nowrap|\bw-\[\d/);
    });
});

describe('OwnerWordsChecksPanel — the silent open check (slice 6)', () => {
    beforeEach(() => vi.clearAllMocks());

    it("shows each owner's phone's last report on the lock, in words", async () => {
        vi.mocked(nodeClient.getOwnerWordsChecks).mockResolvedValue({
            owners: [
                { pubkey: 'a', callsign: 'anna', wordsCheckedAt: NOW - DAY, lockOpen: { envelopeId: 'e1', opened: true, checkedAt: NOW - DAY, current: true } },
                { pubkey: 'b', callsign: 'ben', wordsCheckedAt: null, lockOpen: { envelopeId: 'e0', opened: true, checkedAt: NOW - 9 * DAY, current: false } },
                { pubkey: 'c', callsign: 'cleo', wordsCheckedAt: null, lockOpen: { envelopeId: 'e1', opened: false, checkedAt: NOW - DAY, current: true } },
                { pubkey: 'd', callsign: 'dev', wordsCheckedAt: null, lockOpen: null },
            ],
            lock: { envelopeId: 'e1', sealedAt: '2026-09-19T00:00:00.000Z' },
        });
        render(<OwnerWordsChecksPanel activeNode={node} now={NOW} />);
        const panel = await screen.findByTestId('owner-words-checks');
        const lines = Array.from(panel.querySelectorAll('[data-testid="lock-open-line"]')).map((l) => [l.textContent, l.className]);
        expect(lines[0][0]).toMatch(/^their phone opened the current lock /);
        expect(lines[0][1]).toMatch(/emerald/);
        expect(lines[1][0]).toMatch(/^their phone last opened an older lock .*, before the last change$/);
        expect(lines[2][0]).toMatch(/^their phone could NOT open the current lock/);
        expect(lines[2][1]).toMatch(/amber/);
        expect(lines[3][0]).toBe('their phone has not reported on the lock yet');
    });

    it('a server before slice 6 sends no report field, and nothing is claimed either way', async () => {
        vi.mocked(nodeClient.getOwnerWordsChecks).mockResolvedValue({ owners: [{ pubkey: 'a', callsign: 'anna', wordsCheckedAt: null }] });
        render(<OwnerWordsChecksPanel activeNode={node} now={NOW} />);
        const panel = await screen.findByTestId('owner-words-checks');
        expect(panel.querySelectorAll('[data-testid="lock-open-line"]')).toHaveLength(0);
    });
});
