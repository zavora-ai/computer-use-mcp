/**
 * macOS demo: compose and send an email via Mail.app using AppleScript.
 *
 * Run: node examples/macos/send-email.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import { writeFile } from 'fs/promises'

const mail = 'com.apple.mail'

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  // 1. Check if Mail is scriptable
  console.log('1. Checking Mail capabilities...')
  const caps = await client.callTool('get_app_capabilities', { bundle_id: mail })
  console.log('   ' + caps.content[0]?.text)

  // 2. Compose and send via AppleScript (fastest, most reliable approach)
  console.log('2. Composing email via AppleScript...')
  const result = await client.callTool('run_script', {
    language: 'applescript',
    script: `tell application "Mail"
  activate
  set newMsg to make new outgoing message with properties {¬
    subject: "computer-use-mcp works!", ¬
    content: "Hi James,

This email was sent automatically by computer-use-mcp — the cross-platform desktop automation MCP server.

Everything is working perfectly:
• Mouse, keyboard, and screenshot automation ✓
• AppleScript scripting bridge ✓
• UI Automation (accessibility) ✓
• Clipboard operations ✓
• Window management ✓

Sent from macOS via Rust NAPI + AppleScript.

Best,
computer-use-mcp v6.0", ¬
    visible: true}
  
  tell newMsg
    make new to recipient at end of to recipients with properties {address: "james.karanja@zavora.ai"}
  end tell
  
  -- Send it
  send newMsg
end tell`,
    timeout_ms: 15000,
  })

  if (result.isError) {
    console.log('   ⚠ AppleScript send failed:', result.content[0]?.text)
    console.log('   Mail may need to be configured with an account first.')
  } else {
    console.log('   ✓ Email sent!')
  }

  // 3. Wait for Mail to process, then screenshot
  await client.wait(2)
  console.log('3. Taking screenshot...')
  const shot = await client.screenshot({ target_app: mail, width: 1024 })
  const img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/mail-sent.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/mail-sent.jpg')
  }

  await client.close()
  console.log('\n✓ Done')
}

main().catch(e => { console.error(e); process.exit(1) })
