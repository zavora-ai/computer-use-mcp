/**
 * Fetch top 10 crypto prices from CoinGecko and analyse in Numbers.
 */

import { createComputerUseServer } from './server.js'
import { connectInProcess, type ToolResult } from './client.js'
import { writeFile } from 'fs/promises'

const numbers = 'com.apple.iWork.Numbers'

async function fetchCrypto() {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&sparkline=false'
  )
  if (!res.ok) throw new Error(`CoinGecko: ${res.status}`)
  return res.json() as Promise<Array<{
    name: string; symbol: string; current_price: number
    market_cap: number; price_change_percentage_24h: number
    total_volume: number; high_24h: number; low_24h: number
  }>>
}

async function main() {
  console.log('Fetching crypto data...')
  const coins = await fetchCrypto()
  console.log(`✓ Got ${coins.length} coins\n`)

  // Build tab-separated data for paste into Numbers
  const header = 'Name\tSymbol\tPrice (USD)\tMarket Cap\t24h Change %\t24h Volume\t24h High\t24h Low'
  const rows = coins.map(c =>
    [
      c.name,
      c.symbol.toUpperCase(),
      c.current_price.toFixed(2),
      c.market_cap.toLocaleString('en-US'),
      c.price_change_percentage_24h.toFixed(2),
      c.total_volume.toLocaleString('en-US'),
      c.high_24h.toFixed(2),
      c.low_24h.toFixed(2),
    ].join('\t')
  )
  const tsv = [header, ...rows].join('\n')

  console.log('Preview:')
  console.log(header)
  rows.forEach(r => console.log(r))
  console.log()

  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  // Open Numbers
  console.log('Opening Numbers...')
  await client.openApp(numbers)
  await client.wait(2)

  // New document
  await client.key('command+n', numbers)
  await client.wait(2)

  // Click first cell A1
  await client.key('escape', numbers)
  await client.wait(0.3)

  // Write TSV to clipboard and paste
  console.log('Pasting data...')
  await client.writeClipboard(tsv)
  await client.key('command+v', numbers)
  await client.wait(1)

  // Auto-fit columns
  await client.key('command+a', numbers)
  await client.wait(0.2)

  // Screenshot result
  console.log('Taking screenshot...')
  const shot = await client.screenshot()
  await save(shot, '/tmp/crypto-numbers.jpg')
  console.log('✓ Screenshot saved to /tmp/crypto-numbers.jpg')

  await client.close()
}

async function save(result: ToolResult, path: string) {
  const img = result.content.find(c => c.type === 'image')
  if (img?.type === 'image') {
    await writeFile(path, Buffer.from(img.data, 'base64'))
    const txt = result.content.find(c => c.type === 'text')
    console.log(`   ${txt?.type === 'text' ? txt.text : ''} → ${path}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
