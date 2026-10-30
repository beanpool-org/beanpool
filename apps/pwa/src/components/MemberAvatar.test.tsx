import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';
import { MemberAvatar } from './MemberAvatar';

describe('MemberAvatar (web) — no bare initials (Marty addition)', () => {
    it('renders a deterministic ready-made preset and NO bare initial letter disc for a pictureless member', () => {
        const pubkey = 'e'.repeat(64);
        render(<MemberAvatar avatarUrl={null} pubkey={pubkey} callsign="Eve" size={40} />);

        // Must not render bare initial text
        expect(screen.queryByText('E')).toBeNull();

        // Must render an img element with resolved preset
        const img = screen.getByRole('img');
        expect(img).toBeInTheDocument();
        expect(img).toHaveAttribute('src');
        expect(img.getAttribute('src')).toMatch(/^\/avatars\/avatar_[a-z_]+\.webp$/);
    });

    it('renders the same deterministic preset for the same pubkey across renders', () => {
        const pubkey = 'f'.repeat(64);
        const { unmount } = render(<MemberAvatar avatarUrl={null} pubkey={pubkey} callsign="Frank" size={40} />);
        const img1 = screen.getByRole('img').getAttribute('src');
        unmount();

        render(<MemberAvatar avatarUrl={null} pubkey={pubkey} callsign="Frank" size={40} />);
        const img2 = screen.getByRole('img').getAttribute('src');

        expect(img1).toBeTruthy();
        expect(img1).toBe(img2);
    });
});

// Profile S1, Damo (a), 29 Oct: a picture that fails to load (a stale address after the photo changed elsewhere) was a
// blank disc on the phone and a broken image here. The ready-made picture the key picks stands in for it.
describe('MemberAvatar (web) — a picture that fails to load', () => {
    it('falls back to the preset by key, never a broken image, and tries a new address afresh', () => {
        const pubkey = 'a'.repeat(64);
        const { rerender } = render(<MemberAvatar avatarUrl="/api/avatar/aaaa?size=thumb&k=stale" pubkey={pubkey} callsign="Ann" />);
        const img = screen.getByRole('img');
        expect(img).toHaveAttribute('src', '/api/avatar/aaaa?size=thumb&k=stale');
        fireEvent.error(img);
        expect(screen.getByRole('img').getAttribute('src')).toMatch(/^\/avatars\/avatar_[a-z_]+\.webp$/);

        rerender(<MemberAvatar avatarUrl="/api/avatar/aaaa?size=thumb&k=fresh" pubkey={pubkey} callsign="Ann" />);
        expect(screen.getByRole('img')).toHaveAttribute('src', '/api/avatar/aaaa?size=thumb&k=fresh');
    });
});
