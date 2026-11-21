export const meta = {
  purpose:
    "The state of every repository and worktree in one table: branch, uncommitted counts, ahead and behind the upstream, stashes, an operation in progress, last commit age. The ones that need attention come first. Answers \"what state are my repositories in\" and \"which branch is each on\".",
  params: {
    only: "only repositories whose label or path contains this text (or a list of them), optional",
    roots: "look in these folders instead of the configured ones, comma-separated, optional",
    all: "list the clean ones too when there are more than 60 rows, default false",
  },
  returns:
    "{verdict, count, attention, fetched, rows:[{repo, worktreeOf?, branch, upstream, dirty?, ahead?, behind?, stashes?, operation?, last, needs?:[why]}], leftOut?, roots, cut?}. ahead and behind are against the last fetch; `fetched` says how old that is.",
  example: 'await scripts.run("status", { only: "ask-kit" })',
};

export default async function ({ repos }, { only, roots, all = false } = {}) {
  const r = roots ? repos.within(roots) : repos;
  const found = await r.list({ only });
  if (!found.count) return { verdict: `no repositories found under ${found.roots.join(", ")}`, count: 0, rows: [], roots: found.roots, ...(found.missingRoots ? { missingRoots: found.missingRoots } : {}) };
  const sts = await r.statuses({ only });
  const rows = sts.map((s) => {
    if (s.error) return { repo: s.repo, error: s.error, needs: ["git status failed"] };
    const needs = [];
    if (s.operation) needs.push(`${s.operation} in progress`);
    if (s.conflicted.count) needs.push(`${s.conflicted.count} conflicted`);
    if (s.dirty) needs.push("uncommitted");
    if (s.ahead) needs.push(`${s.ahead} unpushed`);
    if (s.upstreamGone) needs.push("upstream gone");
    if (s.detached) needs.push("detached HEAD");
    if (s.stashes) needs.push(`${s.stashes} stashed`);
    const dirty = [["staged", s.staged], ["unstaged", s.unstaged], ["untracked", s.untracked], ["conflicted", s.conflicted]].filter(([, g]) => g.count).map(([k, g]) => `${g.count} ${k}`).join(", ");
    return {
      repo: s.repo,
      ...(s.worktreeOf ? { worktreeOf: s.worktreeOf } : {}),
      branch: s.detached ? `(detached at ${s.head})` : s.branch,
      upstream: s.upstream ?? "none",
      ...(dirty ? { dirty } : {}),
      ...(s.ahead ? { ahead: s.ahead } : {}),
      ...(s.behind ? { behind: s.behind } : {}),
      ...(s.stashes ? { stashes: s.stashes } : {}),
      ...(s.operation ? { operation: s.operation } : {}),
      last: s.last ? `${s.last.age} ago, ${s.last.sha} ${s.last.subject.slice(0, 60)}` : "no commits",
      ...(needs.length ? { needs } : {}),
    };
  });
  rows.sort((a, b) => (b.needs?.length ? 1 : 0) - (a.needs?.length ? 1 : 0));
  const attention = rows.filter((x) => x.needs).length;
  const behind = rows.filter((x) => x.behind).length;
  const tracked = sts.filter((s) => s.upstream);
  const ages = tracked.filter((s) => s.lastFetch).sort((a, b) => (a.lastFetch < b.lastFetch ? -1 : 1));
  const never = tracked.filter((s) => !s.lastFetch).length;
  const fetched = !tracked.length
    ? "no repository has an upstream"
    : `ahead and behind are as of each repository's last fetch: ${ages.length ? `newest ${ages.at(-1).fetchAge} ago (${ages.at(-1).repo}), oldest ${ages[0].fetchAge} ago (${ages[0].repo})` : "none was ever fetched"}${never && ages.length ? `; ${never} never fetched` : ""}`;
  const max = 60;
  const shown = rows.length > max && !all ? rows.filter((x, i) => x.needs || i < max).slice(0, Math.max(max, attention)) : rows;
  const branches = [...new Set(rows.map((x) => x.branch).filter(Boolean))];
  const noUp = sts.filter((s) => !s.error && !s.upstream && !s.detached).length;
  return {
    verdict: `${attention} of ${rows.length} need attention${behind ? `; ${behind} behind their upstream` : ""}${branches.length === 1 ? `; all on ${branches[0]}` : ""}${noUp ? `; ${noUp} on a branch with no upstream (the unfinished script says whether those hold commits no remote has)` : ""}`,
    count: rows.length,
    attention,
    fetched,
    rows: shown,
    ...(shown.length < rows.length ? { leftOut: `${rows.length - shown.length} clean repositories left out; pass all=true or only=<text>` } : {}),
    roots: found.roots,
    ...(found.missingRoots ? { missingRoots: found.missingRoots } : {}),
    ...(found.cut ? { cut: found.cut } : {}),
  };
}
