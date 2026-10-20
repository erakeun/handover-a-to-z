import {build} from 'esbuild';
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/app.js'],outfile:'dist/app.js',bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:false,sourcemap:false,legalComments:'eof',external:['node:fs','node:module','node:path','node:url'],logLevel:'info'});
await copyFile('styles.css','dist/styles.css');
let html=await readFile('index.html','utf8');
for(const path of ['app.js','styles.css']){
 const digest=createHash('sha256').update(await readFile(`dist/${path}`)).digest('hex').slice(0,12);
 html=html.replace(`"./${path}"`,`"./${path}?v=${digest}"`);
}
await writeFile('dist/index.html',html);
await mkdir('dist/assets',{recursive:true});
await copyFile('assets/mach-selected-A.svg','dist/assets/mach-selected-A.svg');
await copyFile('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs','dist/pdf.worker.min.mjs');
await copyFile('THIRD_PARTY_LICENSES.txt','dist/THIRD_PARTY_LICENSES.txt');
await writeFile('dist/.nojekyll','');
const pkg=JSON.parse(await readFile('package.json','utf8'));
await writeFile('dist/version.json',JSON.stringify({name:pkg.name,version:pkg.version,localOnly:true},null,2));
