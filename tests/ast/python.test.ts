import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  checkPythonDividePagesMinimal,
  checkPythonHasTestMethods,
  checkPythonImportDag,
  checkPythonNoTestMonkeypatches,
} from "../../src/ast/python.ts";

let repo: string;

beforeEach(() => {
  mkdirSync("/tmp/opencode", { recursive: true });
  repo = mkdtempSync("/tmp/opencode/python-ast-");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function write(path: string, source: string): string {
  const file = join(repo, path);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);

  return file;
}

test("checks ranked absolute and relative Python imports", async () => {
  write("modules/__init__.py", "import os\n");
  write("modules/core.py", "from modules import CACHE\n");
  write("modules/media.py", "from .core import cache\n");
  write("modules/sub/pipeline.py", "from .. import media\nimport modules.core as core\n");

  const order = ["modules/__init__.py", "modules/core.py", "modules/media.py", "modules/sub/pipeline.py"];

  expect(await checkPythonImportDag(repo, order)).toBe(true);

  write("modules/core.py", "from . import media as later\n");
  expect(await checkPythonImportDag(repo, order)).toBe(false);

  write("modules/core.py", "import modules.core\n");
  expect(await checkPythonImportDag(repo, order)).toBe(false);

  write("modules/core.py", "from modules.sub import pipeline\n");
  expect(await checkPythonImportDag(repo, order)).toBe(false);
});

test("rejects missing and invalid Python modules", async () => {
  expect(await checkPythonImportDag(repo, ["missing.py"])).toBe(false);
  write("core.py", "invalid:\n");
  expect(await checkPythonImportDag(repo, ["core.py"])).toBe(false);
});

test("checks dot-only imports against the containing package rank", async () => {
  write("pkg/early.py", "from . import CONSTANT\n");
  write("pkg/__init__.py", "CONSTANT = 1\n");

  expect(await checkPythonImportDag(repo, ["pkg/early.py", "pkg/__init__.py"])).toBe(false);
  expect(await checkPythonImportDag(repo, ["pkg/__init__.py", "pkg/early.py"])).toBe(true);
});

test("requires every Python test file to contain a top-level test or class method", async () => {
  write("test_async.py", "async def test_top(): pass\n");
  write("test_class.py", "class Tests:\n    async def test_method(self): pass\n");
  write("test_nested.py", "def helper():\n    def test_hidden(): pass\n");
  write("test_invalid.py", "def test_invalid(: pass\n");

  expect(await checkPythonHasTestMethods(repo, ["test_async.py", "test_class.py"])).toBe(true);
  expect(await checkPythonHasTestMethods(repo, ["test_async.py", "test_nested.py"])).toBe(false);
  expect(await checkPythonHasTestMethods(repo, ["test_class.py", "test_missing.py"])).toBe(false);
  expect(await checkPythonHasTestMethods(repo, ["test_invalid.py"])).toBe(false);
  expect(await checkPythonNoTestMonkeypatches(repo, ["test_nested.py"])).toBe(false);
});

test("permits stdlib fault injection outside strict mode", async () => {
  write("test_spies.py", `
import os
from unittest.mock import patch as spy
def test_io():
    with spy("os.fsync", side_effect=OSError), spy.object(os, "close"):
        pass
    setattr(os, "fsync", None)
`);

  expect(await checkPythonNoTestMonkeypatches(repo, ["test_spies.py"], { projectModules: ["project"] })).toBe(true);
  expect(await checkPythonNoTestMonkeypatches(repo, ["test_spies.py"], { prohibitStdlibPatches: true })).toBe(false);
});

test.each([
  "def test_behavior(monkeypatch): pass\n",
  "def test_behavior(): return helper.monkeypatch\n",
  "from unittest.mock import patch as spy\ndef test_behavior(): spy(target)\n",
  "import unittest as u\ndef test_behavior(): u.mock.patch(target='project.run')\n",
  "import project as p\nfrom unittest.mock import patch as spy\ndef test_behavior(): spy.object(p, 'run')\n",
  "from project import core as c\ndef test_behavior(): setattr(c, 'run', None)\n",
  "import project.core\ndef test_behavior(): delattr(project.core, 'run')\n",
  "from project import core as c\ndef test_behavior(): c.config.run += 1\n",
  "from . import core\ndef test_behavior(): del core.run\n",
])("rejects project patch patterns: %j", async (source) => {
  write("project/test_behavior.py", source);
  expect(await checkPythonNoTestMonkeypatches(repo, ["project/test_behavior.py"], { projectModules: ["project.core", "project"] }))
    .toBe(false);
});

test.each([
  "def test_behavior(): return patch\n",
  "from helpers import setattr as set_value\ndef test_behavior(): pass\n",
  "import os as lib\ndef test_behavior(): lib.fsync = None\n",
  "def test_behavior(): return helper.delattr\n",
])("rejects patch references and imported attribute writes in strict mode: %j", async (source) => {
  write("test_behavior.py", source);
  expect(await checkPythonNoTestMonkeypatches(repo, ["test_behavior.py"], { prohibitStdlibPatches: true })).toBe(false);
});

test("allows strict tests with local attribute writes and no patch references", async () => {
  write("test_clean.py", "import os\nclass Tests:\n    def test_ok(self): self.value = os.getcwd()\n");
  expect(await checkPythonNoTestMonkeypatches(repo, ["test_clean.py"], { prohibitStdlibPatches: true })).toBe(true);
});

test("resolves patch targets against the test's own import bindings", async () => {
  write("test_scoped.py", `
from unittest.mock import patch
def test_one():
    import project as target
    assert target.value
def test_two():
    import os as target
    with patch.object(target, "fsync"):
        pass
`);
  write("test_shadowed.py", `
import os as target
def test_one(target):
    target.fsync = None
def test_two():
    target = make_local()
    target.fsync = None
`);

  expect(await checkPythonNoTestMonkeypatches(repo, ["test_scoped.py"], { projectModules: ["project"] })).toBe(true);
  expect(await checkPythonNoTestMonkeypatches(repo, ["test_shadowed.py"], { prohibitStdlibPatches: true })).toBe(true);
});

test("requires a minimal _divide_pages definition", async () => {
  expect(await checkPythonDividePagesMinimal(write("cli.py", "def _divide_pages(p, n): return p // n\n"))).toBe(true);
  expect(await checkPythonDividePagesMinimal(write("cli.py", "def divide_pages(p, n): return p // n\n"))).toBe(false);
  expect(await checkPythonDividePagesMinimal(join(repo, "missing.py"))).toBe(false);
});

test.each([
  "if n: return p // n",
  "return p // n if n else 0",
  "try: return p // n\n    except ValueError: return 0",
  "return p // max(1, n)",
  "raise builtins.ZeroDivisionError",
])("rejects non-minimal division: %j", async (body) => {
  expect(await checkPythonDividePagesMinimal(write("cli.py", `def _divide_pages(p, n):\n    ${body}\n`))).toBe(false);
});
