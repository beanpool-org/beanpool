import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { SavedNode } from '../utils/nodes';
import { colors, palette } from '../constants/colors';

/**
 * The communities this device has joined before, one tap each. Shared by node-mismatch (switch
 * to the right node) and SSO recovery (pick the node to recover against) so a member recognises
 * their community instead of recalling its address. Renders nothing when there are none.
 */
export function SavedNodePicker({
    nodes, onPick, label, actionLabel, hint, disabled, selectedUrl,
}: {
    nodes: SavedNode[];
    onPick: (url: string) => void;
    label: string;
    /** Screen-reader verb for a row, e.g. "Switch to". */
    actionLabel: string;
    hint?: string;
    disabled?: boolean;
    /** Marks the row whose address is already in the field. */
    selectedUrl?: string | null;
}) {
    if (nodes.length === 0) return null;
    return (
        <View style={styles.pickerWrap}>
            <Text style={styles.label}>{label}</Text>
            {nodes.map((n) => {
                let host = n.url;
                try { host = new URL(n.url).host; } catch {}
                const selected = !!selectedUrl && selectedUrl === n.url;
                return (
                    <Pressable
                        key={n.url}
                        style={[styles.nodeRow, selected && styles.nodeRowSelected]}
                        onPress={() => onPick(n.url)}
                        disabled={disabled}
                        accessibilityRole="button"
                        accessibilityState={{ selected, disabled: !!disabled }}
                        accessibilityLabel={`${actionLabel} ${n.alias || host}`}
                    >
                        <View style={{ flex: 1 }}>
                            <Text style={styles.nodeRowName}>{n.alias || host}</Text>
                            {n.alias ? <Text style={styles.nodeRowUrl}>{host}</Text> : null}
                        </View>
                        <Text style={styles.nodeRowChevron}>{selected ? '✓' : '›'}</Text>
                    </Pressable>
                );
            })}
            {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    pickerWrap: { marginBottom: 18 },
    label: { fontSize: 14, color: palette.gray700, fontWeight: '600', marginBottom: 6 },
    nodeRow: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        minHeight: 48, paddingVertical: 14, paddingHorizontal: 14, marginBottom: 8,
        backgroundColor: colors.surface.app, borderRadius: 12,
        borderWidth: 1, borderColor: colors.border.default,
    },
    nodeRowSelected: { borderColor: palette.blue600 },
    nodeRowName: { color: colors.text.heading, fontSize: 15, fontWeight: '700' },
    nodeRowUrl: { color: colors.text.secondary, fontSize: 12, marginTop: 2 },
    nodeRowChevron: { color: colors.text.muted, fontSize: 22, fontWeight: '300' },
    hint: { fontSize: 13, color: colors.text.secondary, lineHeight: 18, marginBottom: 16 },
});
