/**
 * A chat's unsent words, kept for that chat while the page is open (lib/chat-drafts.ts): the hook every chat box uses.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React, { useState } from 'react';
import { draftKey, draftSent, forgetDraftsForTests, keepDraft, keptDraft, useKeptDraft } from './chat-drafts';

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

/**
 * A send whose answer lands after the member left (review of #3223 at 4c7916a5): the words that went are dropped by the key
 * taken at Send (draftSent), and only a box still showing that chat, still holding those words, is emptied. Both shapes a box
 * comes in: one box for whichever chat is open (MessagesPage) and a box per chat, gone when it closes (EventChat, an outside
 * chat, a forum topic).
 *
 *   (taken | refused | failed)  x  (stay | leave | switch to another chat | leave and open it again)  before the answer
 *     -> the box on screen holds the right words, the chat opened afterwards holds '' (taken) or the words (not taken),
 *        another chat's box is never touched, and the words went once.
 */
type Outcome = 'taken' | 'refused' | 'failed';
type Answer = { outcome: Outcome; land: () => void };
function SendingPage({ shape, send }: { shape: 'one box' | 'box per chat'; send: (text: string) => Promise<'taken' | 'refused'> }) {
    const [chat, setChat] = useState<string | null>('a');
    return (
        <>
            {chat && (shape === 'one box' ? <ChatBox chat={chat} send={send} /> : <ChatBox key={chat} chat={chat} send={send} />)}
            <button type="button" onClick={() => setChat(null)}>close</button>
            <button type="button" onClick={() => setChat('a')}>open a</button>
            <button type="button" onClick={() => setChat('b')}>open b</button>
        </>
    );
}
function ChatBox({ chat, send }: { chat: string; send: (text: string) => Promise<'taken' | 'refused'> }) {
    const [text, setText] = useState('');
    const key = draftKey('ME', 'chat', chat);
    useKeptDraft(key, text, setText);
    const submit = async () => {
        const words = text.trim();
        const sentFrom = key;   // taken at Send
        try {
            if (await send(words) === 'taken') draftSent(sentFrom, words);
        } catch { /* failed: the words stay */ }
    };
    return (
        <>
            <textarea data-testid="box" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="button" onClick={() => void submit()}>send</button>
        </>
    );
}

describe('draftSent: a send that lands after the member left', () => {
    for (const shape of ['one box', 'box per chat'] as const) {
        for (const outcome of ['taken', 'refused', 'failed'] as const) {
            for (const leave of ['stay', 'leave', 'switch', 'leave and open again'] as const) {
                it(`${shape}: ${outcome}, ${leave} before the answer`, async () => {
                    forgetDraftsForTests();
                    keepDraft(draftKey('ME', 'chat', 'b')!, 'for B');
                    const sends: string[] = [];
                    let answer: Answer | null = null;
                    const send = (text: string) => new Promise<'taken' | 'refused'>((resolve, reject) => {
                        sends.push(text);
                        answer = {
                            outcome,
                            land: () => (outcome === 'failed' ? reject(new Error('offline')) : resolve(outcome)),
                        };
                    });
                    const view = render(<SendingPage shape={shape} send={send} />);
                    fireEvent.change(box(), { target: { value: 'See you there ' } });
                    press('send');
                    if (leave === 'leave') press('close');
                    if (leave === 'switch') press('open b');
                    if (leave === 'leave and open again') { press('close'); press('open a'); }
                    await act(async () => { answer!.land(); await Promise.resolve(); await Promise.resolve(); });
                    const words = outcome === 'taken' ? '' : 'See you there ';
                    if (leave === 'stay' || leave === 'leave and open again') expect(box().value).toBe(words);
                    if (leave === 'switch') expect(box().value, "another chat's box is never touched").toBe('for B');
                    if (leave === 'leave') expect(screen.queryByTestId('box')).toBeNull();
                    press('close');
                    press('open a');
                    expect(box().value, 'chat a opened afterwards').toBe(words);
                    expect(keptDraft(draftKey('ME', 'chat', 'b')!)).toBe('for B');
                    expect(sends).toEqual(['See you there']);
                    view.unmount();
                });
            }
        }
    }

    it('words written in the box after Send stay when the send lands', async () => {
        forgetDraftsForTests();
        let land: () => void = () => {};
        render(<SendingPage shape="one box" send={() => new Promise((r) => { land = () => r('taken'); })} />);
        fireEvent.change(box(), { target: { value: 'first' } });
        press('send');
        fireEvent.change(box(), { target: { value: 'first, and more' } });
        await act(async () => { land(); await Promise.resolve(); await Promise.resolve(); });
        expect(box().value).toBe('first, and more');
    });

    it('no key, or no words, does nothing', () => {
        forgetDraftsForTests();
        const key = draftKey('ME', 'chat', 'c')!;
        keepDraft(key, 'kept');
        draftSent(null, 'kept');
        draftSent(key, '   ');
        expect(keptDraft(key)).toBe('kept');
        draftSent(key, ' kept ');
        expect(keptDraft(key)).toBe('');
    });
});
