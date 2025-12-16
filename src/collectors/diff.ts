import * as vscode from 'vscode';
import { BaseCollector } from './base';
import { sessionManager } from '../session/manager';
import { agentMonitor, AgentSubtype } from '../agent/monitor';
import { AgentInteraction } from '../utils/cursor-db';
import { EventSource } from '../database/schema';
import { humanInputTracker } from './human-input-tracker';

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
  // Track total human-typed characters in this batch (DETERMINISTIC via `type` command)
  humanTypedChars: number;
  // Track total external characters in this batch (everything not from `type` command)
  externalChars: number;
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

    // Register command wrappers to detect tab completions (legacy, kept as backup)
    this.registerTabCompletionTracking(context);

    // Register deterministic human input tracker (via `type` command)
    humanInputTracker.register(context);

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
   * Register command wrappers to detect when Tab is pressed
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
          console.log(`[DiffCollector] *** TAB WRAPPER CALLED: ${commandId} ***`);
          this.pendingTabCompletion = true;

          // Also notify the humanInputTracker
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            humanInputTracker.markTabPressed(editor.document.uri.fsPath);
          }

          // Execute the original command
          try {
            await vscode.commands.executeCommand(commandId);
          } catch (e) {
            console.log(`[DiffCollector] Command ${commandId} failed:`, e);
          }

          // Clear the flag after a short delay if no change was detected
          setTimeout(() => {
            this.pendingTabCompletion = false;
          }, 1000);
        }
      );

      this.addDisposable(wrapper);
    }

    // Register a general Tab key wrapper to catch ALL Tab presses
    const generalTabWrapper = vscode.commands.registerCommand(
      'cursorCollector.wrap.tab',
      async () => {
        console.log(`[DiffCollector] *** GENERAL TAB PRESSED ***`);
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          humanInputTracker.markTabPressed(editor.document.uri.fsPath);
        }

        // Execute the default tab action
        try {
          await vscode.commands.executeCommand('tab');
        } catch (e) {
          // Fallback to indent
          try {
            await vscode.commands.executeCommand('editor.action.indentLines');
          } catch (e2) {
            console.log('[DiffCollector] Tab commands failed');
          }
        }
      }
    );
    this.addDisposable(generalTabWrapper);

    this.log('Tab completion tracking registered');
  }

  private shouldTrack(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== 'file') return false;
    return this.shouldTrackPath(document.uri.fsPath);
  }

  private getWorkspacePathForFile(filePath: string): string | null {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    return folder?.uri.fsPath ?? null;
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
        humanTypedChars: 0,
        externalChars: 0,
      });
    }
  }

  private onDocumentOpen(document: vscode.TextDocument): void {
    if (!this.shouldTrack(document)) return;
    this.initFileState(document);
  }

  private async onDocumentClose(document: vscode.TextDocument): Promise<void> {
    if (!this.shouldTrack(document)) return;
    const path = document.uri.fsPath;
    await this.flushDiff(path);
    this.fileStates.delete(path);
  }

  private async onFileCreate(uri: vscode.Uri): Promise<void> {
    const path = uri.fsPath;
    if (!this.shouldTrackPath(path)) return;

    const workspacePath = this.getWorkspacePathForFile(path);
    const source = agentMonitor.getSource(workspacePath || undefined);
    const agentSubtype = source === 'agent' ? agentMonitor.getAgentSubtype(workspacePath || undefined) : null;
    const interaction = source === 'agent' ? agentMonitor.getAgentInteraction(workspacePath || undefined) : null;

    // Read the new file content
    try {
      const content = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(content);
      const lines = text.split('\n');

      // Record as file_create event
      const diffLines = lines.map(line => `+ ${line}`);

      sessionManager.recordEvent(
        {
          source,
          type: 'file_create',
          filePath: path,
          content: `[FILE CREATED]\n${diffLines.join('\n')}`,
          linesAdded: lines.length,
          linesRemoved: 0,
          agentSubtype,
          agentModel: interaction?.model ?? null,
          agentPrompt: interaction?.prompt ?? null,
          agentResponse: interaction?.response ?? null,
          agentThinking: interaction?.thinking ?? null,
          agentToolUsage: interaction?.toolUsage ?? null,
          agentInputTokens: interaction?.inputTokens ?? 0,
          agentOutputTokens: interaction?.outputTokens ?? 0,
        },
        interaction?.bubbleId
      );

      const subtypeStr = agentSubtype ? ` (${agentSubtype})` : '';
      const modelStr = interaction?.model ? ` [${interaction.model.substring(0, 20)}]` : '';
      this.log(`Recorded ${source}${subtypeStr}${modelStr} file create: ${path}`);

      if (source === 'agent') {
        agentMonitor.consumeAgentActivity();
      }
    } catch {
      // File might be binary or unreadable
      sessionManager.recordEvent(
        {
          source,
          type: 'file_create',
          filePath: path,
          content: '[FILE CREATED]',
          linesAdded: 0,
          linesRemoved: 0,
          agentSubtype,
          agentModel: interaction?.model ?? null,
          agentPrompt: interaction?.prompt ?? null,
          agentResponse: interaction?.response ?? null,
          agentThinking: interaction?.thinking ?? null,
          agentToolUsage: interaction?.toolUsage ?? null,
          agentInputTokens: interaction?.inputTokens ?? 0,
          agentOutputTokens: interaction?.outputTokens ?? 0,
        },
        interaction?.bubbleId
      );

      if (source === 'agent') {
        agentMonitor.consumeAgentActivity();
      }
    }
  }

  private onFileDelete(uri: vscode.Uri): void {
    const path = uri.fsPath;
    if (!this.shouldTrackPath(path)) return;

    const workspacePath = this.getWorkspacePathForFile(path);
    const source = agentMonitor.getSource(workspacePath || undefined);
    const agentSubtype = source === 'agent' ? agentMonitor.getAgentSubtype(workspacePath || undefined) : null;
    const interaction = source === 'agent' ? agentMonitor.getAgentInteraction(workspacePath || undefined) : null;

    // Check if we have baseline content
    const state = this.fileStates.get(path);

    if (state) {
      // We have the content - record it as all lines removed
      const lines = state.baseline.split('\n');
      const diffLines = lines.map(line => `- ${line}`);

      sessionManager.recordEvent(
        {
          source,
          type: 'file_delete',
          filePath: path,
          content: `[FILE DELETED]\n${diffLines.join('\n')}`,
          linesAdded: 0,
          linesRemoved: lines.length,
          agentSubtype,
          agentModel: interaction?.model ?? null,
          agentPrompt: interaction?.prompt ?? null,
          agentResponse: interaction?.response ?? null,
          agentThinking: interaction?.thinking ?? null,
          agentToolUsage: interaction?.toolUsage ?? null,
          agentInputTokens: interaction?.inputTokens ?? 0,
          agentOutputTokens: interaction?.outputTokens ?? 0,
        },
        interaction?.bubbleId
      );

      // Clean up state
      if (state.timeout) clearTimeout(state.timeout);
      this.fileStates.delete(path);
    } else {
      // No content tracked - just record the deletion
      sessionManager.recordEvent(
        {
          source,
          type: 'file_delete',
          filePath: path,
          content: '[FILE DELETED]',
          linesAdded: 0,
          linesRemoved: 0,
          agentSubtype,
          agentModel: interaction?.model ?? null,
          agentPrompt: interaction?.prompt ?? null,
          agentResponse: interaction?.response ?? null,
          agentThinking: interaction?.thinking ?? null,
          agentToolUsage: interaction?.toolUsage ?? null,
          agentInputTokens: interaction?.inputTokens ?? 0,
          agentOutputTokens: interaction?.outputTokens ?? 0,
        },
        interaction?.bubbleId
      );
    }

    const subtypeStr = agentSubtype ? ` (${agentSubtype})` : '';
    const modelStr = interaction?.model ? ` [${interaction.model.substring(0, 20)}]` : '';
    this.log(`Recorded ${source}${subtypeStr}${modelStr} file delete: ${path}`);

    if (source === 'agent') {
      agentMonitor.consumeAgentActivity();
    }
  }

  private async onFileSwitch(editor: vscode.TextEditor | undefined): Promise<void> {
    // Flush diff for previous file
    if (this.activeFile) {
      await this.flushDiff(this.activeFile);
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
    const workspacePath = this.getWorkspacePathForFile(path);

    // Update current content
    state.current = document.getText();

    // Calculate total added/removed for this change
    const totalAdded = event.contentChanges.reduce((sum, c) => sum + c.text.length, 0);
    const totalRemoved = event.contentChanges.reduce((sum, c) => sum + c.rangeLength, 0);
    const addedText = event.contentChanges.map(c => c.text).join('');

    // DETERMINISTIC classification using humanInputTracker
    // Simple: HUMAN (typed via `type` command) vs EXTERNAL (everything else)
    const classification = humanInputTracker.classifyChange(
      path,
      addedText,
      totalRemoved,
      event.reason
    );

    // Update state based on deterministic classification
    if (classification.type === 'human') {
      state.humanTypedChars += classification.humanChars;
      this.log(`HUMAN: +${classification.humanChars} chars in ${path}`);
    } else {
      // 'external' - could be agent, paste, undo, redo, selection ops, tab completion, etc.
      state.externalChars += classification.externalChars;

      // Check if this external change correlates with agent activity
      if (agentMonitor.isAgentActive(workspacePath || undefined)) {
        state.hadAgentActivity = true;
        state.agentSubtype = agentMonitor.getAgentSubtype(workspacePath || undefined);
        state.agentInteraction = agentMonitor.getAgentInteraction(workspacePath || undefined);
        const model = state.agentInteraction?.model?.substring(0, 20) || 'N/A';
        this.log(`EXTERNAL (agent): +${classification.externalChars} chars in ${path} (model: ${model})`);
      } else {
        this.log(`EXTERNAL (unknown): +${classification.externalChars} chars in ${path}`);
      }
    }

    // Reset debounce timer
    if (state.timeout) {
      clearTimeout(state.timeout);
    }

    state.timeout = setTimeout(() => {
      this.flushDiff(path);
    }, DEBOUNCE_MS);
  }

  private async flushDiff(filePath: string): Promise<void> {
    const state = this.fileStates.get(filePath);
    if (!state) return;
    const workspacePath = this.getWorkspacePathForFile(filePath);

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
      state.humanTypedChars = 0;
      state.externalChars = 0;
      humanInputTracker.clearBuffer(filePath);
      return;
    }

    // Compute diff
    const diff = this.computeDiff(state.baseline, state.current);

    // DETERMINISTIC source determination:
    // - If we tracked human typing (humanTypedChars > 0), it's HUMAN
    // - If only external chars with agent activity, it's AGENT
    // - If only external chars without agent activity, it's EXTERNAL (paste, undo, etc.)
    let source: EventSource = 'human';
    let agentSubtype: AgentSubtype = null;
    let interaction: AgentInteraction | null = null;

    // Log the deterministic tracking results
    this.log(`Flush stats for ${filePath}: humanTypedChars=${state.humanTypedChars}, externalChars=${state.externalChars}, hadAgentActivity=${state.hadAgentActivity}`);

    if (state.hadAgentActivity) {
      // Agent activity was detected during changes
      source = 'agent';
      agentSubtype = state.agentSubtype;
      interaction = state.agentInteraction;
    } else if (state.externalChars > 0 && state.humanTypedChars === 0) {
      // All external changes, no human typing detected
      // Double-check with agent monitor as fallback
      await agentMonitor.forceCheckForAgentActivity(workspacePath || undefined);
      if (agentMonitor.isAgentActive(workspacePath || undefined)) {
        source = 'agent';
        agentSubtype = agentMonitor.getAgentSubtype(workspacePath || undefined);
        interaction = agentMonitor.getAgentInteraction(workspacePath || undefined);
        this.log(`Agent activity detected on flush for ${filePath}`);
      } else {
        // External change without agent - could be paste, undo, redo, tab completion, etc.
        // Keep as 'human' since user initiated it, just not via typing
        this.log(`External change (non-agent) for ${filePath} - paste/undo/redo/completion`);
      }
    }
    // If humanTypedChars > 0, source stays 'human' (DETERMINISTIC - we KNOW they typed)

    const content = diff.text;

    // Record event
    sessionManager.recordEvent(
      {
        source,
        type: 'diff',
        filePath,
        content,
        linesAdded: diff.added,
        linesRemoved: diff.removed,
        agentSubtype,
        agentModel: interaction?.model ?? null,
        agentPrompt: interaction?.prompt ?? null,
        agentResponse: interaction?.response ?? null,
        agentThinking: interaction?.thinking ?? null,
        agentToolUsage: interaction?.toolUsage ?? null,
        agentInputTokens: interaction?.inputTokens ?? 0,
        agentOutputTokens: interaction?.outputTokens ?? 0,
      },
      interaction?.bubbleId
    );

    const subtypeStr = agentSubtype ? ` (${agentSubtype})` : '';
    const modelStr = interaction?.model ? ` [${interaction.model.substring(0, 20)}]` : '';
    const humanStr = state.humanTypedChars > 0 ? ` [human=${state.humanTypedChars}]` : '';
    const extStr = state.externalChars > 0 ? ` [ext=${state.externalChars}]` : '';
    this.log(`Recorded ${source}${subtypeStr}${modelStr}${humanStr}${extStr} diff for ${filePath} (+${diff.added}/-${diff.removed})`);

    if (source === 'agent') {
      agentMonitor.consumeAgentActivity();
    }

    // Update baseline and reset all tracking state
    state.baseline = state.current;
    state.hadAgentActivity = false;
    state.agentSubtype = null;
    state.agentInteraction = null;
    state.humanTypedChars = 0;
    state.externalChars = 0;
    humanInputTracker.clearBuffer(filePath);
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
    // Flush all pending diffs (fire and forget since we're disposing)
    const flushPromises: Promise<void>[] = [];
    for (const path of this.fileStates.keys()) {
      flushPromises.push(this.flushDiff(path));
    }
    // Wait for all flushes to complete before clearing state
    Promise.all(flushPromises).finally(() => {
      this.fileStates.clear();
    });
    super.dispose();
  }
}

export const diffCollector = new DiffCollector();
