/**
 * System admin demo: Gather system health info, check services, save report.
 * Practical sysadmin workflow using PowerShell, registry, filesystem, and process tools.
 *
 * Run: node examples/windows/sysadmin.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const outDir = path.join(os.tmpdir(), 'cu-sysadmin')
fs.mkdirSync(outDir, { recursive: true })

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  console.log(`+ ${(await client.listTools()).length} tools\n`)

  const report = []
  const addSection = (title, content) => {
    report.push(`\n${'='.repeat(50)}`)
    report.push(`  ${title}`)
    report.push('='.repeat(50))
    report.push(content)
    console.log(`  + ${title}`)
  }

  report.push('System Health Report')
  report.push(`Generated: ${new Date().toISOString()}`)
  report.push(`Hostname: ${os.hostname()}`)

  // 1. Windows version from registry
  console.log('1. Gathering system info...')
  const regPath = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
  const product = await client.callTool('registry', { mode: 'get', path: regPath, name: 'ProductName' })
  const build = await client.callTool('registry', { mode: 'get', path: regPath, name: 'CurrentBuild' })
  addSection('OS Version', `${product.content[0]?.text}\nBuild: ${build.content[0]?.text}`)

  // 2. Display info
  const disp = JSON.parse((await client.getDisplaySize()).content[0].text)
  addSection('Display', `${disp.width}x${disp.height} (${disp.pixelWidth}x${disp.pixelHeight} physical)\nScale: ${disp.scaleFactor}x`)

  // 3. Memory and CPU via PowerShell
  console.log('2. Checking resources...')
  const memCmd = await client.callTool('run_script', {
    language: 'powershell',
    script: '$os = Get-CimInstance Win32_OperatingSystem; $total = [math]::Round($os.TotalVisibleMemorySize/1MB,1); $free = [math]::Round($os.FreePhysicalMemory/1MB,1); $used = $total - $free; Write-Output "Total: ${total}GB, Used: ${used}GB, Free: ${free}GB, Usage: $([math]::Round($used/$total*100,1))%"'
  })
  addSection('Memory', memCmd.content[0]?.text || 'N/A')

  const cpuCmd = await client.callTool('run_script', {
    language: 'powershell',
    script: '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; Write-Output "$($cpu.Name)`nCores: $($cpu.NumberOfCores), Threads: $($cpu.NumberOfLogicalProcessors)`nUsage: $($cpu.LoadPercentage)%"'
  })
  addSection('CPU', cpuCmd.content[0]?.text || 'N/A')

  // 4. Disk space
  console.log('3. Checking disk space...')
  const diskCmd = await client.callTool('run_script', {
    language: 'powershell',
    script: 'Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -gt 0 } | ForEach-Object { $total = [math]::Round(($_.Used + $_.Free)/1GB,1); $used = [math]::Round($_.Used/1GB,1); $pct = [math]::Round($_.Used/($_.Used+$_.Free)*100,1); Write-Output "$($_.Name): ${used}GB / ${total}GB (${pct}%)" }'
  })
  addSection('Disk Space', diskCmd.content[0]?.text || 'N/A')

  // 5. Top processes
  console.log('4. Checking processes...')
  const procs = await client.callTool('process_kill', { mode: 'list', limit: 5 })
  addSection('Top Processes (by memory)', procs.content[0]?.text?.slice(0, 500) || 'N/A')

  // 6. Running apps
  const apps = JSON.parse((await client.listRunningApps()).content[0].text)
  addSection('Running Applications', apps.map(a => `  ${a.bundleId} (PID ${a.pid})${a.isHidden ? ' [minimized]' : ''}`).join('\n'))

  // 7. Network info
  console.log('5. Checking network...')
  const netCmd = await client.callTool('run_script', {
    language: 'powershell',
    script: 'Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne "127.0.0.1" } | Select-Object -First 3 | ForEach-Object { Write-Output "$($_.InterfaceAlias): $($_.IPAddress)/$($_.PrefixLength)" }'
  })
  addSection('Network', netCmd.content[0]?.text || 'N/A')

  // 8. Virtual desktops
  const spaces = JSON.parse((await client.listSpaces()).content[0].text)
  addSection('Virtual Desktops', (spaces.displays[0]?.spaces || []).map(s => `  ${s.name}`).join('\n') || '  1 desktop')

  // 9. Save report
  console.log('\n6. Saving report...')
  const reportPath = path.join(outDir, 'health-report.txt')
  await client.callTool('filesystem', { mode: 'write', path: reportPath, content: report.join('\n') })

  // 10. Screenshot
  const shot = await client.screenshot({ width: 800 })
  const img = shot.content.find(c => c.type === 'image')
  if (img) fs.writeFileSync(path.join(outDir, 'desktop.jpg'), Buffer.from(img.data, 'base64'))

  // 11. Send notification
  console.log('7. Sending notification...')
  await client.callTool('notification', {
    title: 'Health Report Complete',
    message: `Report saved to ${reportPath}`
  })

  console.log(`\n+ Report saved: ${reportPath}`)
  console.log(report.join('\n'))

  await client.close()
}

main().catch(e => { console.error(e); process.exit(1) })
