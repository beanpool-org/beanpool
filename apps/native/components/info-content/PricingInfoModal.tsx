import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { useStyles, useTheme } from '../../app/ThemeContext';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    initialTab?: 'guide' | 'tax';
}

export function PricingInfoModal({ isOpen, onClose, initialTab }: Props) {
    const { colors } = useTheme();
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
            marginBottom: 16,
        },
        priceRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 16,
        },
        priceCol: {
            flexDirection: 'row',
            alignItems: 'center',
            width: 70,
            justifyContent: 'flex-start',
        },
        priceText: {
            color: colors.brand.primary,
            fontWeight: '900',
            fontSize: 15,
            marginRight: 4,
        },
        beanIcon: {
            width: 16,
            height: 16,
            resizeMode: 'contain',
        },
        descCol: {
            flex: 1,
        },
        descText: {
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 20,
        },
        infoBox: {
            flexDirection: 'row',
            backgroundColor: colors.brand.tint,
            padding: 16,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.brand.dark,
            alignItems: 'center',
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
    }));

    const tabs: InfoModalTab[] = [
        {
            id: 'guide',
            label: '💡 Pricing Guide',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        BeanPool uses a mutual credit system. Since credits represent real value and time, we recommend following this general pricing guide for your offers and needs.
                    </Text>

                    <View style={styles.processContainer}>
                        <Text style={styles.processLabel}>SUGGESTED PRICING BRACKETS</Text>

                        <View style={styles.priceRow}>
                            <View style={styles.priceCol}>
                                <Text style={styles.priceText}>0</Text>
                                <Image source={require('../../assets/images/bean.png')} style={styles.beanIcon} />
                            </View>
                            <View style={styles.descCol}>
                                <Text style={styles.descText}>Gifts, freebies, and community contributions.</Text>
                            </View>
                        </View>

                        <View style={styles.priceRow}>
                            <View style={styles.priceCol}>
                                <Text style={styles.priceText}>1–10</Text>
                                <Image source={require('../../assets/images/bean.png')} style={styles.beanIcon} />
                            </View>
                            <View style={styles.descCol}>
                                <Text style={styles.descText}>Small favours, home produce, quick tasks, or simple tools.</Text>
                            </View>
                        </View>

                        <View style={styles.priceRow}>
                            <View style={styles.priceCol}>
                                <Text style={styles.priceText}>10–40</Text>
                                <Image source={require('../../assets/images/bean.png')} style={styles.beanIcon} />
                            </View>
                            <View style={styles.descCol}>
                                <Text style={styles.descText}>Skilled labour (per hour), substantial goods, or tech repairs.</Text>
                            </View>
                        </View>

                        <View style={styles.priceRow}>
                            <View style={styles.priceCol}>
                                <Text style={styles.priceText}>40–100</Text>
                                <Image source={require('../../assets/images/bean.png')} style={styles.beanIcon} />
                            </View>
                            <View style={styles.descCol}>
                                <Text style={styles.descText}>Professional services, large items, or event catering.</Text>
                            </View>
                        </View>

                        <View style={styles.priceRow}>
                            <View style={styles.priceCol}>
                                <Text style={styles.priceText}>100+</Text>
                                <Image source={require('../../assets/images/bean.png')} style={styles.beanIcon} />
                            </View>
                            <View style={styles.descCol}>
                                <Text style={styles.descText}>Major projects, housing rentals, vehicles, or commercial contracts.</Text>
                            </View>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                        <Text style={styles.infoBoxIcon}>🤝</Text>
                        <Text style={styles.infoBoxText}>
                            These are just guidelines. You are free to negotiate prices with other members based on your own needs and the value of your time!
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'tax',
            label: '🔒 Transaction Fee',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        To protect the integrity of the community ledger, BeanPool applies a flat <Text style={styles.boldWhiteText}>1.5% Transaction Fee</Text> on completed marketplace trades. Direct member-to-member transfers are free.
                        {"\n\n"}
                        <Text style={{ fontWeight: 'bold', color: colors.brand.primary }}>🌱 100% Community-Owned:</Text> This fee is never taken for private profit. All collected credits remain fully inside the Commons Pool to support local project grants and guarantee system solvency.
                    </Text>

                    <View style={styles.processContainer}>
                        <Text style={styles.processLabel}>WHY DO WE COLLECT FEES?</Text>
                        
                        <View style={{ marginBottom: 12 }}>
                            <Text style={{ color: colors.text.heading, fontWeight: 'bold', fontSize: 14, marginBottom: 4 }}>Solvency & Balance</Text>
                            <Text style={{ color: colors.text.body, fontSize: 13, lineHeight: 18 }}>
                                As a zero-sum mutual credit network, deleting inactive accounts requires balancing the ledger. These fees fund the Commons Pool to cover write-offs of unpaid debts.
                            </Text>
                        </View>

                        <View style={{ marginBottom: 12 }}>
                            <Text style={{ color: colors.text.heading, fontWeight: 'bold', fontSize: 14, marginBottom: 4 }}>Circulation Fee Gap</Text>
                            <Text style={{ color: colors.text.body, fontSize: 13, lineHeight: 18 }}>
                                In active economies, members spend earned credits quickly (staying in the fee-free green zone under 200B). Holding fees alone are insufficient to cover defaults.
                            </Text>
                        </View>

                        <View>
                            <Text style={{ color: colors.text.heading, fontWeight: 'bold', fontSize: 14, marginBottom: 4 }}>Community Projects</Text>
                            <Text style={{ color: colors.text.body, fontSize: 13, lineHeight: 18 }}>
                                Any surplus in the Commons Pool beyond maintaining solvency is recycled back into community projects proposed and voted on by members.
                            </Text>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                        <Text style={styles.infoBoxIcon}>🛡️</Text>
                        <Text style={styles.infoBoxText}>
                            The <Text style={styles.boldWhiteText}>1.5% fee</Text> is only applied when credits are successfully released to the recipient. Trust wallet deposits and cancellations (refunds) are completely fee-exempt.
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
            title="Pricing & Fees"
            icon={<Text style={{ fontSize: 24 }}>💡</Text>}
            tabs={tabs}
            defaultTab={initialTab}
        />
    );
}

