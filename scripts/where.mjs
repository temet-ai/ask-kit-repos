export const meta = {
  purpose:
    "Where something lives across all repositories and worktrees: a branch name, a commit sha, words from a commit subject, or a file name. Says which repositories have it, and for a branch which worktree has it checked out. Answers \"which repo has branch X\", \"where is commit abc123\", \"which project has a file called Y\".",
  params: {
    q: "the branch name, the commit sha (4 or more hex digits), the words of a commit subject, or the file name or part of it",
    kind: "\"branch\", \"commit\", \"subject\" or \"file\" to look for one kind only; by default all that fit are tried",
    only: "only repositories whose label or path contains this text (or a list of them), optional",
    roots: "look in these folders instead of the configured ones, comma-separated, optional",
  },
  returns:
    "{verdict, q, branches:[{repo, branch, sha, age, match, checkedOutAt?, remotes?:[text], remote?}], commits:[{repo, sha, subject, time, author, on:[branch]}], subjects:[{repo, sha, subject, time, author}], files:[{repo, branch, count, paths}], searched}. Remote branches are as of the last fetch.",
  example: 'await scripts.run("where", { q: "hex-upgrade" })',
};

const lines = (out) => out.split("\n").filter((l) => l.trim());

export default async function ({ repos }, { q, kind, only, roots } = {}) {
  if (q == null || String(q).trim() === "") throw new Error('where needs `q`: a branch name, a commit sha, words from a commit subject, or a file name');
  const kinds = ["branch", "commit", "subject", "file"];
  if (kind && !kinds.includes(kind)) throw new Error(`where: kind is one of ${kinds.join(", ")}; got ${kind}`);
  q = String(q).trim();
  const r = roots ? repos.within(roots) : repos;
  const found = await r.list({ only });
  if (!found.count) return { verdict: `no repositories found under ${found.roots.join(", ")}`, q, roots: found.roots };
  const low = q.toLowerCase();
  const want = (k) => !kind || kind === k;
  const isSha = /^[0-9a-f]{4,40}$/i.test(q);
  const oneWord = !/\s/.test(q);

  // Branches, commits and subjects are shared by a repository's worktrees: asked once, in the main one.
  const perRepo = await r.each(async (repo, git) => {
    const o = { branches: [], commits: [], subjects: [] };
    if (want("branch") && oneWord) {
      const refs = lines((await git("for-each-ref", "--format=%(refname)%09%(objectname:short)%09%(committerdate:unix)%09%(worktreepath)", "refs/heads", "refs/remotes")).out);
      for (const l of refs) {
        const [ref, sha, ct, wt] = l.split("\t");
        const remote = ref.startsWith("refs/remotes/");
        const name = ref.replace(/^refs\/(heads|remotes)\//, "");
        const bare = remote ? name.replace(/^[^/]+\//, "") : name;
        if (bare === "HEAD") continue;
        const match = bare === q || name === q ? "exact" : bare.toLowerCase().includes(low) ? "substring" : null;
        if (match) o.branches.push({ repo: repo.label, branch: name, sha, age: repos.age(Number(ct)), match, ...(remote ? { remote: true } : {}), ...(wt ? { checkedOutAt: wt } : {}) });
      }
    }
    if (want("commit") && isSha) {
      const v = await git("rev-parse", "--verify", "--quiet", `${q}^{commit}`);
      if (v.code === 0) {
        const [sha, time, author, ...subject] = (await git("log", "-1", "--date=format-local:%Y-%m-%d %H:%M", "--format=%h%x09%cd%x09%an%x09%s", v.out.trim())).out.trim().split("\t");
        const on = lines((await git("branch", "-a", "--contains", v.out.trim(), "--format=%(refname)")).out).filter((x) => !x.endsWith("/HEAD") && x.startsWith("refs/")).map((x) => x.replace(/^refs\/(heads|remotes)\//, ""));
        o.commits.push({ repo: repo.label, sha, subject: subject.join(" ").slice(0, 110), time, author, on: on.slice(0, 8), ...(on.length > 8 ? { onMore: on.length - 8 } : {}) });
      }
    }
    if (want("subject") && !(isSha && !kind && q.length >= 7)) {
      const res = await git("log", "--branches", "--remotes", "HEAD", "-i", "--fixed-strings", `--grep=${q}`, "--date=format-local:%Y-%m-%d %H:%M", "--format=%h%x09%cd%x09%an%x09%s", "-n", "6");
      const hits = lines(res.out).map((l) => {
        const [sha, time, author, ...subject] = l.split("\t");
        return { repo: repo.label, sha, subject: subject.join(" ").slice(0, 110), time, author };
      });
      o.subjects.push(...hits.slice(0, 5));
      if (hits.length > 5) o.subjectsMore = true;
    }
    return o;
  }, { only, main: true });

  // Files are per work tree: each worktree can be on another branch.
  const perTree = want("file") && oneWord && !(isSha && !kind && q.length >= 7)
    ? await r.each(async (repo, git) => {
        const res = await git("ls-files", "--", `:(icase)*${q.replace(/[\\*?[\]]/g, "\\$&")}*`);
        const paths = lines(res.out);
        if (!paths.length) return null;
        const base = paths.filter((p) => p.split("/").pop().toLowerCase().includes(low));
        const use = base.length ? base : paths;
        const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).out.trim();
        return { repo: repo.label, branch, count: use.length, paths: use.slice(0, 8), ...(base.length ? {} : { note: "matched in the folder path, not the file name" }) };
      }, { only })
    : [];

  const vals = perRepo.map((x) => x.value).filter(Boolean);
  let branches = vals.flatMap((v) => v.branches);
  const exact = branches.filter((b) => b.match === "exact");
  const usedSubstring = !exact.length && branches.length > 0;
  if (exact.length) branches = exact;
  // A remote branch at the same commit as the local one of that name is folded into the local row.
  branches = branches.filter((b) => {
    if (!b.remote) return true;
    const local = branches.find((x) => !x.remote && x.repo === b.repo && x.branch === b.branch.replace(/^[^/]+\//, ""));
    if (!local) return true;
    (local.remotes ??= []).push(local.sha === b.sha ? `${b.branch} (same commit)` : `${b.branch} at ${b.sha}`);
    return false;
  });
  const commits = vals.flatMap((v) => v.commits);
  const subjects = vals.flatMap((v) => v.subjects);
  const files = perTree.map((x) => x.value).filter(Boolean);
  const errors = [...perRepo, ...perTree].filter((x) => x.error).map((x) => ({ repo: x.repo, error: x.error }));
  const reposOf = (list) => [...new Set(list.map((x) => x.repo))];
  const parts = [];
  if (branches.length) parts.push(`branch ${usedSubstring ? `names containing "${q}" (no exact match)` : q} in ${reposOf(branches).join(", ")}`);
  if (commits.length) parts.push(`commit ${commits[0].sha} in ${reposOf(commits).join(", ")}`);
  if (subjects.length) parts.push(`commit subjects in ${reposOf(subjects).join(", ")}`);
  if (files.length) parts.push(`files in ${reposOf(files).join(", ")}`);
  const cap = (list, n) => (list.length > n ? { list: list.slice(0, n), more: list.length - n } : { list });
  const b = cap(branches, 40), s = cap(subjects, 30), f = cap(files, 30);
  return {
    verdict: parts.length ? `"${q}" found as ${parts.join("; ")}` : `"${q}" was not found as a ${kind ?? "branch, commit, commit subject or tracked file"} in ${found.count} repositories and worktrees${isSha ? "" : " (remote branches as of the last fetch)"}`,
    q,
    ...(branches.length ? { branches: b.list, ...(b.more ? { branchesLeftOut: b.more } : {}) } : {}),
    ...(commits.length ? { commits } : {}),
    ...(subjects.length ? { subjects: s.list, ...(s.more || vals.some((v) => v.subjectsMore) ? { subjectsNote: "more commits match; at most 5 per repository are shown" } : {}) } : {}),
    ...(files.length ? { files: f.list, ...(f.more ? { filesLeftOut: f.more } : {}) } : {}),
    searched: found.count,
    ...(errors.length ? { errors: errors.slice(0, 10) } : {}),
    roots: found.roots,
  };
}
