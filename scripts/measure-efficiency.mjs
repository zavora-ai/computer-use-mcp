/** Deterministic payload measurements, not billed token estimates. No desktop/API access. */
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { createToolDiscovery, compactAccessibilityTree, toModelContent } from '../dist/efficiency.js'

const chars = value => JSON.stringify(value).length
const profiles = []
for (const profile of ['core', 'scripting', 'ax', 'full']) {
  const client = await connectInProcess(createComputerUseServer({ profile, session: {
    dispatch: async () => { throw new Error('Measurement must never operate the desktop') },
  } }))
  try {
    const catalog = await client.listTools()
    const selected = await createToolDiscovery(client).search('screenshot')
    profiles.push({ profile, tools: catalog.length, catalogChars: chars(catalog),
      selectedTools: selected.length, selectedChars: chars(selected) })
  } finally { await client.close() }
}
const tree = { role: 'AXWindow', label: 'Fixture', children: Array.from({ length: 100 }, (_, i) => ({
  role: 'AXButton', label: `Action ${i}`, value: null, description: '', enabled: true,
  focused: false, selected: false, children: [], actions: ['AXPress'],
})) }
const compact = compactAccessibilityTree(tree)
const result = { content: [{ type: 'text', text: JSON.stringify(tree) }], structuredContent: tree }
const image = { content: [{ type: 'image', mimeType: 'image/png', data: 'fixture' }] }
const first = toModelContent(image, { imageScope: 'fixture-window' })
const repeated = toModelContent(image, { imageScope: 'fixture-window', knownImageIds: [JSON.parse(first[0].text).imageId] })
console.log(JSON.stringify({ units: 'JSON characters, not model tokens', profiles,
  syntheticTree: { originalChars: chars(tree), compactChars: chars(compact), nodes: compact.nodes.length, truncated: compact.truncated },
  duplicateResult: { rawChars: chars(result), projectedChars: chars(toModelContent(result)) },
  retainedImage: { firstImageBlocks: first.filter(b => b.type === 'image').length,
    repeatedImageBlocks: repeated.filter(b => b.type === 'image').length },
}, null, 2))
