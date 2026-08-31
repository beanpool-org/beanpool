import { describe, it, expect } from 'vitest';
import {
    platformMeta, categoryMeta, isWebUrl, PLATFORMS, CATEGORIES,
    type ChannelPlatform, type ChannelCategory
} from '../channels.js';

describe('channels platform vocabulary and metadata', () => {
    it('resolves known platforms accurately', () => {
        expect(platformMeta('youtube')).toEqual({
            id: 'youtube',
            icon: '🎥',
            label: 'YouTube',
            listing: 'auto',
            hint: 'youtube.com/@you',
        });

        expect(platformMeta('instagram')).toEqual({
            id: 'instagram',
            icon: '📷',
            label: 'Instagram',
            listing: 'manual',
            hint: '@yourhandle',
        });

        expect(platformMeta('tiktok')).toEqual({
            id: 'tiktok',
            icon: '🎵',
            label: 'TikTok',
            listing: 'manual',
            hint: '@yourhandle',
        });

        expect(platformMeta('website')).toEqual({
            id: 'website',
            icon: '🌐',
            label: 'Website',
            listing: 'card',
            hint: 'yoursite.com',
        });

        expect(platformMeta('facebook')).toEqual({
            id: 'facebook',
            icon: '📘',
            label: 'Facebook',
            listing: 'manual',
            hint: 'facebook.com/yourpage',
        });

        expect(platformMeta('rss')).toEqual({
            id: 'rss',
            icon: '✍️',
            label: 'Blog / RSS',
            listing: 'auto',
            hint: 'yourblog.com/feed',
        });
    });

    it('NEVER falls back to PLATFORMS[0] for unknown platform ids', () => {
        const fallback = platformMeta('unknown_platform_xyz');
        expect(fallback.id).toBe('unknown_platform_xyz');
        expect(fallback.icon).toBe('🔗');
        expect(fallback.label).toBe('Link');
        expect(fallback.listing).toBe('card');
        expect(fallback.label).not.toBe(PLATFORMS[0].label);

        const nullFallback = platformMeta(null);
        expect(nullFallback.icon).toBe('🔗');
        expect(nullFallback.label).toBe('Link');
    });

    it('resolves known categories accurately', () => {
        expect(categoryMeta('community')).toEqual({
            id: 'community',
            icon: '📣',
            label: 'Community',
        });
        expect(categoryMeta('food')).toEqual({
            id: 'food',
            icon: '🌱',
            label: 'Food & growing',
        });
        expect(categoryMeta('craft')).toEqual({
            id: 'craft',
            icon: '🔨',
            label: 'Making & craft',
        });
        expect(categoryMeta('repair')).toEqual({
            id: 'repair',
            icon: '🔧',
            label: 'Repair & reuse',
        });
        expect(categoryMeta('art')).toEqual({
            id: 'art',
            icon: '🎨',
            label: 'Art & music',
        });
        expect(categoryMeta('business')).toEqual({
            id: 'business',
            icon: '☕',
            label: 'Business',
        });
        expect(categoryMeta('other')).toEqual({
            id: 'other',
            icon: '✨',
            label: 'Other',
        });
    });

    it('NEVER falls back to CATEGORIES[0] for unknown category ids', () => {
        const fallback = categoryMeta('non_existent_category');
        expect(fallback.id).toBe('non_existent_category');
        expect(fallback.icon).toBe('✨');
        expect(fallback.label).toBe('Other');
        expect(fallback.label).not.toBe(CATEGORIES[0].label);

        const nullFallback = categoryMeta(null);
        expect(nullFallback.icon).toBe('✨');
        expect(nullFallback.label).toBe('Other');
    });
});

describe('isWebUrl — what may become a link', () => {
    it('accepts http and https, case-insensitively, and tolerates padding', () => {
        expect(isWebUrl('https://www.instagram.com/beanpool/')).toBe(true);
        expect(isWebUrl('http://example.org')).toBe(true);
        expect(isWebUrl('HTTPS://WWW.YOUTUBE.COM/@beanpool')).toBe(true);
        expect(isWebUrl('  https://example.org  ')).toBe(true);
    });

    it('rejects a missing url, which is what a tombstoned row carries', () => {
        expect(isWebUrl(null)).toBe(false);
        expect(isWebUrl(undefined)).toBe(false);
        expect(isWebUrl('')).toBe(false);
        expect(isWebUrl('   ')).toBe(false);
    });

    it('rejects schemes that must never reach an href', () => {
        expect(isWebUrl('javascript:alert(1)')).toBe(false);
        expect(isWebUrl('JavaScript:alert(1)')).toBe(false);
        expect(isWebUrl('  javascript:alert(1)')).toBe(false);
        expect(isWebUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
        expect(isWebUrl('file:///etc/passwd')).toBe(false);
        expect(isWebUrl('vbscript:msgbox(1)')).toBe(false);
    });

    it('rejects a bare path or host, so it cannot be mistaken for a relative link', () => {
        expect(isWebUrl('#')).toBe(false);
        expect(isWebUrl('/beanpool')).toBe(false);
        expect(isWebUrl('www.instagram.com/beanpool')).toBe(false);
        expect(isWebUrl('//evil.example')).toBe(false);
    });
});
