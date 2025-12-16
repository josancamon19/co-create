import * as vscode from 'vscode';
import { dbConnection } from '../database/connection';
import { projectRepository } from '../database/repositories/project';
import { sessionRepository } from '../database/repositories/session';
import { interactionRepository, InteractionInput } from '../database/repositories/interaction';
import { eventRepository, EventInput } from '../database/repositories/event';
import { Project, Session, EventSource, EventType, EventMetadata } from '../database/schema';
import { getGitRemoteUrl, getGitRepoName, generateProjectIdentifier, getGitCommitId } from '../utils/git';

export interface RecordEventOptions {
  source: EventSource;
  type: EventType;
  filePath?: string | null;
  content?: string | null;
  linesAdded?: number;
  linesRemoved?: number;
  // Agent interaction data (only used when source === 'agent')
  agentSubtype?: 'cmdk' | 'composer' | null;
  agentModel?: string | null;
  agentPrompt?: string | null;
  agentResponse?: string | null;
  agentThinking?: string | null;
  agentToolUsage?: string | null;
  agentInputTokens?: number;
  agentOutputTokens?: number;
}

export class SessionManager {
  private static instance: SessionManager | null = null;

  private currentProject: Project | null = null;
  private currentSession: Session | null = null;
  private currentCommitId: string | null = null;
  private workspacePath: string | null = null;
  private lastActivityTime: number = Date.now();
  private idleTimeoutMs: number;
  private isInitialized: boolean = false;

  // Cache the current interaction ID to link multiple events to the same interaction
  private currentInteractionId: number | null = null;
  private currentInteractionBubbleId: string | null = null;

  private constructor() {
    const config = vscode.workspace.getConfiguration('cursorCollector');
    const timeoutMinutes = config.get<number>('sessionTimeoutMinutes', 120);
    this.idleTimeoutMs = timeoutMinutes * 60 * 1000;
  }

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      console.log('[Collector] No workspace folder found');
      return;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    this.workspacePath = workspacePath;

    // Initialize database (async)
    await dbConnection.initialize(workspacePath);

    // Get or create project
    await this.initializeProject(workspacePath);

    // Get current commit ID
    this.currentCommitId = await getGitCommitId(workspacePath);

    // Start or resume session
    this.startOrResumeSession();

    this.isInitialized = true;
    console.log('[Collector] Session manager initialized');
    if (this.currentCommitId) {
      console.log(`[Collector] Current commit: ${this.currentCommitId.substring(0, 8)}`);
    }
  }

  private async initializeProject(workspacePath: string): Promise<void> {
    // Try to get git remote URL
    let projectIdentifier = await getGitRemoteUrl(workspacePath);
    let projectName = await getGitRepoName(workspacePath);

    // Fallback to local identifier if not a git repo
    if (!projectIdentifier) {
      projectIdentifier = generateProjectIdentifier(workspacePath);
      projectName = vscode.workspace.name || null;
    }

    // Find or create project
    this.currentProject = projectRepository.findOrCreate(
      projectIdentifier,
      projectName ?? undefined,
      workspacePath
    );

    console.log(`[Collector] Project: ${this.currentProject.git_remote_url}`);
  }

  private startOrResumeSession(): void {
    if (!this.currentProject) {
      return;
    }

    // Check for an existing open session
    const openSession = sessionRepository.getOpenSessionForProject(this.currentProject.id);

    if (openSession) {
      // Check if the session is still within the idle timeout
      const latestEvent = eventRepository.getLatest(openSession.id);
      if (latestEvent) {
        const lastEventTime = new Date(latestEvent.timestamp).getTime();
        const timeSinceLastEvent = Date.now() - lastEventTime;

        if (timeSinceLastEvent < this.idleTimeoutMs) {
          // Resume existing session
          this.currentSession = openSession;
          this.lastActivityTime = lastEventTime;
          console.log(`[Collector] Resumed session ${this.currentSession.id}`);
          return;
        } else {
          // Session timed out, end it
          sessionRepository.endSession(openSession.id);
        }
      }
    }

    // Create new session
    this.currentSession = sessionRepository.create(this.currentProject.id);
    this.lastActivityTime = Date.now();
    console.log(`[Collector] Started new session ${this.currentSession.id}`);
  }

  /**
   * Record an event (diff, file_create, file_delete, terminal).
   * If source is 'agent', also creates/reuses an interaction record.
   */
  recordEvent(options: RecordEventOptions, bubbleId?: string | null): void {
    if (!this.isInitialized || !this.currentSession) {
      return;
    }

    const now = Date.now();

    // Check if we need to start a new session due to idle timeout
    if (now - this.lastActivityTime > this.idleTimeoutMs) {
      this.endCurrentSession();
      this.startOrResumeSession();
    }

    // Update last activity time
    this.lastActivityTime = now;

    if (!this.currentSession) {
      return;
    }

    let interactionId: number | null = null;

    // If this is an agent event, create or reuse an interaction
    if (options.source === 'agent') {
      // Check if we should reuse the current interaction (same bubble)
      if (bubbleId && bubbleId === this.currentInteractionBubbleId && this.currentInteractionId) {
        interactionId = this.currentInteractionId;
      } else {
        // Create new interaction
        const interactionInput: InteractionInput = {
          sessionId: this.currentSession.id,
          subtype: options.agentSubtype,
          model: options.agentModel,
          prompt: options.agentPrompt,
          thinking: options.agentThinking,
          response: options.agentResponse,
          toolUsage: options.agentToolUsage,
          inputTokens: options.agentInputTokens ?? 0,
          outputTokens: options.agentOutputTokens ?? 0,
        };
        interactionId = interactionRepository.create(interactionInput);
        this.currentInteractionId = interactionId;
        this.currentInteractionBubbleId = bubbleId || null;
      }
    } else {
      // Human or tab-completion event - clear interaction cache
      this.currentInteractionId = null;
      this.currentInteractionBubbleId = null;
    }

    // Build metadata
    const metadata: EventMetadata = {
      commit_id: this.currentCommitId,
    };
    if (options.linesAdded !== undefined) {
      metadata.lines_added = options.linesAdded;
    }
    if (options.linesRemoved !== undefined) {
      metadata.lines_removed = options.linesRemoved;
    }

    // Create the event
    const eventInput: EventInput = {
      interactionId,
      sessionId: this.currentSession.id,
      source: options.source,
      type: options.type,
      filePath: options.filePath,
      content: options.content,
      metadata,
    };
    eventRepository.create(eventInput);
  }

  private endCurrentSession(): void {
    if (this.currentSession) {
      sessionRepository.endSession(this.currentSession.id);
      console.log(`[Collector] Ended session ${this.currentSession.id}`);
      this.currentSession = null;
    }
    // Clear interaction cache
    this.currentInteractionId = null;
    this.currentInteractionBubbleId = null;
  }

  shutdown(): void {
    this.endCurrentSession();
    dbConnection.close();
    this.isInitialized = false;
    console.log('[Collector] Session manager shut down');
  }

  getCurrentSession(): Session | null {
    return this.currentSession;
  }

  getCurrentProject(): Project | null {
    return this.currentProject;
  }

  getSessionStats(): {
    projectName: string | null;
    sessionId: number | null;
    totalEvents: number;
    sessionDuration: number | null;
  } | null {
    if (!this.currentProject || !this.currentSession) {
      return null;
    }

    const totalEvents = eventRepository.countForSession(this.currentSession.id);
    const sessionStart = new Date(this.currentSession.started_at).getTime();
    const duration = Date.now() - sessionStart;

    return {
      projectName: this.currentProject.name,
      sessionId: this.currentSession.id,
      totalEvents,
      sessionDuration: duration,
    };
  }

  isReady(): boolean {
    return this.isInitialized && this.currentSession !== null;
  }
}

export const sessionManager = SessionManager.getInstance();
