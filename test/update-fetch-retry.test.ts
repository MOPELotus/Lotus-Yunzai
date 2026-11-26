import { expect, test } from 'bun:test';
import { runUpdateFetch, retryableGitFetchFailure } from '../lib/update-fetch-retry.ts';
import { runUpdateProcess } from '../lib/update-build.ts';

test('Git fetch retries only transient network failures; permanent errors take precedence',()=>{
 for(const error of ['ECONNRESET','gnutls_handshake() failed: TLS connection was non-properly terminated','Connection reset by peer','curl 92 HTTP/2 INTERNAL_ERROR','early EOF','The requested URL returned error: 503','HTTP/2 429'])expect(retryableGitFetchFailure(error)).toBe(true);
 for(const error of ['Authentication failed','repository not found','invalid refspec','Permission denied; ECONNRESET',"couldn't find remote ref main",'bad object; early EOF','unknown fatal error'])expect(retryableGitFetchFailure(error)).toBe(false);
 expect(retryableGitFetchFailure('',true)).toBe(true);
});
test('fetch recovery retries in place, bounds attempts and stops on success/permanent errors',async()=>{
 const pauses:number[]=[];let calls=0;
 const options={pause:async(ms:number)=>{pauses.push(ms)},run:async(...args:Parameters<typeof runUpdateProcess>)=>{calls++;args[5]?.({code:calls===3?0:128,timedOut:false,stderr:'connection reset by peer'});return calls===3}};
 expect(await runUpdateFetch('.',{},['git','fetch'],undefined,options)).toBe(true);expect(calls).toBe(3);expect(pauses).toEqual([400,1000]);
 calls=0;expect(await runUpdateFetch('.',{},['git','fetch'],undefined,{pause:options.pause,run:async(...args)=>{calls++;args[5]?.({code:128,timedOut:false,stderr:'Authentication failed'});return false}})).toBe(false);expect(calls).toBe(1);
 calls=0;expect(await runUpdateFetch('.',{},['git','fetch'],undefined,{pause:async()=>{},run:async(...args)=>{calls++;args[5]?.({code:128,timedOut:false,stderr:'early EOF'});return false}})).toBe(false);expect(calls).toBe(3);
});
test('fetch cancellation during backoff starts no further attempt',async()=>{
 const controller=new AbortController();let calls=0;
 await expect(runUpdateFetch('.',{},['git','fetch'],controller.signal,{run:async(...args)=>{calls++;args[5]?.({code:128,timedOut:false,stderr:'early EOF'});return false},pause:async()=>{controller.abort()}})).rejects.toThrow();expect(calls).toBe(1);
});
test('process diagnostics retain bounded stderr without publishing it; timeout is explicit',async()=>{
 let captured='';const ok=await runUpdateProcess(process.cwd(),{PATH:process.env.PATH},[process.execPath,'-e','process.stderr.write("x".repeat(200000));process.exit(1)'],2000,undefined,result=>{captured=result.stderr;expect(result.code).toBe(1);expect(result.timedOut).toBe(false)});
 expect(ok).toBe(false);expect(captured.length).toBe(64*1024);
 let timedOut=false;expect(await runUpdateProcess(process.cwd(),{},[process.execPath,'-e','setInterval(()=>{},1000)'],100,undefined,result=>{timedOut=result.timedOut})).toBe(false);expect(timedOut).toBe(true);
});
