import * as vscode from 'vscode';
import { BaseCollector } from './base';
import { sessionManager } from '../session/manager';
import { agentMonitor, AgentSubtype } from '../agent/monitor';
import { AgentInteraction } from '../utils/cursor-db';

const DEBOUNCE_MS = 5000; // 5 seconds of inactivity triggers diff

interface FileState {
  baseline: string;
  current: string;
  timeout: NodeJS.Timeout | null;
  // Track if agent was active during ANY change in this batch
  hadAgentActivity: boolean;
  // Track the subtype of agent activity (cmdk or composer)
  agentSubtype: AgentSubtype;
  // Track the full agent interaction data
  agentInteraction: AgentInteraction | null;
  // Track if tab completion was used during this batch
  hadTabCompletion: boolean;
}

export class DiffCollector extends BaseCollector {
  readonly name = 'Diff';

  private fileStates: Map<string, FileState> = new Map();
  private activeFile: string | null = null;
  // Track if a tab completion just happened (set by command wrapper, cleared after change)
  private pendingTabCompletion: boolean = false;

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

    // Register command wrappers to detect tab completions
    this.registerTabCompletionTracking(context);

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

  /**
   * Register command wrappers to detect when tab completions are accepted
   */
  private registerTabCompletionTracking(context: vscode.ExtensionContext): void {
    // Commands that accept inline suggestions (Cursor/Copilot style ghost text)
    const tabCompletionCommands = [
      'editor.action.inlineSuggest.commit',      // Accept inline suggestion
      'editor.action.inlineSuggest.acceptWord',  // Accept word from inline suggestion
      'editor.action.inlineSuggest.acceptNextLine', // Accept line from inline suggestion
    ];

    for (const commandId of tabCompletionCommands) {
      // Create a wrapper that marks tab completion before executing the original command
      const wrapper = vscode.commands.registerCommand(
        `cursorCollector.wrap.${commandId}`,
        async () => {
          this.log(`Tab completion command: ${commandId}`);
          this.pendingTabCompletion = true;

          // Execute the original command
          try {
            await vscode.commands.executeCommand(commandId);
          } catch (e) {
            // Command might not exist or fail, that's ok
          }

          // Clear the flag after a short delay if no change was detected
          setTimeout(() => {
            this.pendingTabCompletion = false;
          }, 100);
        }
      );

      this.addDisposable(wrapper);
    }

    // Register keybinding overrides for Tab key when suggestions are visible
    // This is done via package.json keybindings, but we can detect via the commands above
    this.log('Tab completion tracking registered');
  }

  /**
   * Mark that a tab completion just happened for the current file
   */
  markTabCompletion(): void {
    if (this.activeFile) {
      const state = this.fileStates.get(this.activeFile);
      if (state) {
        state.hadTabCompletion = true;
        this.log(`Tab completion marked for ${this.activeFile}`);
      }
    }
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
        hadAgentActivity: false,
        agentSubtype: null,
        agentInteraction: null,
        hadTabCompletion: false,
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

    const source = agentMonitor.getSource();
    const agentSubtype = source === 'agent' ? agentMonitor.getAgentSubtype() : null;
    const interaction = source === 'agent' ? agentMonitor.getAgentInteraction() : null;

    // Read the new file content
    try {
      const content = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(content);
      const lines = text.split('\n');

      // Record as diff with all lines added
      const diffLines = lines.map(line => `+ ${line}`);

      sessionManager.recordDiff({
        source,
        agentSubtype,
        agentModel: interaction?.model ?? null,
        agentPrompt: interaction?.prompt ?? null,
        agentResponse: interaction?.response ?? null,
        agentThinking: interaction?.thinking ?? null,
        agentToolUsage: interaction?.toolUsage ?? null,
        agentInputTokens: interaction?.inputTokens ?? 0,
        agentOutputTokens: interaction?.outputTokens ?? 0,
        filePath: path,
        diff: `[FILE CREATED]\n${diffLines.join('\n')}`,
        linesAdded: lines.length,
        linesRemoved: 0,
      });

      const subtypeStr = agentSubtype ? ` (${agentSubtype})` : '';
      const modelStr = interaction?.model ? ` [${interaction.model.substring(0, 20)}]` : '';
      this.log(`Recorded ${source}${subtypeStr}${modelStr} file create: ${path}`);
    } catch {
      // File might be binary or unreadable
      sessionManager.recordDiff({
        source,
        agentSubtype,
        agentModel: interaction?.model ?? null,
        agentPrompt: interaction?.prompt ?? null,
        agentResponse: interaction?.response ?? null,
        agentThinking: interaction?.thinking ?? null,
        agentToolUsage: interaction?.toolUsage ?? null,
        agentInputTokens: interaction?.inputTokens ?? 0,
        agentOutputTokens: interaction?.outputTokens ?? 0,
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

    const source = agentMonitor.getSource();
    const agentSubtype = source === 'agent' ? agentMonitor.getAgentSubtype() : null;
    const interaction = source === 'agent' ? agentMonitor.getAgentInteraction() : null;

    // Check if we have baseline content
    const state = this.fileStates.get(path);

    if (state) {
      // We have the content - record it as all lines removed
      const lines = state.baseline.split('\n');
      const diffLines = lines.map(line => `- ${line}`);

      sessionManager.recordDiff({
        source,
        agentSubtype,
        agentModel: interaction?.model ?? null,
        agentPrompt: interaction?.prompt ?? null,
        agentResponse: interaction?.response ?? null,
        agentThinking: interaction?.thinking ?? null,
        agentToolUsage: interaction?.toolUsage ?? null,
        agentInputTokens: interaction?.inputTokens ?? 0,
        agentOutputTokens: interaction?.outputTokens ?? 0,
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
        source,
        agentSubtype,
        agentModel: interaction?.model ?? null,
        agentPrompt: interaction?.prompt ?? null,
        agentResponse: interaction?.response ?? null,
        agentThinking: interaction?.thinking ?? null,
        agentToolUsage: interaction?.toolUsage ?? null,
        agentInputTokens: interaction?.inputTokens ?? 0,
        agentOutputTokens: interaction?.outputTokens ?? 0,
        filePath: path,
        diff: '[FILE DELETED]',
        linesAdded: 0,
        linesRemoved: 0,
      });
    }

    const subtypeStr = agentSubtype ? ` (${agentSubtype})` : '';
    const modelStr = interaction?.model ? ` [${interaction.model.substring(0, 20)}]` : '';
    this.log(`Recorded ${source}${subtypeStr}${modelStr} file delete: ${path}`);
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

    // Check if this change was from a tab completion (explicit via command wrapper)
    let explicitTabCompletion = false;
    if (this.pendingTabCompletion) {
      state.hadTabCompletion = true;
      explicitTabCompletion = true;
      this.pendingTabCompletion = false;
      this.log(`Tab completion detected for ${path}`);
    } else {
      // Additional heuristic: if a single change added many characters (>10) at once,
      // it's likely an autocomplete, not manual typing
      for (const change of event.contentChanges) {
        const addedChars = change.text.length;
        const removedChars = change.rangeLength;
        // If we added significantly more than we removed and it's substantial
        if (addedChars > 10 && addedChars > removedChars * 2) {
          // Check if it's not from agent activity
          if (!agentMonitor.isAgentActive()) {
            state.hadTabCompletion = true;
            this.log(`Tab completion (heuristic) detected for ${path}: +${addedChars} chars`);
          }
        }
      }
    }

    // Capture agent activity at change time, not flush time
    // This is critical for Cmd+K inline edits where user accepts after AI generates
    // BUT: Don't override explicit tab completion detection - accepting a ghost text
    // suggestion is a specific user action that shouldn't be classified as agent activity
    if (agentMonitor.isAgentActive() && !explicitTabCompletion) {
      state.hadAgentActivity = true;
      state.agentSubtype = agentMonitor.getAgentSubtype();
      state.agentInteraction = agentMonitor.getAgentInteraction();
      const model = state.agentInteraction?.model?.substring(0, 20) || 'N/A';
      this.log(`Agent activity captured for ${path} (subtype: ${state.agentSubtype}, model: ${model})`);
    }

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
    if (state.baseline === state.current) {
      // Reset flags even if no diff
      state.hadAgentActivity = false;
      state.agentSubtype = null;
      state.agentInteraction = null;
      state.hadTabCompletion = false;
      return;
    }

    // Compute diff
    const diff = this.computeDiff(state.baseline, state.current);

    // Determine source with priority:
    // 1. Agent activity (Cmd+K, composer) takes highest priority
    // 2. Tab completion (human-agent collaboration)
    // 3. Human (pure manual edits)
    let source: 'human' | 'agent' | 'tab-completion';
    let agentSubtype: AgentSubtype = null;
    let interaction: AgentInteraction | null = null;
    if (state.hadAgentActivity) {
      source = 'agent';
      agentSubtype = state.agentSubtype;
      interaction = state.agentInteraction;
    } else if (state.hadTabCompletion) {
      source = 'tab-completion';
    } else {
      source = agentMonitor.isAgentActive() ? 'agent' : 'human';
      if (source === 'agent') {
        agentSubtype = agentMonitor.getAgentSubtype();
        interaction = agentMonitor.getAgentInteraction();
      }
    }

    // Record
    sessionManager.recordDiff({
      source,
      agentSubtype,
      agentModel: interaction?.model ?? null,
      agentPrompt: interaction?.prompt ?? null,
      agentResponse: interaction?.response ?? null,
      agentThinking: interaction?.thinking ?? null,
      agentToolUsage: interaction?.toolUsage ?? null,
      agentInputTokens: interaction?.inputTokens ?? 0,
      agentOutputTokens: interaction?.outputTokens ?? 0,
      filePath,
      diff: diff.text,
      linesAdded: diff.added,
      linesRemoved: diff.removed,
    });

    const subtypeStr = agentSubtype ? ` (${agentSubtype})` : '';
    const modelStr = interaction?.model ? ` [${interaction.model.substring(0, 20)}]` : '';
    this.log(`Recorded ${source}${subtypeStr}${modelStr} diff for ${filePath} (+${diff.added}/-${diff.removed})`);

    // Update baseline and reset flags
    state.baseline = state.current;
    state.hadAgentActivity = false;
    state.agentSubtype = null;
    state.agentInteraction = null;
    state.hadTabCompletion = false;
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
