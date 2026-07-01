import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { useStyles } from '../../app/ThemeContext';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

export function GuardianInfoModal({ isOpen, onClose }: Props) {
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
            borderRadius: 12,
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
            borderRadius: 12,
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
            borderRadius: 12,
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
            borderRadius: 12,
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
            id: 'recovery',
            label: '🛡️ Social Recovery',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        BeanPool uses <Text style={styles.boldWhiteText}>Social Recovery</Text> instead of central passwords. Your chosen Guardians are the only way to recover your account if you lose your device.
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>WHAT IS A GUARDIAN?</Text>
                        <Text style={styles.cardText}>
                            A Guardian is a trusted friend you select from your community. You need to assign <Text style={styles.boldWhiteText}>between 3 and 5 friends</Text> as Guardians to activate <Text style={styles.boldWhiteText}>Social Recovery</Text>.
                        </Text>
                    </View>

                    <View style={styles.processContainer}>
                        <Text style={styles.processLabel}>RECOVERY PROCESS</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem prefix="1.">You lose access to your device</ListItem>
                            <ListItem prefix="2.">You install the app on a new device</ListItem>
                            <ListItem prefix="3.">You contact your Guardians offline</ListItem>
                            <ListItem prefix="4.">If a <Text style={styles.boldWhiteText}>majority</Text> (e.g., <Text style={styles.boldWhiteText}>2 out of 3</Text>, or <Text style={styles.boldWhiteText}>3 out of 5</Text>) of your Guardians approve your recovery request, your account is restored!</ListItem>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                        <Text style={styles.infoBoxIcon}>🔒</Text>
                        <Text style={styles.infoBoxText}>
                            Guardians cannot access your funds or messages. They only have the power to approve your account transfer to a new device.
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'security',
            label: '🔐 Best Practices',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        Choosing the right Guardians is critical to keeping your account secure and recoverable.
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>DIVERSITY IS KEY</Text>
                        <Text style={styles.cardText}>
                            Don't choose Guardians who all live in the <Text style={styles.boldWhiteText}>same house</Text> or share the <Text style={styles.boldWhiteText}>same devices</Text>. If one event compromises multiple Guardians, you might lose your account.
                        </Text>
                    </View>

                    <View style={styles.warningBox}>
                        <Text style={styles.warningIcon}>⚠️</Text>
                        <Text style={styles.warningText}>
                            If you do not set up Social Recovery and you lose your device or private key, your account and all its credits are <Text style={styles.boldWhiteText}>permanently lost</Text>. There is no central support team that can restore it!
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
            title="Account Guardians"
            icon="🛡️"
            tabs={tabs}
        />
    );
}

