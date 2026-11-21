#!/usr/bin/env node
// Builds the bench fixture: four small repositories under bench/fixture/roots/, with bare remotes
// in roots/.remotes/ (a hidden folder, so discovery skips it). Git repositories cannot be
// committed inside another repository, so they are built. Every run removes roots/ and builds the
// same thing: fixed author, dates and messages, and nothing taken from the user's git config.
//
//   watch              clean, pushed to its remote
//   clacks             pushed; one changed file, one staged file, one untracked file
//   post-office        two commits ahead of its remote, and one stash
//   unseen-university  no remote; a merged branch (library-hours) still checked out in the linked
//                      worktree unseen-university-library, and a second linked worktree
//                      unseen-university-hex on the unmerged branch hex-upgrade
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = path.join(here, "roots");
const remotes = path.join(roots, ".remotes");

fs.rmSync(roots, { recursive: true, force: true });
fs.mkdirSync(remotes, { recursive: true });

let clock = Date.parse("2026-11-02T12:00:00Z") / 1000;
const people = { vimes: ["Sam Vimes", "sam.vimes@watch.example.com"], moist: ["Moist von Lipwig", "moist@post-office.example.com"], ponder: ["Ponder Stibbons", "ponder@uu.example.com"] };

function git(cwd, who, ...args) {
  const [name, email] = people[who];
  const date = `${clock} +0000`;
  return execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.autocrlf=false", "-c", "protocol.file.allow=always", "-c", "advice.detachedHead=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
}

const write = (dir, file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

// A repository with its own identity in its local config, so nothing depends on the machine's.
function init(name, who, { remote = true } = {}) {
  const dir = path.join(roots, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, who, "init", "--quiet", "--initial-branch=main");
  git(dir, who, "config", "user.name", people[who][0]);
  git(dir, who, "config", "user.email", people[who][1]);
  git(dir, who, "config", "commit.gpgsign", "false");
  if (remote) {
    const bare = path.join(remotes, `${name}.git`);
    git(roots, who, "init", "--quiet", "--bare", "--initial-branch=main", bare);
    git(dir, who, "remote", "add", "origin", bare);
  }
  return dir;
}

// One commit, one hour after the last.
function commit(dir, who, message, files) {
  for (const [f, text] of Object.entries(files)) write(dir, f, text);
  git(dir, who, "add", "-A");
  clock += 3600;
  git(dir, who, "commit", "--quiet", "-m", message);
}

const publish = (dir, who) => {
  git(dir, who, "push", "--quiet", "-u", "origin", "main");
  git(dir, who, "remote", "set-head", "origin", "main");
};

// watch: clean and pushed.
{
  const d = init("watch", "vimes");
  commit(d, "vimes", "WATCH-1 Add the duty roster", { "roster.md": "# Duty roster\n\n- Pseudopolis Yard: Sam Vimes, Carrot Ironfoundersson\n" });
  commit(d, "vimes", "WATCH-7 Add Cable Street to the roster", { "roster.md": "# Duty roster\n\n- Pseudopolis Yard: Sam Vimes, Carrot Ironfoundersson\n- Cable Street: Angua\n" });
  commit(d, "vimes", "WATCH-12 Record the night patrol route", { "patrol/night.md": "Treacle Mine Road, Elm Street, the Shades (in pairs).\n" });
  publish(d, "vimes");
  git(d, "vimes", "fetch", "--quiet"); // so the fixture has one repository with a last fetch time
}

// clacks: pushed, then left with a changed file, a staged file and an untracked file.
{
  const d = init("clacks", "vimes");
  commit(d, "vimes", "Add the tower list", { "towers.txt": "Tower 181\nTower 182\n" });
  commit(d, "vimes", "Add the overhead codes", { "codes.md": "G: send on\nN: do not log\nU: turn at the end of the line\n" });
  publish(d, "vimes");
  write(d, "towers.txt", "Tower 181\nTower 182\nTower 183\n");
  write(d, "semaphore.md", "Shutter positions, eight to a frame.\n");
  git(d, "vimes", "add", "semaphore.md");
  write(d, "notes-smoking-gnu.txt", "Ask the Smoking Gnu about the Woodpecker.\n");
}

// post-office: two commits ahead of its remote, and a stash.
{
  const d = init("post-office", "moist");
  commit(d, "moist", "Open the Post Office again", { "README.md": "# Ankh-Morpork Post Office\n\nNeither rain nor snow nor glom of nit.\n" });
  publish(d, "moist");
  clock = Date.parse("2026-11-03T09:00:00Z") / 1000;
  commit(d, "moist", "Print the penny stamp", { "stamps.md": "- one penny: the Patrician\n" });
  commit(d, "moist", "Print the fivepenny stamp", { "stamps.md": "- one penny: the Patrician\n- five pence: the Tower of Art\n" });
  write(d, "stamps.md", "- one penny: the Patrician\n- five pence: the Tower of Art\n- one dollar: cabbage field (scented)\n");
  clock += 3600;
  git(d, "moist", "stash", "push", "--quiet", "-m", "cabbage stamp, not ready");
}

// unseen-university: no remote, a merged branch, and a linked worktree on an unmerged branch.
{
  clock = Date.parse("2026-11-04T10:00:00Z") / 1000;
  const d = init("unseen-university", "ponder", { remote: false });
  commit(d, "ponder", "List the faculty", { "faculty.md": "- Archchancellor: Mustrum Ridcully\n- Librarian: ook\n" });
  git(d, "ponder", "switch", "--quiet", "-c", "library-hours");
  commit(d, "ponder", "Post the Library opening hours", { "library.md": "Open when the Librarian says so. Bring bananas.\n" });
  git(d, "ponder", "switch", "--quiet", "main");
  clock += 3600;
  git(d, "ponder", "merge", "--quiet", "--no-ff", "-m", "Merge branch 'library-hours'", "library-hours");
  git(d, "ponder", "worktree", "add", "--quiet", "-b", "hex-upgrade", path.join(roots, "unseen-university-hex"), "main");
  commit(path.join(roots, "unseen-university-hex"), "ponder", "Give Hex more ants", { "hex.md": "Anthill Inside. +++ Out of Cheese Error +++\n" });
  git(d, "ponder", "worktree", "add", "--quiet", path.join(roots, "unseen-university-library"), "library-hours");
}

const made = fs.readdirSync(roots).filter((n) => !n.startsWith("."));
console.log(`built ${made.length} work trees in ${roots}: ${made.join(", ")}`);
