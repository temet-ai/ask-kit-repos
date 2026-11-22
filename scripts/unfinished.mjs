export const meta = {
  purpose:
    "Only the repositories and worktrees holding work that could be lost or forgotten, and exactly what: uncommitted paths, unpushed commits with their subjects, a branch with no upstream and the commits no remote has, stashes with message and age, a detached HEAD with commits no branch holds, an operation left in progress. Answers \"what have I not committed or pushed\" and \"is it safe to delete or leave this machine\".",
  params: {
    only: "only repositories whose label or path contains this text (or a list of them), optional",
    roots: "look in these folders instead of the configured ones, comma-separated, optional",
    branches: "also check every other local branch for commits no remote has, default true",
  },
  returns:
    "{verdict, count, unfinished:[{repo, worktreeOf?, branch, operation?, uncommitted?:{staged, unstaged, untracked, conflicted: {count, paths}}, unpushed?:{upstream, count, commits:[sha subject]}, noUpstream?:{count, commits, why}, detached?:{head, count, commits}, stashes?:[{ref, age, message}], otherBranches?:[{branch, why, count}]}], clean:[repo], fetched, roots}",
  example: 'await scripts.run("unfinished", {})',
};

const lines = (out) => out.split("\n").map((l) => l.trim()).filter(Boolean);

export default async function ({ repos }, { only, roots, branches = true } = {}) {
  const r = roots ? repos.within(roots) : repos;
  const found = await r.list({ only });
  if (!found.count) return { verdict: `no repositories found under ${found.roots.join(", ")}`, count: 0, unfinished: [], clean: [], roots: found.roots };
  const sts = await r.statuses({ only, paths: 10 });
  const rows = await r.each(async (repo, git) => {
    const s = sts.find((x) => x.repo === repo.label);
    if (!s || s.error) return { repo: repo.label, error: s?.error ?? "no status" };
    const o = { repo: s.repo, ...(s.worktreeOf ? { worktreeOf: s.worktreeOf } : {}), branch: s.detached ? `(detached at ${s.head})` : s.branch };
    if (s.operation) o.operation = `${s.operation} in progress`;
    if (s.dirty) o.uncommitted = Object.fromEntries(["staged", "unstaged", "untracked", "conflicted"].filter((k) => s[k].count).map((k) => [k, s[k]]));
    const subjects = async (...range) => lines((await git("log", "--format=%h %s", "-n", "10", ...range)).out).map((l) => l.slice(0, 100));
    const count = async (...range) => Number((await git("rev-list", "--count", ...range)).out.trim()) || 0;
    const remoteP = git("remote");
    if (s.ahead) o.unpushed = { upstream: s.upstream, count: s.ahead, commits: await subjects(`${s.upstream}..HEAD`) };
    else if (s.detached) {
      const range = ["HEAD", "--not", "--branches", "--remotes", "--tags"];
      const [n, commits] = await Promise.all([count(...range), subjects(...range)]);
      if (n) o.detached = { head: s.head, count: n, commits, why: "no branch or tag holds these commits" };
    } else if (s.head && (!s.upstream || s.upstreamGone)) {
      const [n, commits, remotes] = await Promise.all([count("HEAD", "--not", "--remotes"), subjects("HEAD", "--not", "--remotes"), remoteP]);
      const hasRemote = lines(remotes.out).length > 0;
      const why = s.upstreamGone ? `the upstream ${s.upstream} is gone` : hasRemote ? "the branch has no upstream" : "the repository has no remote";
      if (n) o.noUpstream = { count: n, commits, why: `${why}; no remote has these commits` };
    }
    if (s.stashes) {
      o.stashes = lines((await git("stash", "list", "--format=%gd%x09%ct%x09%gs", "-n", "10")).out).map((l) => {
        const [ref, ct, ...msg] = l.split("\t");
        return { ref, age: repos.age(Number(ct)), message: msg.join(" ").slice(0, 120) };
      });
      if (s.stashes > o.stashes.length) o.stashesLeftOut = s.stashes - o.stashes.length;
    }
    // Other local branches are shared by a repository's worktrees: look once, from the main one.
    if (branches && !repo.worktree) {
      const refs = lines((await git("for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(worktreepath)", "refs/heads")).out).map((l) => l.split("\t"));
      const found = await Promise.all(refs.slice(0, 40).map(async ([name, up, track, wt]) => {
        if (wt) return null; // checked out somewhere: that worktree's own row says it
        const ahead = /ahead (\d+)/.exec(track ?? "")?.[1];
        if (ahead) return { branch: name, why: `ahead of ${up}`, count: Number(ahead) };
        if (!up || /gone/.test(track ?? "")) {
          const n = await count(name, "--not", "--remotes", "HEAD");
          if (n) return { branch: name, why: up ? `upstream ${up} is gone` : "no upstream", count: n };
        }
        return null;
      }));
      const other = found.filter(Boolean);
      if (other.length) o.otherBranches = other.slice(0, 15);
    }
    return o;
  }, { only });
  const all = rows.map((x) => x.value ?? { repo: x.repo, error: x.error });
  const isUnfinished = (o) => Object.keys(o).some((k) => !["repo", "worktreeOf", "branch"].includes(k));
  const unfinished = all.filter(isUnfinished);
  const n = (k) => unfinished.filter((o) => o[k]).length;
  const parts = [[n("uncommitted"), "with uncommitted changes"], [n("unpushed") + n("noUpstream"), "with commits no remote has"], [n("stashes"), "with stashes"], [n("detached"), "detached with loose commits"], [n("operation"), "mid-operation"], [n("otherBranches"), "with other unpushed branches"]].filter(([c]) => c).map(([c, t]) => `${c} ${t}`);
  const tracked = sts.filter((s) => s.upstream && !s.error);
  const oldest = tracked.filter((s) => s.lastFetch).sort((a, b) => (a.lastFetch < b.lastFetch ? -1 : 1))[0];
  return {
    verdict: unfinished.length ? `${unfinished.length} of ${all.length} hold unfinished work: ${parts.join(", ")}` : `nothing unfinished in ${all.length} repositories: all committed, and no remote lacks a commit as of the last fetch`,
    count: all.length,
    unfinished: unfinished.slice(0, 40),
    ...(unfinished.length > 40 ? { leftOut: unfinished.length - 40 } : {}),
    clean: all.filter((o) => !isUnfinished(o)).map((o) => o.repo).slice(0, 100),
    fetched: !tracked.length ? "no repository has an upstream" : `unpushed counts are against the last fetch${oldest ? `; the oldest was ${oldest.fetchAge} ago (${oldest.repo})` : "; none was ever fetched"}`,
    roots: found.roots,
    ...(found.cut ? { cut: found.cut } : {}),
  };
}
