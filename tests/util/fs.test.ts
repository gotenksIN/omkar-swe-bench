import { expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import nodePath from "node:path";

import {
  assertNoSymlinkBoundary,
  atomicWriteFile,
  ensureDir0700,
  writePrivateFile0600,
} from "../../src/util/fs.ts";

const withTempDir = (check: (dir: string) => void): void => {
  mkdirSync("/tmp/opencode", { recursive: true });
  const dir = mkdtempSync("/tmp/opencode/omkar-fs-test-");

  try {
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("creates private files without overwriting files or symlinks", () => {
  withTempDir((dir) => {
    const file = nodePath.join(dir, "private");
    const link = nodePath.join(dir, "link");
    writePrivateFile0600(file, new Uint8Array([42]));
    symlinkSync(file, link);

    expect(lstatSync(file).mode % 0o1000).toBe(0o600);
    expect(() => {
      writePrivateFile0600(file, "other");
    }).toThrow(/EEXIST/u);
    expect(() => {
      writePrivateFile0600(link, "other");
    }).toThrow(/EEXIST/u);
    expect(readFileSync(file, "utf-8")).toBe("*");
  });
});

test("creates nested private directories and tightens an existing target", () => {
  withTempDir((dir) => {
    const parent = nodePath.join(dir, "parent");
    const child = nodePath.join(parent, "child");
    ensureDir0700(child);
    chmodSync(child, 0o755);
    ensureDir0700(child);

    expect(lstatSync(parent).mode % 0o1000).toBe(0o700);
    expect(lstatSync(child).mode % 0o1000).toBe(0o700);
  });
});

test("replaces a file with the requested mode and removes temporary files on failure", () => {
  withTempDir((dir) => {
    const file = nodePath.join(dir, "file");
    const directory = nodePath.join(dir, "directory");
    atomicWriteFile(file, "old");
    expect(lstatSync(file).mode % 0o1000).toBe(0o600);
    atomicWriteFile(file, "new", 0o640);
    ensureDir0700(directory);

    expect(() => {
      atomicWriteFile(directory, "not a directory");
    }).toThrow();
    expect(readFileSync(file, "utf-8")).toBe("new");
    expect(lstatSync(file).mode % 0o1000).toBe(0o640);
    expect(readdirSync(dir).toSorted()).toEqual(["directory", "file"]);
  });
});

test("checks the full path below and including the boundary", () => {
  withTempDir((dir) => {
    const real = nodePath.join(dir, "real");
    const link = nodePath.join(dir, "link");
    const file = nodePath.join(real, "file");
    ensureDir0700(real);
    writePrivateFile0600(file, "contents");
    symlinkSync(real, link);

    expect(() => {
      assertNoSymlinkBoundary(file, dir);
    }).not.toThrow();
    expect(() => {
      assertNoSymlinkBoundary(nodePath.join(link, "file"), dir);
    }).toThrow(/Unexpected symlink/u);
    expect(() => {
      assertNoSymlinkBoundary(link, link);
    }).toThrow(/Unexpected symlink/u);
    expect(() => {
      assertNoSymlinkBoundary(link);
    }).toThrow(/Unexpected symlink/u);
    expect(() => {
      assertNoSymlinkBoundary(file, link);
    }).toThrow(/not an ancestor/u);
    expect(() => {
      assertNoSymlinkBoundary(`${link}/../real`, dir);
    }).toThrow(/parent components/u);
    expect(() => {
      assertNoSymlinkBoundary(nodePath.join(real, "missing"), dir);
    }).toThrow(/ENOENT/u);
  });
});

test("rejects parent components before modifying the filesystem", () => {
  withTempDir((dir) => {
    const real = nodePath.join(dir, "real");
    const link = nodePath.join(dir, "link");
    ensureDir0700(nodePath.join(real, "child"));
    symlinkSync(nodePath.join(real, "child"), link);

    expect(() => {
      ensureDir0700(`${link}/../private`);
    }).toThrow(/parent components/u);
    expect(() => {
      atomicWriteFile(`${link}/../file`, "");
    }).toThrow(/parent components/u);
    expect(readdirSync(dir).toSorted()).toEqual(["link", "real"]);
    expect(readdirSync(real)).toEqual(["child"]);
  });
});
