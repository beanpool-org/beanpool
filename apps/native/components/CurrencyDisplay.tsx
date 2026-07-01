import React, { useEffect, useState } from 'react';
import { Text, View, Image, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSavedNodes } from '../utils/nodes';

export function useCurrencyString() {
    const [cType, setCType] = useState<'text' | 'image'>('image');
    const [cVal, setCVal] = useState<string>('bean');

    useEffect(() => {
        let mounted = true;
        (async () => {
            const activeUrl = await AsyncStorage.getItem('beanpool_anchor_url');
            if (activeUrl) {
                const nodes = await getSavedNodes();
                const active = nodes.find(n => n.url === activeUrl);
                if (active && mounted) {
                    if (active.currencyType) setCType(active.currencyType);
                    if (active.currencyValue) setCVal(active.currencyValue);
                }
            }
        })();
        return () => { mounted = false; };
    }, []);

    if (cType === 'image') {
        if (cVal === 'bean') return 'Beans';
        return cVal;
    }
    return cVal || 'Beans';
}

interface Props {
    amount?: number | string;
    style?: any;
    hideAmount?: boolean;
    asView?: boolean;
}

export function CurrencyDisplay({ amount, style, hideAmount = false, asView = false }: Props) {
    const [cType, setCType] = useState<'text' | 'image'>('image');
    const [cVal, setCVal] = useState<string>('bean');

    useEffect(() => {
        let mounted = true;
        (async () => {
            const activeUrl = await AsyncStorage.getItem('beanpool_anchor_url');
            if (activeUrl) {
                const nodes = await getSavedNodes();
                const active = nodes.find(n => n.url === activeUrl);
                if (active && mounted) {
                    if (active.currencyType) setCType(active.currencyType);
                    if (active.currencyValue) setCVal(active.currencyValue);
                }
            }
        })();
        return () => { mounted = false; };
    }, []);

    const amtStr = (!hideAmount && amount !== undefined) ? amount.toString() + '\u00A0' : '';
    
    const flatStyle = StyleSheet.flatten(style) || {};
    const fontSize = flatStyle.fontSize ? flatStyle.fontSize * 1.05 : 18;
    const translateY = Math.max(2, fontSize * 0.15);

    if (cType === 'image' && cVal === 'bean') {
        if (asView) {
            return (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {!!amtStr && <Text style={style} numberOfLines={1} adjustsFontSizeToFit>{amtStr}</Text>}
                    <Image
                        source={require('../assets/images/bean.png')}
                        accessibilityElementsHidden={true}
                        importantForAccessibility="no-hide-descendants"
                        style={{ width: fontSize, height: fontSize, resizeMode: 'contain', marginLeft: hideAmount ? 0 : 2, flexShrink: 0 }}
                    />
                </View>
            );
        }
        return (
            <Text style={[style, { textAlignVertical: 'center' }]}>
                {amtStr}
                <Image
                    source={require('../assets/images/bean.png')}
                    accessibilityElementsHidden={true}
                    importantForAccessibility="no-hide-descendants"
                    style={{ width: fontSize, height: fontSize, resizeMode: 'contain', transform: [{translateY}], flexShrink: 0 }}
                />
            </Text>
        );
    }

    // Fallback or explicit text node (e.g., 'Beans' or 'rocks')
    const displayVal = cType === 'text' ? (cVal || 'Beans') : 'Beans';
    if (asView) {
        return (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={style}>
                    {amtStr}{displayVal}
                </Text>
            </View>
        );
    }
    return (
        <Text style={style}>
            {amtStr}{displayVal}
        </Text>
    );
}
