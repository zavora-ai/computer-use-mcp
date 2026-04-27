/**
 * macOS demo: fetch crypto prices from CoinGecko, create a blank Numbers
 * workbook, and paste the data as a formatted table.
 *
 * Handles the case where Numbers is already open with existing workbooks.
 *
 * Run: node examples/macos/crypto-spreadsheet.mjs
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
  const rows = coins.map(c => [
    c.name,
    c.symbol.toUpperCase(),
    c.current_price.toFixed(2),
    c.market_cap.toLocaleString(),
    c.price_change_percentage_24h.toFixed(2),
  ].join('\t'))
  console.log(header)
  rows.forEach(r => console.log(r))

  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  // 1. Launch Numbers (or bring to front if already running)
  console.log('\n1. Opening Numbers...')
  await client.openApp(numbers)
  await client.wait(2)

  // 2. Dismiss any template chooser that might be showing
  console.log('2. Dismissing template chooser if present...')
  await client.key('escape', numbers)
  await client.wait(0.5)

  // 3. Create a fresh blank workbook via AppleScript
  console.log('3. Creating blank workbook...')
  await client.callTool('run_script', {
    language: 'applescript',
    script: `tell application "Numbers"
  make new document
  activate
end tell`,
  })
  await client.wait(1)

  // 4. Select cell A1 in the new document's first table
  console.log('4. Selecting cell A1...')
  await client.callTool('run_script', {
    language: 'applescript',
    script: `tell application "Numbers"
  tell front document
    tell active sheet
      tell table 1
        set selection range to range "A1"
      end tell
    end tell
  end tell
end tell`,
  })
  await client.wait(0.5)

  // 5. Paste the crypto data
  console.log('5. Pasting crypto data...')
  await client.writeClipboard([header, ...rows].join('\n'))
  await client.key('command+v', numbers)
  await client.wait(1)

  // 6. Deselect for a clean screenshot
  console.log('6. Deselecting...')
  await client.key('escape', numbers)
  await client.wait(0.3)

  // 7. Screenshot the result
  console.log('7. Taking screenshot...')
  const shot = await client.screenshot({ target_app: numbers })
  const img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/crypto-numbers.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/crypto-numbers.jpg')
  }

  // 8. Save to Desktop via the save dialog (keyboard only — it's modal)
  console.log('8. Saving to Desktop...')
  await client.key('command+s', numbers)
  await client.wait(1)
  // Filename field is focused — select all, then paste the new name via clipboard
  // (clipboard paste works reliably in system dialogs where CGEvent typing may not)
  await client.key('command+a', numbers)
  await client.wait(0.2)
  await client.writeClipboard('Crypto Prices')
  await client.key('command+v', numbers)
  await client.wait(0.5)
  // Navigate to Desktop
  await client.key('command+d', numbers)
  await client.wait(0.5)

  // Screenshot the save dialog so we can see it
  const saveSshot = await client.screenshot({ target_app: numbers, width: 1024 })
  const saveImg = saveSshot.content.find(c => c.type === 'image')
  if (saveImg) {
    await writeFile('/tmp/crypto-save-dialog.jpg', Buffer.from(saveImg.data, 'base64'))
    console.log('   → /tmp/crypto-save-dialog.jpg')
  }

  // Press Return to confirm save
  await client.key('return', numbers)
  await client.wait(1)

  // If a "Replace" dialog appears, press Return again to confirm
  await client.key('return', numbers)
  await client.wait(0.5)

  await client.close()
  console.log('\n✓ Done — "Crypto Prices.numbers" saved to Desktop')
}

main().catch(e => { console.error(e); process.exit(1) })
