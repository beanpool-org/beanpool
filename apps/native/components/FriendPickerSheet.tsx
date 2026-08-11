import React, { useState, useEffect } from 'react';
import { 
    Modal, View, Text, StyleSheet, TouchableOpacity, FlatList, 
    ActivityIndicator, Image, SafeAreaView, Platform
} from 'react-native';
import { colors } from '../constants/colors';
import { anchorUrl } from '../utils/node-post';
import { useIdentity } from '../app/IdentityContext';
import { enrolFriendKeepers, KeeperEnrolmentResult } from '../utils/keeper-enrolment';
import { TWO_LAYER_THRESHOLD } from '@beanpool/core';

interface Member {
    publicKey: string;
    callsign: string;
    avatarUrl?: string;
}

export function FriendPickerSheet({ 
    visible, 
    onClose,
    onEnrolled,
}: { 
    visible: boolean;
    onClose: () => void;
    onEnrolled: (result: KeeperEnrolmentResult) => void;
}): React.JSX.Element | null {
    const { identity } = useIdentity();
    const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1);
    const [members, setMembers] = useState<Member[]>([]);
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
    const [errorMsg, setErrorMsg] = useState('');
    const [enrolmentResult, setEnrolmentResult] = useState<KeeperEnrolmentResult | null>(null);
    const [loadingMembers, setLoadingMembers] = useState(false);
    const [membersLoaded, setMembersLoaded] = useState(false);

    useEffect(() => {
        if (!visible) return;
        setStep(1);
        setSelectedKeys(new Set());
        setErrorMsg('');
        setEnrolmentResult(null);
        setMembersLoaded(false);
    }, [visible]);

    useEffect(() => {
        if (visible && step === 2 && !membersLoaded && !loadingMembers) {
            let active = true;
            setLoadingMembers(true);
            const load = async () => {
                try {
                    const url = await anchorUrl();
                    if (!url) throw new Error('No node configured.');
                    const res = await fetch(`${url}/api/members`);
                    if (!res.ok) throw new Error(`Node error: ${res.status}`);
                    const data: Member[] = await res.json();
                    if (active) {
                        setMembers(data.filter(m => m.publicKey !== identity?.publicKey));
                        setMembersLoaded(true);
                    }
                } catch (e: any) {
                    if (active) {
                        setErrorMsg(e.message || 'Failed to load members');
                        setStep(6);
                    }
                } finally {
                    if (active) setLoadingMembers(false);
                }
            };
            load();
            return () => { active = false; };
        }
    }, [visible, step, membersLoaded, identity, loadingMembers]);

    const handleConfirmSelection = () => {
        if (selectedKeys.size >= TWO_LAYER_THRESHOLD) {
            setStep(3);
        }
    };

    const handleSplit = async () => {
        setStep(4);
        if (!identity) {
            setErrorMsg('Not signed in');
            setStep(6);
            return;
        }

        const res = await enrolFriendKeepers({
            identity,
            friendPublicKeys: Array.from(selectedKeys)
        });

        if (res.error) {
            setErrorMsg(res.error);
            setStep(6);
        } else {
            setEnrolmentResult(res);
            setStep(5);
        }
    };

    const handleToggle = (key: string) => {
        setSelectedKeys(prev => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else if (next.size < 5) {
                next.add(key);
            }
            return next;
        });
    };

    const renderStep1 = () => (
        <View style={styles.stepContainer}>
            <Text style={styles.title}>Protect with trusted friends</Text>
            <Text style={styles.body}>
                Pick at least {TWO_LAYER_THRESHOLD} friends from your community. If you lose this phone, call any {TWO_LAYER_THRESHOLD} of them — they'll approve your recovery from their phone.
            </Text>
            <View style={styles.noteBox}>
                <Text style={styles.noteText}>Note: Choose people you can actually reach by phone. They get no notification — you'll need to call them.</Text>
            </View>
            <TouchableOpacity style={styles.primaryButton} onPress={() => setStep(2)}>
                <Text style={styles.primaryButtonText}>Choose friends</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.secondaryButton, {marginTop: 12}]} onPress={onClose}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
        </View>
    );

    const renderStep2 = () => {
        const canConfirm = selectedKeys.size >= TWO_LAYER_THRESHOLD;
        return (
            <View style={styles.stepContainer}>
                <Text style={styles.title}>Select friends</Text>
                <Text style={styles.counter}>
                    Selected: {selectedKeys.size}/5 (need at least {TWO_LAYER_THRESHOLD})
                </Text>
                {loadingMembers ? (
                    <ActivityIndicator style={styles.loader} color={colors.text.heading} />
                ) : (
                    <FlatList
                        data={members}
                        extraData={selectedKeys}
                        keyExtractor={m => m.publicKey}
                        style={styles.list}
                        ListEmptyComponent={
                            <Text style={{ color: colors.text.secondary, textAlign: 'center', marginVertical: 24, fontSize: 15 }}>
                                No other members found on this hub.
                            </Text>
                        }
                        renderItem={({ item }) => {
                            const isSelected = selectedKeys.has(item.publicKey);
                            return (
                                <TouchableOpacity 
                                    style={styles.memberRow} 
                                    onPress={() => handleToggle(item.publicKey)}
                                    accessibilityRole="checkbox"
                                    accessibilityState={{ checked: isSelected }}
                                    accessibilityLabel={`Select ${item.callsign || 'Anonymous'}`}
                                >
                                    {item.avatarUrl ? (
                                        <Image source={{ uri: item.avatarUrl }} style={styles.avatar} />
                                    ) : (
                                        <View style={styles.avatarFallback} />
                                    )}
                                    <Text style={styles.memberName}>{item.callsign || 'Anonymous'}</Text>
                                    <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
                                        {isSelected && <Text style={styles.checkmark}>✓</Text>}
                                    </View>
                                </TouchableOpacity>
                            );
                        }}
                    />
                )}
                <View style={styles.actionsRow}>
                    <TouchableOpacity style={styles.secondaryButton} onPress={() => setStep(1)}>
                        <Text style={styles.secondaryButtonText}>Back</Text>
                    </TouchableOpacity>
                    <TouchableOpacity 
                        style={[styles.primaryButton, !canConfirm && styles.buttonDisabled]} 
                        onPress={handleConfirmSelection}
                        disabled={!canConfirm}
                    >
                        <Text style={styles.primaryButtonText}>Confirm</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    };

    const renderStep3 = () => {
        const selectedMembers = members.filter(m => selectedKeys.has(m.publicKey));
        return (
            <View style={styles.stepContainer}>
                <Text style={styles.title}>These friends will each hold a piece:</Text>
                <View style={styles.selectedList}>
                    {selectedMembers.map(m => (
                        <Text key={m.publicKey} style={styles.selectedMemberText}>• {m.callsign || 'Anonymous'}</Text>
                    ))}
                </View>
                {/* 
                  Marty's rule: never leave someone in false-success limbo, and no hard gates. 
                  (The hub piece A is XOR-mandatory and never counted in a threshold).
                */}
                <Text style={styles.body}>
                    Any {TWO_LAYER_THRESHOLD} of them plus your hub can bring you back. They cannot open your account alone.
                </Text>
                <View style={styles.actionsRow}>
                    <TouchableOpacity style={styles.secondaryButton} onPress={() => setStep(2)}>
                        <Text style={styles.secondaryButtonText}>Back</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.primaryButton} onPress={handleSplit}>
                        <Text style={styles.primaryButtonText}>Split and protect</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    };

    const renderStep4 = () => (
        <View style={styles.stepContainerCenter}>
            <ActivityIndicator size="large" color={colors.brand.primary} />
            <Text style={styles.loadingText}>Splitting your account...</Text>
        </View>
    );

    const renderStep5 = () => {
        const selectedMembers = members.filter(m => selectedKeys.has(m.publicKey));
        return (
            <View style={styles.stepContainer}>
                <Text style={styles.successTitle}>✅ You're covered</Text>
                <Text style={styles.body}>
                    Your account has been split. Any {TWO_LAYER_THRESHOLD} of your friends plus your hub can bring you back.
                </Text>
                <View style={styles.selectedList}>
                    {selectedMembers.map(m => (
                        <Text key={m.publicKey} style={styles.selectedMemberText}>✅ {m.callsign || 'Anonymous'}</Text>
                    ))}
                </View>
                <TouchableOpacity style={styles.primaryButton} onPress={() => {
                    if (enrolmentResult) onEnrolled(enrolmentResult);
                    onClose();
                }}>
                    <Text style={styles.primaryButtonText}>Done</Text>
                </TouchableOpacity>
            </View>
        );
    };

    const renderStep6 = () => (
        <View style={styles.stepContainer}>
            <Text style={styles.errorTitle}>Error</Text>
            <Text style={styles.errorText}>{errorMsg}</Text>
            <View style={styles.actionsRow}>
                <TouchableOpacity style={styles.secondaryButton} onPress={onClose}>
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.primaryButton} onPress={() => {
                    if (members.length === 0) {
                        setMembersLoaded(false);
                        setStep(2);
                    } else {
                        setStep(3);
                    }
                }}>
                    <Text style={styles.primaryButtonText}>Try again</Text>
                </TouchableOpacity>
            </View>
        </View>
    );

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <View style={styles.modalOverlay}>
                <SafeAreaView style={styles.modalContent}>
                    {step === 1 && renderStep1()}
                    {step === 2 && renderStep2()}
                    {step === 3 && renderStep3()}
                    {step === 4 && renderStep4()}
                    {step === 5 && renderStep5()}
                    {step === 6 && renderStep6()}
                </SafeAreaView>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    modalContent: {
        backgroundColor: colors.surface.card,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingHorizontal: 20,
        paddingBottom: Platform.OS === 'ios' ? 0 : 20,
        paddingTop: 24,
        maxHeight: '90%',
    },
    stepContainer: {
        paddingBottom: 24,
    },
    stepContainerCenter: {
        paddingBottom: 24,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 200,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.text.heading,
        marginBottom: 16,
    },
    successTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.brand.primary,
        marginBottom: 16,
    },
    errorTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.feedback.danger.solid,
        marginBottom: 16,
    },
    body: {
        fontSize: 16,
        color: colors.text.secondary,
        marginBottom: 20,
        lineHeight: 24,
    },
    noteBox: {
        backgroundColor: colors.surface.subtle,
        padding: 16,
        borderRadius: 8,
        marginBottom: 24,
    },
    noteText: {
        fontSize: 14,
        color: colors.text.secondary,
        lineHeight: 20,
    },
    counter: {
        fontSize: 14,
        color: colors.text.secondary,
        marginBottom: 12,
        fontWeight: '600',
    },
    list: {
        maxHeight: 400,
        marginBottom: 20,
    },
    loader: {
        marginVertical: 40,
    },
    memberRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.border.default,
    },
    avatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
        marginRight: 12,
        backgroundColor: colors.surface.subtle,
    },
    avatarFallback: {
        width: 40,
        height: 40,
        borderRadius: 20,
        marginRight: 12,
        backgroundColor: colors.surface.subtle,
    },
    memberName: {
        flex: 1,
        fontSize: 16,
        color: colors.text.heading,
        fontWeight: '500',
    },
    checkbox: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: colors.border.default,
        alignItems: 'center',
        justifyContent: 'center',
    },
    checkboxSelected: {
        backgroundColor: colors.brand.primary,
        borderColor: colors.brand.primary,
    },
    checkmark: {
        color: '#ffffff',
        fontSize: 14,
        fontWeight: 'bold',
    },
    selectedList: {
        marginBottom: 24,
        backgroundColor: colors.surface.subtle,
        padding: 16,
        borderRadius: 8,
    },
    selectedMemberText: {
        fontSize: 16,
        color: colors.text.heading,
        marginBottom: 8,
        fontWeight: '500',
    },
    loadingText: {
        marginTop: 16,
        fontSize: 16,
        color: colors.text.secondary,
    },
    errorText: {
        fontSize: 16,
        color: colors.feedback.danger.solid,
        marginBottom: 24,
    },
    actionsRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 12,
    },
    primaryButton: {
        backgroundColor: colors.brand.primary,
        paddingVertical: 14,
        paddingHorizontal: 24,
        borderRadius: 12,
        alignItems: 'center',
        flex: 1,
    },
    buttonDisabled: {
        backgroundColor: colors.border.default,
    },
    primaryButtonText: {
        color: '#ffffff',
        fontSize: 16,
        fontWeight: 'bold',
    },
    secondaryButton: {
        backgroundColor: colors.surface.subtle,
        paddingVertical: 14,
        paddingHorizontal: 24,
        borderRadius: 12,
        alignItems: 'center',
        flex: 1,
    },
    secondaryButtonText: {
        color: colors.text.heading,
        fontSize: 16,
        fontWeight: 'bold',
    },
});
