interface GitResult { repo: string; code: number; out: string; err: string; timedOut?: boolean; matched?: string }
interface Repo { label: string; name: string; path: string; worktree: boolean; of?: string; submodule?: boolean }
interface Paths { count: number; paths: string[] }
interface Status {
  repo: string; path: string; worktreeOf?: string; matched?: string;
  branch: string | null; detached: boolean; head: string | null;   // head: short sha, null before the first commit
  upstream: string | null; upstreamGone: boolean; ahead: number; behind: number;   // against the last fetch, see lastFetch
  staged: Paths; unstaged: Paths; untracked: Paths; conflicted: Paths; dirty: boolean;
  stashes: number;
  operation: "rebase" | "merge" | "cherry-pick" | "revert" | "bisect" | "am" | null;
  last: { sha: string; subject: string; time: string; age: string } | null;
  lastFetch: string | null; fetchAge: string | null;   // null: never fetched
  error?: string;   // git's own text when status failed; the other fields are then absent
}

declare const repos: {
  // The repositories and linked worktrees on this machine: found once per process under REPOS_ROOTS, to a bounded depth.
  // label is the short unique name to use everywhere else. worktree: true is a linked worktree `of` that repository.
  // only: text (or texts) a label or path must contain; main: true leaves linked worktrees out. `cut` is set when the count hit the cap.
  list(o?: { only?: string | string[]; main?: boolean }): Promise<{ count: number; roots: string[]; missingRoots?: string[]; cut?: string; repos: Repo[] }>;

  // Any git command in one repository, no shell, each argument separate: repos.git("watch", "log", "-5", "--oneline").
  // repo is a label, a name, a path, or a substring of a label (`matched` then says which was used). With no repository,
  // repos.git("status"), it is the one the agent is in. Never throws on a non-zero exit: read code, out and err.
  // Without act only reading commands run: status, log, show, diff, branch and tag (listing), stash list|show, worktree list,
  // remote -v|get-url, rev-parse, rev-list, for-each-ref, ls-files, ls-tree, cat-file, blame, describe, shortlog, reflog,
  // merge-base, name-rev, grep, cherry, show-ref, symbolic-ref, count-objects, config --get <key>. Anything else throws
  // "not in this ask" (fetch, pull, push, switch, checkout, commit, add, restore, reset, stash, merge, rebase, cherry-pick,
  // revert, branch -d|-D|-m, tag <name>, worktree add|remove|prune, remote add|remove|set-url, clean, gc, config <key> <value>,
  // apply, am, and any command not on the reading list). With act they all run.
  // Refused always: options before the subcommand (-c, -C, --git-dir), `config --list`, `credential`, the content of
  // .env, .npmrc, .netrc, .git-credentials and key files, --no-index, and what waits for a person (-i, -p, difftool, rebase -i).
  // Nothing contacts a remote without act: `ls-remote` and `remote show <name>` (without -n) are refused.
  // A password or token in a URL is shown as [redacted]. Output over 200,000 characters is cut, and says so.
  git(repo: string, ...args: string[]): Promise<GitResult>;

  // The same in every repository, 8 at once, in list order. With git arguments as an array: each(["rev-parse", "--short", "HEAD"])
  // gives [{repo, code, out, err}]. With a function: each(async (repo, git) => (await git("stash", "list")).out) gives
  // [{repo, value}] or [{repo, error}]; `git` runs in that repository. The same reading rules apply.
  each(what: string[] | ((repo: Repo, git: (...args: string[]) => Promise<{ code: number; out: string; err: string }>) => any), o?: { only?: string | string[]; main?: boolean }): Promise<any[]>;

  // One repository's state from `git status --porcelain=v2`: branch or detached, upstream, ahead and behind, counts and the
  // first `paths` (default 5) paths of staged, unstaged, untracked and conflicted files, stashes, an operation in progress,
  // the last commit, and when it was last fetched. ahead and behind are only as fresh as lastFetch.
  status(repo: string, o?: { paths?: number }): Promise<Status>;

  // status() of every repository (or those matching `only`).
  statuses(o?: { only?: string | string[]; main?: boolean; paths?: number }): Promise<Status[]>;

  // The branch others are merged into: what origin/HEAD points at, else a local main, master, trunk or develop, else the
  // branch checked out in the main work tree. ref is what to compare against (the local branch, or origin/<branch>); from says how it was found.
  defaultBranch(repo: string): Promise<{ repo: string; branch: string | null; ref: string | null; from: string }>;

  // The same global looking only in these folders: repos.within("~/work/clients").list(). Relative paths are under the agent's folder.
  within(roots: string | string[]): typeof repos;

  // "3h", "2d", "5w" for a time in the past: ISO text, or seconds since 1970 as git prints with %ct.
  age(t: string | number): string | null;

  // true when this ask may change things.
  acting: boolean;
};
