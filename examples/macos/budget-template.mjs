/**
 * macOS demo: open Numbers, choose the Simple Budget template from the
 * template chooser, personalise it with real data, add formulas, and save.
 *
 * Handles the case where Numbers is already open with existing workbooks.
 *
 * Run: node examples/macos/budget-template.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import { writeFile } from 'fs/promises'

const numbers = 'com.apple.iWork.Numbers'

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  // 1. Launch Numbers
  console.log('1. Opening Numbers...')
  await client.openApp(numbers)
  await client.wait(2)

  // 2. Dismiss any existing template chooser
  await client.key('escape', numbers)
  await client.wait(0.5)

  // 3. Open the template chooser with Cmd+N
  console.log('2. Opening template chooser...')
  await client.key('command+n', numbers)
  await client.wait(2)

  // 4. Screenshot the template chooser
  let shot = await client.screenshot({ target_app: numbers, width: 1024 })
  let img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/budget-1-chooser.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/budget-1-chooser.jpg')
  }

  // 5. Try to find and click the Simple Budget template
  console.log('3. Looking for Simple Budget template...')
  const wins = JSON.parse((await client.listWindows(numbers)).content[0]?.text || '[]')
  // Use the main document window (not the "Save" sheet)
  const numbersWin = wins.find(w => w.title && !w.title.includes('Save'))

  let foundTemplate = false
  if (numbersWin) {
    try {
      const elements = JSON.parse(
        (await client.callTool('find_element', {
          window_id: numbersWin.windowId,
          label: 'Simple Budget',
          max_results: 5,
        })).content[0]?.text || '[]'
      )

      if (Array.isArray(elements) && elements.length > 0) {
        console.log('   Found "Simple Budget", double-clicking...')
        const el = elements[0]
        const cx = Math.round(el.bounds.x + el.bounds.width / 2)
        const cy = Math.round(el.bounds.y + el.bounds.height / 2)
        await client.doubleClick([cx, cy], numbers)
        await client.wait(2)
        foundTemplate = true
      }
    } catch { /* element search failed, fall through */ }
  }

  if (!foundTemplate) {
    // Fallback: dismiss chooser and create a blank doc
    console.log('   Template not found — creating blank workbook...')
    await client.key('escape', numbers)
    await client.wait(0.5)
    await client.callTool('run_script', {
      language: 'applescript',
      script: `tell application "Numbers"
  make new document
  activate
end tell`,
    })
    await client.wait(1)
  }

  // 6. Screenshot the opened template/workbook
  console.log('4. Screenshotting workbook...')
  shot = await client.screenshot({ target_app: numbers, width: 1024 })
  img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/budget-2-template.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/budget-2-template.jpg')
  }

  // 7. Personalise with budget data via AppleScript
  console.log('5. Personalising with budget data...')
  const month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  await client.callTool('run_script', {
    language: 'applescript',
    script: `tell application "Numbers"
  tell front document
    tell active sheet
      tell table 1
        set value of cell "A1" to "Monthly Budget"
        set value of cell "B1" to "${month}"
        set value of cell "A3" to "INCOME"
        set value of cell "A4" to "Salary"
        set value of cell "B4" to 5500
        set value of cell "A5" to "Freelance"
        set value of cell "B5" to 1200
        set value of cell "A6" to "Investments"
        set value of cell "B6" to 350
        set value of cell "A7" to "Other"
        set value of cell "B7" to 150
        set value of cell "A9" to "EXPENSES"
        set value of cell "A10" to "Rent/Mortgage"
        set value of cell "B10" to 1800
        set value of cell "A11" to "Utilities"
        set value of cell "B11" to 250
        set value of cell "A12" to "Groceries"
        set value of cell "B12" to 600
        set value of cell "A13" to "Transport"
        set value of cell "B13" to 200
        set value of cell "A14" to "Insurance"
        set value of cell "B14" to 350
        set value of cell "A15" to "Entertainment"
        set value of cell "B15" to 150
        set value of cell "A16" to "Dining Out"
        set value of cell "B16" to 200
        set value of cell "A17" to "Subscriptions"
        set value of cell "B17" to 85
        set value of cell "A18" to "Clothing"
        set value of cell "B18" to 100
        set value of cell "A19" to "Personal Care"
        set value of cell "B19" to 75
      end tell
    end tell
  end tell
end tell`,
  })
  await client.wait(1)

  // 8. Add summary formulas
  console.log('6. Adding summary formulas...')
  await client.callTool('run_script', {
    language: 'applescript',
    script: `tell application "Numbers"
  tell front document
    tell active sheet
      tell table 1
        set value of cell "A21" to "SUMMARY"
        set value of cell "A22" to "Total Income"
        set value of cell "B22" to "=SUM(B4:B7)"
        set value of cell "A23" to "Total Expenses"
        set value of cell "B23" to "=SUM(B10:B19)"
        set value of cell "A24" to "Net Savings"
        set value of cell "B24" to "=B22-B23"
        set value of cell "A25" to "Savings Rate"
        set value of cell "B25" to "=B24/B22"
      end tell
    end tell
  end tell
end tell`,
  })
  await client.wait(1)

  // 9. Screenshot the personalised budget
  console.log('7. Screenshotting personalised budget...')
  shot = await client.screenshot({ target_app: numbers, width: 1024 })
  img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/budget-3-personalised.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/budget-3-personalised.jpg')
  }

  // 10. Save to Desktop via the save dialog (keyboard only — it's modal)
  console.log('8. Saving to Desktop...')
  await client.key('command+s', numbers)
  await client.wait(1)
  // Filename field is focused — select all, then paste the new name via clipboard
  await client.key('command+a', numbers)
  await client.wait(0.2)
  await client.writeClipboard('Monthly Budget')
  await client.key('command+v', numbers)
  await client.wait(0.5)
  // Navigate to Desktop
  await client.key('command+d', numbers)
  await client.wait(0.5)

  // Screenshot the save dialog
  shot = await client.screenshot({ target_app: numbers, width: 1024 })
  img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/budget-save-dialog.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/budget-save-dialog.jpg')
  }

  // Press Return to confirm save
  await client.key('return', numbers)
  await client.wait(1)
  // If a "Replace" dialog appears, press Return again
  await client.key('return', numbers)
  await client.wait(0.5)

  // 11. Final screenshot
  console.log('9. Final screenshot...')
  shot = await client.screenshot({ target_app: numbers, width: 1024 })
  img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/budget-4-final.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/budget-4-final.jpg')
  }

  await client.close()
  console.log('\n✓ Done — "Monthly Budget.numbers" saved to Desktop')
  console.log('  Screenshots: /tmp/budget-{1,2,3,4}-*.jpg')
}

main().catch(e => { console.error(e); process.exit(1) })
