import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractFlat, runInSandbox, saveConfig, saveConfigs } from './update-captcha-config.mjs'

const sdk = `globalThis._lib={abcd:'efgh'};lib._abo={'n[1:1]':'n[2:2]'};window.location;`
const gct = `function _gct(o){o.biht='12345'}`
const flat = {biht:'12345',lib_key:'abcd',lib_val:'efgh',abo_key:'n[1:1]',abo_val:'n[2:2]'}

test('isolated Node child extracts SDK prologue and GCT without host globals',()=>{
 assert.deepEqual(extractFlat(sdk,gct),flat)
 const seen=runInSandbox(`globalThis._lib={process:typeof process};lib._abo={'key':'value'};window.location;`,gct)
 assert.deepEqual(seen.lib,{process:'undefined'})
})
test('second abo write and multi-key extraction fail closed',()=>{
 assert.throws(()=>extractFlat(sdk.replace('window.location;',`lib._abo={'fake':'answer'};`),gct),/rewrote|honeypot/)
 assert.throws(()=>extractFlat(sdk.replace("{abcd:'efgh'}","{abcd:'efgh',bad:'key'}"),gct),/expected 1 entry/)
})
test('config merge preserves old builds and extra fields, conflicts never alter stored bytes',()=>{
 const directory=mkdtempSync(join(tmpdir(),'lotus-captcha-config-'))
 try {
  const file=join(directory,'v1.9.10-config.json')
  const old={ 'v1.9.10-old':{...flat,retired:true} }
  writeFileSync(file,JSON.stringify(old))
  assert.equal(saveConfig('v1.9.10-new',flat,{directory}),true)
  const saved=readFileSync(file,'utf8')
  assert.deepEqual(JSON.parse(saved)['v1.9.10-old'],old['v1.9.10-old'])
  assert.deepEqual(JSON.parse(saved)['v1.9.10-new'],flat)
  assert.equal(saveConfig('v1.9.10-new',flat,{directory}),false)
  assert.equal(readFileSync(file,'utf8'),saved)
  assert.throws(()=>saveConfig('v1.9.10-new',{...flat,biht:'wrong'},{directory}),/disagrees/)
  assert.equal(readFileSync(file,'utf8'),saved)
  assert.equal(saveConfig('v1.9.10-other',flat,{directory,checkOnly:true}),true)
  assert.equal(readFileSync(file,'utf8'),saved)
  assert.equal(existsSync(file+'.tmp'),false)
 }finally{rmSync(directory,{recursive:true,force:true})}
})
test('unsafe version, corrupt stored data and invalid extracted fields never overwrite configs',()=>{
 const directory=mkdtempSync(join(tmpdir(),'lotus-captcha-config-'))
 try{
  const file=join(directory,'v1.9.10-config.json')
  for(const value of ['../escape','v1.9.10/../../escape','not-a-version'])assert.throws(()=>saveConfig(value,flat,{directory}),/unsafe/)
  for(const value of ['null','[]','invalid JSON']){
   writeFileSync(file,value)
   assert.throws(()=>saveConfig('v1.9.10-new',flat,{directory}),/corrupt/)
   assert.equal(readFileSync(file,'utf8'),value)
  }
  for(const value of ['',null,{},[]])assert.throws(()=>saveConfig('v1.9.10-new',{...flat,biht:value},{directory}),/Failed to extract/)
 }finally{rmSync(directory,{recursive:true,force:true})}
})

test('multi-version inspection validates every build before writing any file',()=>{
 const directory=mkdtempSync(join(tmpdir(),'lotus-captcha-config-'))
 try{
  const file=join(directory,'v1.9.10-config.json')
  const before=JSON.stringify({'v1.9.10-old':flat})
  writeFileSync(file,before)
  assert.throws(()=>saveConfigs([{staticVer:'v1.9.10-new',flat},{staticVer:'v1.9.10-old',flat:{...flat,biht:'conflict'}}],{directory}),/disagrees/)
  assert.equal(readFileSync(file,'utf8'),before)
 }finally{rmSync(directory,{recursive:true,force:true})}
})
