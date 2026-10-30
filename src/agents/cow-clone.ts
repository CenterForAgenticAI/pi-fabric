import fs from "node:fs";
import path from "node:path";

export const CLONE_SKIP_PREFIXES = [".git", ".pi/fabric/worktrees"] as const;

export class CowUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CowUnavailableError";
  }
}

const posixRel = (value: string): string => value.replaceAll("\\", "/");

const isCowUnavailable = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  // Windows libuv rejects COPYFILE_FICLONE_FORCE with ENOSYS; some Linux
  // filesystems without the clone ioctl report ENOTTY.
  return (
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "EXDEV" ||
    code === "ENOTSUPP" ||
    code === "ENOSYS" ||
    code === "ENOTTY"
  );
};

const cloneEntry = async (from: string, to: string): Promise<void> => {
  try {
    await fs.promises.cp(from, to, {
      recursive: true,
      verbatimSymlinks: true,
      force: false,
      mode: fs.constants.COPYFILE_FICLONE_FORCE,
    });
  } catch (error) {
    if (isCowUnavailable(error)) {
      throw new CowUnavailableError(`copy-on-write clone unavailable: ${from} -> ${to}`, {
        cause: error,
      });
    }
    throw error;
  }
};

const skipped = (rel: string, prefixes: readonly string[]): boolean => {
  const value = posixRel(rel);
  return prefixes.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
};

const hasNestedSkip = (rel: string, prefixes: readonly string[]): boolean => {
  const value = posixRel(rel);
  return prefixes.some((prefix) => prefix.startsWith(`${value}/`));
};

const cloneLevel = async (
  source: string,
  dest: string,
  relBase: string,
  prefixes: readonly string[],
): Promise<void> => {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (skipped(rel, prefixes)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink() && hasNestedSkip(rel, prefixes)) {
      await cloneLevel(from, to, rel, prefixes);
      continue;
    }
    if (!(entry.isFile() || entry.isDirectory() || entry.isSymbolicLink())) continue;
    await cloneEntry(from, to);
  }
};

/**
 * Copy `source` into `dest`, skipping `prefixes`. A destination inside the
 * source (a worktree added under the repository) is skipped as well: the copy
 * would otherwise list the new worktree and try to copy it into itself. Both
 * paths are resolved first, so a Windows short name (`RUNNER~1`) still matches.
 */
export const cloneTree = async (
  source: string,
  dest: string,
  prefixes: readonly string[] = CLONE_SKIP_PREFIXES,
): Promise<void> => {
  await cloneLevel(source, dest, "", [...prefixes, ...destinationInside(source, dest)]);
};

const realOrResolved = (value: string): string => {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
};

const destinationInside = (source: string, dest: string): string[] => {
  const rel = path.relative(realOrResolved(source), realOrResolved(dest));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return [];
  return [posixRel(rel)];
};
