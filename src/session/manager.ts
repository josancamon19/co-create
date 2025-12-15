import * as vscode from 'vscode';
import { dbConnection } from '../database/connection';
import { projectRepository } from '../database/repositories/project';
import { sessionRepository } from '../database/repositories/session';
import { diffRepository, DiffInput } from '../database/repositories/diff';
import { Project, Session } from '../database/schema';
import { getGitRemoteUrl, getGitRepoName, generateProjectIdentifier, getGitCommitId } from '../utils/git';

export class SessionManager {
  private static instance: SessionManager | null = null;

  private currentProject: Project | null = null;
  private currentSession: Session | null = null;
  private currentCommitId: string | null = null;
  private workspacePath: string | null = null;
  private lastActivityTime: number = Date.now();
  private idleTimeoutMs: number;
  private isInitialized: boolean = false;

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
      const latestDiff = diffRepository.getLatest(openSession.id);
      if (latestDiff) {
        const lastDiffTime = new Date(latestDiff.timestamp).getTime();
        const timeSinceLastDiff = Date.now() - lastDiffTime;

        if (timeSinceLastDiff < this.idleTimeoutMs) {
          // Resume existing session
          this.currentSession = openSession;
          this.lastActivityTime = lastDiffTime;
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

  recordDiff(input: Omit<DiffInput, 'sessionId' | 'commitId'>): void {
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

    // Record the diff with current commit ID
    if (this.currentSession) {
      diffRepository.create({
        sessionId: this.currentSession.id,
        commitId: this.currentCommitId,
        ...input,
      });
    }
  }

  private endCurrentSession(): void {
    if (this.currentSession) {
      sessionRepository.endSession(this.currentSession.id);
      console.log(`[Collector] Ended session ${this.currentSession.id}`);
      this.currentSession = null;
    }
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
    totalDiffs: number;
    sessionDuration: number | null;
  } | null {
    if (!this.currentProject || !this.currentSession) {
      return null;
    }

    const totalDiffs = diffRepository.countForSession(this.currentSession.id);
    const sessionStart = new Date(this.currentSession.started_at).getTime();
    const duration = Date.now() - sessionStart;

    return {
      projectName: this.currentProject.name,
      sessionId: this.currentSession.id,
      totalDiffs,
      sessionDuration: duration,
    };
  }

  isReady(): boolean {
    return this.isInitialized && this.currentSession !== null;
  }
}

export const sessionManager = SessionManager.getInstance();
