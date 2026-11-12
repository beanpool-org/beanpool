/**
 * "Who can open it ›" (vault rethink VR0, design §4.5): the long sentence of who can open a sign-in copy, one tap away
 * under the row that names BeanPool's key vault. Closed when drawn, as the design draws it: the row above already says
 * who, in short. Words in its children wrap at any width (no numberOfLines), so 320 dp at a 1.3x font cuts none off.
 */
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
// Static colours: only the default of the `colors` prop. Every caller passes its screen's set (measured 12 Nov 2026, colour themes T2), so a colour set reaches it through the prop. KeeperProtectionPanel hands on its own (see there).
import { colors as lightColors, type AppColors } from '../constants/colors';

export function WhoCanOpen({ label, colors = lightColors, children }: {
    /** The button's words, already in the member's language. */
    label: string;
    colors?: AppColors;
    children: React.ReactNode;
}): React.JSX.Element {
    const [open, setOpen] = useState(false);
    return (
        <View>
            <Pressable
                onPress={() => setOpen(o => !o)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                accessibilityLabel={label}
                style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', marginTop: 4 }}
            >
                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text.heading }}>
                    {label}<Text accessibilityElementsHidden importantForAccessibility="no">{open ? ' ˅' : ' ›'}</Text>
                </Text>
            </Pressable>
            {open && children}
        </View>
    );
}
