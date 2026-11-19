import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";

function writeExclusiveFile(filePath: string, content: string | Uint8Array, mode: number): void {
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);

  try {
    try {
      writeFileSync(fd, content);
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    unlinkSync(filePath);
    throw cause;
  }
}

/** Create a private file without replacing an existing entry. The parent must exist. */
export function writePrivateFile0600(filePath: string, content: string | Uint8Array): void {
  writeExclusiveFile(filePath, content, 0o600);
}

/**
 * Create missing directories with private permissions and set the target to mode 0700.
 * The path must not contain parent components.
 */
export function ensureDir0700(dirPath: string): void {
  assertNoParentComponents(dirPath);
  const target = resolve(dirPath);
  mkdirSync(target, { recursive: true, mode: 0o700 });

  if (!lstatSync(target).isDirectory()) {
    throw new Error(`Expected a directory: ${dirPath}`);
  }

  chmodSync(target, 0o700);
}

/**
 * Replace a file atomically in an existing parent directory.
 * The path must not contain parent components.
 */
export function atomicWriteFile(filePath: string, content: string | Uint8Array, mode = 0o600): void {
  assertNoParentComponents(filePath);
  const tempPath = join(dirname(filePath), `.atomic-${randomUUID()}.tmp`);
  writeExclusiveFile(tempPath, content, mode);

  try {
    renameSync(tempPath, filePath);
  } catch (cause) {
    unlinkSync(tempPath);
    throw cause;
  }
}

/**
 * Check existing entries from stopAt (or the root) through targetPath, inclusive.
 * This check does not prevent concurrent changes to the path.
 */
export function assertNoSymlinkBoundary(targetPath: string, stopAt?: string): void {
  assertNoParentComponents(targetPath);

  if (stopAt !== undefined) {
    assertNoParentComponents(stopAt);
  }

  const target = resolve(targetPath);
  const boundary = stopAt === undefined ? parse(target).root : resolve(stopAt);
  const components = [target];
  let current = target;

  while (current !== boundary) {
    const parent = dirname(current);

    if (parent === current) {
      throw new Error(`Symlink boundary ${boundary} is not an ancestor of ${target}.`);
    }

    components.push(parent);
    current = parent;
  }

  for (const component of components.reverse()) {
    if (lstatSync(component).isSymbolicLink()) {
      throw new Error(`Unexpected symlink at ${component}.`);
    }
  }
}

function assertNoParentComponents(path: string): void {
  if (path.split(sep).includes("..")) {
    throw new Error(`Path must not contain parent components: ${path}`);
  }
}
