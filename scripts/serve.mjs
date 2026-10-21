import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(fileURLToPath(new URL('../dist/',import.meta.url)));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.pdf':'application/pdf'};
const server=createServer(async(req,res)=>{
 try{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  const url=new URL(req.url,'http://127.0.0.1');
  const target=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
  if(!target.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  const data=await readFile(target);
  res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'});
  res.end(req.method==='HEAD'?undefined:data);
 }catch{res.writeHead(404);res.end('파일을 찾을 수 없습니다.');}
});
const port=Number(process.env.HANDOVER_PORT||4173);
server.listen(port,'127.0.0.1',()=>console.log(`인수인계 A to Z — http://127.0.0.1:${port}\n종료: Ctrl+C · 다른 기기에 공개되지 않습니다.`));
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'포트가 사용 중입니다. HANDOVER_PORT=4174 npm start 로 실행해 주세요.':e.message);process.exitCode=1;});
