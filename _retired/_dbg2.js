const fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=path.resolve(__dirname,'..');
function makeEl(t){const c=new Set();const s={_p:{},setProperty(k,v){this._p[k]=String(v);this[k]=String(v);},removeProperty(k){delete this._p[k];delete this[k];},getPropertyValue(k){return this._p[k]||'';}};
const e={tagName:String(t||'div').toUpperCase(),children:[],childNodes:[],style:s,dataset:{},_text:'',_html:'',_attrs:{},
classList:{add:(...x)=>x.forEach(y=>y&&c.add(y)),remove:(...x)=>x.forEach(y=>c.delete(y)),contains:x=>c.has(x),toggle(x,f){const on=f===undefined?!c.has(x):!!f;on?c.add(x):c.delete(x);return on;}},
get className(){return Array.from(c).join(' ');},set className(v){c.clear();String(v).split(/\s+/).filter(Boolean).forEach(x=>c.add(x));},
get textContent(){return this._text;},set textContent(v){this._text=String(v);},
get innerHTML(){return this._html;},set innerHTML(v){this._html=String(v);this.children=[];this.childNodes=[];},
appendChild(x){this.children.push(x);this.childNodes.push(x);return x;},append(...x){x.forEach(y=>this.appendChild(y));},prepend(x){this.children.unshift(x);return x;},insertBefore(x){this.children.unshift(x);return x;},removeChild(x){const i=this.children.indexOf(x);if(i>=0)this.children.splice(i,1);return x;},replaceChildren(...x){this.children=x;this.childNodes=x;},remove(){},
setAttribute(k,v){this._attrs[k]=String(v);if(k==='class')this.className=v;},getAttribute(k){return Object.prototype.hasOwnProperty.call(this._attrs,k)?this._attrs[k]:null;},hasAttribute(k){return Object.prototype.hasOwnProperty.call(this._attrs,k);},removeAttribute(k){delete this._attrs[k];},
addEventListener(){},removeEventListener(){},dispatchEvent(){},querySelector(){return makeEl('div');},querySelectorAll(){return [];},closest(){return null;},contains(){return false;},matches(){return false;},
focus(){},blur(){},click(){},scrollIntoView(){},scrollTo(){},getBoundingClientRect(){return{top:0,left:0,right:100,bottom:100,width:100,height:100};},cloneNode(){return makeEl(this.tagName);},animate(){return{finished:Promise.resolve(),cancel(){}};}};return e;}
const IDS={},SEL={};
const doc={createElement:makeEl,createElementNS:(n,t)=>makeEl(t),createTextNode:t=>{const e=makeEl('#text');e.textContent=t;return e;},createDocumentFragment:()=>makeEl('#f'),body:makeEl('body'),documentElement:makeEl('html'),head:makeEl('head'),activeElement:null,
getElementById(id){if(!IDS[id])IDS[id]=makeEl('div');return IDS[id];},querySelector(s){if(!SEL[s])SEL[s]=makeEl('div');return SEL[s];},querySelectorAll(){return[];},addEventListener(){},removeEventListener(){},readyState:'complete'};
const LS=Object.create(null);
const ls={get length(){return Object.keys(LS).length;},key(i){return Object.keys(LS)[i]===undefined?null:Object.keys(LS)[i];},getItem(k){return Object.prototype.hasOwnProperty.call(LS,k)?LS[k]:null;},setItem(k,v){LS[k]=String(v);},removeItem(k){delete LS[k];},clear(){Object.keys(LS).forEach(k=>delete LS[k]);}};
const noop=()=>{};function SC(){return{observe:noop,disconnect:noop,unobserve:noop,addEventListener:noop};}
const win={document:doc,localStorage:ls,navigator:{userAgent:'dbg',language:'zh-CN'},location:{href:'file:///x',protocol:'file:',search:'',hash:''},history:{replaceState:noop,pushState:noop},console,innerWidth:390,innerHeight:844,devicePixelRatio:1,
setTimeout:f=>setTimeout(f,0),clearTimeout,setInterval:()=>0,clearInterval:noop,requestAnimationFrame:f=>setTimeout(f,0),cancelAnimationFrame:noop,
matchMedia:()=>({matches:false,addEventListener:noop,removeEventListener:noop,addListener:noop,removeListener:noop}),getComputedStyle:()=>({getPropertyValue:()=>'',setProperty:noop}),
addEventListener:noop,removeEventListener:noop,scrollTo:noop,alert:noop,confirm:()=>true,prompt:()=>'',Blob:function(){},File:function(){},FileReader:function(){},
URL:{createObjectURL:()=>'blob:x',revokeObjectURL:noop},fetch:()=>Promise.reject(new Error('offline')),Audio:function(){},CustomEvent:function(){},Event:function(){},
MutationObserver:SC,IntersectionObserver:SC,ResizeObserver:SC,Element:SC,HTMLElement:SC,Node:SC,SVGElement:SC,EventTarget:SC};
win.window=win;win.self=win;win.globalThis=win;win.top=win;win.parent=win;
const ctx=vm.createContext(win);
['Error','JSON','Math','Date','Object','Array','String','Number','Boolean','Promise','RegExp','Map','Set','WeakMap','WeakSet','Symbol','Proxy','Reflect','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent','setTimeout','clearTimeout','setInterval','clearInterval','console'].forEach(k=>{try{ctx[k]=globalThis[k];}catch(e){}});
['store.js','core.js'].forEach(f=>vm.runInContext(fs.readFileSync(path.join(ROOT,f),'utf8'),ctx,{filename:f}));

const S=win.Sleepy,C=S.core;
const m=C.upsertChar({name:'大号',kind:'main'});
const s=C.upsertChar({name:'皮套',kind:'sub',parentId:m.id});
const u=C.upsertUser({name:'小雨'});
C.addLink(s.id,u.id,'unaware',true);
C.addMemory({charId:s.id,userId:u.id,role:'user',text:'皮套说的话'});
C.addMemory({charId:m.id,userId:u.id,role:'assistant',text:'大号说的话'});
console.log('掉马前 cognitionOf =',JSON.stringify(C.cognitionOf(s.id,u.id)));
console.log('掉马前 view =',C.memoryViewFor(s.id,u.id).mode, C.memoryViewFor(s.id,u.id).items.length);
const ev=C.unmask(s.id,u.id,'测试');
console.log('');
console.log('unmask 返回 ev.link =',JSON.stringify(ev.link));
console.log('unmask 后 cognitionOf =',JSON.stringify(C.cognitionOf(s.id,u.id)));
console.log('unmask 后 findLink =',JSON.stringify(C.findLink(s.id,u.id)));
console.log('unmask 后 allLinks =',JSON.stringify(C.allLinks()));
const v=C.memoryViewFor(s.id,u.id);
console.log('unmask 后 view =',v.mode,v.items.length);
