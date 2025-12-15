import * as vscode from 'vscode';
import { getMostRecentAIBubbleTime, getAIBubbleCount, getInlineDiffCount, getMostRecentAIGenerationTime } from '../utils/cursor-db';

// How long to consider "agent is active" after detecting AI activity
// Increased to 30 seconds to handle Cmd+K inline edits where user may review before accepting
const AGENT_ACTIVITY_WINDOW_MS = 30000; // 30 seconds

export class AgentActivityMonitor {
  private static instance: AgentActivityMonitor | null = null;

  private pollInterval: NodeJS.Timeout | null = null;
  private lastAgentActivityTime: number = 0;
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
   * Manually mark agent as active (can be called from other sources)
   */
  markAgentActive(): void {
    this.lastAgentActivityTime = Date.now();
    console.log('[AgentMonitor] Agent activity detected');
  }

  private async checkForAgentActivity(): Promise<void> {
    console.log('[AgentMonitor] Checking for agent activity...');
    try {
      // Get the current workspace folder URI
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspaceFolderUri = workspaceFolders?.[0]?.uri.toString() || '';

      // PRIMARY: Check workspace-specific AI generations (captures Cmd+K and composer)
      if (workspaceFolderUri) {
        const mostRecentGenTime = await getMostRecentAIGenerationTime(workspaceFolderUri);
        if (mostRecentGenTime) {
          console.log('[AgentMonitor] Most recent AI generation:', new Date(mostRecentGenTime).toISOString());

          if (mostRecentGenTime > this.lastKnownGenerationTime) {
            const now = Date.now();
            const ageMs = now - mostRecentGenTime;

            // Only mark as active if the generation is recent (within 30 seconds)
            if (ageMs < 30000) {
              console.log('[AgentMonitor] New AI generation detected! Age:', Math.round(ageMs / 1000), 's');
              this.markAgentActive();
            } else {
              console.log('[AgentMonitor] Generation is old (', Math.round(ageMs / 1000), 's), not marking as active');
            }

            this.lastKnownGenerationTime = mostRecentGenTime;
          }
        }
      }

      // SECONDARY: Also check global database for AI bubbles (composer activity)
      const mostRecentTimestamp = await getMostRecentAIBubbleTime();
      if (mostRecentTimestamp) {
        if (this.lastKnownBubbleTimestamp !== mostRecentTimestamp) {
          const bubbleTime = new Date(mostRecentTimestamp).getTime();
          const now = Date.now();
          const ageMs = now - bubbleTime;

          if (ageMs < 30000) {
            console.log('[AgentMonitor] New AI bubble detected! Age:', Math.round(ageMs / 1000), 's');
            this.markAgentActive();
          }

          this.lastKnownBubbleTimestamp = mostRecentTimestamp;
        }
      }

      // TERTIARY: Check for inline diff activity
      const inlineDiffCount = await getInlineDiffCount();
      if (inlineDiffCount > this.lastKnownInlineDiffCount) {
        console.log('[AgentMonitor] New inline diff detected! Count:', inlineDiffCount, 'Previous:', this.lastKnownInlineDiffCount);
        this.markAgentActive();
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
