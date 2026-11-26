import { expect, test } from 'bun:test';
import { waitForCheckinNoticeTransport } from '../lib/checkin-notice-ready.ts';

test('plan notices wait for transport reconnection and stop on timeout or abort',async()=>{
 let clock=0,online=false,waited=0;const signal=new AbortController().signal;
 expect(await waitForCheckinNoticeTransport({signal,available:()=>online,now:()=>clock,pause:async ms=>{clock+=ms;waited++;if(clock>=30_000)online=true;}})).toBe(true);
 expect(clock).toBe(30_000);expect(waited).toBeGreaterThan(0);
 clock=0;expect(await waitForCheckinNoticeTransport({signal,available:()=>false,timeoutMs:500,now:()=>clock,pause:async ms=>{clock+=ms;}})).toBe(false);
 const controller=new AbortController();controller.abort();expect(await waitForCheckinNoticeTransport({signal:controller.signal,available:()=>true})).toBe(false);
});
