export const meta = {
  purpose:
    "Every worktree of every repository that has linked worktrees: path, branch, dirty or clean, locked, prunable, last commit age, with the stale ones flagged (the branch is merged into the default branch, its upstream is gone, the folder is missing, or nothing was committed for a long time). Answers \"which worktrees exist\" and \"which worktrees can I remove\".",
  params: {
    repo: "one repository (label, name, substring or path), optional; by default all of them",
    all: "include repositories that have only their main work tree, default false",
    staleDays: "a clean worktree with no commit for this many days is flagged old, default 30",
    roots: "look in these folders instead of the configured ones, comma-separated, optional",
  },
  returns:
    "{verdict, repositories, worktrees, removable:[path], rows:[{repo, defaultBranch, worktrees:[{path, main?, branch, head, state, last, locked?, prunable?, flags?:[why], removable?}]}], roots}. `removable` is true only for a clean linked worktree whose branch is merged into the default branch.",
  example: 'await scripts.run("worktrees", {})',
};

const lines = (out) => out.split("\n").filter((l) => l.trim());

export default async function ({ repos }, { repo, all = false, staleDays = 30, roots } = {}) {
  const r = roots ? repos.within(roots) : repos;
  const found = await r.list({});
  if (!found.count) return { verdict: `no repositories found under ${found.roots.join(", ")}`, repositories: 0, worktrees: 0, rows: [], roots: found.roots };
  let only;
  if (repo) {
    const one = await r.git(repo, "rev-parse", "--git-common-dir"); // resolves the name, and throws with the list when there is none
    const hit = found.repos.find((e) => e.label === one.repo);
    only = [hit?.worktree ? hit.of : one.repo];
  }
  const now = Date.now();
  const rows = await r.each(async (entry, git) => {
    const res = await git("worktree", "list", "--porcelain");
    if (res.code !== 0) return { repo: entry.label, error: res.err.trim().slice(0, 200) };
    const blocks = res.out.split(/\n\n+/).filter((b) => b.trim());
    if (blocks.length < 2 && !all && !repo) return null;
    const def = await r.defaultBranch(entry.label);
    const merged = def.ref ? new Set(lines((await git("branch", "--merged", def.ref, "--format=%(refname:short)")).out)) : new Set();
    const gone = new Set(lines((await git("for-each-ref", "--format=%(refname:short)%09%(upstream:track)", "refs/heads")).out).filter((l) => /\[gone\]/.test(l)).map((l) => l.split("\t")[0]));
    const trees = [];
    for (const [i, b] of blocks.entries()) {
      const get = (k) => new RegExp(`^${k}(?: (.*))?$`, "m").exec(b);
      const p = get("worktree")?.[1];
      const branch = get("branch")?.[1]?.replace(/^refs\/heads\//, "") ?? null;
      const t = { path: p, ...(i === 0 ? { main: true } : {}), branch: branch ?? (get("bare") ? "(bare)" : "(detached)"), head: get("HEAD")?.[1]?.slice(0, 7) ?? null };
      const flags = [];
      const locked = get("locked");
      const prunable = get("prunable");
      if (locked) (t.locked = locked[1] || true), flags.push("locked");
      if (prunable) {
        t.prunable = prunable[1] || true;
        t.state = "missing";
        flags.push("folder is missing: `git worktree prune` removes the record");
      } else if (!get("bare")) {
        const st = await r.status(p);
        if (st.error) t.state = `unknown: ${st.error.slice(0, 80)}`;
        else {
          const n = st.staged.count + st.unstaged.count + st.untracked.count + st.conflicted.count;
          t.state = n ? `dirty (${n} paths)` : "clean";
          if (st.operation) flags.push(`${st.operation} in progress`);
          if (st.ahead) flags.push(`${st.ahead} unpushed`);
          t.last = st.last ? `${st.last.age} ago` : "no commits";
          const old = st.last && now - Date.parse(st.last.time) > staleDays * 86_400_000;
          if (i > 0 && old && !n) flags.push(`no commit for ${st.last.age}`);
        }
      }
      if (i > 0 && branch && branch !== def.branch && merged.has(branch)) flags.push(`branch merged into ${def.branch}`);
      if (branch && gone.has(branch)) flags.push("upstream is gone");
      if (flags.length) t.flags = flags;
      if (i > 0 && t.state === "clean" && branch && branch !== def.branch && merged.has(branch) && !locked) t.removable = true;
      trees.push(t);
    }
    return { repo: entry.label, defaultBranch: def.branch, worktrees: trees.slice(0, 30), ...(trees.length > 30 ? { leftOut: trees.length - 30 } : {}) };
  }, { only, main: true });
  const kept = rows.map((x) => x.value ?? (x.error ? { repo: x.repo, error: x.error } : null)).filter(Boolean);
  const linked = kept.flatMap((k) => (k.worktrees ?? []).filter((t) => !t.main));
  const removable = linked.filter((t) => t.removable).map((t) => t.path);
  const prunable = linked.filter((t) => t.prunable).length;
  const flagged = linked.filter((t) => t.flags && !t.removable && !t.prunable).length;
  return {
    verdict: linked.length
      ? `${linked.length} linked worktrees in ${kept.filter((k) => (k.worktrees ?? []).length > 1).length} repositories: ${removable.length} can go (clean, branch merged), ${prunable} prunable, ${flagged} flagged for another reason, ${linked.length - removable.length - prunable - flagged} in use`
      : `no linked worktrees in ${rows.length} repositories`,
    repositories: rows.length,
    worktrees: linked.length,
    ...(removable.length ? { removable } : {}),
    rows: kept.slice(0, 40),
    ...(kept.length > 40 ? { leftOut: kept.length - 40 } : {}),
    roots: found.roots,
  };
}
