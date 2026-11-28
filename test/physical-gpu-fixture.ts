import {createRequire} from "node:module";
let probe: Promise<{available:boolean;reason?:string}> | undefined;
export function physicalGpuFixture() {
  return probe ??= (async () => {
    if (Bun.env.LOTUS_TEST_DISABLE_GPU === '1') return {available:false,reason:'LOTUS_TEST_DISABLE_GPU=1'};
    try {
      const {Canvas}=createRequire(new URL('../packages/skia/index.ts',import.meta.url))('skia-canvas');
      const canvas=new Canvas(2,2);canvas.gpu=true;canvas.getContext('2d').fillRect(0,0,2,2);
      await canvas.toBuffer('png');
      const engine=canvas.engine;
      if(engine.renderer!=='GPU'||!engine.device||/llvmpipe|lavapipe|swiftshader|software/iu.test(engine.device)) throw Error(JSON.stringify(engine));
      return {available:true};
    } catch(error) {return {available:false,reason:error instanceof Error?error.message:String(error)};}
  })();
}

export const functionalRenderingPreload = `
Bun.env.LOTUS_SKIA_MODE='gpu';
const {Canvas:FunctionalCanvas}=require('./packages/skia/node_modules/skia-canvas');
FunctionalCanvas.prototype.toBuffer=async function(){throw Error('rendering disabled in functional fixture');};
`;

export const physicalRenderingPreload = `
Bun.env.LOTUS_SKIA_MODE='gpu';
const {Canvas:PhysicalCanvas}=require('./packages/skia/node_modules/skia-canvas');
const physicalToBuffer=PhysicalCanvas.prototype.toBuffer;
PhysicalCanvas.prototype.toBuffer=async function(...args){
  const output=await physicalToBuffer.call(this,...args);
  const engine=this.engine;
  if(engine.renderer!=='GPU'||!engine.device||/llvmpipe|lavapipe|swiftshader|software/i.test(engine.device))
    throw Error('fixture requires a physical GPU renderer');
  require('node:fs').appendFileSync('renderers.jsonl',JSON.stringify(engine)+'\\n');
  return output;
};
`;
