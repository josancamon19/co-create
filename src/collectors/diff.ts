import * as vscode from 'vscode';
import { BaseCollector } from './base';
import { sessionManager } from '../session/manager';

const DEBOUNCE_MS = 5000; // 5 seconds of inactivity triggers diff

interface FileState {
  baseline: string;
  current: string;
  timeout: NodeJS.Timeout | null;
}

export class DiffCollector extends BaseCollector {
  readonly name = 'Diff';

  private fileStates: Map<string, FileState> = new Map();
  private activeFile: string | null = null;

  register(context: vscode.ExtensionContext): void {
    // Track active editor changes (file switch)
    this.addDisposable(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.onFileSwitch(editor);
      })
    );

    // Track document changes
    this.addDisposable(
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.onDocumentChange(event);
      })
    );

    // Track document open - set baseline
    this.addDisposable(
      vscode.workspace.onDidOpenTextDocument((document) => {
        this.onDocumentOpen(document);
      })
    );

    // Track document close - flush and cleanup
    this.addDisposable(
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.onDocumentClose(document);
      })
    );

    // Track file creations and deletions
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    this.addDisposable(
      watcher.onDidCreate((uri) => {
        this.onFileCreate(uri);
      })
    );

    this.addDisposable(
      watcher.onDidDelete((uri) => {
        this.onFileDelete(uri);
      })
    );

    this.addDisposable(watcher);

    // Initialize with current active editor
    if (vscode.window.activeTextEditor) {
      const doc = vscode.window.activeTextEditor.document;
      if (this.shouldTrack(doc)) {
        this.initFileState(doc);
        this.activeFile = doc.uri.fsPath;
      }
    }

    context.subscriptions.push(...this.disposables);
    this.log('Registered');
  }

  private shouldTrack(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== 'file') return false;
    return this.shouldTrackPath(document.uri.fsPath);
  }

  private shouldTrackPath(path: string): boolean {
    if (path.includes('node_modules') || path.includes('.git') || path.includes('.cursor-data')) {
      return false;
    }
    return true;
  }

  private initFileState(document: vscode.TextDocument): void {
    const path = document.uri.fsPath;
    if (!this.fileStates.has(path)) {
      this.fileStates.set(path, {
        baseline: document.getText(),
        current: document.getText(),
        timeout: null,
      });
    }
  }

  private onDocumentOpen(document: vscode.TextDocument): void {
    if (!this.shouldTrack(document)) return;
    this.initFileState(document);
  }

  private onDocumentClose(document: vscode.TextDocument): void {
    if (!this.shouldTrack(document)) return;
    const path = document.uri.fsPath;
    this.flushDiff(path);
    this.fileStates.delete(path);
  }

  private async onFileCreate(uri: vscode.Uri): Promise<void> {
    const path = uri.fsPath;
    if (!this.shouldTrackPath(path)) return;

    // Read the new file content
    try {
      const content = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(content);
      const lines = text.split('\n');

      // Record as diff with all lines added
      const diffLines = lines.map(line => `+ ${line}`);

      sessionManager.recordDiff({
        source: 'human',
        filePath: path,
        diff: `[FILE CREATED]\n${diffLines.join('\n')}`,
        linesAdded: lines.length,
        linesRemoved: 0,
      });

      this.log(`Recorded file create: ${path}`);
    } catch {
      // File might be binary or unreadable
      sessionManager.recordDiff({
        source: 'human',
        filePath: path,
        diff: '[FILE CREATED]',
        linesAdded: 0,
        linesRemoved: 0,
      });
    }
  }

  private onFileDelete(uri: vscode.Uri): void {
    const path = uri.fsPath;
    if (!this.shouldTrackPath(path)) return;

    // Check if we have baseline content
    const state = this.fileStates.get(path);

    if (state) {
      // We have the content - record it as all lines removed
      const lines = state.baseline.split('\n');
      const diffLines = lines.map(line => `- ${line}`);

      sessionManager.recordDiff({
        source: 'human',
        filePath: path,
        diff: `[FILE DELETED]\n${diffLines.join('\n')}`,
        linesAdded: 0,
        linesRemoved: lines.length,
      });

      // Clean up state
      if (state.timeout) clearTimeout(state.timeout);
      this.fileStates.delete(path);
    } else {
      // No content tracked - just record the deletion
      sessionManager.recordDiff({
        source: 'human',
        filePath: path,
        diff: '[FILE DELETED]',
        linesAdded: 0,
        linesRemoved: 0,
      });
    }

    this.log(`Recorded file delete: ${path}`);
  }

  private onFileSwitch(editor: vscode.TextEditor | undefined): void {
    // Flush diff for previous file
    if (this.activeFile) {
      this.flushDiff(this.activeFile);
    }

    // Update active file
    if (editor && this.shouldTrack(editor.document)) {
      const path = editor.document.uri.fsPath;
      this.activeFile = path;
      this.initFileState(editor.document);
    } else {
      this.activeFile = null;
    }
  }

  private onDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const document = event.document;
    if (!this.shouldTrack(document)) return;
    if (event.contentChanges.length === 0) return;

    const path = document.uri.fsPath;
    this.initFileState(document);

    const state = this.fileStates.get(path)!;

    // Update current content
    state.current = document.getText();

    // Reset debounce timer
    if (state.timeout) {
      clearTimeout(state.timeout);
    }

    state.timeout = setTimeout(() => {
      this.flushDiff(path);
    }, DEBOUNCE_MS);
  }

  private flushDiff(filePath: string): void {
    const state = this.fileStates.get(filePath);
    if (!state) return;

    // Clear timeout
    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }

    // Skip if no changes
    if (state.baseline === state.current) return;

    // Compute diff
    const diff = this.computeDiff(state.baseline, state.current);

    // Record
    sessionManager.recordDiff({
      source: 'human',
      filePath,
      diff: diff.text,
      linesAdded: diff.added,
      linesRemoved: diff.removed,
    });

    this.log(`Recorded diff for ${filePath} (+${diff.added}/-${diff.removed})`);

    // Update baseline
    state.baseline = state.current;
  }

  private computeDiff(oldText: string, newText: string): { text: string; added: number; removed: number } {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // Compute LCS-based diff with line positions
    const hunks = this.computeHunks(oldLines, newLines);

    let added = 0;
    let removed = 0;
    const diffParts: string[] = [];

    for (const hunk of hunks) {
      // Format: @@ -oldStart,oldCount +newStart,newCount @@
      diffParts.push(`@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@`);

      for (const line of hunk.lines) {
        diffParts.push(line);
        if (line.startsWith('-')) removed++;
        if (line.startsWith('+')) added++;
      }
    }

    return {
      text: diffParts.join('\n'),
      added,
      removed,
    };
  }

  private computeHunks(oldLines: string[], newLines: string[]): Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: string[];
  }> {
    // Myers diff algorithm (simplified)
    const lcs = this.longestCommonSubsequence(oldLines, newLines);

    // Build hunks from the diff
    const hunks: Array<{
      oldStart: number;
      oldCount: number;
      newStart: number;
      newCount: number;
      lines: string[];
    }> = [];

    let oldIdx = 0;
    let newIdx = 0;
    let lcsIdx = 0;

    while (oldIdx < oldLines.length || newIdx < newLines.length) {
      // Skip matching lines
      while (
        lcsIdx < lcs.length &&
        oldIdx < oldLines.length &&
        newIdx < newLines.length &&
        oldLines[oldIdx] === lcs[lcsIdx] &&
        newLines[newIdx] === lcs[lcsIdx]
      ) {
        oldIdx++;
        newIdx++;
        lcsIdx++;
      }

      // Collect differences into a hunk
      const hunkOldStart = oldIdx;
      const hunkNewStart = newIdx;
      const hunkLines: string[] = [];

      // Removed lines (in old but not matching LCS)
      while (oldIdx < oldLines.length && (lcsIdx >= lcs.length || oldLines[oldIdx] !== lcs[lcsIdx])) {
        hunkLines.push(`- ${oldLines[oldIdx]}`);
        oldIdx++;
      }

      // Added lines (in new but not matching LCS)
      while (newIdx < newLines.length && (lcsIdx >= lcs.length || newLines[newIdx] !== lcs[lcsIdx])) {
        hunkLines.push(`+ ${newLines[newIdx]}`);
        newIdx++;
      }

      if (hunkLines.length > 0) {
        hunks.push({
          oldStart: hunkOldStart,
          oldCount: oldIdx - hunkOldStart,
          newStart: hunkNewStart,
          newCount: newIdx - hunkNewStart,
          lines: hunkLines,
        });
      }
    }

    return hunks;
  }

  private longestCommonSubsequence(a: string[], b: string[]): string[] {
    const m = a.length;
    const n = b.length;

    // DP table
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to find LCS
    const lcs: string[] = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        lcs.unshift(a[i - 1]);
        i--;
        j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }

    return lcs;
  }

  dispose(): void {
    // Flush all pending diffs
    for (const path of this.fileStates.keys()) {
      this.flushDiff(path);
    }
    this.fileStates.clear();
    super.dispose();
  }
}

export const diffCollector = new DiffCollector();
