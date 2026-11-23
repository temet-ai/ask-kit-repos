import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { make } from "../repos.mjs";
import unfinished from "../scripts/unfinished.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repos-watch-"));
const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Sam Vimes", GIT_COMMITTER_NAME: "Sam Vimes", GIT_AUTHOR_EMAIL: "vimes@watch.example.com", GIT_COMMITTER_EMAIL: "vimes@watch.example.com" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function init(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(dir, "init", "--quiet", "--initial-branch=main");
  return dir;
}
function commit(dir, text) {
  fs.writeFileSync(path.join(dir, "roster.txt"), text);
  git(dir, "add", "roster.txt");
  git(dir, "commit", "--quiet", "-m", "Update the roster");
}
try {
  init("empty-watch");
  const watch = init("watch");
  commit(watch, "Carrot\n");
  git(watch, "remote", "add", "origin", "https://example.com/watch.git");
  git(watch, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(watch, "branch", "--set-upstream-to=origin/main", "main");
  const clacks = init("clacks");
  commit(clacks, "Tower 181\n");
  git(clacks, "remote", "add", "origin", "https://example.com/clacks.git");
  git(clacks, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(clacks, "branch", "--set-upstream-to=origin/main", "main");
  git(clacks, "switch", "--quiet", "-c", "tower-repair");
  commit(clacks, "Tower 182\n");
  git(clacks, "switch", "--quiet", "main");
  fs.writeFileSync(path.join(clacks, "roster.txt"), "Tower 183\n");

  const repos = make({ settings: { REPOS_ROOTS: tmp, WORKDIR: tmp } });
  const result = await unfinished({ repos });
  assert.equal(result.count, 3);
  assert.deepEqual(result.clean, ["watch"]);
  const empty = result.unfinished.find((r) => r.repo === "empty-watch");
  assert.equal(empty.noRemote, true);
  assert.equal(empty.noUpstream, undefined);
  const dirty = result.unfinished.find((r) => r.repo === "clacks");
  assert.equal(dirty.uncommitted.unstaged.count, 1);
  assert.deepEqual(dirty.otherBranches, [{ branch: "tower-repair", why: "no upstream", count: 1 }]);
  assert.match(result.verdict, /1 with no remote/);
  assert.ok(!dirty.noRemote);
  const callbacks = await repos.each(async (_repo, git) => (await git("remote")).out);
  assert.ok(callbacks.every((r) => Object.hasOwn(r, "value")));
  console.log("ok: unfinished reports no remotes, local branches and dirty paths in one call");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
