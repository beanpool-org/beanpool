import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiServicesModule } from './AiServicesModule';
import * as aiClient from '../../lib/ai-client';
import type { NodeProfile } from '../../lib/profiles';

vi.mock('../../lib/ai-client', async () => {
    const actual = await vi.importActual<typeof import('../../lib/ai-client')>('../../lib/ai-client');
    return {
        ...actual,
        loadAiConfig: vi.fn(),
        saveAiConfig: vi.fn(),
        askAiCopilot: vi.fn(),
    };
});

describe('AiServicesModule', () => {
    const mockNode: NodeProfile = {
        id: 'node-1',
        name: 'Test Node Alpha',
        url: 'http://localhost:8080',
        adminPassword: 'password123',
    };

    const mockContextData: aiClient.CopilotContextData = {
        telemetry: {
            callsign: 'ALPHA-1',
            status: 'online',
            cpuLoadPercent: 12,
            memoryUsageMb: 128,
            totalMemoryMb: 1024,
            userCount: 5,
        },
        logs: [],
    };

    const mockDefaultConfig: aiClient.AiConfig = {
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'llama3:latest',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(aiClient.loadAiConfig).mockReturnValue(mockDefaultConfig);
    });

    it('renders initial AI provider config and active node name', () => {
        render(<AiServicesModule activeNode={mockNode} contextData={mockContextData} />);

        expect(screen.getByText('Sovereign AI Copilot (`@beanpool/ai`)')).toBeInTheDocument();
        expect(screen.getByText('Test Node Alpha')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('http://localhost:11434')).toHaveValue('http://localhost:11434');
        expect(screen.getByPlaceholderText('llama3:latest')).toHaveValue('llama3:latest');
    });

    it('allows changing provider configuration and saving it', async () => {
        render(<AiServicesModule activeNode={mockNode} contextData={mockContextData} />);

        const providerSelect = screen.getByRole('combobox');
        fireEvent.change(providerSelect, { target: { value: 'openrouter' } });

        // OpenRouter API key field should now appear
        const apiKeyInput = screen.getByPlaceholderText('sk-or-v1-...');
        fireEvent.change(apiKeyInput, { target: { value: 'sk-or-v1-testkey' } });

        const saveButton = screen.getByText('Save AI Config');
        fireEvent.click(saveButton);

        expect(aiClient.saveAiConfig).toHaveBeenCalledWith({
            provider: 'openrouter',
            baseUrl: 'http://localhost:11434',
            model: 'llama3:latest',
            apiKey: 'sk-or-v1-testkey',
        });

        expect(screen.getByText('✓ Settings Saved')).toBeInTheDocument();
    });

    it('submits a prompt and renders copilot response', async () => {
        vi.mocked(aiClient.askAiCopilot).mockResolvedValueOnce('All node metrics are within operational thresholds.');

        render(<AiServicesModule activeNode={mockNode} contextData={mockContextData} />);

        const input = screen.getByPlaceholderText(/Analyze current node diagnostics/i);
        const submitBtn = screen.getByRole('button', { name: /Ask Copilot/i });

        fireEvent.change(input, { target: { value: 'Check memory usage' } });
        fireEvent.click(submitBtn);

        expect(screen.getByText('Analyzing...')).toBeInTheDocument();
        expect(aiClient.askAiCopilot).toHaveBeenCalledWith('Check memory usage', mockContextData, mockDefaultConfig);

        await waitFor(() => {
            expect(screen.getByText('All node metrics are within operational thresholds.')).toBeInTheDocument();
        });
    });

    it('handles errors when asking AI copilot fails', async () => {
        vi.mocked(aiClient.askAiCopilot).mockRejectedValueOnce(new Error('Network error connecting to Ollama'));

        render(<AiServicesModule activeNode={mockNode} contextData={mockContextData} />);

        const input = screen.getByPlaceholderText(/Analyze current node diagnostics/i);
        const submitBtn = screen.getByRole('button', { name: /Ask Copilot/i });

        fireEvent.change(input, { target: { value: 'Test error prompt' } });
        fireEvent.click(submitBtn);

        await waitFor(() => {
            expect(screen.getByText('❌ AI Copilot Error: Network error connecting to Ollama')).toBeInTheDocument();
        });
    });
});
