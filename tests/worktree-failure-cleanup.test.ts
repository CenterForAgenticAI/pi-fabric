import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  failGit: undefined as ((args: string[]) => boolean) | undefined,
  cloneFailure: undefined as ((dest: string) => Promise<void>) | undefined,
}));

vi.mock("../src/agents/transports/process-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/transports/process-utils.js")>();
  return {
    ...actual,
    executeFile: (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) =>
      command === "git" && hooks.failGit?.(args)
        ? Promise.reject(Object.assign(new Error(`stubbed failure: git ${args.join(" ")}`), { stderr: "stubbed" }))
        : actual.executeFile(command, args, options),
  };
});

vi.mock("../src/agents/cow-clone.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/cow-clone.js")>();
  return {
    ...actual,
    cloneTree: (source: string, dest: string, prefixes?: readonly string[]) =>
      hooks.cloneFailure ? hooks.cloneFailure(dest) : actual.cloneTree(source, dest, prefixes),
  };
});

const { addCloneFirstWorktree } = await import("../src/agents/clone-first-worktree.js");
const { CowUnavailableError } = await import("../src/agents/cow-clone.js");
const { WorktreeManager } = await import("../src/agents/worktree-manager.js");
const { fabricWorktreePath } = await import("../src/agents/worktree-paths.js");

const ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const roots: string[] = [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const initRepository = (): string => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-wt-fail-"));
  roots.push(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "pi-fabric-tests@example.invalid");
  git(repository, "config", "user.name", "Pi Fabric tests");
  git(repository, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repository, "README.md"), "tracked\n");
  fs.writeFileSync(path.join(repository, ".gitignore"), "node_modules/\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "initial");
  return fs.realpathSync.native(repository);
};

const worktreeCount = (repository: string): number =>
  git(repository, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;

const fabricBranches = (repository: string): string =>
  git(repository, "branch", "--list", "pi-fabric/*").trim();

afterEach(() => {
  hooks.failGit = undefined;
  hooks.cloneFailure = undefined;
  for (const root of roots.splice(0)) {
    try {
      for (const line of git(root, "worktree", "list", "--porcelain").split("\n")) {
        const worktree = line.startsWith("worktree ") ? line.slice(9) : undefined;
        if (worktree && fs.realpathSync.native(worktree) !== root) {
          execFileSync("git", ["worktree", "unlock", worktree], { cwd: root, stdio: "ignore" });
        }
      }
    } catch {
      // Unlocking is best effort; the directory is removed below.
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("worktree failure cleanup", () => {
  it("rolls back the worktree and branch when create fails after git worktree add", async () => {
    const repository = initRepository();
    const manager = new WorktreeManager();
    hooks.failGit = (args) => args[0] === "reset";

    await expect(manager.create(ID, repository, "reviewer")).rejects.toThrow(/stubbed failure: git reset/);

    expect(manager.get(ID)).toBeUndefined();
    expect(worktreeCount(repository)).toBe(1);
    expect(fabricBranches(repository)).toBe("");
    expect(fs.existsSync(fabricWorktreePath(repository, ID))).toBe(false);
  });

  it("rethrows a clone error that is not CowUnavailableError and removes the half-copied tree", async () => {
    const repository = initRepository();
    const dest = fabricWorktreePath(repository, ID);
    const failure = Object.assign(new Error("EACCES: permission denied, copyfile"), { code: "EACCES" });
    hooks.cloneFailure = async (target) => {
      fs.mkdirSync(path.join(target, "node_modules", "half"), { recursive: true });
      fs.writeFileSync(path.join(target, "node_modules", "half", "index.js"), "partial\n");
      throw failure;
    };

    await expect(
      addCloneFirstWorktree({ gitRoot: repository, dest, branch: { flag: "-b", name: "pi-fabric/clone-fail" }, startPoint: "HEAD" }),
    ).rejects.toBe(failure);

    expect(fs.existsSync(dest)).toBe(false);
    expect(worktreeCount(repository)).toBe(1);
    expect(fabricBranches(repository)).toBe("");
  });

  it("keeps a pre-existing branch when rollback follows a -B worktree add", async () => {
    const repository = initRepository();
    git(repository, "branch", "pi-fabric/existing");
    const dest = fabricWorktreePath(repository, ID);
    hooks.failGit = (args) => args[0] === "clean";

    await expect(
      addCloneFirstWorktree({ gitRoot: repository, dest, branch: { flag: "-B", name: "pi-fabric/existing" }, startPoint: "HEAD" }),
    ).rejects.toThrow(/stubbed failure: git clean/);

    expect(fs.existsSync(dest)).toBe(false);
    expect(fabricBranches(repository)).toBe("pi-fabric/existing");
  });

  it("falls back to a checkout when copy-on-write is unavailable", async () => {
    const repository = initRepository();
    const dest = fabricWorktreePath(repository, ID);
    hooks.cloneFailure = async () => {
      throw new CowUnavailableError("copy-on-write clone unavailable");
    };

    const result = await addCloneFirstWorktree({ gitRoot: repository, dest, branch: { flag: "-b", name: "pi-fabric/cow-off" }, startPoint: "HEAD" });

    expect(result.cloned).toBe(false);
    expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("tracked\n");
    git(repository, "worktree", "remove", "--force", dest);
  });

  it("deletes the branch and drops the lease when the worktree is already gone", async () => {
    const repository = initRepository();
    const manager = new WorktreeManager();
    const lease = await manager.create(ID, repository, "reviewer");
    git(repository, "worktree", "remove", "--force", lease.path);

    await expect(manager.cleanup(ID, true)).resolves.toBe(true);

    expect(manager.get(ID)).toBeUndefined();
    expect(fabricBranches(repository)).toBe("");
  });

  it("drops the lease and reports git's error when the worktree cannot be removed", async () => {
    const repository = initRepository();
    const manager = new WorktreeManager();
    const lease = await manager.create(ID, repository, "reviewer");
    git(repository, "worktree", "lock", lease.path);

    await expect(manager.cleanup(ID, true)).rejects.toThrow(/locked/);

    expect(manager.get(ID)).toBeUndefined();
    expect(fs.existsSync(lease.path)).toBe(true);
  });

  it("keeps git's error text when the cwd is not a Git repository", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-wt-nongit-"));
    roots.push(directory);

    await expect(new WorktreeManager().create(ID, directory, "reviewer")).rejects.toThrow(
      /^Worktree isolation requires a Git repository: .*not a git repository/i,
    );
  });
});
