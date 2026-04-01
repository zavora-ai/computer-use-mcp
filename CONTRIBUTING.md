# Contributing to computer-use-mcp

Thank you for your interest in contributing!

## Getting started

```bash
git clone https://github.com/zavora-ai/computer-use-mcp
cd computer-use-mcp
npm install
npm run build
npm run demo  # verify everything works
```

## Project structure

```
src/           TypeScript source (server, session, client, native loader)
native/src/    Rust NAPI module (mouse, keyboard, apps, display, screenshot)
dist/          Compiled TypeScript output (generated, not committed)
```

## Making changes

### TypeScript changes
Edit files in `src/`, then:
```bash
npm run build:ts
npm run demo
```

### Rust changes
Edit files in `native/src/`, then:
```bash
npm run build:native
npm run demo
```

### Full rebuild
```bash
npm run build
```

## Code standards

- **Rust**: run `cargo fmt` and `cargo clippy` before committing — both must be clean
- **TypeScript**: `strict: true` is enforced — no `any` except where unavoidable
- All tool inputs must be validated in `session.ts` before reaching native code
- New tools must be registered in `server.ts`, dispatched in `session.ts`, and typed in `client.ts`

## Testing

There is no automated test suite. Verify changes manually:

```bash
npm run demo          # Calculator: open, compute 42+58, clipboard, close
npx tsx src/browser-test.ts  # Safari: navigate to example.com and github.com
```

Both must pass cleanly before submitting a PR.

## Pull requests

- Keep PRs focused — one feature or fix per PR
- Update the README if you add or change a tool
- Bump the version in `package.json` following semver if you change public API

## Reporting bugs

Open a GitHub issue with:
1. macOS version (`sw_vers`)
2. Node.js version (`node --version`)
3. The exact error message
4. Steps to reproduce

## License

By contributing, you agree your contributions will be licensed under the MIT License.
