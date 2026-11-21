export const meta = {
  purpose:
    "What was committed since a time across all repositories, grouped by day: repository, branch, short sha, subject, time, files changed. By the configured git user by default. Answers \"what did I do today or this week across projects\".",
  params: {
    since: "\"today\" (default), \"yesterday\", \"week\", or anything git --since takes: \"3 days ago\", \"2026-11-01\"",
    until: "anything git --until takes, optional",
    author: "\"me\" (default: each repository's configured user.email), \"all\", or a name or email fragment",
    only: "only repositories whose label or path contains this text (or a list of them), optional",
    roots: "look in these folders instead of the configured ones, comma-separated, optional",
    max: "commits kept, newest first, default 60",
  },
  returns: "{verdict, since, author, commits, days:[{day, count, commits:[text]}, each commit one line: HH:MM repo [branch] sha subject (N files, author when not \"me\")], byRepo:{repo: count}, leftOut?, quiet (repositories with none)}. Days and times are local.",
  example: 'await scripts.run("activity", { since: "week" })',
};

const SINCE = { today: "midnight", yesterday: "yesterday midnight", week: "1 week ago", "this week": "1 week ago", month: "1 month ago", "this month": "1 month ago" };

export default async function ({ repos }, { since = "today", until, author = "me", only, roots, max = 60 } = {}) {
  const r = roots ? repos.within(roots) : repos;
  const found = await r.list({ only });
  if (!found.count) return { verdict: `no repositories found under ${found.roots.join(", ")}`, commits: 0, days: [], roots: found.roots };
  // git reads a bare date as that day at the present time of day, so a day is given its edges.
  const day = (d, edge) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d).trim()) ? `${String(d).trim()} ${edge}` : String(d));
  const from = SINCE[String(since).toLowerCase()] ?? day(since, "00:00:00");
  if (until) until = day(until, "23:59:59");
  const who = String(author);
  const emails = new Set();
  // A repository's branches are shared by its worktrees, so the log is read once, from the main one.
  const rows = await r.each(async (repo, git) => {
    const a = ["log", "--branches", "HEAD", "--source", `--since=${from}`, "--date=format-local:%Y-%m-%d %H:%M", "--format=%x01%h%x09%cd%x09%S%x09%an%x09%s", "--shortstat", "-n", "300"];
    if (until) a.push(`--until=${until}`);
    if (who === "me") {
      const email = (await git("config", "--get", "user.email")).out.trim();
      if (!email) return { skipped: "no user.email configured" };
      emails.add(email);
      a.push("--fixed-strings", `--author=${email}`);
    } else if (who !== "all") a.push("-i", `--author=${who}`);
    const res = await git(...a);
    if (res.code !== 0) return /does not have any commits|bad revision 'HEAD'|unknown revision/.test(res.err) ? { commits: [] } : { error: res.err.trim().slice(0, 200) };
    const commits = res.out.split("\x01").slice(1).map((chunk) => {
      const [head, ...rest] = chunk.split("\n");
      const [sha, time, source, name, ...subject] = head.split("\t");
      const files = Number(/(\d+) files? changed/.exec(rest.join(" "))?.[1] ?? 0);
      return { repo: repo.label, branch: (source ?? "").replace(/^refs\/heads\//, ""), sha, time, subject: subject.join(" ").slice(0, 110), files, ...(who === "me" ? {} : { author: name }) };
    });
    return { commits };
  }, { only, main: true });
  const all = rows.flatMap((x) => x.value?.commits ?? []).sort((a, b) => (a.time < b.time ? 1 : -1));
  const errors = rows.filter((x) => x.error || x.value?.error).map((x) => ({ repo: x.repo, error: x.error ?? x.value.error }));
  const kept = all.slice(0, max);
  const days = [];
  for (const c of kept) {
    const day = c.time.slice(0, 10);
    if (days.at(-1)?.day !== day) days.push({ day, count: 0, commits: [] });
    days.at(-1).count++;
    days.at(-1).commits.push(`${c.time.slice(11)} ${c.repo} [${c.branch}] ${c.sha} ${c.subject} (${c.files} ${c.files === 1 ? "file" : "files"}${c.author ? `, ${c.author}` : ""})`);
  }
  const byRepo = {};
  for (const c of all) byRepo[c.repo] = (byRepo[c.repo] ?? 0) + 1;
  const whoText = who === "me" ? `by ${[...emails].join(", ") || "the configured user"}` : who === "all" ? "by anyone" : `by authors matching "${who}"`;
  return {
    verdict: all.length ? `${all.length} commits in ${Object.keys(byRepo).length} of ${rows.length} repositories since ${from}${until ? ` until ${until}` : ""}, ${whoText}` : `no commits since ${from}${until ? ` until ${until}` : ""} ${whoText} in ${rows.length} repositories`,
    since: from,
    ...(until ? { until } : {}),
    author: who === "me" ? [...emails] : who,
    commits: all.length,
    days,
    byRepo,
    ...(all.length > kept.length ? { leftOut: `${all.length - kept.length} older commits left out; narrow with since, only or author` } : {}),
    ...(who === "me" && !all.length ? { hint: 'author defaults to the configured user.email; author: "all" shows everyone\'s commits' } : {}),
    quiet: rows.filter((x) => !byRepo[x.repo]).length,
    ...(rows.some((x) => x.value?.skipped) ? { skipped: rows.filter((x) => x.value?.skipped).map((x) => `${x.repo}: ${x.value.skipped}`).slice(0, 10) } : {}),
    ...(errors.length ? { errors: errors.slice(0, 10) } : {}),
    roots: found.roots,
  };
}
