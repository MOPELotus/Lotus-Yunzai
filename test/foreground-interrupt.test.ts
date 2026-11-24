import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test.skipIf(process.platform === "win32")("前台主管Ctrl+C提示结束运行并退出0，自发130和SIGTERM保持失败码",async()=>{
 const root=await mkdtemp(join(tmpdir(),"lotus-foreground-interrupt-"));
 await writeFile(join(root,"app.ts"),`
 process.on("SIGINT",()=>process.exit(130));process.on("SIGTERM",()=>process.exit(143));
 process.send({type:"lotus-ready",token:Bun.env.LOTUS_MANAGED_TOKEN});
 console.log("foreground-interrupt-ready");
 if(Bun.env.FIXTURE_FAIL==="1")setTimeout(()=>process.exit(130),30);else setInterval(()=>{},1000);
 `);
 const script=fileURLToPath(new URL("../scripts/run-managed.ts",import.meta.url));
 try {
  let text="";
  const terminal=new Bun.Terminal({cols:100,rows:20,data:(_t,chunk)=>{text+=new TextDecoder().decode(chunk)}});
  const child=Bun.spawn([process.execPath,script,root],{cwd:root,env:{PATH:process.env.PATH},terminal});
  try {
   for(let attempt=0;attempt<200&&!text.includes("foreground-interrupt-ready");attempt++)await Bun.sleep(20);
   expect(text).toContain("foreground-interrupt-ready");child.kill("SIGINT");
   expect(await child.exited).toBe(0);expect(text).toContain("结束运行");
  } finally {if(child.exitCode===null)child.kill("SIGKILL");await child.exited;terminal.close();}
  const failure=Bun.spawn([process.execPath,script,root],{cwd:root,env:{PATH:process.env.PATH,FIXTURE_FAIL:"1"},stdin:"ignore",stdout:"ignore",stderr:"ignore"});
  expect(await failure.exited).toBe(130);
  const term=Bun.spawn([process.execPath,script,root],{cwd:root,env:{PATH:process.env.PATH},stdin:"ignore",stdout:"pipe",stderr:"ignore"});
  try {const reader=term.stdout.getReader();while(true){const {done,value}=await reader.read();if(done)throw Error("worker exited before ready");if(new TextDecoder().decode(value).includes("foreground-interrupt-ready"))break;}reader.releaseLock();term.kill("SIGTERM");expect(await term.exited).toBe(143);}
  finally {if(term.exitCode===null)term.kill("SIGKILL");await term.exited;}
 }finally{await rm(root,{recursive:true,force:true});}
},20_000);
