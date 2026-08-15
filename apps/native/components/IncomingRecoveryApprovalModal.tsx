import React, { useState, useEffect } from 'react';
import {
    Modal, View, Text, StyleSheet, TouchableOpacity,
    ActivityIndicator, SafeAreaView, Platform, ScrollView
} from 'react-native';
import { colors } from '../constants/colors';
import { anchorUrl } from '../utils/node-post';
import { useIdentity } from '../app/IdentityContext';
import {
    getInboundApprovalContext,
    approveInboundRecovery,
    type InboundApprovalContext,
} from '../utils/friend-recovery';

export function IncomingRecoveryApprovalModal({
    visible,
    collectionId,
    onClose,
    onApproved,
}: {
    visible: boolean;
    collectionId: string | null;
    onClose: () => void;
    onApproved?: () => void;
}): React.JSX.Element | null {
    const { identity } = useIdentity();
    const [loading, setLoading] = useState(false);
    const [approving, setApproving] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');
    const [context, setContext] = useState<InboundApprovalContext | null>(null);
    const [approved, setApproved] = useState(false);

    useEffect(() => {
        if (!visible || !collectionId || !identity) return;
        setLoading(true);
        setErrorMsg('');
        setApproved(false);
        setContext(null);

        let active = true;
        const fetchContext = async () => {
            try {
                const url = await anchorUrl();
                if (!url) throw new Error('No community node address found.');
                const ctx = await getInboundApprovalContext(url, collectionId, identity);
                if (active) {
                    setContext(ctx);
                }
            } catch (e: any) {
                if (active) {
                    setErrorMsg(e.message || 'Could not load recovery details.');
                }
            } finally {
                if (active) setLoading(false);
            }
        };

        fetchContext();
        return () => { active = false; };
    }, [visible, collectionId, identity]);

    const handleApprove = async () => {
        if (!context || !identity) return;
        setApproving(true);
        setErrorMsg('');
        try {
            const url = await anchorUrl();
            if (!url) throw new Error('No community node address found.');
            await approveInboundRecovery(url, context, identity);
            setApproved(true);
            onApproved?.();
        } catch (e: any) {
            setErrorMsg(e.message || 'Failed to approve recovery.');
        } finally {
            setApproving(false);
        }
    };

    if (!visible) return null;

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
            <View style={styles.backdrop}>
                <SafeAreaView style={styles.sheetContainer}>
                    <View style={styles.sheet}>
                        <View style={styles.dragHandle} />

                        <ScrollView contentContainerStyle={styles.content}>
                            <Text style={styles.title} accessibilityRole="header">
                                🛡️ Account Recovery Request
                            </Text>

                            {loading ? (
                                <View style={styles.centerContainer}>
                                    <ActivityIndicator size="large" color={colors.brand.primary} />
                                    <Text style={styles.subtext}>Loading recovery request...</Text>
                                </View>
                            ) : approved ? (
                                <View style={styles.centerContainer}>
                                    <Text style={styles.successIcon}>✅</Text>
                                    <Text style={styles.sectionTitle}>Recovery Approved!</Text>
                                    <Text style={styles.bodyText}>
                                        You safely released your recovery piece for <Text style={styles.bold}>{context?.callsign}</Text>. Once they collect their remaining pieces, they will be back in their account.
                                    </Text>
                                    <TouchableOpacity style={styles.primaryBtn} onPress={onClose}>
                                        <Text style={styles.primaryBtnText}>Done</Text>
                                    </TouchableOpacity>
                                </View>
                            ) : (
                                <>
                                    <View style={styles.memberBox}>
                                        <Text style={styles.memberCallsign}>
                                            {context?.callsign || 'A member'}
                                        </Text>
                                        <Text style={styles.memberSubtext}>
                                            is trying to recover their BeanPool account on a new phone.
                                        </Text>
                                    </View>

                                    <View style={styles.warningBox}>
                                        <Text style={styles.warningTitle}>⚠️ Security Check</Text>
                                        <Text style={styles.warningText}>
                                            Only tap <Text style={styles.bold}>Approve</Text> if you have personally spoken with <Text style={styles.bold}>{context?.callsign}</Text> (by phone or in person) and verified they are restoring their phone.
                                        </Text>
                                        <Text style={[styles.warningText, { marginTop: 6 }]}>
                                            Never approve if you were asked via email or text message.
                                        </Text>
                                    </View>

                                    {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}

                                    <View style={styles.buttonStack}>
                                        <TouchableOpacity
                                            style={[styles.primaryBtn, approving && styles.btnDisabled]}
                                            onPress={handleApprove}
                                            disabled={approving}
                                            accessibilityRole="button"
                                        >
                                            {approving ? (
                                                <ActivityIndicator color={colors.text.inverse} />
                                            ) : (
                                                <Text style={styles.primaryBtnText}>Approve Recovery</Text>
                                            )}
                                        </TouchableOpacity>

                                        <TouchableOpacity
                                            style={styles.cancelBtn}
                                            onPress={onClose}
                                            disabled={approving}
                                            accessibilityRole="button"
                                        >
                                            <Text style={styles.cancelBtnText}>Decline / Cancel</Text>
                                        </TouchableOpacity>
                                    </View>
                                </>
                            )}
                        </ScrollView>
                    </View>
                </SafeAreaView>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    sheetContainer: {
        width: '100%',
        maxHeight: '90%',
    },
    sheet: {
        backgroundColor: colors.surface.card,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingHorizontal: 20,
        paddingBottom: Platform.OS === 'ios' ? 30 : 20,
        paddingTop: 12,
        minHeight: 380,
    },
    dragHandle: {
        width: 36,
        height: 5,
        backgroundColor: colors.border.default,
        borderRadius: 2.5,
        alignSelf: 'center',
        marginBottom: 16,
    },
    content: {
        paddingBottom: 20,
    },
    title: {
        fontSize: 20,
        fontWeight: '700',
        color: colors.text.heading,
        textAlign: 'center',
        marginBottom: 16,
    },
    centerContainer: {
        alignItems: 'center',
        paddingVertical: 32,
    },
    subtext: {
        marginTop: 12,
        fontSize: 15,
        color: colors.text.secondary,
    },
    successIcon: {
        fontSize: 48,
        marginBottom: 12,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: colors.text.heading,
        marginBottom: 8,
    },
    bodyText: {
        fontSize: 15,
        color: colors.text.secondary,
        textAlign: 'center',
        lineHeight: 22,
        marginBottom: 24,
    },
    memberBox: {
        backgroundColor: colors.surface.subtle,
        borderRadius: 12,
        padding: 16,
        alignItems: 'center',
        marginBottom: 16,
        borderWidth: 1,
        borderColor: colors.border.default,
    },
    memberCallsign: {
        fontSize: 18,
        fontWeight: '700',
        color: colors.text.heading,
        marginBottom: 4,
    },
    memberSubtext: {
        fontSize: 14,
        color: colors.text.secondary,
        textAlign: 'center',
    },
    warningBox: {
        backgroundColor: '#FEF3C7',
        borderRadius: 12,
        padding: 14,
        marginBottom: 18,
        borderWidth: 1,
        borderColor: '#FCD34D',
    },
    warningTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: '#92400E',
        marginBottom: 4,
    },
    warningText: {
        fontSize: 13,
        color: '#78350F',
        lineHeight: 18,
    },
    bold: {
        fontWeight: '700',
    },
    errorText: {
        color: colors.feedback.danger.solid,
        fontSize: 13,
        textAlign: 'center',
        marginBottom: 12,
    },
    buttonStack: {
        gap: 10,
        marginTop: 8,
    },
    primaryBtn: {
        backgroundColor: colors.brand.primary,
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: 'center',
    },
    primaryBtnText: {
        color: colors.text.inverse,
        fontSize: 16,
        fontWeight: '600',
    },
    btnDisabled: {
        opacity: 0.6,
    },
    cancelBtn: {
        paddingVertical: 12,
        alignItems: 'center',
    },
    cancelBtnText: {
        color: colors.text.secondary,
        fontSize: 15,
        fontWeight: '500',
    },
});
