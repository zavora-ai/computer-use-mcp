// v8-01: freeze the complete v7 MCP tool wire surface before refactoring.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { TOOL_CATALOG } from '../dist/tool-catalog.js'

const V7_TOOL_COUNT = 64
const V7_FULL_PROFILE_WIRE_SHA256 = 'ca98488ed02cd64bb02ee372db9df1984bb73165fd4637a83233ef446c979f0f'

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

async function advertisedTools() {
  const server = createComputerUseServer({
    // Listing tools must not touch the native desktop runtime.
    session: { async dispatch() { throw new Error('wire baseline must not dispatch') } },
    profile: 'full',
    structuredContent: true,
    legacyFocusTag: false,
  })
  const client = await connectInProcess(server)
  try {
    return await client.listTools()
  } finally {
    await client.close()
  }
}

test('v7 full-profile MCP wire surface remains byte-for-byte canonical', async () => {
  const tools = (await advertisedTools())
    .map(canonicalize)
    .sort((a, b) => a.name.localeCompare(b.name))

  assert.equal(tools.length, V7_TOOL_COUNT)
  const canonicalJson = JSON.stringify(tools)
  const digest = crypto.createHash('sha256').update(canonicalJson).digest('hex')
  assert.equal(
    digest,
    V7_FULL_PROFILE_WIRE_SHA256,
    'advertised descriptions, schemas, annotations, output schemas, or _meta changed; review the canonical wire diff and update this digest only for an intentional documented migration',
  )
})

test('catalog and advertised full-profile tool names have exact parity', async () => {
  const advertised = (await advertisedTools()).map(tool => tool.name).sort()
  const catalog = Object.keys(TOOL_CATALOG).sort()
  assert.deepEqual(advertised, catalog)
})
