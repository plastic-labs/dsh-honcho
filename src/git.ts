/**
 * Minimal git context for session naming.
 *
 * Deliberately tiny — shared git context belongs in the integration core
 * alongside proper worktree resolution. Until then: two calls, both bounded,
 * both failing to `undefined` rather than throwing.
 */

import { execFileSync } from "node:child_process";

function git(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = out.trim();
    return value || undefined;
  } catch {
    // Not a repo, git absent, detached HEAD, timeout — all "no git context".
    return undefined;
  }
}

/** Current branch, or undefined outside a repo / on a detached HEAD. */
export function currentBranch(cwd: string): string | undefined {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === "HEAD" ? undefined : branch;
}

/**
 * Repository root. `--show-toplevel` resolves a worktree to the worktree's own
 * root, not the main repo's — so two worktrees of one repo get separate
 * per-repo sessions. Proper worktree collapsing is core's job.
 */
export function repoRoot(cwd: string): string | undefined {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

/**
 * The `origin` remote URL, or undefined outside a repo / without an origin.
 * git walks up from `cwd` to find the repo itself, so no root resolution is
 * needed here.
 *
 * Read from config rather than `git remote get-url`, which applies each
 * machine's own `url.<base>.insteadOf` rewrites — the raw configured URL is
 * what stays comparable across machines.
 */
export function originRemote(cwd: string): string | undefined {
  return git(cwd, ["config", "--get", "remote.origin.url"]);
}
