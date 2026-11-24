import {test,expect} from "bun:test";
import {mkdtemp,mkdir,writeFile,copyFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
test("更新清单接受内置包上游删除，保留新增文件并排除未跟踪的私人覆盖",async()=>{
 const root=await mkdtemp(join(tmpdir(),"lotus-manifest-generation-"));
 try{
  for(const p of ["scripts","resources/builtin","plugins/example/resources"])await mkdir(join(root,p),{recursive:true});
  await copyFile(new URL("../scripts/update-builtin-resource-manifest.ts",import.meta.url),join(root,"scripts/update.ts"));
  await writeFile(join(root,"resources/builtin/removed.txt"),"old");
  await writeFile(join(root,"plugins/example/resources/public.txt"),"tracked");
  for(const args of [["init","--quiet"],["add","resources/builtin/removed.txt","plugins/example/resources/public.txt"]])expect(await Bun.spawn(["git",...args],{cwd:root,stdout:"ignore",stderr:"ignore"}).exited).toBe(0);
  await rm(join(root,"resources/builtin/removed.txt"));
  await writeFile(join(root,"resources/builtin/new.txt"),"new");
  await writeFile(join(root,"plugins/example/resources/private.txt"),"private");
  const run=()=>Bun.spawn([process.execPath,"scripts/update.ts"],{cwd:root,stdout:"ignore",stderr:"ignore"}).exited;
  expect(await run()).toBe(0);
  const result=JSON.parse(await readFile(join(root,"resources/builtin/manifest.json"),"utf8"));
  expect(result.files.map((x:{path:string})=>x.path)).toEqual(["plugins/example/resources/public.txt","resources/builtin/new.txt"]);
  await rm(join(root,"plugins/example/resources/public.txt"));
  expect(await run()).not.toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
});
