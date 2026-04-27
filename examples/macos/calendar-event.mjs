/**
 * macOS demo: create a calendar event in Calendar.app via AppleScript.
 *
 * Run: node examples/macos/calendar-event.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import { writeFile } from 'fs/promises'

const calendar = 'com.apple.iCal'

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  // 1. Create a calendar event for tomorrow at 10am
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(10, 0, 0, 0)
  const endTime = new Date(tomorrow)
  endTime.setHours(11, 0, 0, 0)

  const dateStr = tomorrow.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })

  console.log(`1. Creating calendar event for ${dateStr} at 10:00 AM...`)

  const result = await client.callTool('run_script', {
    language: 'applescript',
    script: `tell application "Calendar"
  activate
  
  -- Use a writable calendar (skip read-only ones like Birthdays, Subscriptions)
  set targetCal to missing value
  repeat with c in calendars
    if writable of c then
      set targetCal to c
      exit repeat
    end if
  end repeat
  
  if targetCal is missing value then
    error "No writable calendar found"
  end if
  
  set startDate to current date
  set day of startDate to ${tomorrow.getDate()}
  set month of startDate to ${tomorrow.getMonth() + 1}
  set year of startDate to ${tomorrow.getFullYear()}
  set hours of startDate to 10
  set minutes of startDate to 0
  set seconds of startDate to 0
  
  set endDate to startDate + (1 * hours)
  
  tell targetCal
    set newEvent to make new event with properties {¬
      summary: "computer-use-mcp Demo Review", ¬
      start date: startDate, ¬
      end date: endDate, ¬
      description: "Review the computer-use-mcp v6.0 cross-platform demo results.\\n\\nAgenda:\\n1. macOS examples review\\n2. Windows examples review\\n3. Performance benchmarks\\n4. CI pipeline status", ¬
      location: "Zoom Meeting"}
  end tell
  
  -- Navigate to the event date
  view calendar at startDate
  
  return "Event created: " & (summary of newEvent) & " on " & (start date of newEvent as string)
end tell`,
    timeout_ms: 10000,
  })

  if (result.isError) {
    console.log('   ⚠ Failed:', result.content[0]?.text)
  } else {
    console.log('   ✓ ' + result.content[0]?.text)
  }

  // 2. Wait and screenshot
  await client.wait(2)
  console.log('2. Taking screenshot...')
  const shot = await client.screenshot({ target_app: calendar, width: 1024 })
  const img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/calendar-event.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/calendar-event.jpg')
  }

  await client.close()
  console.log('\n✓ Done — event created for ' + dateStr)
}

main().catch(e => { console.error(e); process.exit(1) })
