import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resourceRoot } from './market.js';
export function dreamThemeSource(config:Record<string,any>,targetPlatform:NodeJS.Platform=process.platform):string{
  const platform=targetPlatform==='win32'?'windows':'macos';const choice=String(config.theme||'dream');
  const roots:Record<string,string>={dream:`upstream/dream-skin/${platform}`,tiger:`upstream/cidala-tiger/${platform}`,snow:'upstream/snow-skin',glass:'upstream/glass-vision'};
  const inject=path.join(resourceRoot(),'assets','inject'),root=path.join(inject,roots[choice]||roots.dream);
  const css=fs.readFileSync(path.join(root,choice==='glass'?'glass-vision.css':'dream-skin.css'),'utf8')+'\n'+fs.readFileSync(path.join(inject,'dream-skin-native-shell-compat.css'),'utf8');
  let image=path.join(inject,`upstream/dream-skin/${platform}/${platform==='windows'?'dream-reference.jpg':'portal-hero.png'}`);
  if(config.imagePath)image=path.resolve(config.imagePath);
  const stat=fs.lstatSync(image);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>12*1024*1024)throw new Error('主题背景图不是受支持的普通图片');
  const type:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
  if(!type[path.extname(image).toLowerCase()])throw new Error('主题背景支持 PNG、JPG、WebP、GIF');
  const art=`data:${type[path.extname(image).toLowerCase()]};base64,${fs.readFileSync(image).toString('base64')}`,theme={};
  const revision=createHash('sha256').update(css).update(art).digest('hex').slice(0,20);
  let code=fs.readFileSync(path.join(root,'renderer-inject.js'),'utf8');
  const values:Record<string,string>={CSS:JSON.stringify(css),ART:JSON.stringify(art),THEME:JSON.stringify(theme),VERSION:JSON.stringify('yunhui.me'),STYLE_REVISION:JSON.stringify(revision),PAYLOAD_REVISION:JSON.stringify(revision)};
  code=code.replace(/__(?:DREAM_SKIN|DREAM|GLASS_VISION)_(CSS|ART|THEME|VERSION|STYLE_REVISION|PAYLOAD_REVISION)_JSON__/g,(_,key)=>values[key]);
  if(/__(?:DREAM_SKIN|DREAM|GLASS_VISION)_[A-Z_]+_JSON__/.test(code))throw new Error('主题模板不兼容');
  return `window.__CODEX_PLUS_EXTERNAL_DREAM_SKIN_RUNTIME__=true;window.__CODEX_PLUS_DREAM_SKIN_THEME__=${JSON.stringify(theme)};window.__CODEX_PLUS_DREAM_SKIN_PLATFORM__=${JSON.stringify(platform)};window.__CODEX_PLUS_DREAM_SKIN_ART__=${JSON.stringify(art)};window.__CODEX_PLUS_DREAM_SKIN_RUNTIME_REVISION__=${JSON.stringify(revision)};window.__CODEX_PLUS_DREAM_SKIN_TARGET_ENGINE__=${JSON.stringify(choice)};\n${code};`;
}
