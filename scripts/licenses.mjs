import {readdir,readFile,writeFile} from 'node:fs/promises';
const packageDirs=[];
for(const item of await readdir('node_modules',{withFileTypes:true})){
 if(!item.isDirectory()||item.name.startsWith('.'))continue;
 if(item.name.startsWith('@'))for(const sub of await readdir('node_modules/'+item.name,{withFileTypes:true}))if(sub.isDirectory())packageDirs.push(`node_modules/${item.name}/${sub.name}`);
 else{};
 if(!item.name.startsWith('@'))packageDirs.push(`node_modules/${item.name}`);
}
let output='Third-party packages used to build or test this local review.\nVersions are locked in package-lock.json.\n\n';
for(const dir of packageDirs.sort()){
 try{
  const pkg=JSON.parse(await readFile(dir+'/package.json','utf8'));
  const names=await readdir(dir);const files=names.filter(n=>/^(licen[cs]e|copying|notice)(\.|$)/i.test(n));
  output+=`\n${'='.repeat(60)}\n${pkg.name} ${pkg.version} — ${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license)}\n`;
  for(const name of files){try{output+=`\n${name}\n${await readFile(dir+'/'+name,'utf8')}\n`;}catch{}}
 }catch{}
}
await writeFile('THIRD_PARTY_LICENSES.txt',output);
console.log('Third-party license notices collected.');
