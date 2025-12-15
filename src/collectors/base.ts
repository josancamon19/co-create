import * as vscode from 'vscode';

export interface ICollector {
  /**
   * Name of the collector for logging/debugging
   */
  readonly name: string;

  /**
   * Register all event listeners
   * @param context Extension context for registering disposables
   */
  register(context: vscode.ExtensionContext): void;

  /**
   * Dispose of all event listeners and cleanup
   */
  dispose(): void;
}

/**
 * Base class for collectors with common functionality
 */
export abstract class BaseCollector implements ICollector {
  abstract readonly name: string;
  protected disposables: vscode.Disposable[] = [];

  abstract register(context: vscode.ExtensionContext): void;

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    console.log(`[Collector] ${this.name} disposed`);
  }

  protected addDisposable(disposable: vscode.Disposable): void {
    this.disposables.push(disposable);
  }

  protected log(message: string): void {
    console.log(`[Collector:${this.name}] ${message}`);
  }
}
