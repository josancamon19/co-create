import * as vscode from 'vscode';
import { sessionManager } from './session/manager';
import { diffCollector } from './collectors/diff';
import { ICollector } from './collectors/base';

const collectors: ICollector[] = [
  diffCollector,
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[Cursor Interaction Collector] Activating...');
  console.log('[Cursor Interaction Collector] Workspace folders:', vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath));

  try {
    // Initialize session manager
    await sessionManager.initialize();

    if (!sessionManager.isReady()) {
      console.log('[Cursor Interaction Collector] No workspace detected, collector disabled');
      return;
    }

    // Register all collectors
    for (const collector of collectors) {
      try {
        collector.register(context);
      } catch (error) {
        console.error(`[Cursor Interaction Collector] Failed to register ${collector.name}:`, error);
      }
    }

    // Register commands
    registerCommands(context);

    // Show status
    const stats = sessionManager.getSessionStats();
    if (stats) {
      console.log(`[Cursor Interaction Collector] Active for project: ${stats.projectName}`);
      console.log(`[Cursor Interaction Collector] Session ID: ${stats.sessionId}`);
    }

    // Add status bar item
    const statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    statusBarItem.text = '$(database) Collector';
    statusBarItem.tooltip = 'Cursor Interaction Collector is active';
    statusBarItem.command = 'cursor-collector.showStats';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    console.log('[Cursor Interaction Collector] Activated successfully');
  } catch (error) {
    console.error('[Cursor Interaction Collector] Activation failed:', error);
    vscode.window.showErrorMessage(
      `Cursor Interaction Collector failed to activate: ${error}`
    );
  }
}

function registerCommands(context: vscode.ExtensionContext): void {
  // Show stats command
  context.subscriptions.push(
    vscode.commands.registerCommand('cursor-collector.showStats', () => {
      showStats();
    })
  );

  // Export data command
  context.subscriptions.push(
    vscode.commands.registerCommand('cursor-collector.exportData', () => {
      exportData();
    })
  );
}

async function showStats(): Promise<void> {
  const stats = sessionManager.getSessionStats();

  if (!stats) {
    vscode.window.showInformationMessage('Collector is not active for this workspace.');
    return;
  }

  const durationStr = stats.sessionDuration
    ? formatDuration(stats.sessionDuration)
    : 'In progress';

  const message = `
Project: ${stats.projectName || 'Unknown'}
Session ID: ${stats.sessionId}
Total Diffs: ${stats.totalDiffs}
Duration: ${durationStr}
  `.trim();

  const result = await vscode.window.showInformationMessage(
    message,
    { modal: true },
    'Export Data'
  );

  if (result === 'Export Data') {
    await exportData();
  }
}

async function exportData(): Promise<void> {
  const stats = sessionManager.getSessionStats();

  if (!stats) {
    vscode.window.showInformationMessage('No data to export.');
    return;
  }

  // For now, just show the database location
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspacePath) {
    const dbPath = `${workspacePath}/.cursor-data/collector.db`;
    const result = await vscode.window.showInformationMessage(
      `Data is stored in SQLite database at:\n${dbPath}\n\nYou can query it with any SQLite client.`,
      'Open Folder'
    );

    if (result === 'Open Folder') {
      const folderUri = vscode.Uri.file(`${workspacePath}/.cursor-data`);
      await vscode.env.openExternal(folderUri);
    }
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function deactivate(): void {
  console.log('[Cursor Interaction Collector] Deactivating...');

  // Dispose all collectors
  for (const collector of collectors) {
    try {
      collector.dispose();
    } catch (error) {
      console.error(`[Cursor Interaction Collector] Failed to dispose ${collector.name}:`, error);
    }
  }

  // Shutdown session manager
  sessionManager.shutdown();

  console.log('[Cursor Interaction Collector] Deactivated');
}
