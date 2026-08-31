import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureVault, atomicWrite, frontmatter, stableId } from "../src/vault";
import { openIndex, syncVault, setEmbedderForTests } from "../src/index";
import { recall } from "../src/retrieval";
import { Budgets } from "../src/config";

const BEAM_ROOT = "D:/KEB/consol/.research/BEAM/chats";
const STOP = new Set(["should","contain","mention","state","the","and","for","with","that","have","you","also","your","from","into","been","being","this","these","about","over","there","what","which","when","where","how","will","would","could","might","response","llm","based","provided","chat","there","information","related"]);

function keywords(text: string): string[] {
  const clean = text
    .replace(/^llm response should (?:state|contain|mention):\s*/i, "")
    .replace(/^based on the provided chat,\s*/i, "")
    .replace(/[^a-z0-9 ]/gi, " ")
    .toLowerCase();
  return clean.split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
}

function scoreRubric(retrievedText: string, rubric: string[]): number {
  if (!rubric.length) return 1.0;
  let sum = 0;
  for (const item of rubric) {
    const ks = keywords(item);
    if (!ks.length) { sum += 1; continue; }
    const hits = ks.filter(k => retrievedText.includes(k)).length;
    const r = hits / ks.length;
    sum += r >= 0.5 ? 1.0 : r >= 0.3 ? 0.5 : 0.0;
  }
  return sum / rubric.length;
}

function extractMessages10M(chatData: any): any[] {
  const out: any[] = [];
  // 10M: object with keys "0".."9", each { "plan-N": [ {batch_number, turns:[[msg,msg],...]} ] }
  for (const key of Object.keys(chatData)) {
    const v = chatData[key];
    if (!v || typeof v !== "object") continue;
    for (const planKey of Object.keys(v)) {
      const batches = (v as any)[planKey];
      if (!Array.isArray(batches)) continue;
      for (const b of batches) {
        for (const turn of (b.turns || [])) {
          for (const msg of turn) if (msg.role === "user" && msg.content) out.push(msg);
        }
      }
    }
  }
  return out;
}
function extractMessages1M(chatData: any[]): any[] {
  const out: any[] = [];
  for (const b of chatData) for (const turn of (b.turns||[])) for (const msg of turn) if (msg.role==="user" && msg.content) out.push(msg);
  return out;
}

async function evalDataset(dataset: "10M"|"1M", budgets: any) {
  const base = path.join(BEAM_ROOT, dataset);
  const dirs = fs.readdirSync(base).filter(f => { try{return fs.statSync(path.join(base,f)).isDirectory();}catch{return false;}}).sort((a,b)=>Number(a)-Number(b));
  const cats = ["abstention","contradiction_resolution","event_ordering","information_extraction","instruction_following","knowledge_update","multi_session_reasoning","preference_following","summarization","temporal_reasoning"];
  const catStats: Record<string,{sum:number,total:number,toks:number[],lats:number[]}> = {};
  for(const c of cats) catStats[c]={sum:0,total:0,toks:[],lats:[]};
  let totalScore=0, totalQ=0;
  let allLats:number[]=[], allToks:number[]=[];

  for(const d of dirs) {
    const chatPath = path.join(base,d,"chat.json");
    const pqPath = path.join(base,d,"probing_questions","probing_questions.json");
    if(!fs.existsSync(pqPath) || !fs.existsSync(chatPath)) continue;
    const chatRaw = JSON.parse(fs.readFileSync(chatPath,"utf8"));
    const pq = JSON.parse(fs.readFileSync(pqPath,"utf8"));
    const messages = dataset==="10M" ? extractMessages10M(chatRaw) : extractMessages1M(chatRaw);

    const vault = fs.mkdtempSync(path.join(os.tmpdir(), `honest-${dataset}-${d}-`));
    const { agentRoot } = await ensureVault(vault, "user");
    const db = openIndex(agentRoot);
    setEmbedderForTests(async (texts:string[])=>texts.map(()=>new Array(384).fill(0.01)), vault);

    const now = new Date().toISOString();
    const chunkSize = dataset==="10M" ? 50 : 25;
    for(let i=0;i<messages.length;i+=chunkSize){
      const slice = messages.slice(i,i+chunkSize);
      const combined = slice.map((m:any)=>String(m.content||"").replace(/->->.*$/,"").trim()).filter((c:string)=>c.length>5).join("\n\n");
      if(combined.length>10){
        const id = stableId("mem-");
        const file = path.join(agentRoot,"memories",id+".md");
        const fm = frontmatter("memory", id, { status:"active", updated: now, created_by:"user" } as any);
        await atomicWrite(file, fm+combined+"\n");
      }
    }
    await syncVault(db, vault, agentRoot, "user");

    for(const cat of cats){
      const qList = (pq[cat]||[]) as any[];
      for(const q of qList){
        const t0 = performance.now();
        const packet: any = await recall(db, vault, q.question, budgets, "agent:user");
        const lat = performance.now()-t0;
        const retrievedText = (packet.items||[]).map((it:any)=>String(it.summary||"")).join("\n").toLowerCase() + "\n" + (packet.wire||"").toLowerCase();
        const toks = packet.attribution?.packetTokensEstimate ?? Math.ceil(retrievedText.length/4);
        const s = scoreRubric(retrievedText, q.rubric||[]);
        catStats[cat].sum += s; catStats[cat].total++; catStats[cat].toks.push(toks); catStats[cat].lats.push(lat);
        totalScore+=s; totalQ++; allLats.push(lat); allToks.push(toks);
      }
    }
    db.close();
    try{ fs.rmSync(vault,{recursive:true,force:true}); }catch{}
  }

  allLats.sort((a,b)=>a-b);
  const p50 = allLats.length ? allLats[Math.floor(allLats.length*0.5)] : 0;
  const avgTok = allToks.length ? Math.round(allToks.reduce((a,b)=>a+b,0)/allToks.length) : 0;
  const overall = totalQ ? (totalScore/totalQ)*100 : 0;
  const breakdown: any = {};
  for(const c of cats){
    const s = catStats[c];
    breakdown[c] = s.total ? { acc: Math.round((s.sum/s.total)*1000)/10, total: s.total, avgTok: Math.round(s.toks.reduce((a,b)=>a+b,0)/Math.max(1,s.toks.length)), p50: Math.round(s.lats.sort((a,b)=>a-b)[Math.floor(s.lats.length*0.5)]*100)/100 } : {acc:0,total:0};
  }
  return { dataset, overall: Math.round(overall*10)/10, avgTok, p50: Math.round(p50*100)/100, totalQ, breakdown };
}

const budgets = Budgets.parse({ perArmCap: 60 });
const r10 = await evalDataset("10M", budgets);
const r1 = await evalDataset("1M", budgets);
const out = { r10, r1, budgets: budgets };
console.log(JSON.stringify(out,null,2));
fs.writeFileSync("bench_honest_output.json", JSON.stringify(out,null,2));
