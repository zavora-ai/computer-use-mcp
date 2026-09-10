import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { discoverApplications } from '../dist/session/application-discovery.js'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'

test('installed discovery searches Office, merges running IDs, bounds probes and never runs an app', async () => {
  const root = await mkdtemp(join(tmpdir(),'cu-apps-'))
  const calls=[]
  try {
    for (const name of ['Microsoft Word','Microsoft Excel','Unrelated']) await mkdir(join(root,name+'.app'))
    await symlink(root,join(root,'cycle'))
    const options={platform:'darwin',roots:[root],running:[{bundleId:'com.test.microsoftword',displayName:'Word'}],
      spawn:async(cmd,args)=>{calls.push(cmd);const name=basename(dirname(dirname(args.at(-1)))).slice(0,-4);return {code:0,stdout:JSON.stringify({CFBundleName:name,CFBundleIdentifier:'com.test.'+name.replaceAll(' ','').toLowerCase()})}},
      capabilities:async id=>({id,scriptable:true})}
    const found=await discoverApplications({query:'office',include_capabilities:true},options)
    assert.equal(found.applications.length,2)
    assert.equal(found.applications.find(a=>a.name==='Microsoft Word').running,true)
    assert.equal(found.capabilitiesProbed,2)
    assert.ok(calls.every(c=>c==='/usr/bin/plutil'))
    const limited=await discoverApplications({query:'office',limit:1},options)
    assert.equal(limited.truncated,true)
    assert.equal(limited.matched,2)
    await assert.rejects(discoverApplications({limit:101},options),/limit/)
    await assert.rejects(discoverApplications({}, {...options,signal:AbortSignal.abort()}))
  } finally {await rm(root,{recursive:true,force:true})}
})

test('Linux registration discovery ignores hidden entries and does not execute desktop commands',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cu-desktop-'))
 try {
  await writeFile(join(root,'writer.desktop'),'[Desktop Entry]\nType=Application\nName=LibreOffice Writer\nExec=do-not-execute\n')
  await writeFile(join(root,'hidden.desktop'),'[Desktop Entry]\nType=Application\nName=Hidden\nHidden=true\n')
  const found=await discoverApplications({query:'office'},{platform:'linux',roots:[root],running:[],spawn:async()=>{throw Error('must not spawn')}})
  assert.equal(found.applications.length,1)
  assert.equal(found.applications[0].id,'writer.desktop')
  assert.equal(found.applications[0].targetApp,null)
 } finally {await rm(root,{recursive:true,force:true})}
})

test('Windows search treats queries as data and does not mistake launch IDs for process targets',async()=>{
 let command
 const found=await discoverApplications({query:'office'},{platform:'win32',running:[],spawn:async(_,args)=>{command=args;return {code:0,stdout:JSON.stringify([{Name:'Microsoft Word',AppID:'Office.Word'}])}}})
 assert.equal(found.applications[0].id,'Office.Word')
 assert.equal(found.applications[0].targetApp,null)
 assert.ok(!command.includes('office'))
})

test('discovery is exposed in core, validates input and honors host authorization',async()=>{
 let dispatched=false
 const server=createComputerUseServer({profile:'core',session:{dispatch:async()=>{dispatched=true;return {content:[]}}},authorizeToolCall:()=>{throw Error('Discovery denied')}})
 const client=await connectInProcess(server)
 try {
  const tool=(await client.listTools()).find(t=>t.name==='discover_applications')
  assert.equal(tool.annotations.readOnlyHint,true)
  await assert.rejects(client.discoverApplications({query:'Office'}), /Discovery denied/)
  assert.equal(dispatched,false)
 } finally {await client.close()}
})
