# Examples

Runnable demos showing how to use `@zavora-ai/computer-use-mcp` in-process.

| Example | Description |
|---|---|
| `demo.ts` | Calculator: open, compute 42+58, screenshot, clipboard round-trip |
| `demo-v4.ts` | Window-aware: TextEdit + Safari side-by-side, window targeting, focus recovery |
| `browser-test.ts` | Safari: navigate, copy page text, multi-tab screenshots |
| `crypto-numbers.ts` | Fetch crypto prices from CoinGecko, paste into Numbers spreadsheet |

## Running

```bash
npx tsx examples/demo.ts
```

All examples use the in-process client (`connectInProcess`) — no separate server process needed.
