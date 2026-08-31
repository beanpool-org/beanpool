/**
 * Channel link chips for member profiles (The Pulse, Phase 1).
 *
 * Renders a member's syndicated creator channels as tappable link chips.
 * Opens the external profile URL in the device browser.
 *
 * Rules:
 * - Empty/missing channels: returns null (never an empty state or add prompt).
 * - Verified channel: shows distinct verification indicator when `isVerified === true`.
 * - Wraps rather than clips at 320dp and 1.3x font scale.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable, Linking } from 'react-native';
import { platformMeta, type PublicCreatorChannel } from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';

interface Props {
    channels?: PublicCreatorChannel[] | null;
}

export function ChannelChips({ channels }: Props) {
    const { colors, theme } = useTheme();
    const styles = useStyles(makeStyles);

    if (!channels || channels.length === 0) {
        return null;
    }

    const openChannel = async (channel: PublicCreatorChannel) => {
        if (!channel.url) return;
        try {
            const url = channel.url.trim();
            if (!/^https?:\/\//i.test(url)) return;
            const can = await Linking.canOpenURL(url).catch(() => false);
            if (can) {
                await Linking.openURL(url);
            }
        } catch (e) {
            console.warn('[ChannelChips] Could not open external URL:', e);
        }
    };

    return (
        <View style={styles.container} accessibilityRole="list" accessibilityLabel="External channels">
            {channels.map((channel) => {
                const meta = platformMeta(channel.platform);
                const hasHandle = Boolean(channel.handle && channel.handle.trim());
                const displayLabel = hasHandle
                    ? `${meta.label} · ${channel.handle}`
                    : meta.label;

                const accessLabel = `${meta.label}${hasHandle ? ` ${channel.handle}` : ''}${
                    channel.isVerified ? ' (verified account)' : ''
                }`;

                return (
                    <Pressable
                        key={channel.id}
                        onPress={() => openChannel(channel)}
                        style={({ pressed }) => [
                            styles.chip,
                            channel.isVerified && styles.chipVerified,
                            pressed && styles.chipPressed,
                        ]}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityRole="link"
                        accessibilityLabel={accessLabel}
                        accessibilityHint="Opens external channel link"
                    >
                        <Text style={styles.icon} allowFontScaling={false}>
                            {meta.icon}
                        </Text>
                        <Text style={styles.label} numberOfLines={1}>
                            {displayLabel}
                        </Text>
                        {channel.isVerified ? (
                            <View
                                style={styles.verifiedBadge}
                                accessibilityLabel="Verified account"
                            >
                                <Text style={styles.verifiedIcon} allowFontScaling={false}>
                                    ✓
                                </Text>
                            </View>
                        ) : null}
                    </Pressable>
                );
            })}
        </View>
    );
}

const makeStyles = ({ colors, theme }: { colors: any; theme: string }) =>
    StyleSheet.create({
        container: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 8,
            marginTop: 12,
            width: '100%',
        },
        chip: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 20,
            paddingVertical: 8,
            paddingHorizontal: 12,
            minHeight: 38,
            maxWidth: '100%',
        },
        chipVerified: {
            borderColor: theme === 'dark' ? colors.brand.primary : colors.brand.tint,
            backgroundColor: theme === 'dark' ? colors.brand.tint : colors.surface.subtle,
        },
        chipPressed: {
            opacity: 0.75,
            transform: [{ scale: 0.98 }],
        },
        icon: {
            fontSize: 14,
            marginRight: 6,
        },
        label: {
            fontSize: 13,
            fontWeight: '600',
            color: colors.text.body,
            flexShrink: 1,
        },
        verifiedBadge: {
            marginLeft: 6,
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: colors.brand.primary,
            alignItems: 'center',
            justifyContent: 'center',
        },
        verifiedIcon: {
            color: colors.text.inverse,
            fontSize: 10,
            fontWeight: '900',
            lineHeight: 12,
        },
    });
