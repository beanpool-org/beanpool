import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet, AppState, DeviceEventEmitter } from 'react-native';
import { router, usePathname } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIdentity } from '../app/IdentityContext';
import { useTheme } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import { getConversations, getDecisions, getMarketplaceTransactions, signedGet } from '../utils/db';

// MOCK v4 (mock/header-slim): the slot between the bean and the invite icon holds small ICONS,
// one per kind of thing that needs the member, and only while something of that kind does. No text.
// Tapping an icon goes to that section, or to the item itself when there is only one.

type Kind = 'deal' | 'vote' | 'message' | 'group';
/** Priority order, highest first: the ones that don't fit are the lowest. */
const KINDS: Kind[] = ['deal', 'vote', 'message', 'group'];
const ICON: Record<Kind, string> = {
    deal: 'handshake-outline',
    vote: 'vote-outline',
    message: 'message-text-outline',
    group: 'account-group-outline',
};

export interface NeedsYouEntry {
    kind: Kind;
    count: number;
    /** Only a deal waiting on you, or a vote closing within 48h, gets the accent. */
    accent: boolean;
    /** In words, for screen readers and the "•••" sheet: "2 deals waiting for you". */
    label: string;
    go: () => void;
}

// Warm and readable on the dark vine header in both themes (the header image is dark in light mode too).
const ACCENT = palette.amber300;
const NEUTRAL = '#ffffff';
const VOTE_WINDOW_MS = 48 * 3600_000;
const SLOT = 48;

function closesIn(closesAt: string): string {
    const ms = new Date(closesAt).getTime() - Date.now();
    const h = Math.round(ms / 3600_000);
    if (h < 1) return 'closes within the hour';
    if (h < 12) return `closes in ${h} hours`;
    if (new Date(closesAt).toDateString() === new Date().toDateString()) return 'closes tonight';
    return h < 36 ? 'closes tomorrow' : `closes in ${Math.round(h / 24)} days`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const toDeals = () => router.push({ pathname: '/(tabs)/', params: { tab: 'deals' } });
const toCommons = () => router.push('/(tabs)/projects');
const toMessages = () => router.push({ pathname: '/(tabs)/chats', params: { view: 'messages' } });

async function loadReal(me: string): Promise<NeedsYouEntry[]> {
    const settle = <T,>(p: Promise<T>) => p.catch(() => null);
    const [txns, open, convs, yours] = await Promise.all([
        settle(getMarketplaceTransactions(me)),
        settle(getDecisions('open')),
        settle(getConversations(me)),
        settle(signedGet('/api/your-groups').then(r => (r.ok ? r.json() : null))),
    ]);
    const out: NeedsYouEntry[] = [];

    // Deals: the step that is yours to take (accept a request, confirm, deliver).
    const deals = (txns || []).filter((t: any) => {
        const iSell = t.sellerPublicKey === me;
        return (t.status === 'requested' && iSell) || t.status === 'pending';
    });
    if (deals.length) {
        const t = deals[0];
        out.push({
            kind: 'deal', count: deals.length, accent: true,
            label: deals.length === 1 ? 'A deal is waiting for you' : `${deals.length} deals waiting for you`,
            go: deals.length === 1 ? () => router.push({ pathname: '/post/[id]', params: { id: t.postId, txId: t.id } }) : toDeals,
        });
    }

    // Votes you haven't cast; accent only when one closes within 48h.
    const votes = (open?.decisions || []).filter((d: any) => {
        const closes = new Date(d.closesAt).getTime();
        return !d.myVote && closes > Date.now() && new Date(d.opensAt).getTime() <= Date.now();
    }).sort((a: any, b: any) => new Date(a.closesAt).getTime() - new Date(b.closesAt).getTime());
    if (votes.length) {
        const soonest = votes[0];
        const soon = new Date(soonest.closesAt).getTime() - Date.now() <= VOTE_WINDOW_MS;
        const when = closesIn(soonest.closesAt);
        out.push({
            kind: 'vote', count: votes.length, accent: soon,
            label: votes.length === 1 ? `Vote ${when}` : `${votes.length} votes to cast, the first ${when}`,
            go: toCommons,
        });
    }

    // Unread direct messages. (@mentions: no client-side signal yet — see notes.)
    const dms = (convs || []).filter((c: any) => c.unread && (!c.type || ['dm', 'marketplace', 'post'].includes(c.type)));
    if (dms.length) {
        out.push({
            kind: 'message', count: dms.length, accent: false,
            label: dms.length === 1 ? `Unread message from ${dms[0].peer}` : `${dms.length} unread messages`,
            go: dms.length === 1 ? () => router.push(`/chat/${dms[0].id}`) : toMessages,
        });
    }

    // Unread lines in your groups (GET /api/your-groups; muted chats skipped).
    const groups = (yours?.items || []).filter((g: any) => g.unreadCount && (!g.mute || g.mute === 'none'));
    if (groups.length) {
        const lines = groups.reduce((n: number, g: any) => n + g.unreadCount, 0);
        out.push({
            kind: 'group', count: groups.length, accent: false,
            label: groups.length === 1 ? `${plural(lines, 'new line', 'new lines')} in ${groups[0].name}` : `New lines in ${groups.length} of your groups`,
            go: groups.length === 1 ? () => router.push(`/chat/${groups[0].conversationId}`) : toMessages,
        });
    }
    return out;
}

// ── DEV-ONLY MOCK SWITCH ─────────────────────────────────────────────────────────────────────────
// Long-press the empty slot (dev builds only) to cycle states the test node can't produce on its own.
const MOCK_KEY = 'beanpool_MOCK_needs_you_mode';
const MOCK_MODES = ['real', 'MOCK-none', 'MOCK-one', 'MOCK-three', 'MOCK-all'] as const;
type MockMode = typeof MOCK_MODES[number];
const MOCK: Record<Kind, NeedsYouEntry> = {
    deal: { kind: 'deal', count: 2, accent: true, label: '2 deals waiting for you', go: toDeals },
    vote: { kind: 'vote', count: 1, accent: true, label: 'Vote closes tomorrow', go: toCommons },
    message: { kind: 'message', count: 1, accent: false, label: 'Unread message from Ana', go: toMessages },
    group: { kind: 'group', count: 3, accent: false, label: 'New lines in 3 of your groups', go: toMessages },
};
function mockEntries(mode: MockMode): NeedsYouEntry[] | null {
    switch (mode) {
        case 'MOCK-none': return [];
        case 'MOCK-one': return [{ ...MOCK.vote }];
        case 'MOCK-three': return [MOCK.deal, MOCK.vote, MOCK.message];
        case 'MOCK-all': return KINDS.map(k => MOCK[k]);
        default: return null;
    }
}

function NeedIcon({ e, onPress }: { e: NeedsYouEntry; onPress: () => void }) {
    const color = e.accent ? ACCENT : NEUTRAL;
    return (
        <Pressable onPress={onPress} style={({ pressed }) => [s.slot, pressed && s.pressed]}
            accessibilityRole="button" accessibilityLabel={e.label}>
            <MaterialCommunityIcons name={ICON[e.kind] as any} size={24} color={color} style={s.iconShadow} />
            {e.count > 1 && (
                <View style={[s.countDot, { backgroundColor: e.accent ? ACCENT : 'rgba(255,255,255,0.9)' }]}>
                    <Text style={s.countText} maxFontSizeMultiplier={1}>{e.count > 9 ? '9+' : e.count}</Text>
                </View>
            )}
        </Pressable>
    );
}

export function NeedsYouIcons() {
    const { identity } = useIdentity();
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const pathname = usePathname();
    const [real, setReal] = useState<NeedsYouEntry[]>([]);
    const [mode, setMode] = useState<MockMode>('real');
    const [sheet, setSheet] = useState(false);
    const [width, setWidth] = useState(0);
    const busy = useRef(false);

    useEffect(() => {
        if (!__DEV__) return;
        AsyncStorage.getItem(MOCK_KEY).then(v => { if (v && (MOCK_MODES as readonly string[]).includes(v)) setMode(v as MockMode); }).catch(() => {});
    }, []);

    const refresh = useCallback(async () => {
        if (!identity?.publicKey || busy.current) return;
        busy.current = true;
        try { setReal(await loadReal(identity.publicKey)); } catch { /* keep what we had */ } finally { busy.current = false; }
    }, [identity?.publicKey]);

    // Same rhythm as the tab badges: on open, on each page change, every 30s while active, and on a ws nudge.
    useEffect(() => { refresh(); }, [refresh, pathname]);
    useEffect(() => {
        const iv = setInterval(() => { if (AppState.currentState === 'active') refresh(); }, 30_000);
        const ws = DeviceEventEmitter.addListener('ws_activity', refresh);
        return () => { clearInterval(iv); ws.remove(); };
    }, [refresh]);

    const cycleMock = () => {
        if (!__DEV__) return;
        const next = MOCK_MODES[(MOCK_MODES.indexOf(mode) + 1) % MOCK_MODES.length];
        setMode(next);
        AsyncStorage.setItem(MOCK_KEY, next).catch(() => {});
    };

    const entries = mockEntries(mode) ?? real;
    // Every icon is a 48dp slot. If they don't all fit, the last slot becomes "•••" for the rest.
    const slots = Math.floor(width / SLOT);
    const overflow = width > 0 && entries.length > slots;
    const shown = overflow ? entries.slice(0, Math.max(0, slots - 1)) : entries;

    return (
        <Pressable style={s.row} onLayout={e => setWidth(e.nativeEvent.layout.width)}
            onLongPress={__DEV__ ? cycleMock : undefined} delayLongPress={600}
            accessible={false} importantForAccessibility="no">
            {shown.map(e => <NeedIcon key={e.kind} e={e} onPress={e.go} />)}
            {overflow && (
                <Pressable onPress={() => setSheet(true)} style={({ pressed }) => [s.slot, pressed && s.pressed]}
                    accessibilityRole="button" accessibilityLabel={`${entries.length - shown.length} more things need you`}>
                    <MaterialCommunityIcons name="dots-horizontal" size={24} color={NEUTRAL} style={s.iconShadow} />
                </Pressable>
            )}

            <Modal visible={sheet} transparent animationType="fade" onRequestClose={() => setSheet(false)}>
                <Pressable style={s.sheetBg} onPress={() => setSheet(false)} accessibilityRole="button" accessibilityLabel="Close">
                    <View style={[s.sheet, { marginTop: insets.top + 52, backgroundColor: colors.surface.card }]}>
                        <Text style={[s.sheetTitle, { color: colors.text.secondary }]}>Needs you</Text>
                        {entries.map(e => (
                            <Pressable key={e.kind} style={({ pressed }) => [s.sheetRow, pressed && { backgroundColor: colors.surface.subtle }]}
                                onPress={() => { setSheet(false); e.go(); }} accessibilityRole="button" accessibilityLabel={e.label}>
                                <MaterialCommunityIcons name={ICON[e.kind] as any} size={22}
                                    color={e.accent ? palette.amber600 : colors.text.secondary} />
                                <Text style={[s.sheetText, { color: colors.text.heading, fontWeight: e.accent ? '700' : '500' }]} numberOfLines={2}>
                                    {e.label}
                                </Text>
                                <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.muted} />
                            </Pressable>
                        ))}
                    </View>
                </Pressable>
            </Modal>
        </Pressable>
    );
}

const s = StyleSheet.create({
    row: { flex: 1, minWidth: 0, height: 48, flexDirection: 'row', alignItems: 'center' },
    slot: { width: SLOT, height: SLOT, alignItems: 'center', justifyContent: 'center', borderRadius: 24 },
    pressed: { backgroundColor: 'rgba(255,255,255,0.15)' },
    iconShadow: { textShadowColor: 'rgba(0,0,0,0.75)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
    countDot: { position: 'absolute', top: 7, right: 5, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center' },
    countText: { color: '#1f2937', fontSize: 10, fontWeight: '900' },
    sheetBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center' },
    sheet: { width: '92%', borderRadius: 16, paddingVertical: 8, elevation: 6 },
    sheetTitle: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, paddingHorizontal: 16, paddingVertical: 8 },
    sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16, paddingVertical: 8 },
    sheetText: { flex: 1, fontSize: 15 },
});
