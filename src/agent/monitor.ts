import * as vscode from 'vscode';
import { getMostRecentAIBubbleTime, getAIBubbleCount } from '../utils/cursor-db';

// How long to consider "agent is active" after detecting AI activity
const AGENT_ACTIVITY_WINDOW_MS = 10000; // 10 seconds

export class AgentActivityMonitor {
  private static instance: AgentActivityMonitor | null = null;

  private pollInterval: NodeJS.Timeout | null = null;
  private lastAgentActivityTime: number = 0;
  private lastKnownBubbleTimestamp: string | null = null;
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
      // Get the most recent AI bubble timestamp from cursorDiskKV
      const mostRecentTimestamp = await getMostRecentAIBubbleTime();

      if (mostRecentTimestamp) {
        console.log('[AgentMonitor] Most recent AI bubble:', mostRecentTimestamp);

        // Check if this is a new bubble (timestamp changed)
        if (this.lastKnownBubbleTimestamp !== mostRecentTimestamp) {
          console.log('[AgentMonitor] New AI activity detected! Previous:', this.lastKnownBubbleTimestamp);

          // Check if the bubble is recent (within the last few seconds)
          const bubbleTime = new Date(mostRecentTimestamp).getTime();
          const now = Date.now();
          const ageMs = now - bubbleTime;

          // Only mark as active if the bubble is very recent (within 30 seconds)
          // This helps avoid false positives from old data on startup
          if (ageMs < 30000) {
            this.markAgentActive();
          } else {
            console.log('[AgentMonitor] Bubble is old (', Math.round(ageMs / 1000), 's), not marking as active');
          }

          this.lastKnownBubbleTimestamp = mostRecentTimestamp;
        }
      } else {
        console.log('[AgentMonitor] No AI bubbles found in cursorDiskKV');
      }

      // Also log the total count for debugging
      const totalCount = await getAIBubbleCount();
      console.log('[AgentMonitor] Total AI bubble count:', totalCount);

    } catch (error) {
      console.error('[AgentMonitor] Error checking activity:', error);
    }
  }
}

export const agentMonitor = AgentActivityMonitor.getInstance();
