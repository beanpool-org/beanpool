/**
 * People → Community with Show credit ON (DESIGN-credit-list-fable.md §3.1 with its amendments 1 and 2): the node's own list,
 * 30 a page, in the node's order (no credit yet with a live Offer, no credit yet, then the rest). Never the phone's copy of
 * the members: offline it reads "Connect to your community to see credit lines."
 *
 * Chips: All · No credit yet · Has Offers · My people, and Vouchers when the NODE answers the Vouchers chip (owners and the
 * credit committee; a 403 is its no, so the chip is never drawn from a role the phone holds). A voucher sees their own budget
 * above the chips with Ask for more.
 *
 * Nothing is kept: the pages live in this component's state while the pane is open (no phone database, no storage, no
 * offline copy). A row is changed only by reading it again from the node after a give. Each page the node answers is a look it
 * records for each person on it; 403 `not_a_giver` hands the view back (the switch goes off).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { CREDIT_SIGHT_WORDS, formatHundredths, t, word, type WordKey } from '@beanpool/core';
import { useStyles, useTheme } from '../app/ThemeContext';
import { CreditRow } from './CreditRow';
import { CreditVoucherRow } from './CreditVoucherRow';
import { GiveCreditSheet } from './GiveCreditSheet';
import { AskForMore } from './AskForMore';
import { askMyVouching, type MyVouching } from '../utils/vouchers';
import { offersNamesList } from '../utils/names-list';
import {
    fetchCreditPage, fetchCreditPerson, fetchVouchersChip, nextToGive,
    type CreditFilter, type CreditPerson, type CreditSightKind, type VoucherChipRow,
} from '../utils/credit-view';
import type { BeanPoolIdentity } from '../utils/identity';

const CHIP_WORDS: Readonly<Record<CreditFilter, WordKey>> = {
    all: word('All'),
    no_credit: word('No credit yet'),
    has_offers: word('Has Offers'),
    mine: word('My people'),
    vouchers: word('Vouchers'),
};

export function CreditList({ anchorUrl, identity, query, initialFilter, focusVoucher, nodeProfile, onOpenProfile, onRefused }: {
    anchorUrl: string;
    identity: BeanPoolIdentity;
    /** The search above the list (callsign), as the node's `q`. */
    query: string;
    initialFilter?: CreditFilter;
    /** The voucher the bell's "A voucher asks for more" opened the chip on. */
    focusVoucher?: string;
    /** The community's kind: a global community keeps no names list, so Confirm is not offered there. */
    nodeProfile: 'local' | 'global' | null | undefined;
    onOpenProfile: (p: { memberPubkey: string; callsign: string }) => void;
    /** The node said 403 `not_a_giver`: the view goes off. */
    onRefused: () => void;
}) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors: c }) => StyleSheet.create({
        head: { padding: 16, paddingBottom: 4, backgroundColor: c.surface.app },
        only: { fontSize: 13, lineHeight: 19, color: c.text.secondary, marginBottom: 8 },
        budget: { fontSize: 14, fontWeight: '700', lineHeight: 20, color: c.text.heading },
        chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 8, paddingBottom: 8 },
        chip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 22, backgroundColor: c.surface.subtle, borderWidth: 1, borderColor: c.border.default },
        chipOn: { backgroundColor: c.brand.fill, borderColor: c.brand.dark },
        chipText: { fontSize: 13, fontWeight: '600', color: c.text.secondary },
        chipTextOn: { color: c.text.inverse },
        empty: { padding: 32, alignItems: 'center' },
        emptyText: { fontSize: 15, lineHeight: 22, color: c.text.secondary, textAlign: 'center' },
    }));
    const [filter, setFilter] = useState<CreditFilter>(initialFilter ?? 'all');
    const [people, setPeople] = useState<CreditPerson[]>([]);
    const [vouchers, setVouchers] = useState<VoucherChipRow[]>([]);
    const [committee, setCommittee] = useState(false);
    const [next, setNext] = useState<string | null>(null);
    const [sight, setSight] = useState<CreditSightKind>('voucher');
    const [status, setStatus] = useState<'loading' | 'ok' | 'offline' | 'error'>('loading');
    const [more, setMore] = useState(false);
    const [mine, setMine] = useState<MyVouching | null>(null);
    const [giving, setGiving] = useState<CreditPerson | null>(null);
    const [q, setQ] = useState(query);
    const run = useRef(0);
    const confirmFor = useRef<string | null>(null);

    // The search is the node's `q`, asked after the typing settles.
    useEffect(() => { const id = setTimeout(() => setQ(query), 400); return () => clearTimeout(id); }, [query]);

    /** The Vouchers chip is offered only when the node answers it (200); 403 is its no. */
    const loadChip = useCallback(async () => {
        const res = await fetchVouchersChip(anchorUrl, identity);
        if (res.ok) { setCommittee(true); setVouchers(res.value.vouchers); return; }
        setCommittee(false);
        if (res.status === 403 && res.code === 'not_a_giver') onRefused();
    }, [anchorUrl, identity, onRefused]);

    const loadPage = useCallback(async (after: string | null) => {
        if (filter === 'vouchers') { await loadChip(); setStatus('ok'); return; }
        const id = ++run.current;
        const res = await fetchCreditPage(anchorUrl, identity, { filter, q, after });
        if (id !== run.current) return;
        if (res.ok) {
            setSight(res.value.sight);
            setPeople((prev) => (after ? [...prev, ...res.value.people] : res.value.people));
            setNext(res.value.next);
            setStatus('ok');
        } else if (res.status === 403 && res.code === 'not_a_giver') {
            onRefused();
        } else {
            setStatus(res.offline ? 'offline' : 'error');
        }
        setMore(false);
    }, [filter, q, anchorUrl, identity, loadChip, onRefused]);

    useEffect(() => { setStatus('loading'); setPeople([]); setNext(null); void loadPage(null); }, [loadPage]);
    useEffect(() => { void loadChip(); }, [loadChip]);
    useEffect(() => {
        let alive = true;
        void askMyVouching(anchorUrl, identity).then((mv) => { if (alive) setMine(mv); });
        return () => { alive = false; };
    }, [anchorUrl, identity]);

    // Back from the names list after Confirm: the person is read again from the node, never assumed.
    useFocusEffect(useCallback(() => {
        const key = confirmFor.current;
        if (!key) return undefined;
        confirmFor.current = null;
        void fetchCreditPerson(anchorUrl, identity, key).then((r) => {
            if (r.ok) setPeople((prev) => prev.map((p) => (p.memberPubkey === key ? r.value.person : p)));
        });
        return undefined;
    }, [anchorUrl, identity]));

    const onGiven = (fresh: CreditPerson) => setPeople((prev) => prev.map((p) => (p.memberPubkey === fresh.memberPubkey ? fresh : p)));
    const following = giving ? nextToGive(people, giving.memberPubkey) : null;
    const openNext = async () => {
        if (!giving) return;
        if (following) { setGiving(following); return; }
        if (!next) { setGiving(null); return; }
        // The next page, then the first person on it who can be given credit.
        const res = await fetchCreditPage(anchorUrl, identity, { filter: filter === 'vouchers' ? 'all' : filter, q, after: next });
        if (!res.ok) { setGiving(null); return; }
        setPeople((prev) => [...prev, ...res.value.people]);
        setNext(res.value.next);
        setGiving(nextToGive([giving, ...res.value.people], giving.memberPubkey));
    };

    const budget = mine?.voucher && !mine.noLimit && mine.budget
        ? t('Your budget: {left} of {level} left', { left: formatHundredths(mine.budget.left), level: formatHundredths(mine.budget.level) })
        : null;
    const chips: CreditFilter[] = committee ? ['all', 'no_credit', 'has_offers', 'mine', 'vouchers'] : ['all', 'no_credit', 'has_offers', 'mine'];

    const header = (
        <View style={styles.head}>
            <Text style={styles.only} maxFontSizeMultiplier={1.3} testID="credit-only-givers">{t(CREDIT_SIGHT_WORDS.onlyGivers)}</Text>
            {budget ? <Text style={styles.budget} maxFontSizeMultiplier={1.3} testID="credit-own-budget">{budget}</Text> : null}
            {budget && mine?.ask ? <AskForMore anchorUrl={anchorUrl} identity={identity} ask={mine.ask} onAsked={(ask) => setMine((m) => (m ? { ...m, ask } : m))} testID="credit-ask-top" /> : null}
            <View style={styles.chips}>
                {chips.map((c) => (
                    <Pressable key={c} accessibilityRole="button" accessibilityState={{ selected: filter === c }} style={[styles.chip, filter === c && styles.chipOn]} onPress={() => setFilter(c)} testID={`credit-chip-${c}`}>
                        <Text style={[styles.chipText, filter === c && styles.chipTextOn]} maxFontSizeMultiplier={1.3}>{t(CHIP_WORDS[c])}</Text>
                    </Pressable>
                ))}
            </View>
        </View>
    );

    const emptyWords = status === 'offline'
        ? t('Connect to your community to see credit lines.')
        : status === 'error' ? t('Credit lines could not be read just now. Try again in a moment.')
        : status === 'loading' ? null : t('Nobody to show here.');

    return (
        <>
            <FlatList<CreditPerson | VoucherChipRow>
                data={filter === 'vouchers' ? vouchers : people}
                keyExtractor={(item) => item.memberPubkey}
                ListHeaderComponent={header}
                ListEmptyComponent={
                    <View style={styles.empty}>
                        {status === 'loading' ? <ActivityIndicator color={colors.brand.primary} /> : <Text style={styles.emptyText} maxFontSizeMultiplier={1.3}>{emptyWords}</Text>}
                    </View>
                }
                ListFooterComponent={more ? <ActivityIndicator color={colors.brand.primary} style={{ padding: 16 }} /> : null}
                onEndReachedThreshold={0.4}
                onEndReached={() => { if (filter !== 'vouchers' && next && !more && status === 'ok') { setMore(true); void loadPage(next); } }}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => filter === 'vouchers'
                    ? <CreditVoucherRow row={item as VoucherChipRow} anchorUrl={anchorUrl} identity={identity} highlighted={(item as VoucherChipRow).memberPubkey === focusVoucher} onChanged={() => { void loadChip(); }} />
                    : <CreditRow person={item as CreditPerson} sight={sight} onOpenProfile={onOpenProfile} onGive={setGiving} />}
            />
            {giving ? (
                <GiveCreditSheet
                    person={giving}
                    sight={sight}
                    anchorUrl={anchorUrl}
                    identity={identity}
                    offersNamesList={offersNamesList(sight === 'voucher' ? null : sight, nodeProfile)}
                    hasNext={!!following || !!next}
                    onClose={() => setGiving(null)}
                    onNext={() => { void openNext(); }}
                    onGiven={onGiven}
                    onConfirmOpened={(key) => { confirmFor.current = key; }}
                />
            ) : null}
        </>
    );
}
