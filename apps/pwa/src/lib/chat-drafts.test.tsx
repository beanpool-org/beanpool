/**
 * A chat's unsent words, kept for that chat while the page is open (lib/chat-drafts.ts): the hook every chat box uses.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React, { useState } from 'react';
import { draftKey, keepDraft, keptDraft, useKeptDraft } from './chat-drafts';

/**
 * A chat page's box, as MessagesPage holds it: one box for whichever chat is open. `switchTo` opens another chat and, in the
 * same render, puts `prefill` in the box (a way in that brings words for the next chat).
 */
function Page({ initial }: { initial: string | null }) {
    const [chat, setChat] = useState<string | null>(initial);
    const [text, setText] = useState('');
    useKeptDraft(draftKey('ME', 'chat', chat), text, setText);
    return (
        <>
            {chat && <textarea data-testid="box" value={text} onChange={(e) => setText(e.target.value)} />}
            <button type="button" onClick={() => setChat(null)}>close</button>
            <button type="button" onClick={() => setChat('a')}>open a</button>
            <button type="button" onClick={() => { setChat('b'); setText('prefill for B'); }}>switch to b</button>
        </>
    );
}
const box = () => screen.getByTestId('box') as HTMLTextAreaElement;
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('useKeptDraft', () => {
    it('keeps what the box held when its chat closes, and gives it back when that chat opens again', () => {
        render(<Page initial="a" />);
        fireEvent.change(box(), { target: { value: 'half a thought' } });
        press('close');
        expect(keptDraft(draftKey('ME', 'chat', 'a')!)).toBe('half a thought');
        press('open a');
        expect(box().value).toBe('half a thought');
    });

    it('a chat switched straight to another keeps the first one\'s words, never the words the switch brought for the next one', () => {
        render(<Page initial="a" />);
        fireEvent.change(box(), { target: { value: 'for A' } });
        press('switch to b');
        expect(keptDraft(draftKey('ME', 'chat', 'a')!)).toBe('for A');
        press('open a');
        expect(box().value).toBe('for A');
    });

    it('an emptied box keeps nothing: the words go when they are sent', () => {
        render(<Page initial="a" />);
        fireEvent.change(box(), { target: { value: 'sent now' } });
        fireEvent.change(box(), { target: { value: '' } });
        press('close');
        expect(keptDraft(draftKey('ME', 'chat', 'a')!)).toBe('');
        const key = draftKey('ME', 'chat', 'c')!;
        keepDraft(key, 'something');
        keepDraft(key, '   ');
        expect(keptDraft(key)).toBe('');
    });

    it('each account\'s drafts are its own; no chat, no key', () => {
        expect(draftKey('ME', 'chat', 'a')).not.toBe(draftKey('YOU', 'chat', 'a'));
        expect(draftKey('ME', 'chat', 'a')).not.toBe(draftKey('ME', 'event', 'a'));
        expect(draftKey(null, 'chat', 'a')).toBeNull();
        expect(draftKey('ME', 'chat', null)).toBeNull();
    });
});
