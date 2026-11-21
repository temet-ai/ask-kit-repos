# Recipe: the repos kit

## What it answers

Across all git repositories and worktrees on one machine: which have uncommitted, unpushed or stashed work; which branch each is on and how far ahead or behind its upstream; where a branch, a commit or a file lives; what was committed today or this week; which worktrees exist and which are stale; which branches are merged and can go. It also acts: fetch, pull, push, switch, stash, prune, delete branches, and any other git command.

## What it needs

- `git` on PATH (2.35 or newer, for `status --show-stash` and `%(worktreepath)`).
- ask-kit with act support (`min_ask_kit = "0.3.0"`).
- Settings, all optional: `REPOS_ROOTS` (folders to look in, comma-separated), `REPOS_DEPTH` (default 4), `REPOS_MAX` (default 300), and `WORKDIR` (detected: the agent's folder). No tokens.

## What it reads and runs

It walks the roots for a `.git` directory or file, to a bounded depth, skipping hidden folders, `node_modules`, `target`, `vendor`, `dist`, `build` and bare repositories, and not descending into a repository once found. Linked worktrees outside the roots come from `git worktree list`. It reads `.git` files, `commondir`, the mtime of `FETCH_HEAD` and the marker files of a rebase, merge, cherry-pick, revert or bisect. The list is kept for the life of the process.

It runs `git` (no shell, each argument separate, in the repository's folder) as the user, eight repositories at once, each call with a timeout of 30 seconds (120 for fetch, pull and push), with `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, no pager, an editor that returns at once, and stdin closed.

Without act only the reading commands listed in `repos.mjs` run; anything else, an unknown subcommand included, is refused with `not in this ask: ... (act: true)`. Nothing contacts a remote without act (`ls-remote` and `remote show <name>` are refused). Refused always, because answers go to a cloud model: `config --list`, `--get-regexp` and `--file`, config keys that can hold a credential, `credential` commands, the content of `.env`, `.npmrc`, `.netrc`, `.git-credentials` and key files, and `--no-index`. Refused always, because they wait for a person: `-i` and `-p`, `rebase -i`, `difftool`, `mergetool`, `gui`, `help`. Options before the subcommand are refused. The user part of a URL is redacted in all output when it holds a password or token.

## Brief to rebuild it from an empty folder

Make a folder with `ask-kit.toml` (id `temet.repos`, name `repos`, `requires = ["git"]`, `says`, `keywords`, `route_hint`, `cite`, `acts` as command phrases, the four settings, one `[[sources]]` of kind `module`, name `repos`, module `repos.mjs`, api `api.d.ts`, three reading `[[actions]]` for `status`, `unfinished` and `activity`) and `instructions = "instructions.md"`.

`repos.mjs` exports `make({settings, push, act})` returning a `repos` global: `list({only, main})` (label, name, path, whether a linked worktree and of what; the label is the folder's name, with parent folders added while two share it), `git(repo, ...args)` (execFile, never throws on a non-zero exit, throws on a refusal or an unknown or ambiguous repository, naming what exists; the repository is matched by label, name, path, then substring; with no repository it is the one the agent is in), `each(args or fn, {only, main})` (the same in all, gathered in order), `status(repo)` (parsed from `status --porcelain=v2 --branch --show-stash`, plus the operation in progress, the last commit and the last fetch time), `statuses()`, `defaultBranch(repo)` (`origin/HEAD`, else main, master, trunk or develop, else the branch checked out), `within(roots)` (the same global over other folders) and `age(t)`. A `gate` passes only the reading list without act and everything but the always-refused with act.

The host recognises an `acts` phrase only when its words follow one another in a call's arguments, so `git push` is caught for `repos.git("push")` and not for `repos.git("watch", "push")`. The module's reading list is what holds everything back. In scripts, pass a search text as one argument (`--grep=<text>`), so a commit subject that holds "git push" is not taken for the command.

Scripts in `scripts/` (each `export const meta = {purpose, params, returns, example}` and `export default async function ({repos}, params)`, each taking `roots` to look elsewhere and returning a one-line `verdict`): `status`, `unfinished`, `activity`, `where`, `worktrees`, `branches`.

`instructions.md` has the same structure as the docker kit: how to work (scripts first, then the global; say which repository a substring matched; say how old the last fetch is; what is off limits; verdicts from evidence; act on exactly what was named and read back; dangerous commands only when named) and the answer format.

`bench/fixture/build.mjs` builds the fixture, because git repositories cannot be committed inside another repository. It removes `bench/fixture/roots/` (git-ignored) and creates four repositories with fixed authors, dates and messages, taking nothing from the user's git config: `watch` (clean, pushed to a local bare remote), `clacks` (a changed, a staged and an untracked file), `post-office` (two commits ahead, one stash), `unseen-university` (no remote, a merged branch, two linked worktrees). The bare remotes are in `roots/.remotes/`, a hidden folder, so discovery skips them.

## Running the bench

```sh
cd <the kit's folder>
node bench/fixture/build.mjs
ask-kit kit test repos
```

`bench/questions.json` holds only shots (`do` with `params`, no model), each passing `roots: "bench/fixture/roots"`, so they never read the machine's own repositories. The relative path resolves against the folder the bench is run from. Model questions (`q`) are still to be added, and only from real sessions that dug the answer out by hand.

## Results

ask-kit `kit test` on 2026-11-20: 10/10 shots, all answered with no model. No model run yet.
