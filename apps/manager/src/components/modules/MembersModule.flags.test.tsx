import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MembersModule } from './MembersModule';

/**
 * The owner's list of flags (Marty, 4 Nov): each reads in words, never as its raw type; a flag that shows real harm opens a
 * window that offers Freeze, one that does not, does not.
 */

const KEY_A = 'aa11bb22cc33dd44ee55ff6677889900aa11bb22';
const KEY_B = 'bb22cc33dd44ee55ff6677889900aa11bb22cc33';

function nodeData(flags: Array<Record<string, unknown>>) {
    return {
        members: [
            { publicKey: KEY_A, name: 'Alder', tier: 'Resident', platform: 'ios' },
            { publicKey: KEY_B, name: 'Birch', tier: 'Resident', platform: 'android' },
        ],
        profiles: [
            { publicKey: KEY_A, name: 'Alder' },
            { publicKey: KEY_B, name: 'Birch' },
        ],
        posts: [],
        health: { healthScore: 98, flags },
        reports: [],
    };
}

const branch = { type: 'isolated_branch', severity: 'warning', description: 'A branch of 1 invited member who only trades with each other', members: [KEY_A] };
const wash = { type: 'wash_trading', severity: 'alert', description: 'Wash trading detected: Alder and Birch', members: [KEY_A, KEY_B] };

describe('MembersModule flags', () => {
    it('a flag is an alert, counts every flag, and reads in words, not as its raw type', () => {
        render(<MembersModule nodeData={nodeData([branch, wash])} nodeDataLoading={false} onRefresh={vi.fn()} />);
        expect(screen.getByText(/Active Security Alerts & Abuse Radar \(2\)/)).toBeInTheDocument();
        expect(screen.getByText('ACTION REQUIRED')).toBeInTheDocument();
        expect(screen.getByText('Two members trading Beans back and forth')).toBeInTheDocument();
        expect(screen.getByText('A branch of invited members who only trade with each other')).toBeInTheDocument();
        expect(document.body.textContent).not.toContain('wash_trading');
        expect(document.body.textContent).not.toContain('isolated_branch');
    });

    it('a flag with nothing to freeze opens a window by name that offers Dismiss only', () => {
        render(<MembersModule nodeData={nodeData([branch])} nodeDataLoading={false} onRefresh={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        expect(screen.getByText('Members involved (1)')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Dismiss Flag' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Freeze/ })).not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain(KEY_A);
    });

    it('a freeze the node refuses is said in the window, and nobody it refused shows as frozen (Marty, 14 Nov 2026)', async () => {
        const onFreezeUser = vi.fn(async (pk: string) => {
            if (pk === KEY_A) throw new Error('Only an owner can freeze or unfreeze an owner.');
        });
        render(<MembersModule nodeData={nodeData([wash])} nodeDataLoading={false} onRefresh={vi.fn()} onFreezeUser={onFreezeUser} />);
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Freeze Accounts/ })); });
        expect(onFreezeUser).toHaveBeenCalledTimes(2);
        expect(screen.getByRole('alert')).toHaveTextContent('Only an owner can freeze or unfreeze an owner.');
        expect(screen.queryByText('Member access rights frozen. Moderation event logged.')).not.toBeInTheDocument();
    });

    it('a real flag opens a window that offers Freeze', () => {
        render(<MembersModule nodeData={nodeData([wash])} nodeDataLoading={false} onRefresh={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        expect(screen.getByRole('button', { name: /Freeze Accounts/ })).toBeInTheDocument();
        expect(screen.getByText('Members involved (2)')).toBeInTheDocument();
    });
});
