/**
 * macOS demo: create a contact in Contacts.app via AppleScript.
 *
 * Run: node examples/macos/create-contact.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import { writeFile } from 'fs/promises'

const contacts = 'com.apple.AddressBook'

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  // 1. Create a new contact via AppleScript
  console.log('1. Creating contact...')
  const result = await client.callTool('run_script', {
    language: 'applescript',
    script: `tell application "Contacts"
  activate
  
  set newPerson to make new person with properties {¬
    first name: "Computer Use", ¬
    last name: "MCP Bot", ¬
    organization: "Zavora Technologies", ¬
    job title: "Desktop Automation Agent", ¬
    note: "Created automatically by computer-use-mcp v6.0 demo."}
  
  -- Add email
  tell newPerson
    make new email at end of emails with properties {¬
      label: "work", ¬
      value: "bot@zavora.ai"}
  end tell
  
  -- Add phone
  tell newPerson
    make new phone at end of phones with properties {¬
      label: "work", ¬
      value: "+1-555-MCP-RUST"}
  end tell
  
  -- Add URL
  tell newPerson
    make new url at end of urls with properties {¬
      label: "homepage", ¬
      value: "https://github.com/zavora-ai/computer-use-mcp"}
  end tell
  
  save
  
  return "Created: " & (first name of newPerson) & " " & (last name of newPerson) & " at " & (organization of newPerson)
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
  const shot = await client.screenshot({ target_app: contacts, width: 1024 })
  const img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/contact-created.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/contact-created.jpg')
  }

  // 3. Clean up — delete the test contact
  console.log('3. Cleaning up test contact...')
  await client.callTool('run_script', {
    language: 'applescript',
    script: `tell application "Contacts"
  set matches to (every person whose first name is "Computer Use" and last name is "MCP Bot")
  repeat with p in matches
    delete p
  end repeat
  save
end tell`,
    timeout_ms: 5000,
  })
  console.log('   ✓ Cleaned up')

  await client.close()
  console.log('\n✓ Done')
}

main().catch(e => { console.error(e); process.exit(1) })
