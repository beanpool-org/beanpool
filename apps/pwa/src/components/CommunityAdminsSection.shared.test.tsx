/**
 * What a web member sees of the shared placement (vault rethink VR4), which is the phone's for now: half at this community's
 * server, half at BeanPool's key vault, which the web app can't reach (design VR6). A copy a phone made is said as that, in
 * Settings' two places, with no button: a Remove here would leave the vault's half behind, and "keeps no copy" would be false.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CommunityAdminsSection } from './CommunityAdminsSection';
import { WaysBackSection } from './WaysBackSection';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Mia', createdAt: '2026-11-01T00:00:00.000Z' };
const SINCE = '2026-10-05T00:00:00.000Z';

afterEach(cleanup);

describe('Settings: your community\'s admins', () => {
    it('a copy a phone made is said as on, and managed there: no Turn on, no Remove', () => {
        render(<CommunityAdminsSection identity={IDENTITY as never} offeredHere={false} onChanged={vi.fn()}
            status={{ kept: true, since: SINCE, offered: false, unopenable: null, shared: true }} />);
        expect(screen.getByTestId('community-admins-shared').textContent).toMatch(/from your phone\..*each keep half of a locked copy\. Manage it in the phone app\./);
        expect(screen.queryByTestId('community-admins-turn-on')).toBeNull();
        expect(screen.queryByTestId('community-admins-remove')).toBeNull();
        expect(screen.queryByTestId('community-admins-on')).toBeNull();
    });

    it('under the key vault\'s rule, with nothing kept, the web offers nothing, as before', () => {
        const { container } = render(<CommunityAdminsSection identity={IDENTITY as never} offeredHere={false} onChanged={vi.fn()}
            status={{ kept: false, since: null, offered: false, unopenable: null, shared: false }} />);
        expect(container.innerHTML).toBe('');
    });

    it('a whole copy is as it was', () => {
        render(<CommunityAdminsSection identity={IDENTITY as never} offeredHere onChanged={vi.fn()}
            status={{ kept: true, since: SINCE, offered: true, unopenable: null, shared: false }} />);
        expect(screen.getByTestId('community-admins-on')).toBeTruthy();
        expect(screen.getByTestId('community-admins-remove')).toBeTruthy();
    });
});

describe('Settings: where your account can be brought back from', () => {
    const open = () => screen.getByRole('button', { expanded: false }).click();

    it('half of a copy is listed, with no Remove, and never as "keeps no copy"', async () => {
        render(<WaysBackSection enrolled={[]} adminsHalf={{ since: SINCE }} hasWords onShowWords={vi.fn()} onChanged={vi.fn()} />);
        open();
        const row = await screen.findByTestId('ways-back-admins-half');
        expect(row.textContent).toContain('Half of a locked copy');
        expect(row.textContent).toContain('Manage it in the phone app.');
        expect(row.querySelector('button')).toBeNull();
        expect(screen.queryByText('Keeps no copy of your account.')).toBeNull();
    });

    it('with nothing there, it still says so', async () => {
        render(<WaysBackSection enrolled={[]} hasWords onShowWords={vi.fn()} onChanged={vi.fn()} />);
        open();
        expect(await screen.findByText('Keeps no copy of your account.')).toBeTruthy();
    });
});
