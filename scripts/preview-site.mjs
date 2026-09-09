import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep, extname } from "node:path";

const root = await realpath(resolve("landing"));
const port = Number(process.argv[2] || 4194);
const mime = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".jpg":"image/jpeg", ".png":"image/png", ".svg":"image/svg+xml", ".pdf":"application/pdf", ".txt":"text/plain; charset=utf-8", ".zip":"application/zip", ".sha256":"text/plain" };
createServer(async (req,res)=>{
  if(!["GET","HEAD"].includes(req.method)){res.writeHead(405);res.end();return;}
  try{
    const path=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
    if(path.split("/").some(p=>p.startsWith(".")))throw Error("Hidden path");
    let target=resolve(root,`.${path}`);
    if((await stat(target)).isDirectory())target=resolve(target,"index.html");
    target=await realpath(target);
    const rel=relative(root,target);
    if(isAbsolute(rel)||rel===".."||rel.startsWith(`..${sep}`)||!mime[extname(target)])throw Error("Outside public assets");
    const body=await readFile(target);res.writeHead(200,{"Content-Type":mime[extname(target)],"Cache-Control":"no-store","Access-Control-Allow-Origin":"*","X-Content-Type-Options":"nosniff"});res.end(req.method==="HEAD"?undefined:body);
  }catch{res.writeHead(404);res.end("Not found");}
}).listen(port,"127.0.0.1",()=>console.log(`Public website preview http://127.0.0.1:${port}/`));
