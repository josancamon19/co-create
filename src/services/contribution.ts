import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Storage } from '@google-cloud/storage';
import { dbConnection } from '../database/connection';
import { GCP_CREDENTIALS, GCP_BUCKET_NAME } from './gcp-credentials';
import { getGitUsername } from '../utils/git';

// GitHub repo for creating contribution issues
const GITHUB_REPO = 'josancamon19/co-create';

export interface ContributionStats {
  totalEvents: number;
  humanEvents: number;
  agentEvents: number;
  tabCompletionEvents: number;
  totalInteractions: number;
  totalSessions: number;
  totalProjects: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  eventsByType: {
    diff: number;
    file_create: number;
    file_delete: number;
    terminal: number;
  };
  dateRange: {
    earliest: string | null;
    latest: string | null;
  };
  fileExtensions: string[];
  projectUrls: string[];
}

export class ContributionService {
  private storage: Storage | null = null;

  private getStorage(): Storage {
    if (!this.storage) {
      this.storage = new Storage({
        credentials: GCP_CREDENTIALS,
        projectId: GCP_CREDENTIALS.project_id,
      });
    }
    return this.storage;
  }

  async getContributionStats(): Promise<ContributionStats | null> {
    if (!dbConnection.isInitialized()) {
      return null;
    }

    const db = dbConnection.getDatabase();

    // Total events
    const totalResult = db.exec('SELECT COUNT(*) FROM events');
    const totalEvents = totalResult.length > 0 ? (totalResult[0].values[0][0] as number) : 0;

    // Breakdown by source
    const sourceResult = db.exec(`
      SELECT source, COUNT(*) as count
      FROM events
      GROUP BY source
    `);

    let humanEvents = 0;
    let agentEvents = 0;
    let tabCompletionEvents = 0;

    if (sourceResult.length > 0) {
      for (const row of sourceResult[0].values) {
        const source = row[0] as string;
        const count = row[1] as number;
        if (source === 'human') humanEvents = count;
        else if (source === 'agent') agentEvents = count;
        else if (source === 'tab-completion') tabCompletionEvents = count;
      }
    }

    // Breakdown by type
    const typeResult = db.exec(`
      SELECT type, COUNT(*) as count
      FROM events
      GROUP BY type
    `);

    const eventsByType = { diff: 0, file_create: 0, file_delete: 0, terminal: 0 };
    if (typeResult.length > 0) {
      for (const row of typeResult[0].values) {
        const type = row[0] as string;
        const count = row[1] as number;
        if (type in eventsByType) {
          eventsByType[type as keyof typeof eventsByType] = count;
        }
      }
    }

    // Total interactions
    const interactionsResult = db.exec('SELECT COUNT(*) FROM interactions');
    const totalInteractions = interactionsResult.length > 0 ? (interactionsResult[0].values[0][0] as number) : 0;

    // Total sessions
    const sessionsResult = db.exec('SELECT COUNT(DISTINCT session_id) FROM events');
    const totalSessions = sessionsResult.length > 0 ? (sessionsResult[0].values[0][0] as number) : 0;

    // Total projects
    const projectsResult = db.exec('SELECT COUNT(*) FROM projects');
    const totalProjects = projectsResult.length > 0 ? (projectsResult[0].values[0][0] as number) : 0;

    // Lines added/removed (from metadata JSON)
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    const metadataResult = db.exec('SELECT metadata FROM events WHERE metadata IS NOT NULL');
    if (metadataResult.length > 0) {
      for (const row of metadataResult[0].values) {
        try {
          const metadata = JSON.parse(row[0] as string);
          if (metadata.lines_added) totalLinesAdded += metadata.lines_added;
          if (metadata.lines_removed) totalLinesRemoved += metadata.lines_removed;
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Date range
    const dateResult = db.exec('SELECT MIN(timestamp), MAX(timestamp) FROM events');
    const earliest = dateResult.length > 0 ? (dateResult[0].values[0][0] as string | null) : null;
    const latest = dateResult.length > 0 ? (dateResult[0].values[0][1] as string | null) : null;

    // File extensions from file_path
    const filePathsResult = db.exec('SELECT DISTINCT file_path FROM events WHERE file_path IS NOT NULL LIMIT 100');
    const extensions = new Set<string>();
    if (filePathsResult.length > 0) {
      for (const row of filePathsResult[0].values) {
        const filePath = row[0] as string;
        const ext = path.extname(filePath);
        if (ext) {
          extensions.add(ext);
        }
      }
    }

    // Project URLs
    const projectUrlsResult = db.exec('SELECT git_remote_url FROM projects');
    const projectUrls: string[] = [];
    if (projectUrlsResult.length > 0) {
      for (const row of projectUrlsResult[0].values) {
        const url = row[0] as string;
        if (url && !url.startsWith('local://')) {
          projectUrls.push(url);
        }
      }
    }

    return {
      totalEvents,
      humanEvents,
      agentEvents,
      tabCompletionEvents,
      totalInteractions,
      totalSessions,
      totalProjects,
      totalLinesAdded,
      totalLinesRemoved,
      eventsByType,
      dateRange: { earliest, latest },
      fileExtensions: Array.from(extensions).slice(0, 15),
      projectUrls,
    };
  }

  async uploadToGCP(username: string): Promise<string | null> {
    const workspacePath = dbConnection.getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path available');
    }

    const dbPath = path.join(workspacePath, '.cursor-data', 'collector.db');
    if (!fs.existsSync(dbPath)) {
      throw new Error('Database file not found');
    }

    // Ensure latest data is saved
    dbConnection.saveToDisk();

    // Create timestamp for versioning
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destinationPath = `contributions/${username}/${timestamp}.db`;

    try {
      const storage = this.getStorage();
      const bucket = storage.bucket(GCP_BUCKET_NAME);

      await bucket.upload(dbPath, {
        destination: destinationPath,
        metadata: {
          contentType: 'application/x-sqlite3',
          metadata: {
            contributor: username,
            uploadedAt: new Date().toISOString(),
          },
        },
      });

      // Files are publicly readable via bucket-level permissions (allUsers: objectViewer)
      return `gs://${GCP_BUCKET_NAME}/${destinationPath}`;
    } catch (error) {
      console.error('[Contribution] GCP upload failed:', error);
      throw error;
    }
  }

  formatStatsForIssue(stats: ContributionStats, gcpUrl: string, username: string): string {
    // Convert gs:// URL to public https:// URL
    const publicUrl = gcpUrl.replace('gs://', 'https://storage.googleapis.com/');
    const dashboardUrl = `https://josancamon19.github.io/co-create/dashboard/viewer.html?db=${encodeURIComponent(publicUrl)}`;

    const projectsList = stats.projectUrls.length > 0
      ? stats.projectUrls.join('\n')
      : 'No git repositories';

    return `## View Traces
[Open in Trace Viewer](${dashboardUrl})

## Download
${publicUrl}

## Statistics
- Total Events: ${stats.totalEvents}
- Human Events: ${stats.humanEvents}
- Agent Events: ${stats.agentEvents}
- Tab Completions: ${stats.tabCompletionEvents}
- Agent Interactions: ${stats.totalInteractions}
- Sessions: ${stats.totalSessions}
- Lines Added: ${stats.totalLinesAdded}
- Lines Removed: ${stats.totalLinesRemoved}

## Event Types
- Diffs: ${stats.eventsByType.diff}
- File Creates: ${stats.eventsByType.file_create}
- File Deletes: ${stats.eventsByType.file_delete}
- Terminal: ${stats.eventsByType.terminal}

## Date Range
${stats.dateRange.earliest || 'N/A'} to ${stats.dateRange.latest || 'N/A'}

## Projects
${projectsList}

## File Types
${stats.fileExtensions.length > 0 ? stats.fileExtensions.join(', ') : 'N/A'}`;
  }

  openGitHubIssue(stats: ContributionStats, gcpUrl: string, username: string): void {
    const title = encodeURIComponent(`Data Contribution: ${username}`);
    const body = encodeURIComponent(this.formatStatsForIssue(stats, gcpUrl, username));

    const issueUrl = `https://github.com/${GITHUB_REPO}/issues/new?title=${title}&body=${body}&labels=contribution`;

    vscode.env.openExternal(vscode.Uri.parse(issueUrl));
  }

  async contribute(): Promise<void> {
    // Check if collector is active
    if (!dbConnection.isInitialized()) {
      vscode.window.showErrorMessage('Collector is not active. Open a workspace first.');
      return;
    }

    // Get stats first to show summary
    const stats = await this.getContributionStats();
    if (!stats || stats.totalEvents === 0) {
      vscode.window.showInformationMessage('No data to contribute yet. Start coding to collect data!');
      return;
    }

    // Get default username from git config
    const defaultUsername = await getGitUsername();

    // Prompt for username
    const username = await vscode.window.showInputBox({
      prompt: 'Enter your username or identifier for this contribution',
      placeHolder: 'e.g., johndoe or github-username',
      value: defaultUsername || undefined,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Username is required';
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(value.trim())) {
          return 'Username can only contain letters, numbers, underscores, and hyphens';
        }
        return null;
      },
    });

    if (!username) {
      return; // User cancelled
    }

    const cleanUsername = username.trim();

    // Show confirmation with stats summary
    const humanPercent = ((stats.humanEvents / stats.totalEvents) * 100).toFixed(1);
    const agentPercent = ((stats.agentEvents / stats.totalEvents) * 100).toFixed(1);

    const confirmMessage = `You're about to contribute:
• ${stats.totalEvents} events (${humanPercent}% human, ${agentPercent}% agent)
• ${stats.totalInteractions} agent interactions
• ${stats.totalSessions} sessions
• ${stats.totalLinesAdded} lines added, ${stats.totalLinesRemoved} removed

⚠️ Your local collection history will be cleared after upload.

Continue?`;

    const confirm = await vscode.window.showInformationMessage(
      confirmMessage,
      { modal: true },
      'Upload & Clear History'
    );

    if (confirm !== 'Upload & Clear History') {
      return;
    }

    // Upload to GCP
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Uploading data to GCP...',
          cancellable: false,
        },
        async () => {
          const gcpUrl = await this.uploadToGCP(cleanUsername);

          if (gcpUrl) {
            // Open GitHub issue
            this.openGitHubIssue(stats, gcpUrl, cleanUsername);

            // Clear the database after successful upload
            dbConnection.resetDatabase();

            vscode.window.showInformationMessage(
              'Data uploaded and history cleared! Complete the GitHub issue to finish your contribution.'
            );
          }
        }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to upload data: ${errorMessage}`);
    }
  }
}

export const contributionService = new ContributionService();
