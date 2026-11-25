import {expect,test} from "bun:test";
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm} from "node:fs/promises";
import {dirname,join} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
import {stageLegacyGlobalConfig} from "../lib/migration-global-config.ts";
import {stageLegacyNetworkConfig} from "../lib/migration-network-config.ts";
import {readLocalConfig} from "../lib/config.ts";
import {readServerSettings,parseServerSettings} from "../lib/server.ts";
import {captchaConfig,createAutomaticProviders} from "../lib/captcha/providers.ts";
import {createCaptchaService} from "../lib/captcha/service.ts";
import {createManualCaptchaRelay} from "../lib/captcha/manual-relay.ts";

const mockFetch = (implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch =>
 Object.assign(implementation, { preconnect() {} });

async function fixture(run:(source:string,stage:string)=>Promise<void>){
 const parent=await mkdtemp(join(tmpdir(),"lotus-captcha-migrate-"));
 try{const source=join(parent,"old"),stage=join(parent,"stage");await mkdir(source);await mkdir(stage,{mode:0o700});await run(source,stage)}
 finally{await rm(parent,{recursive:true,force:true})}
}
async function put(root:string,path:string,value:unknown){const file=join(root,path);await mkdir(dirname(file),{recursive:true});const text=Bun.YAML.stringify(value);await writeFile(file,text,{mode:0o600});return text}
const sourceCaptcha={enable:true,providers:["ttocr","test_nine","gtmanual"],test_nine:{enable:false,timeout_ms:32100,endpoint:"http://obsolete.invalid/pass_uni"},
 ttocr:{enable:true,key:"synthetic-ttocr-key",api:"https://ocr.invalid/submit",resapi:"https://ocr.invalid/result",query:"itemid=399&referer=https%3A%2F%2Frefer.invalid%2F",itemid_v4:499,timeout_ms:45000,poll_interval_ms:2500},
 gtmanual:{enable:true,verify_addr:"https://gt.invalid/GTest/register?key=synthetic-old-key"}};
for(const generation of [1,2])test(`第${generation}代验证码启用/顺序/密钥和query被真实provider消费，人工域名独立`,()=>fixture(async(source,stage)=>{
 const prefix="plugins/Lotus-Plugin";
 if(generation===1)await put(source,`${prefix}/MihoyoBBSTools/config/42.yaml`,{enable:false});
 const path=`${prefix}/config/${generation===1?"config.yaml":"global.yaml"}`;
 const original=await put(source,path,{captcha:sourceCaptcha});
 await put(source,"config/config/server.yaml",{port:43326,onebot_port:43327,url:"https://main.invalid",panel_url:"https://panel.invalid",web_mount:{directory:"/srv/public",socket:"/run/public.sock"}});
 await stageLegacyNetworkConfig(source,stage);
 const report=await stageLegacyGlobalConfig(source,stage);
 expect(report.sections).toContain("captcha");expect(report).toMatchObject({deferredCaptcha:["captcha.manual.reverse_proxy"]});
 const root=pathToFileURL(stage+"/"),config=captchaConfig((await readLocalConfig(root,"global")).captcha);
 expect(config).toMatchObject({enabled:true,order:["ttocr","local","manual"],local:{enabled:false,timeoutMs:32100},manual:{enabled:true},ttocr:{enabled:true,key:"synthetic-ttocr-key",itemid:"399",itemidV4:"499",referer:"https://refer.invalid/",timeoutMs:45000,pollMs:2500}});
 expect((await lstat(join(stage,"config/global.yaml"))).mode&0o777).toBe(0o600);
 expect(JSON.stringify(report)).not.toContain("synthetic-ttocr-key");expect(JSON.stringify(report)).not.toContain("synthetic-old-key");
 let submittedV3=false;
 const requests:Array<{url:string;body:URLSearchParams}>=[];
 const providers=createAutomaticProviders(config,{wait:async()=>{},fetchImpl:mockFetch(async(input,init)=>{
  const url=String(input),body=new URLSearchParams(String(init?.body));requests.push({url,body});
  if(url===config.ttocr.api){submittedV3=body.has("challenge");return Response.json({status:1,resultid:"synthetic-task"})}
  if(url!==config.ttocr.resultApi)throw Error("不应访问真实服务");
  if(submittedV3)return Response.json({status:1,data:{challenge:"legacy-challenge",validate:"proof3",seccode:"proof3|jordan"}});
  return Response.json({status:1,data:{captcha_id:"site",lot_number:"lot",captcha_output:"output",pass_token:"proof",gen_time:"1234"}});
 })});
 expect(providers.available("local")).toBe(false);expect(providers.available("ttocr")).toBe(true);
 expect(await providers.solve("ttocr",{captchaVersion:4,captchaId:"site"},new AbortController().signal)).toMatchObject({lotNumber:"lot"});
 expect(requests[0]!.body.get("key")).toBe("synthetic-ttocr-key");expect(requests[0]!.body.get("itemid")).toBe("499");expect(requests[0]!.body.get("referer")).toBe("https://refer.invalid/");
 expect(requests[1]!.body.get("key")).toBe("synthetic-ttocr-key");
 expect(await providers.solve("ttocr",{captchaVersion:3,gt:"legacy-gt",challenge:"legacy-challenge"},new AbortController().signal)).toMatchObject({validate:"proof3"});
 expect(requests[2]!.body.get("itemid")).toBe("399");expect(requests[2]!.body.get("challenge")).toBe("legacy-challenge");
 await providers.close();
 const network=await readServerSettings(root,{});expect(network.http?.port).toBe(43326);expect(network.oneBot?.port).toBe(43327);
 expect(network.publicUrl?.hostname).toBe("main.invalid");expect(network.panelPublicUrl?.hostname).toBe("panel.invalid");expect(network.manualCaptchaUrl).toBe("https://gt.invalid");
 expect(network.webMount).toEqual({directory:"/srv/public",socket:"/run/public.sock"});
 const relay=createManualCaptchaRelay({publicUrl:network.manualCaptchaUrl!});
 try{const ticket=await relay.register({captchaVersion:4,captchaId:"site"},new AbortController().signal);expect(ticket?.link).toStartWith("https://gt.invalid/captcha/manual/")}finally{relay.close()}
 expect(await readFile(join(source,path),"utf8")).toBe(original);
}));

test("显式server人工域名优先于旧注册API，禁用自动节点保持关闭",()=>fixture(async(source,stage)=>{
 await put(source,"config/config/server.yaml",{port:0,onebot_port:0,captcha:{url:"https://explicit-gt.invalid/proxy"}});
 await put(source,"plugins/Lotus-ReFactor/config/global.yaml",{captcha:{...sourceCaptcha,enable:false,ttocr:{...sourceCaptcha.ttocr,enable:false},gtmanual:{enable:false}}});
 await stageLegacyNetworkConfig(source,stage);const report=await stageLegacyGlobalConfig(source,stage);
 expect(report).not.toHaveProperty("deferredCaptcha");
 const root=pathToFileURL(stage+"/"),network=await readServerSettings(root,{}),config=captchaConfig((await readLocalConfig(root,"global")).captcha);
 expect(network.manualCaptchaUrl).toBe("https://explicit-gt.invalid/proxy");expect(network.http?.port).toBe(0);expect(network.oneBot?.port).toBe(0);
 expect(config.enabled).toBe(false);expect(config.ttocr.enabled).toBe(false);expect(config.manual.enabled).toBe(false);
}));

test("未知旧人工API路径只报告待核，不猜测反代base；扁平旧验证码字段正常转为provider",()=>fixture(async(source,stage)=>{
 await put(source,"plugins/Lotus-Plugin/config/global.yaml",{captcha:{type:1,api:"https://ocr.invalid/submit",resapi:"https://ocr.invalid/result",key:"synthetic-flat-key",query:"itemid=400",verifyAddr:"https://gt.invalid/custom/register?key=synthetic"}});
 const report=await stageLegacyGlobalConfig(source,stage);expect(report).toMatchObject({deferredCaptcha:["captcha.manual.legacy_endpoint"]});
 const root=pathToFileURL(stage+"/"),config=captchaConfig((await readLocalConfig(root,"global")).captcha);
 expect(config.ttocr).toMatchObject({key:"synthetic-flat-key",itemid:"400",enabled:true});expect((await readServerSettings(root,{})).manualCaptchaUrl).toBeUndefined();
}));

test("网络端口环境优先、显式关闭WS和非法端口校验一致",()=>{
 expect(parseServerSettings({port:43326,onebot_port:43327},{LOTUS_HTTP_PORT:"0",LOTUS_ONEBOT_PORT:"0"})).toMatchObject({http:{port:0},oneBot:{port:0}});
 expect(parseServerSettings({port:0,onebot_port:0,onebot_enable:false},{}).oneBot).toBeUndefined();
 for(const onebot_port of [-1,65536,"bad"])expect(()=>parseServerSettings({onebot_port},{})).toThrow();
});

test("迁入本地节点真正内部调用，节点顺序由service使用而非旧HTTP地址",()=>fixture(async(source,stage)=>{
 await put(source,"plugins/Lotus-Plugin/config/global.yaml",{captcha:{enable:true,providers:["test_nine","ttocr"],test_nine:{enable:true,timeout_ms:42000,endpoint:"http://obsolete.invalid/pass_uni"},ttocr:{enable:false,key:"synthetic-disabled-key"}}});
 await stageLegacyGlobalConfig(source,stage);
 const raw=(await readLocalConfig(pathToFileURL(stage+"/"),"global")).captcha,config=captchaConfig(raw);
 let solved=0;
 const providers=createAutomaticProviders(config,{fetchImpl:mockFetch(async()=>{throw Error("禁止请求旧HTTP或真实服务")}),createLocalSolver:async()=>({
  solve:async(input)=>{expect(input).toMatchObject({version:4,captcha_id:"site"});solved++;return{version:4,captcha_id:"site",lot_number:"lot",captcha_output:"output",pass_token:"proof",gen_time:"1234"}},close:async()=>{}
 })});
 const service=createCaptchaService({config:raw,providers});
 try{expect(await service.run({signal:new AbortController().signal,verify:async()=>{},challenge:async()=>({captchaVersion:4,captchaId:"site"}),accept:async()=>({accepted:true,value:"accepted"})})).toEqual({ok:true,value:"accepted"});expect(solved).toBe(1);expect(config.local.timeoutMs).toBe(42000)}finally{await service.close()}
}));

test("迁移明确关闭OneBot时不误报缺少令牌，也不丢独立面板/验证码地址",()=>fixture(async(source,stage)=>{
 await put(source,"config/config/server.yaml",{port:0,onebot_enable:false,panel_url:"https://panel.invalid",captcha:{url:"https://gt.invalid"}});
 const report=await stageLegacyNetworkConfig(source,stage);expect(report.deferred).toEqual([]);
 const network=await readServerSettings(pathToFileURL(stage+"/"),{});expect(network.oneBot).toBeUndefined();expect(network.http?.port).toBe(0);expect(network.panelPublicUrl?.hostname).toBe("panel.invalid");expect(network.manualCaptchaUrl).toBe("https://gt.invalid");
}));

for(const captcha of [{type:1,key:"synthetic-key-only"},{key:"synthetic-key-only"}])test("嵌套旧验证码仅密钥也采用默认TTOCR接口，不丢密钥",()=>fixture(async(source,stage)=>{
 await put(source,"plugins/Lotus-Plugin/config/global.yaml",{captcha});await stageLegacyGlobalConfig(source,stage);
 expect(captchaConfig((await readLocalConfig(pathToFileURL(stage+"/"),"global")).captcha).ttocr).toMatchObject({enabled:true,key:"synthetic-key-only",api:"http://api.ttocr.com/api/recognize",resultApi:"http://api.ttocr.com/api/results"});
}));

test("旧人工验证小写地址与类型字段迁入有效节点及独立域名",()=>fixture(async(source,stage)=>{
 await put(source,"plugins/Lotus-Plugin/config/global.yaml",{captcha:{address:"https://manual.example.invalid"}});
 const report=await stageLegacyGlobalConfig(source,stage);
 expect(captchaConfig((await readLocalConfig(pathToFileURL(stage+"/"),"global")).captcha).order).toContain("manual");
 expect((await readServerSettings(pathToFileURL(stage+"/"),{})).manualCaptchaUrl).toBe("https://manual.example.invalid");
 expect(report.deferredCaptcha).toContain("captcha.manual.reverse_proxy");
 const {normalizeLegacyCaptchaGlobal}=await import("../lib/migration-captcha-config.ts");
 expect(normalizeLegacyCaptchaGlobal({captcha:{gtestType:2}}).captcha).toHaveProperty("gtmanual");
 expect(normalizeLegacyCaptchaGlobal({address:"https://unrelated.example.invalid"})).not.toHaveProperty("captcha");
}));

test("全局不相关key不当验证码；明确TTOCR类型加密钥及混合旧配置保留显式新字段",()=>fixture(async(source,stage)=>{
 await put(source,"plugins/Lotus-Plugin/config/global.yaml",{key:"unrelated-config-key",type:"music"});await stageLegacyGlobalConfig(source,stage);
 expect((await readLocalConfig(pathToFileURL(stage+"/"),"global")).captcha).toBeUndefined();
 const {normalizeLegacyCaptchaGlobal,projectLegacyCaptchaConfig}=await import("../lib/migration-captcha-config.ts");
 const raw=normalizeLegacyCaptchaGlobal({type:"ttocr",key:"synthetic-root-key"});expect(captchaConfig(projectLegacyCaptchaConfig(raw.captcha)).ttocr.key).toBe("synthetic-root-key");
 const mixed=normalizeLegacyCaptchaGlobal({captcha:{type:1,key:"synthetic-old-key",ttocr:{enable:false,key:"synthetic-explicit-key"}}});
 expect(captchaConfig(projectLegacyCaptchaConfig(mixed.captcha)).ttocr).toMatchObject({enabled:false,key:"synthetic-explicit-key"});
}));
