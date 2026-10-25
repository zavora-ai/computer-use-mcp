# Native package releases

The main `@zavora-ai/computer-use-mcp` package declares six native packages as
optional dependencies, pinned to exactly its own version. Each native package
contains its manifest, MIT license and one `.node` binary, with no install script
or runtime dependencies. Its `os` and `cpu` fields let npm select the host target.

| npm package suffix | Rust target | Cargo release artifact |
| --- | --- | --- |
| `darwin-arm64` | `aarch64-apple-darwin` | `libcomputer_use_napi.dylib` |
| `darwin-x64` | `x86_64-apple-darwin` | `libcomputer_use_napi.dylib` |
| `win32-x64` | `x86_64-pc-windows-msvc` | `computer_use_napi.dll` |
| `win32-arm64` | `aarch64-pc-windows-msvc` | `computer_use_napi.dll` |
| `linux-x64` | `x86_64-unknown-linux-gnu` | `libcomputer_use_napi.so` |
| `linux-arm64` | `aarch64-unknown-linux-gnu` | `libcomputer_use_napi.so` |

`build-native` compiles the existing Rust N-API 9 cdylib with
`cargo build --release --target <target>` and copies
`native/target/<target>/release/<artifact>` to
`computer-use-napi.<platform>-<arch>.node` at the repository root.
Linux builds use the existing GNU/X11 targets; these names do not promise musl
compatibility or add a new platform ABI.

## Compatibility and bundlers

The resolution order remains:

1. An existing file at `COMPUTER_USE_NATIVE_PATH`.
2. `@zavora-ai/computer-use-mcp-<platform>-<arch>/computer-use-napi.<platform>-<arch>.node`.
3. `computer-use-napi.<platform>-<arch>.node` in the package root: a source checkout's build.
4. The generic `computer-use-napi.node` in the package root, also a checkout's build.

Since 7.7.0 the main package is thin, the way Claude Code, Codex and esbuild ship: it carries no binary of its own
(2.5 MB unpacked, against 10.8 MB for 7.6.1 with all six binaries). npm installs only the platform package whose `os`
and `cpu` match the machine and skips the other five without downloading them. An install with `--omit=optional`, a
registry or mirror that lacks the platform package, or a lockfile made on another OS that left it out, installs
without error but gets no addon: the launcher then exits 2 naming
`@zavora-ai/computer-use-mcp-<platform>-<arch>` and the fix, and loading reports the same. An explicit native path
retains its existing behavior. Bundlers can keep the matching native package external and ship its `.node` file
separately, or use the path override when staging a binary.

## Source checkout validation

Source development and CI select the freshly built root binary with a
process-scoped `COMPUTER_USE_NATIVE_PATH`; installing platform packages does not
change this explicit choice. `node scripts/verify-local-native.mjs` requires a
nonempty artifact matching this Node platform/architecture, checks the real
resolved path, and actually loads its native exports. A missing override target
must not make source validation pass through an installed optional package.
See [the contributing guide](../CONTRIBUTING.md#using-the-checkout-native-build)
for shell examples that leave the user's persistent environment unchanged.

CI keeps normal dependency installation, including the Playwright types required
by TypeScript. Source validation, the full suite and each smoke step explicitly
set the path to the downloaded build artifact. Validation and smoke steps run the
verifier before their existing checks. Missing-addon fixtures temporarily clear
and restore the override within their own test process. The consumer installation
step has no source override and clears any inherited override in
its disposable child environment. It proves that a normal npm install downloads and loads only the matching platform
package, that the main package carries no binary, and that an omitted or unavailable
platform package is reported with the fix.

## Versioning and packing

Use `npm version <version> --no-git-tag-version` to update the root version and
run the version hook. The hook invokes `prepare:packages -- --sync-only`, which
updates all six manifests, root optional dependency pins and native lockfile
entries. Commit those files together. `npm run prepare:packages -- --sync-only`
also synchronizes a version edited by hand, without requiring native artifacts.

Before the package names exist on npm, `npm install --package-lock-only` drops
them from the lockfile. Run the synchronization command after regenerating the
lockfile: it records the version, public tarball URL, license, `os`, `cpu` and
optional status from the local manifests. It does not fabricate an integrity
hash for an unpublished version, and preserves registry integrity for unchanged
versions. This lets `npm ci` omit unavailable optional packages without rejecting
an incomplete lockfile.

`npm run prepare:packages` copies available root binaries and the license into
the corresponding packages. It removes stale package binaries when the matching
root artifact is missing. `npm run pack:platforms` requires all six nonempty root
artifacts, validates all manifests before preparing any package, packs each with
`--ignore-scripts`, and verifies that each tarball contains exactly its manifest,
license and native addon. It writes the tarballs and their name/version/integrity
inventory to `release/platform/`. Binaries and generated licenses are ignored by
Git.

## CI and staged publishing

The existing `.github/workflows/ci.yml` release flow gains a `platform-packages`
job after `build-native`. It packs all six targets and uploads the tarballs as
`native-platform-packages`. The existing macOS arm64, Windows x64/arm64 and Linux
x64/arm64 test jobs install these exact tarballs through a temporary local
registry and load the addon through the main package. The test checks automatic
host selection, override precedence, a source checkout with an already installed
platform package, that the main package carries no binary, and the named fix when the
platform package is omitted or unavailable. Metadata and
contents are checked for all six targets, including cross-compiled macOS x64.

After all existing release gates pass, the upstream main-push release job:

1. Downloads the tested native tarballs and all six root binaries.
2. Packs the main package and verifies that it carries no binary and pins all six native packages at its version.
3. Attests the six binaries and all seven tarballs; retains the main SBOM
   attestation and uploads immutable release evidence.
4. Validates every native tarball's integrity, then asks npm whether the main
   version is already published. When it is, the push is not a release and nothing
   is staged (7.7.0). Otherwise it checks each native version: an identical
   published version is skipped; a published version whose bytes differ from this
   build (Windows binaries are not reproducible build to build) is skipped with a
   warning, since published versions are immutable; a registry error fails the
   release before any new native package is staged.
5. Stages all six native packages with `npm stage publish --access public
   --provenance`, then stages the main tarball with the existing approval flow.

Only this upstream repository can stage releases; fork and PR workflows only
build and test. A version that is already staged and awaiting approval (E409,
"Cannot stage previously published version") is reported with a warning and not
staged again, for the native packages and the main package alike: staging again
cannot replace a pending tarball, and the review happens at approval. Any other
failed staging request fails the release, and the error names the package and
version, commit, tarball and integrity. A native staging failure prevents the main
staging step. Already staged packages are not rolled back automatically;
publication is not atomic across seven packages, which is also why a push to main
never cancels the run before it. Use a maintainer session to inspect pending
tarballs against the original run's immutable release evidence. Reuse those exact
tarballs when recovering the same release; rebuilding the same commit need not
reproduce the same bytes. Changed contents require a new synchronized version. CI
does not add credentials for inspecting, approving or rejecting pending packages.
Review the matching release evidence, approve all six native packages first,
then approve the main package. Neither the workflow nor the scripts approve
packages automatically. Existing published main versions remain immutable;
a version bump is required for the new optional dependency declaration to reach
users of the main package.

## First release of new package names

npm supports creating new names through staged publishing, but trusted
publishing must be configured separately for each name after its creation.
See [npm's new-package announcement](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages/)
and [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

For the first release, a maintainer provides the temporary repository secret
`NPM_NATIVE_STAGE_TOKEN`, because trusted publishing cannot create a package name. Without it the native staging step
stops before anything is staged and says so (before 7.7.0, npm answered only `ENEEDAUTH`). The steps:

1. On npmjs.com, create a granular access token with the permission **Read and write (stage only)**, selected for
   the `@zavora-ai` scope, with the shortest expiry that covers the release (1 to 7 days) and without bypassing 2FA.
   A stage-only token can stage but never publish directly. Add it as the repository secret `NPM_NATIVE_STAGE_TOKEN`.
2. Push or re-run the release on `main`. The native step stages the six tarballs with the token, provenance and
   `--access public`; the main package stages through its existing OIDC configuration. npm creates each new name with
   a public placeholder and keeps the real version pending until approval.
3. Compare the pending tarballs with the run's `release-evidence-<sha>` artifact (`npm stage list`,
   `npm stage download <id>`), then approve the six native packages first and the main package last, each with 2FA
   (`npm stage approve <id>` or the Staged Packages tab on npmjs.com).
4. Configure trusted publishing for the six new names at once (one 2FA prompt), and confirm with `npm trust list`:

   ```sh
   for t in darwin-arm64 darwin-x64 win32-x64 win32-arm64 linux-x64 linux-arm64; do
     npm trust github "@zavora-ai/computer-use-mcp-$t" --file ci.yml --repo zavora-ai/computer-use-mcp --allow-stage-publish -y
   done
   ```

5. Delete the secret and revoke the token. Later runs stage all seven packages through OIDC with `id-token: write`
   and no npm write token. npm expires a trusted-publisher configuration that has not completed a release within 48
   hours of being created, so stage the next release soon or recreate the configuration.

npm's required CLI version is 11.15.0 or later, with Node 22.14.0 or later; the release job uses Node 24. Sources:
[staged publishing](https://docs.npmjs.com/staged-publishing),
[stage-only tokens](https://github.blog/changelog/2026-09-18-stage-only-npm-tokens-for-safer-automation),
[unvalidated configurations expire](https://github.blog/changelog/2026-10-02-unvalidated-npm-trusted-publishing-configurations-now-expire).
