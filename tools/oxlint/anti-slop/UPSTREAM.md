# Anti-slop provenance

The `install-anti-slop` skill installer copied `assets/anti-slop/` from the local skill at `/home/gotenks/.agents/skills/install-anti-slop` into this directory.
The original repository and source commit are unknown because the installed skill does not include Git metadata or a source revision.
The first commit adding this directory contains the pristine installer snapshot, apart from this provenance file.
The SHA-256 digest of the snapshot's sorted file checksums is `24f771967ed0c6595fcac4adb93086b4996ccb06a570146f059e720bbf807acf`.
To reproduce it, exclude this root `UPSTREAM.md` and run the following command from this directory:

```sh
find . -type f ! -path './UPSTREAM.md' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum
```

No copied files have local modifications.
The harness loads `index.ts`; the copied `effect/index.ts` is not registered.
See [the Stylistic provenance](vendor/eslint-stylistic/UPSTREAM.md) for the upstream spacing rule and its adaptations.
Keep the [Stylistic license](vendor/eslint-stylistic/LICENSE) with the copied rule.
