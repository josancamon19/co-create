import * as vscode from 'vscode';
import { getAIBubbleCount, getInlineDiffCount, getMostRecentAIGeneration, getLatestAgentInteraction, getLatestAIBubbleTimestamp, AgentInteraction } from '../utils/cursor-db';

// How long to consider an agent activity as "recent" for immediate changes
// Shorter window reduces bleed-over into later human edits
const RECENT_AGENT_ACTIVITY_MS = 4000; // 4 seconds

export type AgentSubtype = 'cmdk' | 'composer' | null;

export class AgentActivityMonitor {
  private static instance: AgentActivityMonitor | null = null;

  private pollInterval: NodeJS.Timeout | null = null;
  private lastAgentActivityTime: number = 0;
  private lastAgentSubtype: AgentSubtype = null;
  private lastAgentInteraction: AgentInteraction | null = null;
  private lastWorkspaceFsPath: string | null = null;
  private lastKnownBubbleTimestamp: string | null = null;
  private lastKnownInlineDiffCount: number = 0;
  private lastKnownGenerationTime: number = 0;
  private isRunning: boolean = false;
  private pollIntervalMs: number;

  // Track whether the current agent activity has been "consumed" by a change
  // This prevents the same agent activity from being attributed to multiple change batches
  private agentActivityConsumed: boolean = false;
  // Track when we detected NEW activity (not just any activity within window)
  private newActivityDetectedAt: number = 0;

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
   * Returns true if there is PENDING agent activity that hasn't been consumed yet,
   * or if the agent was very recently active (within RECENT_AGENT_ACTIVITY_MS).
   *
   * This prevents human changes from being incorrectly attributed to old agent activity.
   */
  isAgentActive(workspaceFsPath?: string): boolean {
    // If activity was already consumed by a previous change, not active
    if (this.agentActivityConsumed) {
      return false;
    }

    // Check if we detected new activity recently
    const timeSinceNewActivity = Date.now() - this.newActivityDetectedAt;
    if (timeSinceNewActivity < RECENT_AGENT_ACTIVITY_MS) {
      if (workspaceFsPath && this.lastWorkspaceFsPath) {
        // Only treat as active if the current change is within the same workspace
        if (!workspaceFsPath.startsWith(this.lastWorkspaceFsPath)) {
          return false;
        }
      }
      return true;
    }

    return false;
  }

  /**
   * Get the source for a change based on current agent activity
   */
  getSource(workspaceFsPath?: string): 'human' | 'agent' {
    return this.isAgentActive(workspaceFsPath) ? 'agent' : 'human';
  }

  /**
   * Get the subtype of the most recent agent activity
   * Returns null if no agent activity or if subtype is unknown
   */
  getAgentSubtype(workspaceFsPath?: string): AgentSubtype {
    if (!this.isAgentActive(workspaceFsPath)) {
      return null;
    }
    return this.lastAgentSubtype;
  }

  /**
   * Get the model used for the most recent agent activity
   */
  getAgentModel(workspaceFsPath?: string): string | null {
    if (!this.isAgentActive(workspaceFsPath)) {
      return null;
    }
    return this.lastAgentInteraction?.model ?? null;
  }

  /**
   * Get the prompt/instruction for the most recent agent activity
   */
  getAgentPrompt(workspaceFsPath?: string): string | null {
    if (!this.isAgentActive(workspaceFsPath)) {
      return null;
    }
    return this.lastAgentInteraction?.prompt ?? null;
  }

  /**
   * Get the full agent interaction data
   */
  getAgentInteraction(workspaceFsPath?: string): AgentInteraction | null {
    if (!this.isAgentActive(workspaceFsPath)) {
      return null;
    }
    return this.lastAgentInteraction;
  }

  /**
   * Mark the current agent activity as consumed.
   * Call this after attributing a change to the agent to prevent
   * the same activity from being attributed to subsequent human changes.
   */
  consumeAgentActivity(): void {
    this.agentActivityConsumed = true;
    console.log('[AgentMonitor] Agent activity consumed');
  }

  /**
   * Manually mark agent as active with full interaction data
   */
  markAgentActive(
    subtype: AgentSubtype = null,
    interaction: AgentInteraction | null = null,
    workspaceFsPath?: string | null,
  ): void {
    this.lastAgentActivityTime = Date.now();
    this.newActivityDetectedAt = Date.now();
    this.lastAgentSubtype = subtype;
    this.lastAgentInteraction = interaction;
    this.lastWorkspaceFsPath = workspaceFsPath ?? null;
    this.agentActivityConsumed = false; // New activity, not consumed yet
    const model = interaction?.model?.substring(0, 30) || 'N/A';
    const prompt = interaction?.prompt?.substring(0, 50) || 'N/A';
    console.log(`[AgentMonitor] Agent activity detected (subtype: ${subtype}, model: ${model}, prompt: ${prompt}...)`);
  }

  /**
   * Force an immediate check for agent activity.
   * Returns true if new activity was detected.
   * Use this when large changes are detected to ensure we don't miss agent activity.
   */
  async forceCheckForAgentActivity(workspaceFsPath?: string): Promise<boolean> {
    const wasActive = this.isAgentActive(workspaceFsPath);
    await this.checkForAgentActivity();
    const isNowActive = this.isAgentActive(workspaceFsPath);

    // Return true if we detected new activity (wasn't active before, is now)
    // or if activity state changed
    return !wasActive && isNowActive;
  }

  private async checkForAgentActivity(): Promise<void> {
    console.log('[AgentMonitor] Checking for agent activity...');
    try {
      // Get the current workspace folder URI
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspaceFolderUri = workspaceFolders?.[0]?.uri.toString() || '';
      const workspaceFolderFsPath = workspaceFolders?.[0]?.uri.fsPath || null;

      // PRIMARY: Check for new AI bubbles in global DB (this captures composer/chat)
      // This is the most reliable source for model, prompt, response, etc.
      const latestBubbleTimestamp = await getLatestAIBubbleTimestamp();
      if (latestBubbleTimestamp && latestBubbleTimestamp !== this.lastKnownBubbleTimestamp) {
        // NEW bubble detected - mark as active
        const interaction = await getLatestAgentInteraction();
        if (interaction) {
          const bubbleTime = new Date(latestBubbleTimestamp).getTime();
          const ageMs = Date.now() - bubbleTime;
          console.log('[AgentMonitor] New AI bubble detected! Age:', Math.round(ageMs / 1000), 's');
          console.log(`[AgentMonitor] Model: ${interaction.model}, Prompt: ${interaction.prompt?.substring(0, 50)}...`);
          console.log(`[AgentMonitor] Response: ${interaction.response?.substring(0, 100)}...`);
          console.log(`[AgentMonitor] Tokens: in=${interaction.inputTokens}, out=${interaction.outputTokens}`);
          this.markAgentActive('composer', interaction, workspaceFolderFsPath);
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
              this.markAgentActive('cmdk', finalInteraction, workspaceFolderFsPath);
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
        this.markAgentActive('cmdk', interaction, workspaceFolderFsPath);
      }
      this.lastKnownInlineDiffCount = inlineDiffCount;

      // Log status
      const totalCount = await getAIBubbleCount();
      const isActive = this.isAgentActive();
      console.log('[AgentMonitor] Status - Bubbles:', totalCount, 'InlineDiffs:', inlineDiffCount, 'Active:', isActive, 'Consumed:', this.agentActivityConsumed);

    } catch (error) {
      console.error('[AgentMonitor] Error checking activity:', error);
    }
  }
}

export const agentMonitor = AgentActivityMonitor.getInstance();
