/**
 * The recovery kit on the web (RecoveryKitButton, lib/recovery-kit.ts): one optional button by the 12 words that asks
 * first, then prints the kit from a frame that is gone afterwards. The browser's print is a stand-in.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RecoveryKitButton } from './RecoveryKitButton';
import { KIT_WEB_RESTORE_STEPS } from '@beanpool/core';
import { printKitInFrame } from '../lib/recovery-kit';

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const WARNING = 'Keep this page or file off cloud backups and chats. Anyone who has it can sign in as you.';
const FAILED = 'The recovery kit couldn’t be made in this browser. Write the 12 words down instead.';

afterEach(cleanup);

function setup(print: (w: Window) => void) {
    const seen: { html: string; inDom: boolean }[] = [];
    const printer = vi.fn((w: Window) => {
        seen.push({ html: w.document.documentElement.outerHTML, inDom: document.querySelectorAll('iframe').length === 1 });
        print(w);
    });
    render(<RecoveryKitButton words={WORDS} print={printer} />);
    return { printer, seen };
}

describe('RecoveryKitButton', () => {
    it('is one button, and nothing without 12 words', () => {
        setup(() => {});
        expect(screen.getByRole('button', { name: 'Print or save your recovery kit' })).toBeTruthy();
        cleanup();
        render(<RecoveryKitButton words={WORDS.slice(0, 11)} />);
        expect(screen.queryByRole('button', { name: 'Print or save your recovery kit' })).toBeNull();
    });

    it('asks first with the warning; Cancel prints nothing and leaves no frame', () => {
        const { printer } = setup(() => {});
        fireEvent.click(screen.getByRole('button', { name: 'Print or save your recovery kit' }));
        expect(screen.getByText(WARNING)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(printer).not.toHaveBeenCalled();
        expect(document.querySelector('iframe')).toBeNull();
        expect(screen.queryByText(WARNING)).toBeNull();
    });

    it('Continue prints the kit: all 12 words in order, no callsign, name or key; the frame is gone afterwards', async () => {
        const { printer, seen } = setup(() => {});
        fireEvent.click(screen.getByRole('button', { name: 'Print or save your recovery kit' }));
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
        await vi.waitFor(() => expect(printer).toHaveBeenCalledTimes(1));
        expect(seen[0].inDom).toBe(true);
        const html = seen[0].html;
        expect(html).toContain('Your BeanPool recovery kit');
        let at = -1;
        for (const word of WORDS) {
            const found = html.indexOf(`>${word}<`, at + 1);
            expect(found, word).toBeGreaterThan(at);
            at = found;
        }
        expect(html).toContain(`Address: <strong>${window.location.origin}</strong>`);
        expect(html).not.toMatch(/callsign|publicKey|private/i);
        await vi.waitFor(() => expect(document.querySelector('iframe')).toBeNull());
        expect(screen.queryByText(/printed|saved|success/i)).toBeNull();
    });

    it('when print throws: the frame is still removed, and the failure line shows', async () => {
        setup(() => { throw new Error('no print here'); });
        fireEvent.click(screen.getByRole('button', { name: 'Print or save your recovery kit' }));
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
        expect(await screen.findByText(FAILED)).toBeTruthy();
        expect(document.querySelector('iframe')).toBeNull();
    });
});

describe('printKitInFrame', () => {
    it('removes the frame after print, and when print throws', async () => {
        expect(await printKitInFrame('<p>x</p>', () => {})).toBe('done');
        expect(document.querySelector('iframe')).toBeNull();
        expect(await printKitInFrame('<p>x</p>', () => { throw new Error('x'); })).toBe('failed');
        expect(document.querySelector('iframe')).toBeNull();
    });
});

describe('the kit’s web steps match the web app’s screens (review 4170915901)', () => {
    const src = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
    const app = src('../App.tsx');
    const lobby = src('../pages/GuestLobby.tsx');
    const join = src('./WebJoin.tsx');
    const welcome = src('../pages/WelcomePage.tsx').replace(/<span aria-hidden="true">🔑<\/span> /g, '🔑 ');
    const between = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));
    const named = KIT_WEB_RESTORE_STEPS.join('\n').match(/“[^”]+”/g)!.map((q) => q.slice(1, -1));

    it('every button the steps name is on a web restore screen', () => {
        expect(named).toEqual(['Already have BeanPool?', '🔑 Restore Existing Identity →', 'Use my 12 words', '🔑 Recover with 12 Words', 'Recover Identity']);
        for (const name of named) expect([lobby, join, welcome].some((s) => s.includes(name))).toBe(true);
    });

    it('the global community: its address opens the lobby, whose "Already have BeanPool?" opens the ways back', () => {
        expect(app).toMatch(/visitorsSeeListings\(info\) && !inFlight \? \{ kind: 'lobby'/);
        const have = between(lobby, 'data-testid="lobby-have-account"', '</button>');
        expect(have).toContain("openJoin('restore')");
        expect(have).toContain('Already have BeanPool?');
        // An open door: WebJoin's "Bring your account here", whatever the node's words door says.
        const restore = between(join, "case 'restore':", "case 'name':");
        expect(restore).toContain("onRestore('words')");
        expect(restore).toMatch(/Use my 12 words/);
        expect(restore).not.toMatch(/wordsDoor|wordsOpen/);
        // A shut door: WelcomePage opens on the member options, whose words button is "🔑 Recover with 12 Words".
        expect(welcome).toContain("useState(() => start === 'restore')");
        expect(welcome).toMatch(/setShowRecovery\(true\); setError\(null\); \}\}[\s\S]{0,900}🔑 Recover with 12 Words/);
    });

    it('a local community: the invite page’s "🔑 Restore Existing Identity →", and an open door’s "Already have BeanPool?"', () => {
        const invite = between(welcome, '/* ===== NEW USER SIGNUP + FAQs ===== */', '/* ===== MAIN WELCOME');
        expect(invite).toContain('Join with Invite Code');
        expect(invite).toContain('🔑 Restore Existing Identity →');
        expect(between(join, "case 'lobby':", "case 'guard':")).toContain('Already have BeanPool?');
        // Every way ends at the twelve boxes and "Recover Identity".
        expect(between(welcome, '/* ===== RECOVERY FROM 12 WORDS ===== */', '← ')).toContain("'Recover Identity'");
    });
});

describe('where the button is', () => {
    const welcome = readFileSync(resolve(__dirname, '../pages/WelcomePage.tsx'), 'utf8');
    const settings = readFileSync(resolve(__dirname, '../pages/SettingsPage.tsx'), 'utf8');
    const lib = readFileSync(resolve(__dirname, '../lib/recovery-kit.ts'), 'utf8');
    const button = readFileSync(resolve(__dirname, './RecoveryKitButton.tsx'), 'utf8');

    it('sits by the joining step’s words and by Settings’ Recovery Phrase', () => {
        const grid = welcome.indexOf('data-testid="backup-words"');
        const kit = welcome.indexOf('<RecoveryKitButton words={pendingWords');
        expect(kit).toBeGreaterThan(grid);
        expect(kit).toBeLessThan(welcome.indexOf('I\'ve written these words down somewhere safe'));
        const seed = settings.indexOf("mode === 'seed'");
        const sKit = settings.indexOf('<RecoveryKitButton words={seedWords');
        expect(sKit).toBeGreaterThan(seed);
        expect(sKit).toBeLessThan(settings.indexOf('Copy All Words'));
    });

    it('never gates joining: Next is disabled only while loading and does not mention the kit', () => {
        const next = welcome.lastIndexOf('<button', welcome.indexOf('Next →'));
        const block = welcome.slice(next, welcome.indexOf('Next →'));
        expect(block).toContain('disabled={loading}');
        expect(block).not.toMatch(/[Kk]it/);
    });

    it('sends the words nowhere else: no console, storage, URL or clipboard', () => {
        for (const src of [lib, button]) {
            expect(src).not.toMatch(/console\.|localStorage|sessionStorage|indexedDB|clipboard|location\.(href|hash|search)\s*=|history\.|window\.open/);
        }
    });

    it('is a 44px target whose label wraps', () => {
        expect(button).toMatch(/minHeight: 44|min-h-\[44px\]/);
        expect(button).toMatch(/whiteSpace: 'normal'|whitespace-normal/);
    });
});
