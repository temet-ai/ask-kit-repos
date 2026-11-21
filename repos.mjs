// Many git repositories and worktrees on one machine, through the `git` command: which exist, what
// state each is in, and any git command in one of them or in all of them.
//
// Three kinds of check.
//  - Changing things: without act only the reading commands in READS run. Everything else, an
//    unknown subcommand included, is refused, because a wrong guess here loses work.
//  - The network: nothing contacts a remote unless the caller asked for a change (fetch, pull,
//    push). Ahead and behind are against the last fetched upstream, and status says when that was.
//  - Secrets: answers go to a cloud model, so a password or token in a remote URL is redacted in
//    all output, and `config --list`, `credential` commands and credential files are refused.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const deny = (why) => {
  throw new Error(`not allowed: ${why}`);
};

const READ_LIST =
  "status, log, show, diff, branch (listing), tag (listing), stash list|show, worktree list, remote (-v, get-url), rev-parse, rev-list, for-each-ref, ls-files, ls-tree, cat-file, blame, describe, shortlog, reflog (show), merge-base, name-rev, grep, cherry, show-ref, symbolic-ref (reading), count-objects, diff-tree, whatchanged, bisect log, submodule status, config --get <key>";

const notInThisAsk = (what) =>
  new Error(
    `not in this ask: ${what} changes things, and the caller did not ask for a change (act: true), so nothing was done. ` +
      `Reading commands: ${READ_LIST}. Answer what you can, and say that this needs \`ask\` with act: true. Do not look for another way to do it.`,
  );

const OUT_CAP = 200_000;
const SKIP = new Set(["node_modules", "target", "vendor", "dist", "build", "__pycache__"]);
const SECRET_PATH = /(^|[\/\\:])(\.env(\.(?!example$|sample$|template$)[\w.-]+)?|\.npmrc|\.netrc|\.git-credentials|\.pgpass|id_(rsa|ed25519|ecdsa|dsa)|[^\/\\:]*\.pem)$/i;
const SECRET_KEY = /credential|token|passw|secret|extraheader|cookie|proxy|key$/i;

/** Hides the user part of a URL when it holds a password or token: https://user:pass@host and https://token@host. */
export const redact = (s) =>
  String(s).replace(/\b([a-z][a-z0-9+.-]*):\/\/([^\/\s@"'<>]+)@/gi, (m, scheme, user) =>
    !user.includes(":") && /^(ssh|git\+ssh|ssh\+git)$/i.test(scheme) ? m : `${scheme}://[redacted]@`,
  );

/** "3h", "2d", "5w", "14mo" for a time in the past (ISO text, a Date, or seconds or milliseconds since 1970). */
export function age(t, now = Date.now()) {
  if (t == null || t === "") return null;
  const ms = t instanceof Date ? t.getTime() : typeof t === "number" ? (t < 1e11 ? t * 1000 : t) : Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129_600) return `${Math.round(s / 3600)}h`;
  if (s < 86_400 * 21) return `${Math.round(s / 86_400)}d`;
  if (s < 86_400 * 90) return `${Math.round(s / 604_800)}w`;
  if (s < 86_400 * 730) return `${Math.round(s / 2_629_800)}mo`;
  return `${Math.round(s / 31_557_600)}y`;
}

const iso = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString().replace(".000Z", "Z") : null);

// The subcommand and what follows it. Options before the subcommand are refused: -c can define an
// alias that runs a shell, and -C, --git-dir and --work-tree would leave the repository named.
function split(args) {
  const a = args.map(String);
  if (!a.length) throw new Error("repos.git needs a git subcommand after the repository: repos.git(\"watch\", \"log\", \"-5\", \"--oneline\")");
  if (a[0] === "git") a.shift();
  if (a[0]?.startsWith("-")) deny(`git ${a[0]} before the subcommand; name the repository as the first argument and start with the subcommand`);
  return { sub: a[0], rest: a.slice(1), a };
}

const has = (rest, ...flags) => rest.some((x) => flags.some((f) => x === f || (f.startsWith("--") && x.startsWith(f + "="))));
// Arguments that are not options; `valued` options take the next argument with them.
const positionals = (rest, valued = []) => {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--") continue;
    if (valued.includes(rest[i])) i++;
    else if (!rest[i].startsWith("-")) out.push(rest[i]);
  }
  return out;
};

// Refused with or without act: output that leaks credentials, and commands that wait for a person.
function always(sub, rest) {
  if (/^credential/.test(sub)) deny(`git ${sub} prints or stores credentials, and answers go to a cloud model; say which remote needs a login and let the person do it`);
  if (["difftool", "mergetool", "gui", "gitk", "citool", "instaweb", "daemon", "help", "web--browse", "send-email", "shell", "fsmonitor--daemon"].includes(sub)) deny(`git ${sub} waits for a person or never ends`);
  // Naming such a file is fine where only its name or history is printed (log --stat, ls-files, add).
  const names = ["log", "rev-list", "ls-files", "ls-tree", "status", "shortlog", "add", "rm", "restore", "checkout", "reset", "commit", "stash", "clean"].includes(sub) && !has(rest, "-p", "--patch", "-u", "--unified", "--cc", "-c") && !rest.some((x) => /^-U\d*$/.test(x));
  if (has(rest, "--no-index") || (sub === "grep" && has(rest, "--untracked", "--no-exclude-standard"))) deny(`git ${sub} outside what is tracked can read files that hold secrets; search tracked files only`);
  if (sub === "blame" && has(rest, "--contents")) deny("git blame --contents reads another file");
  if (!names) for (const x of rest) if (SECRET_PATH.test(x.replace(/^[^:]*:(?=.)/, ":"))) deny(`${x} may hold secrets, and answers go to a cloud model; ask for the file's name, size or history (log --stat) instead of its content`);
  if (sub === "config") {
    if (has(rest, "-l", "--list", "list", "--get-regexp", "--get-urlmatch", "-e", "--edit", "edit", "--show-origin", "--show-scope")) deny("git config --list, --get-regexp and --edit print or open the whole configuration, which can hold tokens; read one key with config --get <key>");
    if (has(rest, "-f", "--file", "--blob")) deny("git config --file reads another file; read one key of this repository with config --get <key>");
    if (rest.some((x) => !x.startsWith("-") && SECRET_KEY.test(x))) deny("that config key can hold a credential; the remote's address is repos.git(repo, \"remote\", \"-v\"), with any password redacted");
  }
  if (["add", "checkout", "restore", "reset", "stash", "commit", "clean"].includes(sub) && has(rest, "-i", "--interactive", "-p", "--patch")) deny(`git ${sub} with --interactive or --patch waits for a person; name the paths`);
  if (sub === "rebase" && has(rest, "-i", "--interactive")) deny("git rebase --interactive waits for a person; use rebase without it, or --autosquash");
  if (sub === "bisect" && rest[0] === "visualize") deny("git bisect visualize opens a viewer");
  if (sub === "log" && has(rest, "-L") && has(rest, "--follow")) deny("log -L with --follow is not supported by git");
}

// True when the command only reads. Anything not listed here needs act.
const READS = {
  status: (r) => true,
  log: (r) => !has(r, "--output"),
  show: (r) => !has(r, "--output"),
  diff: (r) => !has(r, "--output"),
  "diff-tree": (r) => !has(r, "--output"),
  whatchanged: (r) => !has(r, "--output"),
  shortlog: () => true,
  "rev-parse": () => true,
  "rev-list": () => true,
  "for-each-ref": () => true,
  "ls-files": () => true,
  "ls-tree": () => true,
  "cat-file": () => true,
  blame: () => true,
  describe: () => true,
  "merge-base": () => true,
  "name-rev": () => true,
  grep: (r) => !has(r, "-O", "--open-files-in-pager"),
  cherry: () => true,
  "show-ref": (r) => !has(r, "--exclude-existing"),
  "count-objects": () => true,
  version: () => true,
  reflog: (r) => !["expire", "delete", "drop"].includes(positionals(r)[0]),
  "symbolic-ref": (r) => !has(r, "-d", "--delete", "-m") && positionals(r).length <= 1,
  bisect: (r) => r[0] === "log",
  submodule: (r) => !r.length || r[0] === "status" || r[0] === "summary",
  stash: (r) => r[0] === "list" || r[0] === "show",
  worktree: (r) => r[0] === "list",
  remote(r) {
    const p = positionals(r);
    if (!p.length) return true;
    if (p[0] === "get-url") return true;
    if (p[0] === "show") {
      if (p.length > 1 && !has(r, "-n")) deny("git remote show <name> contacts the remote; add -n to read what is known locally, or ask for a fetch with act: true");
      return true;
    }
    return false;
  },
  branch(r) {
    if (has(r, "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-u", "--set-upstream-to", "--unset-upstream", "--edit-description", "-f", "--force", "-t", "--track", "--no-track", "--create-reflog")) return false;
    if (has(r, "-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--show-current")) return true;
    return positionals(r, ["--sort", "--format", "--color", "--column", "--abbrev"]).length === 0;
  },
  tag(r) {
    if (has(r, "-d", "--delete", "-a", "--annotate", "-s", "--sign", "-u", "--local-user", "-f", "--force", "-m", "--message", "-F", "--file", "-e", "--edit")) return false;
    if (has(r, "-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "-v", "--verify") || r.some((x) => /^-n\d*$/.test(x))) return true;
    return positionals(r, ["--sort", "--format", "--color", "--column"]).length === 0;
  },
  config(r) {
    if (has(r, "--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "set", "unset", "rename-section", "remove-section")) return false;
    const p = positionals(r, ["--default", "--type"]).filter((x) => x !== "get");
    return p.length === 1; // one key and no value
  },
};

const NETWORK = new Set(["fetch", "pull", "push", "clone", "ls-remote", "submodule", "remote"]);

function exec(args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "never", LC_ALL: "C", NO_COLOR: "1", TERM: "dumb" };
    const child = execFile("git", ["--no-pager", ...args], { cwd, timeout: timeoutMs, maxBuffer: 64 << 20, encoding: "utf8", env, windowsHide: true }, (err, stdout, stderr) => {
      if (err?.code === "ENOENT") return resolve({ code: 127, out: "", err: "git is not installed or not on PATH: https://git-scm.com/downloads" });
      let out = redact(stdout ?? "");
      if (out.length > OUT_CAP) out = out.slice(0, OUT_CAP) + `\n[output cut at ${OUT_CAP} characters; narrow the command (-n, a path, --since)]`;
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out, err: redact(stderr ?? "").slice(0, 2000), ...(err?.killed ? { timedOut: true } : {}) });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(); // a command that reads stdin gets nothing and ends
  });
}

// Runs fn over items, at most `limit` at once, keeping the order.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readText = (p) => {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
};
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const expandHome = (p) => (p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(2)) : p);

// The git directory and the shared (common) directory of a work tree, read from disk: `.git` is a
// directory in a main work tree, and a file "gitdir: <path>" in a linked worktree or a submodule.
function gitDirs(dir) {
  const dot = path.join(dir, ".git");
  let st;
  try {
    st = fs.statSync(dot);
  } catch {
    return null;
  }
  if (st.isDirectory()) return { gitDir: dot, commonDir: dot, kind: "repository" };
  const m = /^gitdir:\s*(.+)$/m.exec(readText(dot) ?? "");
  if (!m) return null;
  const gitDir = path.resolve(dir, m[1].trim());
  const common = readText(path.join(gitDir, "commondir"));
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  return { gitDir, commonDir, kind: common ? "worktree" : "submodule" };
}

// The work tree that holds `dir`, walking up.
function enclosing(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (gitDirs(d)) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export function make({ settings = {}, push = () => {}, act = false } = {}) {
  const workdir = path.resolve(expandHome(String(settings.WORKDIR ?? process.env.WORKDIR ?? process.cwd())));
  const depth = Math.min(8, Math.max(1, Number(settings.REPOS_DEPTH ?? 4) || 4));
  const maxRepos = Math.min(2000, Math.max(1, Number(settings.REPOS_MAX ?? 300) || 300));
  const abs = (p) => path.resolve(workdir, expandHome(String(p).trim()));

  function defaultRoots() {
    const given = String(settings.REPOS_ROOTS ?? process.env.REPOS_ROOTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (given.length) return given.map(abs);
    const here = enclosing(workdir);
    const hereDirs = here ? gitDirs(here) : null;
    // From a linked worktree, the folder next to the main repository is the one that holds the projects.
    const main = hereDirs?.kind === "worktree" ? path.dirname(hereDirs.commonDir) : here;
    const out = [main ? path.dirname(main) : workdir];
    for (const n of ["projects", "code", "src", "dev", "work", "repos", "git"]) out.push(path.join(os.homedir(), n));
    return [...new Set(out.map(real))].filter(isDir);
  }

  const raw = async (cwd, args, timeoutMs = 30_000) => {
    const started = Date.now();
    const r = await exec(args, { cwd, timeoutMs });
    push({ kind: "git", detail: redact(`git -C ${cwd} ${args.join(" ")}`).slice(0, 240), ms: Date.now() - started, code: r.code, size: r.out.length });
    return r;
  };

  // ---- discovery ----

  const cache = new Map();

  async function discover(roots) {
    const found = new Map(); // real path -> entry
    const missing = [];
    let cut = false;
    const add = (dir, dirs) => {
      const p = real(dir);
      if (found.has(p)) return;
      if (found.size >= maxRepos) return void (cut = true);
      found.set(p, { path: p, name: path.basename(p), kind: dirs.kind, gitDir: dirs.gitDir, commonDir: real(dirs.commonDir) });
    };
    const walk = (dir, level) => {
      if (cut) return;
      const dirs = gitDirs(dir);
      if (dirs) return add(dir, dirs);
      // A bare repository has no work tree to report on.
      if (fs.existsSync(path.join(dir, "HEAD")) && isDir(path.join(dir, "objects")) && isDir(path.join(dir, "refs"))) return;
      if (level >= depth) return;
      let names;
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of names.sort((x, y) => (x.name < y.name ? -1 : 1))) {
        if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) continue;
        walk(path.join(dir, e.name), level + 1);
      }
    };
    for (const r of roots) {
      if (!isDir(r)) missing.push(r);
      else walk(r, 0);
    }
    // Linked worktrees can live anywhere; git knows where.
    const mains = [...found.values()].filter((e) => e.kind === "repository" && isDir(path.join(e.gitDir, "worktrees")));
    await pool(mains, 8, async (e) => {
      const r = await raw(e.path, ["worktree", "list", "--porcelain"]);
      for (const block of r.out.split(/\n\n+/)) {
        const w = /^worktree (.+)$/m.exec(block)?.[1];
        if (!w || /^bare$/m.test(block) || /^prunable/m.test(block)) continue;
        const dirs = gitDirs(w);
        if (dirs) add(w, dirs);
      }
    });
    const list = [...found.values()].sort((x, y) => (x.path < y.path ? -1 : 1));
    // A short label that names one entry: the folder's name, with parent folders added while two share it.
    for (let n = 1; n <= 6; n++) {
      const tail = (e) => e.path.split(path.sep).filter(Boolean).slice(-n).join("/");
      const seen = new Map();
      for (const e of list) if (!e.label) seen.set(tail(e), (seen.get(tail(e)) ?? 0) + 1);
      const taken = new Set(list.filter((e) => e.label).map((e) => e.label));
      for (const e of list) if (!e.label && (seen.get(tail(e)) === 1 || n === 6) && !taken.has(tail(e))) e.label = tail(e);
    }
    for (const e of list) e.label ??= e.path;
    const byCommon = new Map(list.filter((e) => e.kind === "repository").map((e) => [e.commonDir, e]));
    for (const e of list) if (e.kind === "worktree") e.of = byCommon.get(e.commonDir)?.label ?? path.dirname(e.commonDir);
    return { list, roots, missing, cut };
  }

  const found = (roots) => {
    const key = roots.join("\n");
    if (!cache.has(key)) cache.set(key, discover(roots));
    return cache.get(key);
  };

  const pub = (e) => ({ label: e.label, name: e.name, path: e.path, worktree: e.kind === "worktree", ...(e.kind === "worktree" ? { of: e.of } : {}), ...(e.kind === "submodule" ? { submodule: true } : {}) });

  // ---- the gate ----

  // Without act only reading commands pass. With act everything passes except what `always` refuses.
  const gate = act
    ? (sub, rest) => always(sub, rest)
    : (sub, rest) => {
        always(sub, rest);
        if (sub === "ls-remote") deny("git ls-remote contacts the remote, and nothing here does that unless the caller asked for a change; branches known from the last fetch are for-each-ref refs/remotes");
        const reads = READS[sub];
        if (!reads || !reads(rest)) throw notInThisAsk(`git ${[sub, ...rest.filter((x) => !x.includes("/") || x.length < 30)].slice(0, 3).join(" ")}`);
      };

  function scoped(roots) {
    const all = () => found(roots);

    async function resolve(repo) {
      const { list } = await all();
      if (repo && typeof repo === "object" && repo.path) repo = repo.path;
      const q = String(repo ?? "").trim();
      if (!q) throw new Error(`name a repository; have: ${list.map((e) => e.label).slice(0, 40).join(", ") || "none"}`);
      const exact = list.find((e) => e.label === q) ?? list.find((e) => e.path === q);
      if (exact) return { entry: exact, how: "exact" };
      const named = list.filter((e) => e.name === q);
      if (named.length === 1) return { entry: named[0], how: "exact" };
      if (named.length > 1) throw new Error(`${named.length} repositories are named ${q}: ${named.map((e) => e.label).join(", ")}; use one of these labels`);
      if (/[\/\\]|^\.{1,2}$|^~/.test(q)) {
        const p = real(abs(q));
        const hit = list.find((e) => e.path === p);
        if (hit) return { entry: hit, how: "path" };
        const top = isDir(p) ? enclosing(p) : null;
        if (top) {
          const inList = list.find((e) => e.path === real(top));
          if (inList) return { entry: inList, how: "path" };
          const dirs = gitDirs(top);
          return { entry: { path: real(top), name: path.basename(top), label: real(top), kind: dirs.kind, gitDir: dirs.gitDir, commonDir: real(dirs.commonDir) }, how: "path" };
        }
      }
      const low = q.toLowerCase();
      const sub = list.filter((e) => e.label.toLowerCase().includes(low) || e.path.toLowerCase().includes(low));
      const narrowed = sub.filter((e) => e.label.toLowerCase().includes(low));
      const pick = narrowed.length ? narrowed : sub;
      if (pick.length === 1) return { entry: pick[0], how: `substring "${q}"` };
      if (pick.length > 1) throw new Error(`"${q}" matches ${pick.length} repositories: ${pick.map((e) => e.label).slice(0, 20).join(", ")}; use one label`);
      throw new Error(`no repository ${q}; have: ${list.map((e) => e.label).slice(0, 40).join(", ") || `none under ${roots.join(", ")}`}`);
    }

    const run = async (entry, args) => {
      const { sub, rest, a } = split(args);
      gate(sub, rest);
      return raw(entry.path, a, NETWORK.has(sub) ? 120_000 : 30_000);
    };

    async function git(repo, ...args) {
      // repos.git("status") with no repository named is the repository the agent is in.
      let r;
      if (typeof repo === "string" && (READS[repo] || /^(fetch|pull|push|switch|checkout|commit|add|restore|reset|merge|rebase|cherry-pick|revert|clean|gc|apply|am)$/.test(repo))) {
        const { list } = await all();
        if (!list.some((e) => e.label === repo || e.name === repo)) {
          const top = enclosing(workdir);
          if (!top) throw new Error(`"${repo}" is a git command, and the agent's folder ${workdir} is not in a repository; name the repository first: repos.git("<label>", "${repo}")`);
          r = await resolve(top);
          args = [repo, ...args];
        }
      }
      r ??= await resolve(repo);
      const res = await run(r.entry, args);
      return { repo: r.entry.label, ...(r.how.startsWith("substring") ? { matched: r.how } : {}), ...res };
    }

    async function pick(o = {}) {
      const { list } = await all();
      let sel = o.main ? list.filter((e) => e.kind !== "worktree") : list;
      if (o.only != null && o.only !== "") {
        const wants = [].concat(o.only).map((s) => String(s).toLowerCase());
        const exact = sel.filter((e) => wants.includes(e.label.toLowerCase()) || wants.includes(e.name.toLowerCase()));
        sel = exact.length ? exact : sel.filter((e) => wants.some((w) => e.label.toLowerCase().includes(w) || e.path.toLowerCase().includes(w)));
        if (!sel.length) throw new Error(`no repository matches ${JSON.stringify(o.only)}; have: ${list.map((e) => e.label).slice(0, 40).join(", ") || "none"}`);
      }
      return sel;
    }

    async function each(what, o = {}) {
      const sel = await pick(o);
      if (Array.isArray(what)) {
        const { sub, rest } = split(what);
        gate(sub, rest); // refuse once, before anything runs
      } else if (typeof what !== "function") throw new Error('repos.each needs git arguments as an array, each(["log", "-1", "--oneline"]), or a function, each(async (repo, git) => ...)');
      return pool(sel, 8, async (e) => {
        if (Array.isArray(what)) return { repo: e.label, ...(await run(e, what)) };
        try {
          return { repo: e.label, value: await what(pub(e), (...args) => run(e, args)) };
        } catch (err) {
          if (/^not (in this ask|allowed)/.test(err.message)) throw err;
          return { repo: e.label, error: String(err.message).slice(0, 300) };
        }
      });
    }

    async function status(repo, o = {}) {
      const { entry: e, how } = repo && typeof repo === "object" && repo.gitDir ? { entry: repo, how: "exact" } : await resolve(repo);
      const keep = o.paths ?? 5;
      const [st, last] = await Promise.all([
        raw(e.path, ["status", "--porcelain=v2", "--branch", "--show-stash"]),
        raw(e.path, ["log", "-1", "--format=%h%x09%ct%x09%s"]),
      ]);
      if (st.code !== 0) return { repo: e.label, path: e.path, error: (st.err || st.out).trim().slice(0, 300) || `git status failed with code ${st.code}` };
      const s = { branch: null, detached: false, head: null, upstream: null, ahead: 0, behind: 0, stashes: 0 };
      let ab = false;
      const groups = { staged: [], unstaged: [], untracked: [], conflicted: [] };
      for (const line of st.out.split("\n")) {
        if (line.startsWith("# branch.oid ")) s.head = line.slice(13) === "(initial)" ? null : line.slice(13, 20);
        else if (line.startsWith("# branch.head ")) line.slice(14) === "(detached)" ? (s.detached = true) : (s.branch = line.slice(14));
        else if (line.startsWith("# branch.upstream ")) s.upstream = line.slice(18);
        else if (line.startsWith("# branch.ab ")) {
          const m = /\+(\d+) -(\d+)/.exec(line);
          if (m) (ab = true), (s.ahead = Number(m[1])), (s.behind = Number(m[2]));
        } else if (line.startsWith("# stash ")) s.stashes = Number(line.slice(8)) || 0;
        else if (line.startsWith("? ")) groups.untracked.push(line.slice(2));
        else if (line.startsWith("u ")) groups.conflicted.push(line.split(" ").slice(10).join(" "));
        else if (line.startsWith("1 ") || line.startsWith("2 ")) {
          const f = line.split(" ");
          const p = (line[0] === "1" ? f.slice(8) : f.slice(9)).join(" ").split("\t")[0];
          if (f[1][0] !== ".") groups.staged.push(p);
          if (f[1][1] !== ".") groups.unstaged.push(p);
        }
      }
      const g = (list) => ({ count: list.length, paths: list.slice(0, keep).map((p) => p.slice(0, 160)) });
      const d = e.gitDir;
      const operation = fs.existsSync(path.join(d, "rebase-merge")) ? "rebase"
        : fs.existsSync(path.join(d, "rebase-apply")) ? (fs.existsSync(path.join(d, "rebase-apply", "applying")) ? "am" : "rebase")
        : fs.existsSync(path.join(d, "MERGE_HEAD")) ? "merge"
        : fs.existsSync(path.join(d, "CHERRY_PICK_HEAD")) ? "cherry-pick"
        : fs.existsSync(path.join(d, "REVERT_HEAD")) ? "revert"
        : fs.existsSync(path.join(d, "BISECT_LOG")) ? "bisect" : null;
      let fetched = 0;
      for (const f of new Set([path.join(d, "FETCH_HEAD"), path.join(e.commonDir, "FETCH_HEAD")])) {
        try {
          fetched = Math.max(fetched, fs.statSync(f).mtimeMs);
        } catch {}
      }
      const [sha, ct, ...subj] = last.code === 0 ? last.out.trim().split("\t") : [];
      return {
        repo: e.label,
        ...(how.startsWith("substring") ? { matched: how } : {}),
        path: e.path,
        ...(e.kind === "worktree" ? { worktreeOf: e.of } : {}),
        branch: s.branch,
        detached: s.detached,
        head: s.head,
        upstream: s.upstream,
        upstreamGone: !!s.upstream && !ab,
        ahead: s.ahead,
        behind: s.behind,
        staged: g(groups.staged),
        unstaged: g(groups.unstaged),
        untracked: g(groups.untracked),
        conflicted: g(groups.conflicted),
        dirty: groups.staged.length + groups.unstaged.length + groups.untracked.length + groups.conflicted.length > 0,
        stashes: s.stashes,
        operation,
        last: sha ? { sha, subject: subj.join("\t").slice(0, 120), time: iso(ct), age: age(Number(ct)) } : null,
        lastFetch: fetched ? new Date(fetched).toISOString().replace(/\.\d+Z$/, "Z") : null,
        fetchAge: fetched ? age(fetched) : null,
      };
    }

    // The branch others are merged into: what origin/HEAD points at, else a local main, master,
    // trunk or develop, else the branch checked out in the main work tree.
    async function defaultBranch(repo) {
      const { entry: e } = await resolve(repo);
      const head = await raw(e.path, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
      if (head.code === 0 && head.out.trim()) {
        const branch = head.out.trim().replace(/^origin\//, "");
        const local = (await raw(e.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
        return { repo: e.label, branch, ref: local ? branch : `origin/${branch}`, from: "origin/HEAD" };
      }
      const have = (await raw(e.path, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).out.split("\n").filter(Boolean);
      for (const b of ["main", "master", "trunk", "develop"]) if (have.includes(b)) return { repo: e.label, branch: b, ref: b, from: "the usual names (origin/HEAD is not set)" };
      const main = path.dirname(e.commonDir);
      const cur = (await raw(isDir(main) && gitDirs(main) ? main : e.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).out.trim();
      return cur ? { repo: e.label, branch: cur, ref: cur, from: "the branch checked out (origin/HEAD is not set, and there is no main or master)" } : { repo: e.label, branch: null, ref: null, from: "not found" };
    }

    return {
      defaultBranch,
      /** The repositories and linked worktrees found. */
      async list(o = {}) {
        const f = await all();
        const sel = await pick(o);
        return { count: sel.length, roots: f.roots, ...(f.missing.length ? { missingRoots: f.missing } : {}), ...(f.cut ? { cut: `stopped at ${maxRepos} repositories; set REPOS_ROOTS to narrower folders or raise REPOS_MAX` } : {}), repos: sel.map(pub) };
      },
      git,
      each,
      status,
      /** status() of every repository, at most 8 at once. */
      async statuses(o = {}) {
        const sel = await pick(o);
        return pool(sel, 8, (e) => status(e, o));
      },
      /** The same global looking only in these folders (comma-separated text or an array), for a question about one place. */
      within(r) {
        const dirs = (Array.isArray(r) ? r : String(r ?? "").split(",")).map((s) => String(s).trim()).filter(Boolean).map(abs);
        if (!dirs.length) throw new Error("repos.within needs one or more folders");
        return scoped(dirs.map(real));
      },
      age,
      redact,
      acting: act,
    };
  }

  return scoped(defaultRoots());
}
