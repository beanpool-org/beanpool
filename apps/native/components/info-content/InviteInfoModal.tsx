import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { useStyles } from '../../app/ThemeContext';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

export function InviteInfoModal({ isOpen, onClose }: Props) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        tabContent: {
            paddingBottom: 40,
        },
        descriptionText: {
            color: colors.text.secondary,
            fontSize: 15,
            lineHeight: 24,
            marginBottom: 24,
        },
        boldWhiteText: {
            color: colors.text.heading,
            fontWeight: 'bold',
        },
        cardContainer: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 14,
            borderLeftWidth: 4,
            borderLeftColor: colors.brand.primary,
            marginBottom: 16,
        },
        cardLabel: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: 'bold',
            letterSpacing: 1,
            marginBottom: 8,
        },
        cardText: {
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 24,
        },
        infoBox: {
            flexDirection: 'row',
            backgroundColor: colors.brand.tint,
            padding: 16,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.brand.dark,
            alignItems: 'center',
            marginTop: 8,
        },
        infoBoxIcon: {
            fontSize: 24,
            marginRight: 12,
        },
        infoBoxText: {
            flex: 1,
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 20,
        },
        processContainer: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 14,
            borderLeftWidth: 4,
            borderLeftColor: colors.brand.primary,
            marginBottom: 24,
        },
        processLabel: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: 'bold',
            letterSpacing: 1,
            marginBottom: 8,
        },
        processText: {
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 24,
        },
        warningBox: {
            flexDirection: 'row',
            backgroundColor: colors.feedback.warning.bg,
            padding: 16,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.feedback.warning.border,
            alignItems: 'center',
            marginTop: 8,
        },
        warningIcon: {
            fontSize: 24,
            marginRight: 12,
        },
        warningText: {
            flex: 1,
            color: colors.feedback.warning.fg,
            fontSize: 14,
            lineHeight: 20,
        },
        listItemRow: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            marginBottom: 6,
        },
        listItemPrefix: {
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 22,
            marginRight: 8,
            width: 16,
            textAlign: 'right',
        },
        listItemText: {
            flex: 1,
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 22,
        }
    }));

    const ListItem = ({ prefix = "•", children }: { prefix?: string; children: React.ReactNode }) => (
        <View style={styles.listItemRow}>
            <Text style={styles.listItemPrefix}>{prefix}</Text>
            <Text style={styles.listItemText}>{children}</Text>
        </View>
    );

    const tabs: InfoModalTab[] = [
        {
            id: 'invites',
            label: '🎟️ Network Invites',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        BeanPool is an invite-only network. To grow the community safely, we rely on a <Text style={styles.boldWhiteText}>Peer Vouching</Text> system.
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>WHO CAN INVITE</Text>
                        <Text style={styles.cardText}>
                            <Text style={styles.boldWhiteText}>Every member can invite, from day one.</Text> Each invite is a single-use code that lasts <Text style={styles.boldWhiteText}>7 days</Text> — generate as many as you need.
                        </Text>
                    </View>

                    <View style={styles.warningBox}>
                        <Text style={styles.warningIcon}>⚠️</Text>
                        <Text style={styles.warningText}>
                            You are permanently linked as the inviter of everyone you bring in — the community's invite tree is <Text style={styles.boldWhiteText}>public</Text>. Invite people you'd vouch for in real life.
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'vouching',
            label: '🤝 Vouching',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        When you invite someone, you are <Text style={styles.boldWhiteText}>vouching</Text> for them. This creates a web of trust across the network.
                    </Text>

                    <View style={styles.processContainer}>
                        <Text style={styles.processLabel}>VOUCHING PROCESS</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem prefix="1.">Generate a <Text style={styles.boldWhiteText}>single-use invite link</Text> (valid for <Text style={styles.boldWhiteText}>7 days</Text>)</ListItem>
                            <ListItem prefix="2.">Share it securely with someone you trust</ListItem>
                            <ListItem prefix="3.">They create an account and join as a <Text style={styles.boldWhiteText}>Newcomer</Text></ListItem>
                            <ListItem prefix="4.">Your profile is permanently linked as their inviter</ListItem>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                        <Text style={styles.infoBoxIcon}>💡</Text>
                        <Text style={styles.infoBoxText}>
                            Because of the vouching system, we don't need invasive KYC (Know Your Customer) checks. Trust is maintained peer-to-peer!
                        </Text>
                    </View>
                </View>
            )
        }
    ];

    return (
        <InfoModal
            isOpen={isOpen}
            onClose={onClose}
            title="Invites & Vouching"
            icon="🎟️"
            tabs={tabs}
        />
    );
}

