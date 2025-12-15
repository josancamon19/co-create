import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);

export async function getGitRemoteUrl(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git remote get-url origin', {
      cwd: workspacePath,
    });
    return stdout.trim();
  } catch {
    // Not a git repo or no origin remote
    return null;
  }
}

export async function getGitRepoName(workspacePath: string): Promise<string | null> {
  const remoteUrl = await getGitRemoteUrl(workspacePath);
  if (!remoteUrl) {
    return null;
  }

  // Extract repo name from URL
  // Handles: git@github.com:user/repo.git, https://github.com/user/repo.git, etc.
  const match = remoteUrl.match(/[\/:]([^\/]+\/[^\/]+?)(?:\.git)?$/);
  if (match) {
    return match[1];
  }

  return null;
}

export async function isGitRepository(workspacePath: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --is-inside-work-tree', {
      cwd: workspacePath,
    });
    return true;
  } catch {
    return false;
  }
}

export function generateProjectIdentifier(workspacePath: string): string {
  // Fallback identifier when git remote is not available
  // Use the folder name as identifier
  return `local://${path.basename(workspacePath)}`;
}

export async function getGitCommitId(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', {
      cwd: workspacePath,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}
