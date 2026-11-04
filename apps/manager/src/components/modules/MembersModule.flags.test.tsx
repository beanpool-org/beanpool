import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MembersModule } from './MembersModule';

/**
 * The owner's list of flags (Marty, 4 Nov): members with no trades for a while are news, listed quietly apart from the
 * alerts, never counted as one, and opened in a window with nothing to freeze. A real flag still reads as an alert.
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

const inactive = { type: 'inactive_member', severity: 'info', days: 30, description: '1 member has not traded Beans for 30+ days', members: [KEY_A] };
const wash = { type: 'wash_trading', severity: 'alert', description: 'Wash trading detected: Alder and Birch', members: [KEY_A, KEY_B] };

describe('MembersModule flags', () => {
    it('members with no trades are not an alert: no red panel, no count, no ACTION REQUIRED', () => {
        render(<MembersModule nodeData={nodeData([inactive])} nodeDataLoading={false} onRefresh={vi.fn()} />);
        expect(screen.queryByText(/Active Security Alerts/)).not.toBeInTheDocument();
        expect(screen.queryByText('ACTION REQUIRED')).not.toBeInTheDocument();
        expect(screen.getByText('For your information')).toBeInTheDocument();
        expect(screen.getByText('Members with no trades for 30 days')).toBeInTheDocument();
        expect(document.body.textContent).not.toContain('inactive_member');
    });

    it('an older node that sends them as a warning gets the same quiet treatment', () => {
        render(<MembersModule nodeData={nodeData([{ ...inactive, severity: 'warning' }])} nodeDataLoading={false} onRefresh={vi.fn()} />);
        expect(screen.queryByText(/Active Security Alerts/)).not.toBeInTheDocument();
        expect(screen.getByText('For your information')).toBeInTheDocument();
    });

    it('a real flag stays an alert, counts only itself, and reads in words, not as its raw type', () => {
        render(<MembersModule nodeData={nodeData([inactive, wash])} nodeDataLoading={false} onRefresh={vi.fn()} />);
        expect(screen.getByText(/Active Security Alerts & Abuse Radar \(1\)/)).toBeInTheDocument();
        expect(screen.getByText('ACTION REQUIRED')).toBeInTheDocument();
        expect(screen.getByText('Two members trading Beans back and forth')).toBeInTheDocument();
        expect(document.body.textContent).not.toContain('wash_trading');
    });

    it('the quiet row opens a window by name with Dismiss only', () => {
        render(<MembersModule nodeData={nodeData([inactive])} nodeDataLoading={false} onRefresh={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Look' }));
        expect(screen.getByText('Members involved (1)')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Dismiss Flag' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Freeze/ })).not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain(KEY_A);
    });

    it('a real flag opens a window that offers Freeze', () => {
        render(<MembersModule nodeData={nodeData([wash])} nodeDataLoading={false} onRefresh={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        expect(screen.getByRole('button', { name: /Freeze Accounts/ })).toBeInTheDocument();
        expect(screen.getByText('Members involved (2)')).toBeInTheDocument();
    });
});
