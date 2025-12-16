import * as vscode from 'vscode';

/**
 * Deterministic human input tracker.
 *
 * Uses the `type` command to track exactly what the user types,
 * then compares against actual document changes to classify:
 * - HUMAN: Change matches what user typed (via `type` command)
 * - EXTERNAL: Everything else (agent, paste, undo, redo, selection ops, etc.)
 */

interface PendingInput {
  text: string;
  timestamp: number;
  filePath: string;
}

interface ChangeClassification {
  type: 'human' | 'external';
  confidence: 1; // Always 1 - this is deterministic
  humanChars: number;
  externalChars: number;
}

export class HumanInputTracker {
  private static instance: HumanInputTracker | null = null;

  // Queue of pending inputs from `type` command
  private pendingInputs: PendingInput[] = [];

  // Track accumulated human input per file since last flush
  private humanInputBuffer: Map<string, string> = new Map();

  // Track if Tab was recently pressed (for tab completion detection)
  private pendingTab: { filePath: string; timestamp: number } | null = null;

  // How long to keep pending inputs before expiring (ms)
  private readonly INPUT_EXPIRY_MS = 500;

  private disposables: vscode.Disposable[] = [];
  private isRegistered = false;

  private constructor() { }

  static getInstance(): HumanInputTracker {
    if (!HumanInputTracker.instance) {
      HumanInputTracker.instance = new HumanInputTracker();
    }
    return HumanInputTracker.instance;
  }

  /**
   * Register the type command override.
   * IMPORTANT: Only one extension can override `type` at a time.
   */
  register(context: vscode.ExtensionContext): void {
    if (this.isRegistered) return;

    // Override the `type` command to intercept all keystrokes
    const typeCommand = vscode.commands.registerCommand('type', async (args: { text: string }) => {
      this.onType(args.text);

      // Execute the actual typing
      return vscode.commands.executeCommand('default:type', args);
    });

    this.disposables.push(typeCommand);
    context.subscriptions.push(typeCommand);
    this.isRegistered = true;

    console.log('[HumanInputTracker] Registered type command override');
  }

  /**
   * Called when user types something (via `type` command)
   */
  private onType(text: string): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const filePath = editor.document.uri.fsPath;
    const now = Date.now();

    // Track Tab presses specifically for tab completion detection
    if (text === '\t') {
      this.pendingTab = { filePath, timestamp: now };
      console.log(`[HumanInputTracker] TAB PRESSED in ${filePath}`);
    }

    // Add to pending inputs queue
    this.pendingInputs.push({
      text,
      timestamp: now,
      filePath,
    });

    // Also accumulate in the buffer for this file
    const existing = this.humanInputBuffer.get(filePath) || '';
    this.humanInputBuffer.set(filePath, existing + text);

    // Clean up old pending inputs
    this.cleanupExpiredInputs();

    console.log(`[HumanInputTracker] Typed "${text.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}" in ${filePath}`);
  }

  /**
   * Classify a document change.
   * Call this from onDidChangeTextDocument.
   *
   * Cases:
   * 1. HUMAN - if added text matches what we saw from `type` command
   * 2. TAB_COMPLETION - if Tab was pressed but change is more than just "\t"
   * 3. EXTERNAL - everything else (agent, paste, undo, redo, selections, etc.)
   */
  classifyChange(
    filePath: string,
    addedText: string,
    _removedLength: number,
    _changeReason?: vscode.TextDocumentChangeReason
  ): ChangeClassification {
    const now = Date.now();
    this.cleanupExpiredInputs();

    // Get pending human input for this file
    const pendingHumanText = this.humanInputBuffer.get(filePath) || '';

    // Check for TAB scenario:
    // Tab in VS Code inserts spaces (not \t) based on tabSize setting (usually 2-4)
    // - Tab + only spaces (1-8) = HUMAN indentation
    // - Tab + more content = TAB COMPLETION
    console.log(`[HumanInputTracker]"`, { pendingTab: this.pendingTab, addedText, pendingHumanText });

    if (this.pendingTab &&
      this.pendingTab.filePath === filePath &&
      now - this.pendingTab.timestamp < this.INPUT_EXPIRY_MS) {

      // Check if this is just indentation (spaces only, typically 1-8 spaces or a literal \t)
      const isJustIndentation = /^(\t| {1,8})$/.test(addedText);

      if (isJustIndentation) {
        // Just indentation - this is HUMAN pressing Tab
        this.pendingTab = null;
        this.clearPendingForFile(filePath);
        console.log(`[HumanInputTracker] HUMAN (tab indent): Tab pressed, got "${addedText.replace(/\t/g, '\\t')}" (${addedText.length} spaces)`);
        return {
          type: 'human',
          confidence: 1,
          humanChars: addedText.length,
          externalChars: 0,
        };
      } else if (addedText.length > 0) {
        // Tab was pressed but we got actual code - this is TAB COMPLETION!
        this.pendingTab = null;
        this.clearPendingForFile(filePath);
        console.log(`[HumanInputTracker] *** TAB COMPLETION DETECTED ***`);
        console.log(`[HumanInputTracker]   Tab pressed, got ${addedText.length} chars of code`);
        console.log(`[HumanInputTracker]   Content: "${addedText.substring(0, 100).replace(/\n/g, '\\n')}..."`);
        return {
          type: 'external', // Tab completion is external (AI-generated)
          confidence: 1,
          humanChars: 0,
          externalChars: addedText.length,
        };
      }
    }

    // HUMAN: If we have pending typed text and it matches the change
    if (pendingHumanText.length > 0 && addedText.length > 0) {
      if (this.textMatchesPending(addedText, pendingHumanText)) {
        this.consumeInput(filePath, addedText);
        console.log(`[HumanInputTracker] HUMAN: "${addedText.replace(/\n/g, '\\n')}" matched pending "${pendingHumanText.replace(/\n/g, '\\n')}"`);
        return {
          type: 'human',
          confidence: 1,
          humanChars: addedText.length,
          externalChars: 0,
        };
      }
    }

    // EXTERNAL: Everything else
    // Try to detect if this looks like a TAB COMPLETION (heuristic)
    // Tab completion usually: appears right after typing, adds code that "completes" what was typed
    const looksLikeCompletion = this.detectPossibleCompletion(filePath, addedText);

    this.clearPendingForFile(filePath);

    if (looksLikeCompletion) {
      console.log(`[HumanInputTracker] *** POSSIBLE TAB COMPLETION (heuristic) ***`);
      console.log(`[HumanInputTracker]   Got ${addedText.length} chars right after typing`);
      console.log(`[HumanInputTracker]   Content: "${addedText.substring(0, 100).replace(/\n/g, '\\n')}..."`);
    } else {
      console.log(`[HumanInputTracker] EXTERNAL: "${addedText.substring(0, 50).replace(/\n/g, '\\n')}..." (no matching pending input)`);
    }

    return {
      type: 'external',
      confidence: 1,
      humanChars: 0,
      externalChars: addedText.length,
    };
  }

  /**
   * Heuristic to detect if an external change looks like a tab completion.
   * Since we can't intercept Tab in Cursor, we detect by pattern:
   * - Change happened shortly after user was typing
   * - Content looks like code (not just whitespace)
   * - Not a huge multi-file change (that would be agent)
   */
  private detectPossibleCompletion(filePath: string, addedText: string): boolean {
    // Check if user was recently typing in this file
    const recentTyping = this.pendingInputs.some(
      p => p.filePath === filePath && Date.now() - p.timestamp < 2000 // within 2 seconds
    );

    if (!recentTyping) {
      return false; // No recent typing, probably not a completion
    }

    // Check if the added text looks like code (not just whitespace)
    const isJustWhitespace = /^\s*$/.test(addedText);
    if (isJustWhitespace) {
      return false;
    }

    // Check if it's a reasonable size for a completion (not too small, not too huge)
    if (addedText.length < 3 || addedText.length > 500) {
      return false; // Too small or too big
    }

    return true;
  }

  /**
   * Check if the added text matches what we expect from pending human input.
   */
  private textMatchesPending(addedText: string, pendingText: string): boolean {
    // Simple check: added text should be a prefix of pending text
    // or pending text should be a prefix of added text (for multi-char scenarios)

    // Handle character-by-character typing
    if (addedText.length <= pendingText.length) {
      return pendingText.startsWith(addedText);
    }

    // Handle case where multiple chars arrive at once
    return addedText.startsWith(pendingText);
  }

  /**
   * Consume input that was matched to a change.
   */
  private consumeInput(filePath: string, consumedText: string): void {
    const existing = this.humanInputBuffer.get(filePath) || '';

    if (existing.startsWith(consumedText)) {
      const remaining = existing.slice(consumedText.length);
      if (remaining.length === 0) {
        this.humanInputBuffer.delete(filePath);
      } else {
        this.humanInputBuffer.set(filePath, remaining);
      }
    } else {
      // Mismatch - clear buffer
      this.humanInputBuffer.delete(filePath);
    }

    // Also remove from pending inputs
    this.pendingInputs = this.pendingInputs.filter(
      p => !(p.filePath === filePath && consumedText.includes(p.text))
    );
  }

  /**
   * Clear all pending state for a file.
   */
  private clearPendingForFile(filePath: string): void {
    this.humanInputBuffer.delete(filePath);
    this.pendingInputs = this.pendingInputs.filter(p => p.filePath !== filePath);
    if (this.pendingTab?.filePath === filePath) {
      this.pendingTab = null;
    }
  }

  /**
   * Get accumulated human input for a file (for debugging/logging).
   */
  getHumanInputBuffer(filePath: string): string {
    return this.humanInputBuffer.get(filePath) || '';
  }

  /**
   * Clear the human input buffer for a file.
   * Call this after flushing a diff.
   */
  clearBuffer(filePath: string): void {
    this.humanInputBuffer.delete(filePath);
  }

  /**
   * Check if there's any pending human input for a file.
   */
  hasPendingInput(filePath: string): boolean {
    return (this.humanInputBuffer.get(filePath)?.length ?? 0) > 0;
  }

  /**
   * Mark that Tab was pressed (called from command wrapper, not from type command)
   * This is needed because Tab doesn't go through the `type` command.
   */
  markTabPressed(filePath: string): void {
    this.pendingTab = { filePath, timestamp: Date.now() };
    console.log(`[HumanInputTracker] TAB PRESSED (via command wrapper) in ${filePath}`);
  }

  /**
   * Clean up expired pending inputs.
   */
  private cleanupExpiredInputs(): void {
    const now = Date.now();
    const cutoff = now - this.INPUT_EXPIRY_MS;
    this.pendingInputs = this.pendingInputs.filter(p => p.timestamp > cutoff);

    // Also clean up expired pendingTab
    if (this.pendingTab && this.pendingTab.timestamp < cutoff) {
      this.pendingTab = null;
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.pendingInputs = [];
    this.humanInputBuffer.clear();
    this.pendingTab = null;
    this.isRegistered = false;
  }
}

export const humanInputTracker = HumanInputTracker.getInstance();
