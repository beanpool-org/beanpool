import React from 'react';
import { View, Text } from 'react-native';

export const PROVIDER_DEFAULT = 'default';

export const Marker = () => null;

const MapView = (props: any) => {
    return (
        <View style={[{ flex: 1, backgroundColor: '#111827', justifyContent: 'center', alignItems: 'center' }, props.style]}>
            <Text style={{ color: '#9ca3af', fontFamily: 'monospace' }}>[ Native MapView Stub ]</Text>
        </View>
    );
};

export default MapView;
