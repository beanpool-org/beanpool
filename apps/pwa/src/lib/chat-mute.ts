/**
 * Chat muting helpers for web (parity with apps/native/utils/your-groups.ts).
 */
import { t, tn, word, type WordKey } from '@beanpool/core';
import type { YourChatMute } from './api';

export function isMuted(mute: YourChatMute | null | undefined, now: Date = new Date()): boolean {
    if (!mute) return false;
    if (mute.always || mute.mutedUntil === null) return true;
    const tVal = new Date(mute.mutedUntil).getTime();
    return !isNaN(tVal) && tVal > now.getTime();
}

export function muteMenuLabel(mute: YourChatMute | null | undefined, now: Date = new Date()): string {
    return isMuted(mute, now) ? t('Unmute') : t('Mute notifications');
}

export function chatMuteFromAnswer(answer: { mute?: YourChatMute | null } | null | undefined, current: YourChatMute | null = null): YourChatMute | null {
    return answer && 'mute' in answer ? (answer.mute ?? null) : current;
}

export function groupHeaderDetail(memberCount: number | null, muted: boolean): string | null {
    if (memberCount != null && muted) return tn(memberCount, '{n} member · muted', '{n} members · muted');
    if (memberCount != null) return tn(memberCount, '{n} member', '{n} members');
    return muted ? t('muted', undefined, 'chat') : null;
}

export const MUTE_CHOICES: Array<{ key: '8h' | '1w' | 'always'; label: WordKey }> = [
    { key: '8h', label: word('For 8 hours') },
    { key: '1w', label: word('For a week') },
    { key: 'always', label: word('Always', 'mute for') },
];
