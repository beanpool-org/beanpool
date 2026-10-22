// @vitest-environment jsdom
/**
 * The composer's clear sweep must not wipe a draft the screen put back on purpose (components/chat/ChatComposer.tsx).
 *
 * After a send, scheduleClearSweep re-clears the box at 400 / 1200 / 3000 / 6000 ms when its only write since the send
 * carries exactly the sent text (the signature of Android's dropped-clear echo). Edit on a message just sent fills the
 * box with exactly that text in ONE write (setText), so the sweep took it for the echo and emptied the box about a
 * second later (tester, 22 Oct, app 1.2.75: "the text appeared for about 1 second then it just disappeared"). A refused
 * send restoring its text (app/chat/[id].tsx, restoredDraft) has the same shape. setText now cancels the pending sweep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, createRef, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const box: { onChangeText?: (t: string) => void; send?: () => void } = {};

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => createElement(tag, null, props.children);
    const TextInput = forwardRef((props: Record<string, any>, ref) => {
        box.onChangeText = props.onChangeText;
        useImperativeHandle(ref, () => ({ clear: () => { }, setNativeProps: () => { }, focus: () => { } }));
        return createElement('input', { 'aria-label': props.accessibilityLabel });
    });
    const Pressable = (props: Record<string, any>) => {
        if (props.accessibilityLabel === 'Send message') box.send = () => props.onPress?.();
        return createElement('button', null, props.children);
    };
    return {
        View: el('div'), Text: el('span'), TextInput, Pressable,
        ActivityIndicator: () => null,
        StyleSheet: { create: (s: unknown) => s },
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: 'light', colors: lightColors }) };
});

import { ChatComposer, type ChatComposerHandle } from '../../components/chat/ChatComposer';

const anyStyles = new Proxy({}, { get: () => ({}) }) as any;

describe('ChatComposer: a draft put back right after a send stays', () => {
    let root: Root;
    let host: HTMLDivElement;
    const ref = createRef<ChatComposerHandle>();

    beforeEach(async () => {
        vi.useFakeTimers();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root.render(createElement(ChatComposer, { ref, styles: anyStyles, onSend: async () => { }, placeholder: 'Message', accessibilityLabel: 'Message', bottomPadding: 12 }) as any);
        });
    });
    afterEach(async () => {
        await act(async () => { root.unmount(); });
        host.remove();
        vi.useRealTimers();
    });

    const typeAndSend = async (text: string) => {
        await act(async () => { box.onChangeText!(text); });
        await act(async () => { box.send!(); });
        expect(ref.current!.currentText()).toBe('');
    };

    it('Edit on the message just sent keeps its text in the box', async () => {
        await typeAndSend('OK new message then edit');
        await act(async () => { vi.advanceTimersByTime(300); });
        await act(async () => { ref.current!.setText('OK new message then edit'); });
        await act(async () => { vi.advanceTimersByTime(7000); });
        expect(ref.current!.currentText()).toBe('OK new message then edit');
    });

    it('still clears a dropped-clear echo (one write of the sent text with no setText)', async () => {
        await typeAndSend('hello');
        await act(async () => { box.onChangeText!('hello'); });
        await act(async () => { vi.advanceTimersByTime(1300); });
        expect(ref.current!.currentText()).toBe('');
    });
});
