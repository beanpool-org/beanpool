/**
 * Sovereign AI Copilot Client — Fleet Intelligence & Diagnostics Assistant
 */

export interface AiConfig {
    provider: 'ollama' | 'openrouter' | 'custom';
    baseUrl: string;
    apiKey?: string;
    model: string;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'llama3:latest',
};

export function loadAiConfig(): AiConfig {
    try {
        const raw = localStorage.getItem('bp_fleet_ai_config');
        if (raw) return JSON.parse(raw);
    } catch {}
    return DEFAULT_AI_CONFIG;
}

export function saveAiConfig(config: AiConfig): void {
    try {
        localStorage.setItem('bp_fleet_ai_config', JSON.stringify(config));
    } catch {}
}

export async function askAiCopilot(
    prompt: string,
    contextData: { telemetry?: any; gateway?: any; members?: any; logs?: any[] },
    config: AiConfig = loadAiConfig()
): Promise<string> {
    const systemPrompt = `You are BeanPool Sovereign Fleet AI Copilot — an autonomous node diagnostics and community assistant.
You assist node operators with multi-node control, telemetry, security auditing, and member trust analysis.
Here is the current target node state telemetry:
- Node Telemetry: ${JSON.stringify(contextData.telemetry || {})}
- Gateway Config: ${JSON.stringify(contextData.gateway || {})}
- Member Summary: ${contextData.members?.length ? `${contextData.members.length} members` : 'Unknown'}
- Recent Logs Count: ${contextData.logs?.length || 0} logs

Provide clear, professional, concise, actionable advice in Markdown format.`;

    if (config.provider === 'ollama') {
        try {
            const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: config.model || 'llama3',
                    prompt: `${systemPrompt}\n\nUser Question: ${prompt}`,
                    stream: false,
                }),
            });
            if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${res.statusText}`);
            const data = await res.json();
            return data.response || 'No response received from Ollama.';
        } catch (e: any) {
            // Fallback simulation / helpful guidance if Ollama local server is not reachable right now
            return `### 🤖 Sovereign AI Copilot Analysis (Local Diagnostic Mode)

*Notice: Could not connect to local Ollama server at \`${config.baseUrl}\`. Running offline diagnostic synthesis:*

**Node Health Assessment:**
- **Status:** Target node status is \`${contextData.telemetry?.status || 'ONLINE'}\`.
- **Database Storage:** ${(contextData.telemetry?.dbSizeBytes ? contextData.telemetry.dbSizeBytes / (1024 * 1024) : 0).toFixed(2)} MB.
- **WebSocket & P2P Connections:** ${contextData.telemetry?.activeWsConnections || 0} active WebSocket streams, ${contextData.telemetry?.p2pActivePeers || 0} P2P peers.

**Recommendations:**
1. Maintain active WAL checkpoints to keep SQLite memory usage optimized.
2. Verify rate limiting is enabled under Gateway settings for production public nodes.
3. To enable live local LLM inference, launch Ollama locally (\`ollama run llama3\`) or configure OpenRouter API credentials in the settings panel below.`;
        }
    } else if (config.provider === 'openrouter') {
        try {
            const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey || ''}`,
                },
                body: JSON.stringify({
                    model: config.model || 'meta-llama/llama-3-8b-instruct:free',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: prompt },
                    ],
                }),
            });
            if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${res.statusText}`);
            const data = await res.json();
            return data.choices?.[0]?.message?.content || 'No response from OpenRouter.';
        } catch (e: any) {
            return `❌ OpenRouter API Request Failed: ${e.message}. Please verify your API key and network connection.`;
        }
    }

    return 'Selected AI Provider is not supported yet.';
}
