/**
 * The owners' and admins' part of People → Invites (DESIGN-invites-and-names-list-amend3-fable.md §1, slice A2): under the vouch
 * presets, "Add them to the names list" with their real name, and "Make them a voucher" with a budget. Members never see it.
 * The rules are utils/invite-names.ts; the list's own flows (open, seal, add, bind) are core's, as the names list uses them.
 *
 * Ticking the names box opens the list on this phone (each read is logged on the node, as the list's screen does), so the
 * duplicate-name warning can look at every name: the node never sees one. The vouch presets stay as they are (Marty's Q1:
 * allow both). The voucher box is greyed for an admin not on the credit committee, with no connection, or until the names
 * box is ticked, each with its sentence. Every row is at least 48 dp tall and wraps at 320 dp with 1.3× text.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { formatNumber, t, INVITE_ADDS_WORDS } from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';
import type { BeanPoolIdentity } from '../utils/identity';
import {
    DEVICE_NAMES_STORE as STORE, NAMES_COPY, openNamesList, openEntries, saveNamesEntry, inviteForNamesEntry, newEntryId, type NamesOpened,
} from '../utils/names-list';
import { makeOfflineTicket } from '../utils/member-statements';
import { nearestBudgetLevel, budgetLevelUp, budgetLevelDown } from '../utils/voucher-rules';
import {
    voucherBoxWhy, voucherBoxWords, sameNameOnList, sameNameWords, inviteWithNamesEntry, type NamesInviteResult,
} from '../utils/invite-names';
import { keyLineWords } from './key-lines';
import { askNodeRole, persistNodeRole, readPersistedNodeRole, rememberNodeRole } from '../utils/node-admin';
import type { InviteRole } from '../utils/invite-entries';

/** The list's own English (core names-list flows) in the member's language, paragraph by paragraph, as the list's screen says it. */
const say = (text: string) => text.split('\n\n').map(keyLineWords).join('\n\n');

/**
 * The member's role for the boxes where the community's door is open to every member (where only admins invite, People asks it
 * already): the node's answer to GET /api/node-admin/me, asked when Invites is open (`ask`), remembered as People remembers it;
 * with no answer, the last role this node gave this key. Undefined until heard: no boxes until then.
 */
export function useRoleOnInvites(o: { anchorUrl: string; identity: BeanPoolIdentity | null; ask: boolean }): InviteRole | undefined {
    const { anchorUrl, identity, ask } = o;
    const [role, setRole] = useState<InviteRole | undefined>(undefined);
    useEffect(() => {
        setRole(undefined);
        if (!ask || !identity || !anchorUrl) return;
        let alive = true;
        askNodeRole(anchorUrl, identity).then(async (r) => {
            if (r) {
                rememberNodeRole(anchorUrl, identity.publicKey, r);
                void persistNodeRole(anchorUrl, identity.publicKey, r.role);
                if (alive) setRole(r.role);
                return;
            }
            const last = await readPersistedNodeRole(anchorUrl, identity.publicKey);
            if (alive && last !== undefined) setRole(last);
        }).catch(() => {});
        return () => { alive = false; };
    }, [ask, anchorUrl, identity]);
    return role;
}

export interface InviteNames {
    offered: boolean;
    namesTicked: boolean;
    setNamesTicked: (v: boolean) => void;
    name: string;
    setName: (v: string) => void;
    voucherTicked: boolean;
    setVoucherTicked: (v: boolean) => void;
    level: number;
    setLevel: (v: number) => void;
    /** Why the voucher box is greyed, or null. */
    voucherWhy: ReturnType<typeof voucherBoxWhy>;
    /** The list on this phone: opening, open, or why not. */
    list: { kind: 'idle' } | { kind: 'opening' } | { kind: 'open' } | { kind: 'refused'; message: string };
    same: ReturnType<typeof sameNameOnList>;
    /** Generate with the names box ticked: the entry, then the invite bound to it (or to `existingEntryId`). */
    make: (vouchAmount: number | null, existingEntryId?: string) => Promise<NamesInviteResult>;
    /** After an invite was made: the boxes and the name start again. */
    reset: () => void;
}

/**
 * The boxes' state for People → Invites. `offered`: an owner or admin of a local community where invites are made (the caller
 * decides, utils/invite-names.ts offersNamesBoxes). `committee`: the node answered GET /api/names/vouchers (only owners and
 * committee admins get an answer; a 403 is false; undefined while not heard). `voucherBudget`: the community's default budget,
 * where the stepper starts.
 */
export function useInviteNames(o: {
    anchorUrl: string; identity: BeanPoolIdentity | null; offered: boolean; committee: boolean | undefined; online: boolean; voucherBudget?: number | null;
}): InviteNames {
    const { anchorUrl, identity, offered, committee, online } = o;
    const [namesTicked, setNamesTicked] = useState(false);
    const [name, setName] = useState('');
    const [voucherTicked, setVoucherTicked] = useState(false);
    const [level, setLevelState] = useState(() => nearestBudgetLevel(o.voucherBudget));
    const levelTouched = useRef(false);
    const [opened, setOpened] = useState<NamesOpened | null>(null);
    const [list, setList] = useState<InviteNames['list']>({ kind: 'idle' });
    // One id per new entry, chosen when the box is ticked and kept until an invite is made: a Generate tried again after a lost
    // answer adds the same entry (the node answers entry_exists), never a second one (core saveNamesEntry).
    const addId = useRef<string>(newEntryId());

    // The community's default arrives with the vouchers block: the stepper starts there unless it was moved.
    useEffect(() => {
        if (!levelTouched.current) setLevelState(nearestBudgetLevel(o.voucherBudget));
    }, [o.voucherBudget]);
    const setLevel = useCallback((v: number) => { levelTouched.current = true; setLevelState(v); }, []);

    // The list opens when the box is ticked (again after a refusal, on the next tick). A change of community starts the boxes
    // again: a name typed for one community never carries into another, and an open still in flight for the old one is
    // dropped and asked again (`retry`) rather than left waiting.
    const opening = useRef(false);
    const anchorNow = useRef(anchorUrl);
    anchorNow.current = anchorUrl;
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        setOpened(null);
        setList({ kind: 'idle' });
        setNamesTicked(false);
        setName('');
        setVoucherTicked(false);
        addId.current = newEntryId();
    }, [anchorUrl, identity?.publicKey]);
    useEffect(() => {
        if (!offered || !namesTicked || !identity || !anchorUrl || opened || opening.current) return;
        opening.current = true;
        const forAnchor = anchorUrl;
        setList({ kind: 'opening' });
        openNamesList(anchorUrl, identity, STORE).then((r) => {
            opening.current = false;
            if (anchorNow.current !== forAnchor) { setRetry((n) => n + 1); return; }
            if (!r.ok) { setList({ kind: 'refused', message: say(r.message) }); return; }
            if (!r.value.list) { setList({ kind: 'refused', message: say(NAMES_COPY.notReady) }); return; }
            setOpened(r.value);
            setList({ kind: 'open' });
        }).catch(() => {
            opening.current = false;
            if (anchorNow.current !== forAnchor) setRetry((n) => n + 1);
            else setList({ kind: 'refused', message: say(NAMES_COPY.notReady) });
        });
    }, [offered, namesTicked, identity, anchorUrl, opened, retry]);

    const entries = useMemo(() => (opened?.list ? openEntries(opened.list, opened) : []), [opened]);
    const same = useMemo(() => (namesTicked ? sameNameOnList(name, entries, opened) : null), [namesTicked, name, entries, opened]);
    const voucherWhy = voucherBoxWhy({ committee, online, namesTicked });

    const make = useCallback(async (vouchAmount: number | null, existingEntryId?: string): Promise<NamesInviteResult> => {
        if (!identity || !anchorUrl) return { kind: 'entry_not_saved', message: say(NAMES_COPY.notReady) };
        if (!existingEntryId && !name.trim()) return { kind: 'entry_not_saved', message: t('Type their real name first.') };
        if (!existingEntryId && !opened) return { kind: 'entry_not_saved', message: list.kind === 'refused' ? list.message : say(NAMES_COPY.notReady) };
        const voucherLevel = voucherTicked && voucherWhy === null ? level : null;
        return inviteWithNamesEntry({
            saveEntry: async () => {
                const r = await saveNamesEntry(anchorUrl, identity, STORE, opened!, { name: name.trim(), note: '' }, undefined, addId.current);
                return r.ok ? { ok: true, value: { id: r.value.id } } : { ok: false, status: r.status, message: say(r.message) };
            },
            invite: async (entryId, body) => {
                const r = await inviteForNamesEntry(anchorUrl, identity, entryId, body);
                return r.ok ? r : { ok: false, status: r.status, message: say(r.message) };
            },
            offlineTicket: (entryId) => makeOfflineTicket(anchorUrl, identity.publicKey, identity.privateKey, { namesEntryId: entryId }),
        }, { vouchAmount, voucherLevel }, existingEntryId);
    }, [identity, anchorUrl, name, opened, list, voucherTicked, voucherWhy, level]);

    const reset = useCallback(() => {
        addId.current = newEntryId();
        setName('');
        setNamesTicked(false);
        setVoucherTicked(false);
        // The list just gained an entry: the next tick opens it afresh, so the warning sees it.
        setOpened(null);
        setList({ kind: 'idle' });
    }, []);

    return {
        offered, namesTicked, setNamesTicked, name, setName, voucherTicked, setVoucherTicked, level, setLevel, voucherWhy, list, same, make, reset,
    };
}

function Box({ checked, disabled, label, onPress, testID }: { checked: boolean; disabled?: boolean; label: string; onPress: () => void; testID: string }) {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    return (
        <Pressable
            onPress={() => { if (!disabled) onPress(); }}
            disabled={disabled}
            accessibilityRole="checkbox"
            accessibilityState={{ checked, disabled: !!disabled }}
            accessibilityLabel={label}
            style={[styles.boxRow, disabled && styles.off]}
            testID={testID}
        >
            <MaterialCommunityIcons
                name={checked ? 'checkbox-marked' : 'checkbox-blank-outline'}
                size={24}
                color={disabled ? colors.text.muted : checked ? colors.brand.fill : colors.text.secondary}
            />
            <Text style={styles.boxLabel} maxFontSizeMultiplier={1.3}>{label}</Text>
        </Pressable>
    );
}

/** The two boxes, drawn under the vouch presets. `onInviteExisting`: the warning's "Invite that entry" (the parent makes it). */
export function InviteNamesBoxes({ names, busy, onInviteExisting }: { names: InviteNames; busy: boolean; onInviteExisting: (entryId: string) => void }) {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    if (!names.offered) return null;
    const why = names.voucherWhy;
    const voucherOn = names.voucherTicked && why === null;
    const down = budgetLevelDown(names.level);
    const up = budgetLevelUp(names.level);
    return (
        <View style={styles.block} testID="invite-names">
            <Box checked={names.namesTicked} label={t(INVITE_ADDS_WORDS.addToNames)} onPress={() => names.setNamesTicked(!names.namesTicked)} testID="invite-names-box" />
            {names.namesTicked ? (
                <View style={styles.inner}>
                    <TextInput
                        value={names.name}
                        onChangeText={names.setName}
                        placeholder={t('Their real name')}
                        accessibilityLabel={t('Their real name')}
                        placeholderTextColor={colors.text.muted}
                        autoCorrect={false}
                        style={styles.input}
                        maxFontSizeMultiplier={1.3}
                        testID="invite-names-name"
                    />
                    <Text style={styles.hint} maxFontSizeMultiplier={1.3}>
                        {t('Sealed on this phone under the list’s key: the community’s server and the invite link never hold the name.')}
                    </Text>
                    {names.list.kind === 'opening' ? (
                        <View style={styles.row}>
                            <ActivityIndicator color={colors.brand.fill} />
                            <Text style={styles.hint} maxFontSizeMultiplier={1.3}>{t('Opening the names list…')}</Text>
                        </View>
                    ) : null}
                    {names.list.kind === 'refused' ? (
                        <Text style={styles.warnText} accessibilityRole="alert" maxFontSizeMultiplier={1.3} testID="invite-names-refused">{names.list.message}</Text>
                    ) : null}
                    {names.same ? (
                        <View style={styles.warn} accessibilityLiveRegion="polite" testID="invite-names-same">
                            <Text style={styles.warnText} maxFontSizeMultiplier={1.3}>{sameNameWords(names.same)}</Text>
                            {names.same.member === null ? (
                                <Pressable
                                    onPress={() => onInviteExisting(names.same!.entryId)}
                                    disabled={busy}
                                    accessibilityRole="button"
                                    accessibilityState={{ disabled: busy }}
                                    style={[styles.smallBtn, busy && styles.off]}
                                    testID="invite-names-same-invite"
                                >
                                    <Text style={styles.smallBtnText} maxFontSizeMultiplier={1.3}>{t('Invite that entry')}</Text>
                                </Pressable>
                            ) : null}
                        </View>
                    ) : null}
                </View>
            ) : null}

            <Box
                checked={voucherOn}
                disabled={why !== null}
                label={t(INVITE_ADDS_WORDS.makeVoucher)}
                onPress={() => names.setVoucherTicked(!names.voucherTicked)}
                testID="invite-voucher-box"
            />
            {voucherBoxWords(why) ? (
                <Text style={[styles.hint, styles.inner]} maxFontSizeMultiplier={1.3} testID="invite-voucher-why">{voucherBoxWords(why)}</Text>
            ) : null}
            {voucherOn ? (
                <View style={styles.inner} testID="invite-voucher-level">
                    <View style={styles.stepper}>
                        <Pressable
                            onPress={() => { if (down !== null) names.setLevel(down); }}
                            disabled={down === null}
                            accessibilityRole="button"
                            accessibilityState={{ disabled: down === null }}
                            accessibilityLabel={t('Decrease budget by 100')}
                            style={[styles.smallBtn, down === null && styles.off]}
                            testID="invite-voucher-down"
                        >
                            <Text style={styles.smallBtnText}>−</Text>
                        </Pressable>
                        <Text style={styles.amount} maxFontSizeMultiplier={1.3} testID="invite-voucher-amount">{t('{amount} Beans', { amount: formatNumber(names.level) })}</Text>
                        <Pressable
                            onPress={() => { if (up !== null) names.setLevel(up); }}
                            disabled={up === null}
                            accessibilityRole="button"
                            accessibilityState={{ disabled: up === null }}
                            accessibilityLabel={t('Increase budget by 100')}
                            style={[styles.smallBtn, up === null && styles.off]}
                            testID="invite-voucher-up"
                        >
                            <Text style={styles.smallBtnText}>+</Text>
                        </Pressable>
                    </View>
                    <Text style={styles.hint} maxFontSizeMultiplier={1.3}>
                        {t('They get a budget of {amount} Beans to vouch for the people they invite, up to 100 each, from the day they join.', { amount: formatNumber(names.level) })}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}

const makeStyles = ({ colors }: { colors: any }) => StyleSheet.create({
    block: { marginBottom: 16 },
    inner: { marginLeft: 36, marginBottom: 8 },
    boxRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 6 },
    boxLabel: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.text.heading },
    off: { opacity: 0.55 },
    input: {
        backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, padding: 14, borderRadius: 12, fontSize: 15,
        fontWeight: '500', marginBottom: 6, color: colors.text.heading, minHeight: 48,
    },
    hint: { fontSize: 12, lineHeight: 17, color: colors.text.secondary, marginBottom: 6, flexShrink: 1 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    warn: { backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border, borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 6, gap: 8 },
    warnText: { fontSize: 13, lineHeight: 18, color: colors.feedback.warning.fg },
    smallBtn: {
        minHeight: 48, minWidth: 48, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border.strong,
        backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start',
    },
    smallBtnText: { fontSize: 15, fontWeight: '700', color: colors.text.body },
    stepper: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 6, flexWrap: 'wrap' },
    amount: { fontSize: 17, fontWeight: '700', color: colors.text.heading },
});
