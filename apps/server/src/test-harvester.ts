/**
 * Harvester service unit/integration test.
 *
 * Tests node slug generation, fleet node config load/save persistence,
 * and harvest state load/save in isolated temporary data directory.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-harvester.ts
 */

import { nodeSlug, getNodes, saveNodes, loadHarvestState, type FleetNodeConfig } from './services/harvester.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

function main() {
    console.log('Running harvester service test...\n');

    // 1. Test nodeSlug
    assert(nodeSlug('') === 'unknown', 'nodeSlug handles empty target');
    assert(nodeSlug('mullum') === 'mullum', 'nodeSlug handles exact default node id');
    assert(nodeSlug({ id: 'custom-1', name: 'Mullumbimby Node', url: 'https://mullum.example.com' }) === 'mullum', 'nodeSlug detects mullum keyword in name/url');
    assert(nodeSlug({ id: 'custom-2', name: 'Local Dev Node', url: 'http://localhost:8450' }) === 'local-node', 'nodeSlug detects localhost url');
    assert(nodeSlug({ id: 'special@node/1', name: 'Special Node', url: 'https://special.org' }) === 'special_node_1', 'nodeSlug sanitizes special characters');

    // 2. Test getNodes default fallback
    const initialNodes = getNodes();
    assert(Array.isArray(initialNodes) && initialNodes.length > 0, 'getNodes returns default nodes when no config file exists');
    assert(initialNodes.some(n => n.id === 'mullum'), 'default nodes include mullum');

    // 3. Test saveNodes & getNodes persistence roundtrip
    const customNodes: FleetNodeConfig[] = [
        { id: 'custom-pool', name: 'Custom Pool Node', url: 'https://custom.beanpool.org', adminPassword: 'secret-pass' },
    ];
    saveNodes(customNodes);
    const reloadedNodes = getNodes();
    assert(reloadedNodes.length === 1 && reloadedNodes[0].id === 'custom-pool', 'saveNodes persists custom node configuration');
    assert(reloadedNodes[0].adminPassword === 'secret-pass', 'adminPassword field preserved');

    // 4. Test loadHarvestState default
    const initialState = loadHarvestState();
    assert(typeof initialState === 'object' && Object.keys(initialState).length === 0, 'loadHarvestState returns empty object when state file does not exist');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main();
