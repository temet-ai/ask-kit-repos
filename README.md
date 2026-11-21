# ask-kit-repos

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer questions about all the git repositories and worktrees on your machine at once. A cheap
model runs `git status`, `git log`, `git branch` and `git worktree list` in every repository,
outside your agent's context, and answers with repository names, branches and short shas.

Questions it is built for, which agents answer by hand with a loop of git commands over folders:

- Which of my repositories have uncommitted or unpushed work, and what exactly?
- Which repository has the branch `hex-upgrade`, and where is it checked out?
- What did I commit this week across all projects?
- Which worktrees and branches are merged and can go?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) and `git`.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-repos
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-repos        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-repos --yes  # installs and enables it
```

Restart your agents so `ask` lists `repos`. `ask-kit kit list` says whether it can run on this
machine, and why not.

Settings, all optional:

- `REPOS_ROOTS`: the folders to look for repositories in, comma-separated. By default the parent
  of the repository the agent is in, and those of `~/projects`, `~/code`, `~/src`, `~/dev`,
  `~/work`, `~/repos` and `~/git` that exist.
- `REPOS_DEPTH` (default 4): how many folder levels below each root to look.
- `REPOS_MAX` (default 300): the most repositories and worktrees to list. A result says when it
  stopped there.

## What it can change

Without a request for a change it runs only reading commands. `repos.mjs` holds a list of them
(`status`, `log`, `show`, `diff`, listing forms of `branch` and `tag`, `stash list`, `worktree
list`, `for-each-ref` and the like), and refuses everything else, an unknown subcommand included.

When asked, it runs any other git command in the repositories named: `fetch`, `pull`, `push`,
`switch`, `checkout`, `commit`, `add`, `restore`, `reset`, `stash`, `merge`, `rebase`,
`cherry-pick`, `revert`, `branch -d`, `tag`, `worktree add`, `remove` and `prune`, `remote add`,
`remove` and `set-url`, `clean`, `gc`, `config <key> <value>`, `apply`, `am`. Its instructions
say to use `push --force`, `reset --hard`, `clean -fdx` and `branch -D` only when the caller named
exactly that.

`repos.mjs` checks each command before it runs:

- Nothing contacts a remote unless the caller asked for a change. Ahead and behind are against the
  last fetch, and results say when that was.
- Commands that print secrets are refused: `config --list`, `credential`, and the content of
  `.env`, `.npmrc`, `.netrc`, `.git-credentials` and key files. A password or token in a remote
  URL is shown as `[redacted]`. What the investigator reads goes to a model.
- Commands that wait for a person are refused: `rebase -i`, `add -p`, `difftool`, `mergetool`.
- Options before the subcommand (`-c`, `-C`, `--git-dir`) are refused, so a call cannot define an
  alias that runs a shell or leave the repository it named.

A shot (`ask-kit run repos <script>`) runs with the caller's own authority. The six scripts only
read.

## How well it works

The bench, `bench/questions.json`, holds ten shots: scripts run with no model against a fixture
of four small repositories that `node bench/fixture/build.mjs` builds. `ask-kit kit test repos`
on 2026-11-20: 10/10, all answered with no model. No model run has been made yet: the bench has
no model questions, because those come only from real sessions.

## What is in it

`repos.mjs` finds the repositories and gives the investigator `git` in one of them or in all,
with the refusals above. Its scripts are `status` (every repository in one table, the ones needing
attention first), `unfinished` (uncommitted paths, unpushed commits, stashes, and branches no
remote has), `activity` (commits since a time across all repositories, by day), `where` (which
repositories have a branch, a commit, a commit subject or a file), `worktrees` (every worktree,
and which are stale) and `branches` (merged, gone and never-pushed branches).
[RECIPE.md](RECIPE.md) says what it reads and runs, and how to rebuild it.

MIT licence.
