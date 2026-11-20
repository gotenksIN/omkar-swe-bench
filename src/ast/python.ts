import { parseJsonText } from "../util/json.ts";

export interface MonkeypatchCheckOptions {
  readonly projectModules?: readonly string[];
  readonly prohibitStdlibPatches?: boolean;
}

const PYTHON_AST_DRIVER = String.raw`
import ast
import json
from pathlib import Path
import sys


def parse_file(path):
    return ast.parse(path.read_bytes(), filename=str(path))


def module_name(path):
    parts = Path(path).with_suffix("").parts
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


def qualified(prefix, name):
    return f"{prefix}.{name}" if prefix else name


def from_module(node, path):
    base = node.module or ""
    if not node.level:
        return base
    module = module_name(path)
    package = module if Path(path).name == "__init__.py" else module.rpartition(".")[0]
    parts = package.split(".") if package else []
    if node.level > len(parts):
        return None
    prefix = ".".join(parts[:len(parts) - node.level + 1])
    return qualified(prefix, base) if base else prefix


def import_targets(tree, path):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield from (alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = from_module(node, path)
            if base is None:
                continue
            if base:
                yield base
            for alias in node.names:
                if alias.name != "*":
                    yield qualified(base, alias.name)


def import_dag(repo, paths):
    ranks = {module_name(path): rank for rank, path in enumerate(paths)}
    for rank, path in enumerate(paths):
        for target in import_targets(parse_file(repo / path), path):
            if ranks.get(target, -1) >= rank:
                return False
    return True


def has_tests(tree):
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
            return True
        if isinstance(node, ast.ClassDef) and has_tests(node):
            return True
    return False


class PatchScope:
    def __init__(self, parent=None):
        self.parent = parent
        self.bindings = {}

    def lookup(self, name):
        scope = self
        while scope is not None:
            if name in scope.bindings:
                return scope.bindings[name]
            scope = scope.parent
        return ()


def patch_nodes(tree, path):
    nodes = []

    def visit(node, scope, outer):
        nodes.append((node, scope))
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            if not isinstance(node, ast.Lambda):
                scope.bindings.setdefault(node.name, set())
            child_scope = PatchScope(outer)
            if isinstance(node, ast.ClassDef):
                body_scope = outer
            else:
                body_scope = child_scope
                for arg in ast.walk(node.args):
                    if isinstance(arg, ast.arg):
                        child_scope.bindings.setdefault(arg.arg, set())
            body = node.body if isinstance(node.body, list) else [node.body]
            for field, value in ast.iter_fields(node):
                if field == "body":
                    continue
                for item in value if isinstance(value, list) else [value]:
                    if isinstance(item, ast.AST):
                        visit(item, scope, outer)
            for item in body:
                visit(item, child_scope, body_scope)
            return
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.asname or alias.name.split(".")[0]
                scope.bindings.setdefault(root, set()).add(alias.name if alias.asname else root)
        elif isinstance(node, ast.ImportFrom):
            base = from_module(node, path)
            for alias in node.names:
                prefix = "." * node.level
                relative = qualified(node.module, alias.name)
                names = scope.bindings.setdefault(alias.asname or alias.name, set())
                names.add(prefix + relative)
                if base is not None:
                    names.add(qualified(base, alias.name))
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            scope.bindings.setdefault(node.id, set())
        for item in ast.iter_child_nodes(node):
            visit(item, scope, outer)

    module = PatchScope()
    visit(tree, module, module)
    return nodes


def root_and_suffix(node):
    attrs = []
    while isinstance(node, (ast.Attribute, ast.Subscript)):
        if isinstance(node, ast.Attribute):
            attrs.append(node.attr)
        node = node.value
    return (node.id if isinstance(node, ast.Name) else None, list(reversed(attrs)))


def matches_module(name, modules):
    return any(name == module or name.startswith(module + ".") for module in modules)


def reference_names(node):
    if isinstance(node, ast.Name):
        return (node.id,)
    if isinstance(node, ast.Attribute):
        return (node.attr,)
    if isinstance(node, ast.alias):
        return (*node.name.split("."), node.asname)
    if isinstance(node, ast.arg):
        return (node.arg,)
    return ()


def first_argument(call, keyword):
    if call.args:
        return call.args[0]
    return next((item.value for item in call.keywords if item.arg == keyword), None)


def no_patches(tree, path, modules, strict):
    prohibited = {"monkeypatch", "patch", "setattr", "delattr"} if strict else {"monkeypatch"}

    def targets_project(node, scope):
        root, attrs = root_and_suffix(node)
        return any(
            matches_module(".".join([name, *attrs]), modules)
            for name in scope.lookup(root)
        )

    for node, scope in patch_nodes(tree, path):
        if prohibited.intersection(reference_names(node)):
            return False
        if isinstance(node, ast.Attribute) and isinstance(node.ctx, (ast.Store, ast.Del)):
            root, _ = root_and_suffix(node)
            if (strict and scope.lookup(root)) or targets_project(node, scope):
                return False
        if strict or not isinstance(node, ast.Call):
            continue
        root, attrs = root_and_suffix(node.func)
        calls = {".".join([name, *attrs]) for name in scope.lookup(root)}
        if root:
            calls.add(".".join([root, *attrs]))
        if any(name == "patch" or name.endswith(".patch") for name in calls):
            target = first_argument(node, "target")
            if not isinstance(target, ast.Constant) or not isinstance(target.value, str):
                return False
            if matches_module(target.value, modules):
                return False
        elif any(
            name.rsplit(".", 1)[-1] in {"setattr", "delattr"} or
            name == "patch.object" or name.endswith(".patch.object")
            for name in calls
        ):
            target = first_argument(node, "target")
            if targets_project(target, scope):
                return False
    return True


def divide_pages_minimal(path):
    funcs = [
        node for node in ast.walk(parse_file(path))
        if isinstance(node, ast.FunctionDef) and node.name == "_divide_pages"
    ]
    return bool(funcs) and all(
        not isinstance(node, (ast.If, ast.IfExp, ast.Try))
        and "ZeroDivisionError" not in reference_names(node)
        and not (isinstance(node, ast.Call) and "max" in reference_names(node.func))
        for func in funcs for node in ast.walk(func)
    )


def check(request):
    kind = request["kind"]
    if kind == "divide":
        return divide_pages_minimal(Path(request["path"]))
    repo = Path(request["repoDir"])
    paths = request["paths"]
    if kind == "imports":
        return import_dag(repo, paths)
    for path in paths:
        tree = parse_file(repo / path)
        if not has_tests(tree):
            return False
        if kind == "patches" and not no_patches(tree, path, request["modules"], request["strict"]):
            return False
    return True


try:
    passed = check(json.loads(sys.argv[1]))
except (SyntaxError, OSError, ValueError, RecursionError):
    passed = False
print(json.dumps(passed))
`;

type PythonAstRequest =
  | {
      readonly kind: "imports" | "tests";
      readonly repoDir: string;
      readonly paths: readonly string[];
    }
  | { readonly kind: "divide"; readonly path: string }
  | {
      readonly kind: "patches";
      readonly repoDir: string;
      readonly paths: readonly string[];
      readonly modules: readonly string[];
      readonly strict: boolean;
    };

const runPythonAst = async (request: PythonAstRequest): Promise<boolean> => {
  const child = Bun.spawn(["python3", "-I", "-", JSON.stringify(request)], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    stdin: new TextEncoder().encode(PYTHON_AST_DRIVER),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 15_000);

  try {
    const [exitCode, reply] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    return exitCode === 0 && parseJsonText(reply) === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

export const checkPythonImportDag = async (
  repoDir: string,
  moduleOrder: readonly string[]
): Promise<boolean> =>
  await runPythonAst({ kind: "imports", repoDir, paths: moduleOrder });

export const checkPythonHasTestMethods = async (
  repoDir: string,
  testFiles: readonly string[]
): Promise<boolean> =>
  await runPythonAst({ kind: "tests", repoDir, paths: testFiles });

export const checkPythonNoTestMonkeypatches = async (
  repoDir: string,
  testFiles: readonly string[],
  options?: MonkeypatchCheckOptions
): Promise<boolean> =>
  await runPythonAst({
    kind: "patches",
    repoDir,
    paths: testFiles,
    modules: options?.projectModules ?? [],
    strict: options?.prohibitStdlibPatches === true,
  });

export const checkPythonDividePagesMinimal = async (
  cliFilePath: string
): Promise<boolean> =>
  await runPythonAst({ kind: "divide", path: cliFilePath });
