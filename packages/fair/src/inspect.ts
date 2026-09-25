import { canonicalJson, recordHash } from './record.js';
import { play } from './verify.js';
import { isGameName } from './games/index.js';
import { verifyCommitment, assertClientSeed } from './seeds.js';
import { verifyRecordSignature } from './sign.js';
import { crashResult, verifyCrashLink } from './crash.js';
import type { FairRecord, GameName, GameParams } from './types.js';

export type CheckState = 'matches' | 'mismatch' | 'not-provided' | 'unsupported';
export interface InspectionCheck { name:string; state:CheckState; detail:string }
export interface Inspection { kind:string; status:'matches'|'mismatch'|'incomplete'; computed:unknown; claimed:unknown; checks:InspectionCheck[]; difference:string|null; recordHash?:string|undefined; note:string }
export const MAX_RECORD_BYTES = 64 * 1024;
const hex = /^[0-9a-f]{64}$/;
function object(value:unknown, label:string):Record<string,unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected a JSON object.`);
 return value as Record<string,unknown>;
}
function integer(value:unknown,label:string,min=0,max=Number.MAX_SAFE_INTEGER) {
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${label}: enter a whole number from ${min} to ${max}.`);
 return value;
}
function hash(value:unknown,label:string) {if(typeof value!=='string'||!hex.test(value))throw new Error(`${label}: expected 64 lowercase hexadecimal characters.`);return value;}
function finite(value:unknown,label:string,min:number,max:number) {if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(`${label}: expected a number from ${min} to ${max}.`);return value;}
export function validateInspectionParams(game:GameName,value:unknown):GameParams {
 const p=object(value,'params');
 const fields:Partial<Record<GameName,[string,number,number]>>={limbo:['houseEdge',0,.5],wheel:['segments',2,100],plinko:['rows',8,16],mines:['mines',1,24],keno:['draws',1,40],blackjack:['decks',1,8],hilo:['decks',1,8]};
 const rule=fields[game];
 for(const [key,v] of Object.entries(p)){if(!rule||key!==rule[0])throw new Error(`params.${key}: not supported for ${game}.`);if(key==='houseEdge')finite(v,key,rule[1],rule[2]);else integer(v,key,rule[1],rule[2]);}
 return p as GameParams;
}
function safeTree(value:unknown,depth=0):void {
 if(depth>12)throw new Error('Record nesting is too deep.');
 if(typeof value==='number'&&!Number.isFinite(value))throw new Error('Record numbers must be finite.');
 if(value&&typeof value==='object')for(const v of Object.values(value))safeTree(v,depth+1);
}
export function parseInspection(text:string):Record<string,unknown> {
 if(new TextEncoder().encode(text).length>MAX_RECORD_BYTES)throw new Error('Record is too large. Open a JSON file smaller than 64 KB.');
 let value:unknown;try{value=JSON.parse(text);}catch{throw new Error('Record JSON is incomplete or invalid. Include the opening and closing braces.');}
 safeTree(value);return object(value,'record');
}
function firstDifference(a:unknown,b:unknown,path='result'):string|null {
 if(canonicalJson(a)===canonicalJson(b))return null;
 if(Array.isArray(a)&&Array.isArray(b)){for(let i=0;i<Math.max(a.length,b.length);i++){if(i>=a.length||i>=b.length)return `${path}: recorded and calculated lengths differ (${a.length} / ${b.length}).`;const d=firstDifference(a[i],b[i],`${path}[${i}]`);if(d)return d;}}
 if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){const aa=a as Record<string,unknown>,bb=b as Record<string,unknown>;for(const key of new Set([...Object.keys(aa),...Object.keys(bb)])){if(!(key in aa)||!(key in bb))return `${path}.${key}: field is missing from one result.`;const d=firstDifference(aa[key],bb[key],`${path}.${key}`);if(d)return d;}}
 return `${path}: recorded ${JSON.stringify(a)}, calculated ${JSON.stringify(b)}.`;
}
/** Validates untrusted inputs before running bounded calculations. Shared by browser and API. */
export async function inspectRecord(input:unknown):Promise<Inspection> {
 const r=parseInspection(JSON.stringify(input));
 const checks:InspectionCheck[]=[];
 const add=(name:string,ok:boolean|undefined,detail:string)=>checks.push({name,state:ok===undefined?'not-provided':ok?'matches':'mismatch',detail});
 let computed:unknown=null,kind='',fingerprint:string|undefined;
 const claimed=Object.hasOwn(r,'result')?r.result:null;
 if(Object.hasOwn(r,'gameHash')){
  kind=Object.hasOwn(r,'id')?'Galabet Flight':'Crash';
  if(r.spec!==undefined&&r.spec!=='GFS/1.0')throw new Error('Unsupported calculation version. Expected GFS/1.0.');
  const gameHash=hash(r.gameHash,'gameHash');
  if(typeof r.salt!=='string'||r.salt.length<1||r.salt.length>1024)throw new Error('salt: enter 1–1024 characters.');
  const edge=finite(r.houseEdge,'houseEdge',0,.999999);
  computed=await crashResult(gameHash,r.salt,edge);
  if(Object.hasOwn(r,'result'))finite(r.result,'result',1,Number.MAX_VALUE);
  if(r.commitment!==undefined){hash(r.commitment,'commitment');add('Commitment',await verifyCrashLink(gameHash,r.commitment as string),'SHA-256 of the revealed game hash compared with the supplied commitment.');}
  else add('Commitment',undefined,'No saved commitment supplied.');
  if(r.previousHash!==undefined){hash(r.previousHash,'previousHash');add('Chain link',await verifyCrashLink(gameHash,r.previousHash as string),'This checks one link to the supplied previous hash, not an entire chain.');}
  else if(kind==='Crash')add('Chain link',undefined,'Supply previousHash to check the adjacent chain link.');
  if(r.signature!==undefined||r.signer!==undefined)checks.push({name:'Signature',state:'unsupported',detail:'This Crash/Flight format has no supported signature contract.'});
 }else{
  if(r.spec!=='GFS/1.0')throw new Error('Unsupported calculation version. Expected GFS/1.0.');
  if(r.profile!=='single-player')throw new Error('Unsupported profile. Expected single-player or a Crash/Flight record with gameHash.');
  if(typeof r.game!=='string'||!isGameName(r.game))throw new Error('game: choose one of the nine supported seed-based games.');
  kind=r.game;const params=validateInspectionParams(r.game,r.params);
  if(typeof r.clientSeed!=='string')throw new Error('clientSeed: expected text.');assertClientSeed(r.clientSeed);
  const nonce=integer(r.nonce,'nonce');
  if(r.cursor!==undefined)integer(r.cursor,'cursor');
  if(r.at!==undefined)integer(r.at,'at');
  if(r.commitment!==undefined)hash(r.commitment,'commitment');
  if(r.serverSeed!==undefined){const serverSeed=hash(r.serverSeed,'serverSeed');const out=await play({game:r.game,params,serverSeed,clientSeed:r.clientSeed,nonce});computed=out.result;add('Commitment',r.commitment===undefined?undefined:await verifyCommitment(serverSeed,r.commitment as string),'Compared with the commitment supplied in this record. Publication timing is not checked.');add('Cursor',r.cursor===undefined?undefined:r.cursor===out.cursor,`Calculated cursor: ${out.cursor}.`);}
  else {add('Commitment',undefined,'The server seed has not been revealed.');add('Cursor',undefined,'Reveal the seed before reproducing the calculation.');}
  if(r.signature!==undefined||r.signer!==undefined){
   if(typeof r.signature!=='string'||!/^[0-9a-f]{128}$/.test(r.signature))throw new Error('signature: expected 128 lowercase hexadecimal characters.');hash(r.signer,'signer');
   for(const key of ['result','cursor','at','commitment'])if(!Object.hasOwn(r,key))throw new Error(`${key}: required for a signed record.`);
   try{add('Signature',await verifyRecordSignature(r as unknown as FairRecord),'Checked against the supplied public key. This does not establish the signer’s identity.');}catch{checks.push({name:'Signature',state:'unsupported',detail:'This environment could not perform Ed25519 signature verification.'});}
  }else add('Signature',undefined,'This record is unsigned.');
  if(['result','cursor','at','commitment'].every(k=>Object.hasOwn(r,k)))fingerprint=await recordHash(r as unknown as FairRecord);
 }
 if(r.beacon!==undefined)checks.push({name:'Beacon',state:'unsupported',detail:'External beacon authenticity is not checked by this local verifier.'});
 const difference=claimed!==null&&computed!==null?firstDifference(claimed,computed):null;
 add('Outcome',claimed===null||computed===null?undefined:difference===null,claimed===null?'No original result supplied. This is a calculation only.':computed===null?'The seed must be revealed before comparing outcomes.':difference??'The supplied outcome reproduces exactly.');
 const required=checks.filter(c=>['Outcome',...(kind==='Crash'&&r.previousHash!==undefined?['Chain link']:['Commitment']),...(kind!=='Crash'&&kind!=='Galabet Flight'?['Cursor']:[])].includes(c.name));
 const status=checks.some(c=>c.state==='mismatch')?'mismatch':checks.some(c=>c.state==='unsupported')||required.some(c=>c.state!=='matches')?'incomplete':'matches';
 return {kind,status,computed,claimed,checks,difference,recordHash:fingerprint,note:kind==='Galabet Flight'?'Endpoint checks do not authenticate cash-out timing, stakes or payouts. Those fields are a supplied receipt.':'These checks do not establish when a commitment was published, guarantee a payout or certify an operator.'};
}
