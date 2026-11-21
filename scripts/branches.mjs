export const meta = {
  purpose:
    "Local branches that can go and branches that hold unpushed work, per repository or for all: merged into the default branch, upstream gone (deleted on the remote, usually after a merge there), ahead of the upstream, or with no upstream at all, each with its age. Says how the default branch was found. Answers \"which branches are merged and can be deleted\" and \"which branches did I never push\".",
  params: {
    repo: "one repository (label, name, substring or path), optional; by default all of them",
    roots: "look in these folders instead of the configured ones, comma-separated, optional",
  },
  returns:
    "{verdict, rows:[{repo, defaultBranch, defaultFrom, current, branches, merged:[{branch, age, checkedOutAt?}], gone:[{branch, upstream, age, unmerged}], unpushed:[{branch, upstream, ahead, behind, age}], noUpstream:[{branch, age, commits}]}], nothing:[repo], fetched, roots}. merged leaves out the default branch; noUpstream leaves out merged ones; commits is how many no remote has.",
  example: 'await scripts.run("branches", { repo: "unseen-university" })',
};

const lines = (out) => out.split("\n").filter((l) => l.trim());

export default async function ({ repos }, { repo, roots } = {}) {
  const r = roots ? repos.within(roots) : repos;
  const found = await r.list({});
  if (!found.count) return { verdict: `no repositories found under ${found.roots.join(", ")}`, rows: [], roots: found.roots };
  let only;
  let matched;
  if (repo) {
    const one = await r.git(repo, "rev-parse", "--git-common-dir");
    const hit = found.repos.find((e) => e.label === one.repo);
    only = [hit?.worktree ? hit.of : one.repo];
    matched = one.matched;
  }
  const rows = await r.each(async (entry, git) => {
    const def = await r.defaultBranch(entry.label);
    const refs = lines((await git("for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)%09%(worktreepath)%09%(HEAD)", "refs/heads")).out).map((l) => {
      const [branch, ct, upstream, track, wt, head] = l.split("\t");
      return { branch, age: repos.age(Number(ct)), upstream: upstream || null, track: track ?? "", wt: wt || null, current: head === "*" };
    });
    const mergedSet = def.ref ? new Set(lines((await git("branch", "--merged", def.ref, "--format=%(refname:short)")).out)) : new Set();
    const o = { repo: entry.label, defaultBranch: def.branch, defaultFrom: def.from, current: refs.find((x) => x.current)?.branch ?? "(detached)", branches: refs.length, merged: [], gone: [], unpushed: [], noUpstream: [] };
    let checks = 0;
    for (const b of refs) {
      const isMerged = b.branch !== def.branch && mergedSet.has(b.branch);
      const where = b.wt && !b.current ? { checkedOutAt: b.wt } : b.current ? { current: true } : {};
      if (isMerged) o.merged.push({ branch: b.branch, age: b.age, ...where });
      const ahead = Number(/ahead (\d+)/.exec(b.track)?.[1] ?? 0);
      const behind = Number(/behind (\d+)/.exec(b.track)?.[1] ?? 0);
      if (/gone/.test(b.track)) o.gone.push({ branch: b.branch, upstream: b.upstream, age: b.age, unmerged: !isMerged && b.branch !== def.branch, ...where });
      else if (ahead) o.unpushed.push({ branch: b.branch, upstream: b.upstream, ahead, behind, age: b.age, ...where });
      else if (!b.upstream && !isMerged && checks++ < 25) {
        const n = Number((await git("rev-list", "--count", b.branch, "--not", "--remotes")).out.trim()) || 0;
        if (n) o.noUpstream.push({ branch: b.branch, age: b.age, commits: n, ...where });
      }
    }
    for (const k of ["merged", "gone", "unpushed", "noUpstream"]) {
      if (o[k].length > 15) (o[`${k}LeftOut`] = o[k].length - 15), (o[k] = o[k].slice(0, 15));
      if (!o[k].length) delete o[k];
    }
    return o;
  }, { only, main: true });
  const vals = rows.map((x) => x.value ?? { repo: x.repo, error: x.error });
  const interesting = (o) => o.error || o.merged || o.gone || o.unpushed || o.noUpstream;
  const kept = repo ? vals : vals.filter(interesting);
  const total = (k) => vals.reduce((n, o) => n + (o[k]?.length ?? 0) + (o[`${k}LeftOut`] ?? 0), 0);
  const sts = await r.statuses({ only });
  const tracked = sts.filter((s) => s.upstream && !s.error);
  const oldest = tracked.filter((s) => s.lastFetch).sort((a, b) => (a.lastFetch < b.lastFetch ? -1 : 1))[0];
  return {
    verdict: `${vals.length} repositories: ${total("merged")} branches merged into the default branch, ${total("gone")} with a gone upstream, ${total("unpushed")} ahead of their upstream, ${total("noUpstream")} never pushed`,
    ...(matched ? { matched } : {}),
    rows: kept.slice(0, 40),
    ...(kept.length > 40 ? { leftOut: kept.length - 40 } : {}),
    ...(repo ? {} : { nothing: vals.filter((o) => !interesting(o)).map((o) => o.repo).slice(0, 100) }),
    fetched: !tracked.length ? "no checked-out branch has an upstream" : `gone and ahead are as of the last fetch${oldest ? `; the oldest was ${oldest.fetchAge} ago (${oldest.repo})` : "; none was ever fetched"}`,
    roots: found.roots,
  };
}
