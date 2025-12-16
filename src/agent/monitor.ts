import * as vscode from 'vscode';
import { getAIBubbleCount, getInlineDiffCount, getMostRecentAIGeneration, getLatestAgentInteraction, getLatestAIBubbleTimestamp, AgentInteraction } from '../utils/cursor-db';

// How long to consider "agent is active" after detecting AI activity
// Increased to 30 seconds to handle Cmd+K inline edits where user may review before accepting
const AGENT_ACTIVITY_WINDOW_MS = 30000; // 30 seconds

export type AgentSubtype = 'cmdk' | 'composer' | null;

export class AgentActivityMonitor {
  private static instance: AgentActivityMonitor | null = null;

  private pollInterval: NodeJS.Timeout | null = null;
  private lastAgentActivityTime: number = 0;
  private lastAgentSubtype: AgentSubtype = null;
  private lastAgentInteraction: AgentInteraction | null = null;
  private lastKnownBubbleTimestamp: string | null = null;
  private lastKnownInlineDiffCount: number = 0;
  private lastKnownGenerationTime: number = 0;
  private isRunning: boolean = false;
  private pollIntervalMs: number;

  private constructor() {
    const config = vscode.workspace.getConfiguration('cursorCollector');
    this.pollIntervalMs = config.get<number>('chatPollIntervalMs', 5000);
  }

  static getInstance(): AgentActivityMonitor {
    if (!AgentActivityMonitor.instance) {
      AgentActivityMonitor.instance = new AgentActivityMonitor();
    }
    return AgentActivityMonitor.instance;
  }

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log(`[AgentMonitor] Starting with poll interval: ${this.pollIntervalMs}ms`);

    this.pollInterval = setInterval(() => {
      this.checkForAgentActivity();
    }, this.pollIntervalMs);

    // Initial check
    this.checkForAgentActivity();
    console.log('[AgentMonitor] Started monitoring for agent activity');
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isRunning = false;
    console.log('[AgentMonitor] Stopped monitoring');
  }

  /**
   * Returns true if the agent was recently active (within the activity window)
   */
  isAgentActive(): boolean {
    const timeSinceActivity = Date.now() - this.lastAgentActivityTime;
    return timeSinceActivity < AGENT_ACTIVITY_WINDOW_MS;
  }

  /**
   * Get the source for a change based on current agent activity
   */
  getSource(): 'human' | 'agent' {
    return this.isAgentActive() ? 'agent' : 'human';
  }

  /**
   * Get the subtype of the most recent agent activity
   * Returns null if no agent activity or if subtype is unknown
   */
  getAgentSubtype(): AgentSubtype {
    if (!this.isAgentActive()) {
      return null;
    }
    return this.lastAgentSubtype;
  }

  /**
   * Get the model used for the most recent agent activity
   */
  getAgentModel(): string | null {
    if (!this.isAgentActive()) {
      return null;
    }
    return this.lastAgentInteraction?.model ?? null;
  }

  /**
   * Get the prompt/instruction for the most recent agent activity
   */
  getAgentPrompt(): string | null {
    if (!this.isAgentActive()) {
      return null;
    }
    return this.lastAgentInteraction?.prompt ?? null;
  }

  /**
   * Get the full agent interaction data
   */
  getAgentInteraction(): AgentInteraction | null {
    if (!this.isAgentActive()) {
      return null;
    }
    return this.lastAgentInteraction;
  }

  /**
   * Manually mark agent as active with full interaction data
   */
  markAgentActive(subtype: AgentSubtype = null, interaction: AgentInteraction | null = null): void {
    this.lastAgentActivityTime = Date.now();
    this.lastAgentSubtype = subtype;
    this.lastAgentInteraction = interaction;
    const model = interaction?.model?.substring(0, 30) || 'N/A';
    const prompt = interaction?.prompt?.substring(0, 50) || 'N/A';
    console.log(`[AgentMonitor] Agent activity detected (subtype: ${subtype}, model: ${model}, prompt: ${prompt}...)`);
  }

  private async checkForAgentActivity(): Promise<void> {
    console.log('[AgentMonitor] Checking for agent activity...');
    try {
      // Get the current workspace folder URI
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspaceFolderUri = workspaceFolders?.[0]?.uri.toString() || '';

      // PRIMARY: Check for new AI bubbles in global DB (this captures composer/chat)
      // This is the most reliable source for model, prompt, response, etc.
      const latestBubbleTimestamp = await getLatestAIBubbleTimestamp();
      if (latestBubbleTimestamp && latestBubbleTimestamp !== this.lastKnownBubbleTimestamp) {
        const bubbleTime = new Date(latestBubbleTimestamp).getTime();
        const now = Date.now();
        const ageMs = now - bubbleTime;

        if (ageMs < 30000) {
          // Fetch full interaction data
          const interaction = await getLatestAgentInteraction();
          if (interaction) {
            console.log('[AgentMonitor] New AI bubble detected! Age:', Math.round(ageMs / 1000), 's');
            console.log(`[AgentMonitor] Model: ${interaction.model}, Prompt: ${interaction.prompt?.substring(0, 50)}...`);
            this.markAgentActive('composer', interaction);
          }
        } else {
          console.log('[AgentMonitor] Bubble is old (', Math.round(ageMs / 1000), 's), not marking as active');
        }

        this.lastKnownBubbleTimestamp = latestBubbleTimestamp;
      }

      // SECONDARY: Check workspace-specific AI generations (captures Cmd+K)
      // This helps detect Cmd+K which might not create bubbles in the same way
      if (workspaceFolderUri) {
        const mostRecentGen = await getMostRecentAIGeneration(workspaceFolderUri);
        if (mostRecentGen) {
          if (mostRecentGen.unixMs > this.lastKnownGenerationTime) {
            const now = Date.now();
            const ageMs = now - mostRecentGen.unixMs;

            // Only mark as active if the generation is recent (within 30 seconds)
            // and it's a Cmd+K type (composer handled above via bubbles)
            if (ageMs < 30000 && mostRecentGen.type === 'cmdk') {
              // For Cmd+K, try to get interaction data if available
              const interaction = await getLatestAgentInteraction();

              // If we have interaction data and prompt from generation, merge them
              const finalInteraction: AgentInteraction | null = interaction ? {
                ...interaction,
                prompt: mostRecentGen.textDescription || interaction.prompt,
              } : mostRecentGen.textDescription ? {
                bubbleId: mostRecentGen.generationUUID,
                model: null,
                prompt: mostRecentGen.textDescription,
                response: null,
                thinking: null,
                toolUsage: null,
                inputTokens: 0,
                outputTokens: 0,
                timestamp: new Date(mostRecentGen.unixMs).toISOString(),
                isAgentic: false,
              } : null;

              console.log('[AgentMonitor] New Cmd+K generation detected! Age:', Math.round(ageMs / 1000), 's');
              this.markAgentActive('cmdk', finalInteraction);
            }

            this.lastKnownGenerationTime = mostRecentGen.unixMs;
          }
        }
      }

      // TERTIARY: Check for inline diff activity (Cmd+K creates inline diffs)
      const inlineDiffCount = await getInlineDiffCount();
      if (inlineDiffCount > this.lastKnownInlineDiffCount) {
        // Get interaction data for inline diff activity
        const interaction = await getLatestAgentInteraction();
        console.log('[AgentMonitor] New inline diff detected! Count:', inlineDiffCount, 'Previous:', this.lastKnownInlineDiffCount);
        this.markAgentActive('cmdk', interaction);
      }
      this.lastKnownInlineDiffCount = inlineDiffCount;

      // Log status
      const totalCount = await getAIBubbleCount();
      console.log('[AgentMonitor] Status - Bubbles:', totalCount, 'InlineDiffs:', inlineDiffCount, 'GenTime:', this.lastKnownGenerationTime);

    } catch (error) {
      console.error('[AgentMonitor] Error checking activity:', error);
    }
  }
}

export const agentMonitor = AgentActivityMonitor.getInstance();
