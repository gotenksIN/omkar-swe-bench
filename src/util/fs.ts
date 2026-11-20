import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import nodePath from "node:path";

const writeExclusiveFile = (
  filePath: string,
  content: string | Uint8Array,
  mode: number
): void => {
  const fd = openSync(filePath, "wx", 0o600);

  try {
    try {
      writeFileSync(fd, content);
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    unlinkSync(filePath);
    throw error;
  }
};

/** Create a private file without replacing an existing entry. The parent must exist. */
export const writePrivateFile0600 = (
  filePath: string,
  content: string | Uint8Array
): void => {
  writeExclusiveFile(filePath, content, 0o600);
};

/**
 * Create missing directories with private permissions and set the target to mode 0700.
 * The path must not contain parent components.
 */
export const ensureDir0700 = (dirPath: string): void => {
  assertNoParentComponents(dirPath);
  const target = nodePath.resolve(dirPath);
  mkdirSync(target, { recursive: true, mode: 0o700 });

  if (!lstatSync(target).isDirectory()) {
    throw new Error(`Expected a directory: ${dirPath}`);
  }

  chmodSync(target, 0o700);
};

/**
 * Replace a file atomically in an existing parent directory.
 * The path must not contain parent components.
 */
export const atomicWriteFile = (
  filePath: string,
  content: string | Uint8Array,
  mode = 0o600
): void => {
  assertNoParentComponents(filePath);

  const tempPath = nodePath.join(
    nodePath.dirname(filePath),
    `.atomic-${randomUUID()}.tmp`
  );

  writeExclusiveFile(tempPath, content, mode);

  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    unlinkSync(tempPath);
    throw error;
  }
};

/**
 * Check existing entries from stopAt (or the root) through targetPath, inclusive.
 * This check does not prevent concurrent changes to the path.
 */
export const assertNoSymlinkBoundary = (
  targetPath: string,
  stopAt?: string
): void => {
  assertNoParentComponents(targetPath);

  if (stopAt !== undefined) {
    assertNoParentComponents(stopAt);
  }

  const target = nodePath.resolve(targetPath);

  const boundary =
    stopAt === undefined
      ? nodePath.parse(target).root
      : nodePath.resolve(stopAt);

  const components = [target];
  let current = target;

  while (current !== boundary) {
    const parent = nodePath.dirname(current);

    if (parent === current) {
      throw new Error(
        `Symlink boundary ${boundary} is not an ancestor of ${target}.`
      );
    }

    components.push(parent);
    current = parent;
  }

  for (const component of components.toReversed()) {
    if (lstatSync(component).isSymbolicLink()) {
      throw new Error(`Unexpected symlink at ${component}.`);
    }
  }
};

const assertNoParentComponents = (path: string): void => {
  if (path.split(nodePath.sep).includes("..")) {
    throw new Error(`Path must not contain parent components: ${path}`);
  }
};
