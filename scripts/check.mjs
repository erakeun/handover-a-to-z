import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
let failed=false;
for(const folder of ['src','scripts','tests'])for(const name of await readdir(folder)){
 if(!/\.(mjs|js)$/.test(name))continue;
 const result=spawnSync(process.execPath,['--check',`${folder}/${name}`],{encoding:'utf8'});
 if(result.status!==0){console.error(result.stderr);failed=true;}
}
const app=await readFile('src/app.js','utf8');
if(/\.innerHTML\s*=|insertAdjacentHTML|eval\s*\(/.test(app)){console.error('Unsafe dynamic HTML or eval detected');failed=true;}
if(failed)process.exitCode=1;else console.log('모든 소스 문법 확인 · 앱의 동적 HTML/eval 미사용 확인');
