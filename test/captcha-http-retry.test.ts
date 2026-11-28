import { expect, test } from 'bun:test';
import { CaptchaError } from '../packages/captcha/src/domain/errors.ts';
import { retryCaptchaRead } from '../packages/captcha/src/infrastructure/retry.ts';
import { HttpClient } from '../packages/captcha/src/infrastructure/http.ts';
import { GeetestChallenge } from '../packages/captcha/src/protocols/v3/client.ts';
import { V4Adapter } from '../packages/captcha/src/protocols/v4/adapter.ts';
const signal = () => new AbortController().signal;

test('temporary read failures are bounded to three attempts with 150/300ms backoff', async () => {
 const waits: number[] = []; let calls = 0;
 const value = await retryCaptchaRead(async () => { if (++calls < 3) throw new CaptchaError('upstream_http_error', undefined, true); return 'ok'; }, signal(), {wait: async ms => {waits.push(ms)}});
 expect(value).toBe('ok'); expect(calls).toBe(3); expect(waits).toEqual([150,300]);
 calls=0; await expect(retryCaptchaRead(async () => {calls++; throw new TypeError('socket closed')}, signal(), {wait: async()=>{}})).rejects.toThrow(); expect(calls).toBe(3);
});

test('cancellation stops backoff without another request', async () => {
 const abort = new AbortController(); let calls=0;
 await expect(retryCaptchaRead(async()=>{calls++;throw new TypeError('network')},abort.signal,{wait:async()=>{abort.abort();}})).rejects.toThrow();
 expect(calls).toBe(1);
});

test('HTTP resource retries release failed response bodies and keep 4xx terminal', async()=>{
 let calls=0,cancelled=0;
 const http=new HttpClient((async()=>{calls++; if(calls<3)return new Response(new ReadableStream({cancel(){cancelled++}}),{status:503});return new Response('asset')}) as unknown as typeof fetch);
 expect((await http.bytes('https://static.geetest.com/fixture',signal())).toString()).toBe('asset'); expect(calls).toBe(3);expect(cancelled).toBe(2);
 for(const status of [400,401,403,404,429]){
  let count=0;const terminal=new HttpClient((async()=>{count++;return new Response('rejected',{status})}) as unknown as typeof fetch);
  await expect(terminal.bytes('https://static.geetest.com/fixture',signal())).rejects.toThrow();expect(count).toBe(1);
 }
});

test('empty assets retry while oversized and malformed responses do not', async()=>{
 let count=0;const empty=new HttpClient((async()=>{count++;return new Response(count===1?'':'asset')}) as unknown as typeof fetch);
 expect((await empty.bytes('https://static.geetest.com/fixture',signal())).toString()).toBe('asset');expect(count).toBe(2);
 count=0;const large=new HttpClient((async()=>{count++;return new Response('oversized')}) as unknown as typeof fetch);
 await expect(large.bytes('https://static.geetest.com/fixture',signal(),2)).rejects.toThrow();expect(count).toBe(1);
 count=0;const malformed=new HttpClient((async()=>{count++;return new Response('bad JSON')}) as unknown as typeof fetch);
 await expect(malformed.jsonp(new URL('https://gcaptcha4.geetest.com/load'),signal(),true)).rejects.toThrow();expect(count).toBe(1);
});

test('V3 retries taking a challenge but never retries ajax answer submissions',async()=>{
 const seen:string[]=[];
 const client=new GeetestChallenge({gt:'site',challenge:'challenge'},{fetch:(async(url:URL|string)=>{const path=new URL(String(url)).pathname;seen.push(path);return new Response('busy',{status:503})}) as unknown as typeof fetch,signal:signal()});
 await expect(client.get('api.geetest.com','/get.php')).rejects.toThrow();
 await expect(client.get('api.geetest.com','/ajax.php')).rejects.toThrow();
 expect(seen).toEqual(['/get.php','/get.php','/get.php','/ajax.php']);
});

test('V4 only enables JSONP retries for load, never verify',async()=>{
 const seen: {path:string;retry:boolean}[]=[];
 const adapter=new V4Adapter({jsonp:async(url:URL,_signal:AbortSignal,retry:boolean)=>{seen.push({path:url.pathname,retry});return {}}} as unknown as HttpClient) as unknown as {api(route:string,params:object,signal:AbortSignal):Promise<unknown>};
 await adapter.api('/load',{},signal());await adapter.api('/verify',{},signal());
 expect(seen).toEqual([{path:'/load',retry:true},{path:'/verify',retry:false}]);
 let count=0;const http=new HttpClient((async()=>{count++;throw new TypeError('socket closed')}) as unknown as typeof fetch);
 await expect(http.jsonp(new URL('https://gcaptcha4.geetest.com/verify'),signal())).rejects.toThrow();expect(count).toBe(1);
});
