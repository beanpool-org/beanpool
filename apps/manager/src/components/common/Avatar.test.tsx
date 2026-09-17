import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Avatar } from './Avatar';

describe('Avatar component', () => {
    it('renders an img for bundled:// avatar with resolved src and name as alt', () => {
        render(<Avatar src="bundled://sprout" alt="BeanPool" />);
        const img = screen.getByRole('img', { name: 'BeanPool' });
        expect(img).toBeInTheDocument();
        expect(img).toHaveAttribute('src', '/avatars/avatar_sprout.jpg');
        expect(img).toHaveAttribute('alt', 'BeanPool');
        expect(screen.queryByText('bundled://sprout')).not.toBeInTheDocument();
    });

    it('renders an img for /api/avatar URL with name as alt', () => {
        const url = '/api/avatar/7d566ff87a5fd0dc35a81214388bfcca78a91406284f5dfc165dd20d9383ff46?size=thumb';
        render(<Avatar src={url} alt="Community Eggs" />);
        const img = screen.getByRole('img', { name: 'Community Eggs' });
        expect(img).toBeInTheDocument();
        expect(img).toHaveAttribute('src', url);
        expect(img).toHaveAttribute('alt', 'Community Eggs');
        expect(screen.queryByText(url)).not.toBeInTheDocument();
    });

    it('renders text for an emoji avatar with accessible role and label', () => {
        render(<Avatar src="  🚜  " alt="Machinery Co-op" />);
        expect(screen.getByText('🚜')).toBeInTheDocument();
        const emoji = screen.getByRole('img', { name: 'Machinery Co-op' });
        expect(emoji).toBeInTheDocument();
        expect(emoji).toHaveAttribute('role', 'img');
        expect(emoji).toHaveAttribute('aria-label', 'Machinery Co-op');
    });

    it('hides decorative emoji avatars from screen readers when alt is empty', () => {
        const { container } = render(<Avatar src="🚜" alt="" />);
        expect(screen.getByText('🚜')).toBeInTheDocument();
        expect(screen.queryByRole('img')).not.toBeInTheDocument();
        expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    });

    it('renders fallback glyph for null, undefined, or empty avatar', () => {
        const { rerender } = render(<Avatar src="" alt="" />);
        expect(screen.getByText('🌾')).toBeInTheDocument();
        expect(screen.queryByRole('img')).not.toBeInTheDocument();

        rerender(<Avatar src={null} alt="" />);
        expect(screen.getByText('🌾')).toBeInTheDocument();
        expect(screen.queryByRole('img')).not.toBeInTheDocument();

        rerender(<Avatar src={undefined} alt="" />);
        expect(screen.getByText('🌾')).toBeInTheDocument();
        expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('renders fallback glyph with accessible label when alt is provided', () => {
        render(<Avatar src="" alt="Empty Org" />);
        expect(screen.getByText('🌾')).toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'Empty Org' })).toBeInTheDocument();
    });

    it('renders fallback glyph if image fails to load (onError) and never prints URL string', () => {
        const url = 'https://example.com/broken-avatar.jpg';
        render(<Avatar src={url} alt="Broken Org" />);
        const img = screen.getByRole('img', { name: 'Broken Org' });
        expect(img).toBeInTheDocument();

        fireEvent.error(img);

        expect(screen.getByText('🌾')).toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'Broken Org' })).toBeInTheDocument();
        expect(screen.queryByText(url)).not.toBeInTheDocument();
    });

    it('falls back to custom fallback glyph', () => {
        render(<Avatar src="" alt="User" fallbackGlyph="A" />);
        expect(screen.getByText('A')).toBeInTheDocument();
    });

    it('does not render raw string for unknown bundled key or invalid URL', () => {
        render(<Avatar src="bundled://nonexistent" alt="" />);
        expect(screen.getByText('🌾')).toBeInTheDocument();
        expect(screen.queryByText('bundled://nonexistent')).not.toBeInTheDocument();
        expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });
});
