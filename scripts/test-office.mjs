// Explicit live macOS smoke test: creates only its own documents and leaves saved fixtures for inspection.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
if(process.platform!=='darwin') throw Error('This live Office script currently supports macOS')
const directory=mkdtempSync(join(tmpdir(),'computer-use-office-'))
const client=await connectInProcess(createComputerUseServer())
const payload=result=>result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text)
const quote=value=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"'
const report={directory,discovery:null,tests:[]}
try {
 const discovered=payload(await client.discoverApplications({query:'office',include_capabilities:true}))
 report.discovery=discovered
 console.log('Discovered:',discovered.applications.map(a=>a.name).join(', '))
 for(const appName of ['Microsoft Word','Microsoft Excel','Microsoft PowerPoint']) {
  const app=discovered.applications.find(a=>a.name===appName)
  if(!app?.targetApp){report.tests.push({app:appName,status:'unavailable'});process.exitCode=1;continue}
  const extension=appName.endsWith('Word')?'docx':appName.endsWith('Excel')?'xlsx':'pptx'
  const filename=basename(directory)+'.'+extension
  const path=join(directory,filename)
  const body=extension==='docx'?`
set fixture to make new document
set content of text object of fixture to "Computer-use Office fixture" & return & "Created and edited through MCP run_script."
set evidence to content of text object of fixture
save as fixture file name ${quote(path)} file format format document default
close document ${quote(filename)} saving no
return evidence` : extension==='xlsx'?`
set fixture to make new workbook
set fixtureSheet to worksheet 1 of fixture
set value of range "A1:B4" of fixtureSheet to {{"Item", "Amount"}, {"Alpha", 12}, {"Beta", 30}, {"Total", ""}}
set formula of range "B4" of fixtureSheet to "=SUM(B2:B3)"
set evidence to value of range "B4" of fixtureSheet
save workbook as fixture filename ${quote(path)} file format Excel XML file format
close workbook ${quote(filename)} saving no
return evidence` : `
set fixture to make new presentation
set slideOne to make new slide at end of fixture with properties {layout:slide layout title slide}
set content of text range of text frame of shape 1 of slideOne to "Computer-use Office fixture"
set content of text range of text frame of shape 2 of slideOne to "Created and edited through MCP run_script."
set evidence to count of slides of fixture
save fixture in POSIX file ${quote(path)} as save as Open XML presentation
close presentation ${quote(filename)} saving no
return evidence`
  const script=`tell application id ${quote(app.targetApp)}\n${body}\nend tell`
  const start=Date.now()
  const result=await client.callTool('run_script',{language:'applescript',script,timeout_ms:60000})
  let verification
  if (!result.isError) {
    try {
      verification=execFileSync('python3',['-c', `import sys,zipfile,xml.etree.ElementTree as E
path,kind=sys.argv[1:]
with zipfile.ZipFile(path) as z:
 if kind=='docx':
  root=E.fromstring(z.read('word/document.xml'))
  text=''.join(root.itertext())
  assert 'Computer-use Office fixture' in text and 'Created and edited through MCP run_script.' in text
 elif kind=='xlsx':
  root=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
  ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
  cell=root.find('.//s:c[@r="B4"]',ns)
  assert cell.find('s:f',ns).text=='SUM(B2:B3)'
  assert float(cell.find('s:v',ns).text)==42
 else:
  root=E.fromstring(z.read('ppt/slides/slide1.xml'))
  text=''.join(root.itertext())
  assert 'Computer-use Office fixture' in text and 'Created and edited through MCP run_script.' in text
print('Saved OOXML content verified')`,path,extension],{encoding:'utf8'}).trim()
    } catch(error) { verification=String(error); process.exitCode=1 }
  } else process.exitCode=1
  report.tests.push({app:appName,path,elapsedMs:Date.now()-start,result,verification})
  console.log(appName,JSON.stringify(result),verification??'Not verified')
 }
} finally {await client.close();writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2));console.log('Fixtures and report:',directory)}
