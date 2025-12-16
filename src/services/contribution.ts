import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Storage } from '@google-cloud/storage';
import { dbConnection } from '../database/connection';
import { GCP_CREDENTIALS, GCP_BUCKET_NAME } from './gcp-credentials';

// GitHub repo for creating contribution issues
const GITHUB_REPO = 'josancamon19/co-create';

export interface ContributionStats {
  totalDiffs: number;
  humanDiffs: number;
  agentDiffs: number;
  tabCompletionDiffs: number;
  totalSessions: number;
  totalProjects: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  dateRange: {
    earliest: string | null;
    latest: string | null;
  };
  fileExtensions: string[];
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

    // Total diffs
    const totalResult = db.exec('SELECT COUNT(*) FROM diffs');
    const totalDiffs = totalResult.length > 0 ? (totalResult[0].values[0][0] as number) : 0;

    // Breakdown by source
    const sourceResult = db.exec(`
      SELECT source, COUNT(*) as count
      FROM diffs
      GROUP BY source
    `);

    let humanDiffs = 0;
    let agentDiffs = 0;
    let tabCompletionDiffs = 0;

    if (sourceResult.length > 0) {
      for (const row of sourceResult[0].values) {
        const source = row[0] as string;
        const count = row[1] as number;
        if (source === 'human') humanDiffs = count;
        else if (source === 'agent') agentDiffs = count;
        else if (source === 'tab-completion') tabCompletionDiffs = count;
      }
    }

    // Total sessions
    const sessionsResult = db.exec('SELECT COUNT(DISTINCT session_id) FROM diffs');
    const totalSessions = sessionsResult.length > 0 ? (sessionsResult[0].values[0][0] as number) : 0;

    // Total projects
    const projectsResult = db.exec('SELECT COUNT(*) FROM projects');
    const totalProjects = projectsResult.length > 0 ? (projectsResult[0].values[0][0] as number) : 0;

    // Lines added/removed
    const linesResult = db.exec('SELECT SUM(lines_added), SUM(lines_removed) FROM diffs');
    const totalLinesAdded = linesResult.length > 0 ? (linesResult[0].values[0][0] as number) || 0 : 0;
    const totalLinesRemoved = linesResult.length > 0 ? (linesResult[0].values[0][1] as number) || 0 : 0;

    // Date range
    const dateResult = db.exec('SELECT MIN(timestamp), MAX(timestamp) FROM diffs');
    const earliest = dateResult.length > 0 ? (dateResult[0].values[0][0] as string | null) : null;
    const latest = dateResult.length > 0 ? (dateResult[0].values[0][1] as string | null) : null;

    // File extensions
    const extensionsResult = db.exec(`
      SELECT DISTINCT
        CASE
          WHEN file_path LIKE '%.%'
          THEN SUBSTR(file_path, INSTR(file_path, '.') + LENGTH(file_path) - LENGTH(REPLACE(file_path, '.', '')) - INSTR(file_path, '.') + 1)
          ELSE 'no-extension'
        END as ext
      FROM diffs
      LIMIT 20
    `);

    // Simpler approach: get file paths and extract extensions in JS
    const filePathsResult = db.exec('SELECT DISTINCT file_path FROM diffs LIMIT 100');
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

    return {
      totalDiffs,
      humanDiffs,
      agentDiffs,
      tabCompletionDiffs,
      totalSessions,
      totalProjects,
      totalLinesAdded,
      totalLinesRemoved,
      dateRange: { earliest, latest },
      fileExtensions: Array.from(extensions).slice(0, 15),
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

      return `gs://${GCP_BUCKET_NAME}/${destinationPath}`;
    } catch (error) {
      console.error('[Contribution] GCP upload failed:', error);
      throw error;
    }
  }

  formatStatsForIssue(stats: ContributionStats, gcpUrl: string, username: string): string {
    const humanPercent = stats.totalDiffs > 0
      ? ((stats.humanDiffs / stats.totalDiffs) * 100).toFixed(1)
      : '0';
    const agentPercent = stats.totalDiffs > 0
      ? ((stats.agentDiffs / stats.totalDiffs) * 100).toFixed(1)
      : '0';
    const tabPercent = stats.totalDiffs > 0
      ? ((stats.tabCompletionDiffs / stats.totalDiffs) * 100).toFixed(1)
      : '0';

    return `## Data Contribution from ${username}

### GCP Bucket URL
\`${gcpUrl}\`

### Statistics

| Metric | Value |
|--------|-------|
| **Total Diffs** | ${stats.totalDiffs} |
| **Human Edits** | ${stats.humanDiffs} (${humanPercent}%) |
| **Agent Edits** | ${stats.agentDiffs} (${agentPercent}%) |
| **Tab Completions** | ${stats.tabCompletionDiffs} (${tabPercent}%) |
| **Sessions** | ${stats.totalSessions} |
| **Projects** | ${stats.totalProjects} |
| **Lines Added** | ${stats.totalLinesAdded} |
| **Lines Removed** | ${stats.totalLinesRemoved} |

### Date Range
- **From**: ${stats.dateRange.earliest || 'N/A'}
- **To**: ${stats.dateRange.latest || 'N/A'}

### File Types
${stats.fileExtensions.length > 0 ? stats.fileExtensions.join(', ') : 'N/A'}

---
*Submitted via Cursor Interaction Collector extension*`;
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
    if (!stats || stats.totalDiffs === 0) {
      vscode.window.showInformationMessage('No data to contribute yet. Start coding to collect data!');
      return;
    }

    // Prompt for username
    const username = await vscode.window.showInputBox({
      prompt: 'Enter your username or identifier for this contribution',
      placeHolder: 'e.g., johndoe or github-username',
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
    const humanPercent = ((stats.humanDiffs / stats.totalDiffs) * 100).toFixed(1);
    const agentPercent = ((stats.agentDiffs / stats.totalDiffs) * 100).toFixed(1);

    const confirmMessage = `You're about to contribute:
• ${stats.totalDiffs} diffs (${humanPercent}% human, ${agentPercent}% agent)
• ${stats.totalSessions} sessions
• ${stats.totalLinesAdded} lines added, ${stats.totalLinesRemoved} removed

Continue?`;

    const confirm = await vscode.window.showInformationMessage(
      confirmMessage,
      { modal: true },
      'Upload & Create Issue'
    );

    if (confirm !== 'Upload & Create Issue') {
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

            vscode.window.showInformationMessage(
              'Data uploaded successfully! Complete the GitHub issue to finish your contribution.'
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
