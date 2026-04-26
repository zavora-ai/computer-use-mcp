/**
 * macOS demo: fetch crypto prices from CoinGecko, paste into Numbers.
 *
 * Run: node examples/macos-crypto-spreadsheet.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import { writeFile } from 'fs/promises'

const numbers = 'com.apple.iWork.Numbers'

async function main() {
  console.log('Fetching crypto data...')
  const res = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&sparkline=false')
  const coins = await res.json()
  console.log(`✓ Got ${coins.length} coins\n`)

  const header = 'Name\tSymbol\tPrice (USD)\tMarket Cap\t24h Change %'
  const rows = coins.map(c => [c.name, c.symbol.toUpperCase(), c.current_price.toFixed(2), c.market_cap.toLocaleString(), c.price_change_percentage_24h.toFixed(2)].join('\t'))
  console.log(header)
  rows.forEach(r => console.log(r))

  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  console.log('\nOpening Numbers...')
  await client.openApp(numbers); await client.wait(2)
  await client.key('command+n', numbers); await client.wait(2)
  await client.key('escape', numbers); await client.wait(0.3)

  console.log('Pasting data...')
  await client.writeClipboard([header, ...rows].join('\n'))
  await client.key('command+v', numbers); await client.wait(1)

  const shot = await client.screenshot()
  const img = shot.content.find(c => c.type === 'image')
  if (img) { await writeFile('/tmp/crypto-numbers.jpg', Buffer.from(img.data, 'base64')); console.log('→ /tmp/crypto-numbers.jpg') }

  await client.close()
  console.log('✓ Done')
}

main().catch(e => { console.error(e); process.exit(1) })
