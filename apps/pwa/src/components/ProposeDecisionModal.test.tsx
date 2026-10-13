import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProposeDecisionModal } from './ProposeDecisionModal';
import { createDecision } from '../lib/api';

vi.mock('../lib/api', () => ({
    createDecision: vi.fn(),
    getBalance: vi.fn().mockResolvedValue({ balance: 10 }),
}));

describe('ProposeDecisionModal Accessibility & UX', () => {
    const mockIdentity = {
        publicKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        privateKey: '0x5678',
        boxPublicKey: '0x1234',
        secretKey: '0x5678',
        callsign: 'Alice',
        createdAt: '2026-01-01T00:00:00.000Z',
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not render when isOpen is false', () => {
        render(
            <ProposeDecisionModal
                isOpen={false}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('renders dialog with modal attributes and title linking', () => {
        render(
            <ProposeDecisionModal
                isOpen={true}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'propose-modal-title');
        expect(screen.getByText('Propose a Community Decision')).toBeInTheDocument();
    });

    it('renders close button with explicit type="button", aria-label, and min touch target', () => {
        const onClose = vi.fn();
        render(
            <ProposeDecisionModal
                isOpen={true}
                onClose={onClose}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );
        const closeBtn = screen.getByRole('button', { name: 'Close modal' });
        expect(closeBtn).toBeInTheDocument();
        expect(closeBtn).toHaveAttribute('type', 'button');
        expect(closeBtn.className).toContain('min-w-[44px]');
        expect(closeBtn.className).toContain('min-h-[44px]');
        expect(closeBtn.className).toContain('focus-visible:ring-2');

        fireEvent.click(closeBtn);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('renders touch option buttons with aria-pressed state and min touch target height', () => {
        render(
            <ProposeDecisionModal
                isOpen={true}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );

        const memberBtn = screen.getByRole('button', { name: /Member/i });
        const poolBtn = screen.getByRole('button', { name: /Commons Pool/i });

        expect(memberBtn).toHaveAttribute('aria-pressed', 'true');
        expect(poolBtn).toHaveAttribute('aria-pressed', 'false');
        expect(memberBtn.className).toContain('min-h-[44px]');
        expect(poolBtn.className).toContain('min-h-[44px]');

        fireEvent.click(poolBtn);
        expect(memberBtn).toHaveAttribute('aria-pressed', 'false');
        expect(poolBtn).toHaveAttribute('aria-pressed', 'true');
    });

    it('hides decorative emojis from screen readers with aria-hidden="true"', () => {
        const { container } = render(
            <ProposeDecisionModal
                isOpen={true}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );

        const hiddenEmojis = container.querySelectorAll('span[aria-hidden="true"]');
        expect(hiddenEmojis.length).toBeGreaterThan(0);
    });

    it('names the group it acts on "Project or enterprise", never a treasury (group decisions §3.1)', () => {
        render(
            <ProposeDecisionModal
                isOpen={true}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );
        const dialog = screen.getByRole('dialog');
        fireEvent.click(screen.getAllByRole('radio').find(r => r.textContent?.includes('Remove a lead keeper or project leader'))!);
        expect(screen.getByText('Project or enterprise')).toBeInTheDocument();
        expect(dialog.textContent).not.toMatch(/treasur/i);
        fireEvent.click(screen.getByRole('button', { name: /Commons Pool/i }));
        fireEvent.click(screen.getAllByRole('radio').find(r => r.textContent?.includes("Pay off a project's or enterprise's debt"))!);
        expect(screen.getByText('Project or enterprise')).toBeInTheDocument();
        expect(dialog.textContent).not.toMatch(/treasur/i);
    });

    it('says the three group effects in the new words, and none of the old ones (§3.1)', () => {
        render(
            <ProposeDecisionModal
                isOpen={true}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );
        const dialog = screen.getByRole('dialog');
        expect(screen.getByRole('radio', { name: /Remove a lead keeper or project leader/ })).toBeInTheDocument();
        const memberText = dialog.textContent;
        fireEvent.click(screen.getByRole('button', { name: /Commons Pool/i }));
        expect(screen.getByRole('radio', { name: /Give Beans to a project or enterprise/ })).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: /Pay off a project's or enterprise's debt/ })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('radio', { name: /Give Beans to a project or enterprise/ }));
        expect(screen.getByText('Project or enterprise public key')).toBeInTheDocument();
        for (const words of [memberText, dialog.textContent]) {
            for (const old of ['Remove Lead Keeper', 'Grant to Enterprise', 'Write Off Deficit', 'defaulted enterprise', 'Target Enterprise']) {
                expect(words).not.toContain(old);
            }
        }
    });

    it('a project picked under "remove" names its leader, an enterprise its lead keeper', async () => {
        const roof = 'r'.repeat(64), eggs = 'e'.repeat(64);
        render(
            <ProposeDecisionModal
                isOpen={true}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
                treasuries={[
                    { publicKey: roof, name: 'New hall roof', lifecycle: 'bounded' },
                    { publicKey: eggs, name: 'Egg flock', lifecycle: 'ongoing' },
                ]}
            />
        );
        fireEvent.click(screen.getByRole('radio', { name: /Remove a lead keeper or project leader/ }));
        expect(screen.getByText('The lead keeper or leader to remove: callsign or public key')).toBeInTheDocument();
        fireEvent.change(screen.getByPlaceholderText('e.g. Grant 200 beans to the Tool Library'), { target: { value: 'New roof lead' } });
        fireEvent.change(screen.getByPlaceholderText(/Explain why this decision is needed/), { target: { value: 'They moved away' } });
        fireEvent.change(screen.getByPlaceholderText("Enter the lead keeper or leader's callsign or pubkey..."), { target: { value: 'b'.repeat(64) } });
        fireEvent.click(screen.getByRole('button', { name: 'Egg flock' }));
        expect(screen.getByText('The lead keeper to remove: callsign or public key')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'New hall roof' }));
        expect(screen.getByText('The leader to remove: callsign or public key')).toBeInTheDocument();
        expect(screen.getByPlaceholderText("Enter the leader's callsign or pubkey...")).toBeInTheDocument();
        vi.mocked(createDecision).mockResolvedValueOnce({ success: true } as any);
        fireEvent.click(screen.getByRole('button', { name: 'Submit Decision' }));
        await vi.waitFor(() => expect(vi.mocked(createDecision)).toHaveBeenCalledWith(expect.objectContaining({
            effect: 'remove_lead_keeper', params: { enterprisePubkey: roof, leadPubkey: 'b'.repeat(64) },
        })));
    });

    it("shows the node's grant-cap sentence as it comes, and keeps the form open", async () => {
        // The node refuses a grant bigger than the Commons could pay (decisions-engine.ts grantCapRefusal); request()
        // throws its `error` field. The screen is not the rule, so it shows the node's words unchanged.
        const sentence = 'This grant is bigger than the Commons could pay: it holds 100 Beans and took in 23.50 Beans over the last 30 days, so the most you can ask for now is 123.50 Beans.';
        vi.mocked(createDecision).mockRejectedValueOnce(new Error(sentence));
        const onCreated = vi.fn();
        render(
            <ProposeDecisionModal
                isOpen={true}
                onClose={vi.fn()}
                onCreated={onCreated}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );
        fireEvent.click(screen.getByRole('button', { name: /Commons Pool/i }));
        fireEvent.change(screen.getByPlaceholderText('e.g. Grant 200 beans to the Tool Library'), { target: { value: 'Seed money' } });
        fireEvent.change(screen.getByPlaceholderText(/Explain why this decision is needed/), { target: { value: 'For the tool library roof' } });
        fireEvent.change(screen.getByPlaceholderText('Enter its public key...'), { target: { value: 'ab'.repeat(32) } });
        fireEvent.change(screen.getByPlaceholderText('e.g. 250'), { target: { value: '124.5' } });
        fireEvent.click(screen.getByRole('button', { name: 'Submit Decision' }));

        expect(await screen.findByText(sentence)).toBeInTheDocument();
        expect(vi.mocked(createDecision)).toHaveBeenCalledWith(expect.objectContaining({ effect: 'grant_enterprise', params: { amount: 124.5 } }));
        expect(onCreated).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
});
