// /view — daemon-served read-only fallback page (§21.1 item 9). Token comes from the URL fragment
// (`/view#token=…`, printed by `ate ui`), never from the page itself. Text is rendered via textContent only.
export const VIEW_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ATE · read-only view</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:13px/1.45 ui-monospace,Menlo,monospace;background:#0d0f12;color:#d7dae0;margin:0;padding:16px}
h1{font-size:16px;margin:0 0 8px} h2{font-size:13px;margin:18px 0 6px;color:#8fb3ff}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #222;padding:3px 6px;text-align:left;vertical-align:top}
.ok{color:#5fd38d}.bad{color:#ff6b6b}.muted{color:#7d8590} #footer{position:sticky;bottom:0;background:#0d0f12;padding:6px 0;border-top:1px solid #222}
a{color:#8fb3ff}
</style></head><body>
<h1>ATE — bounded autonomy for AI traders <span class="muted">(read-only)</span></h1>
<div id="err" class="bad"></div>
<h2>Markets</h2><table id="markets"></table>
<h2>Positions</h2><table id="positions"></table>
<h2>Decisions</h2><table id="journal"></table>
<h2>Events</h2><table id="events"></table>
<div id="footer"></div>
<script>
(function(){
var tok=(new URLSearchParams(location.hash.slice(1))).get('token')||'';
var X='https://hsk.blockscout.com';
function el(t,txt,cls){var e=document.createElement(t);if(txt!==undefined)e.textContent=String(txt);if(cls)e.className=cls;return e}
function row(tb,cells,head){var tr=el('tr');cells.forEach(function(c){var td=el(head?'th':'td');if(c instanceof Node)td.appendChild(c);else td.textContent=c==null?'':String(c);tr.appendChild(td)});tb.appendChild(tr)}
function link(href,txt){var a=el('a',txt);a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a}
function px(s){return s?(Number(s)/1e8).toFixed(6):'-'}
function get(p){return fetch(p,{headers:{authorization:'Bearer '+tok}}).then(function(r){return r.json()})}
function refresh(){
 get('/status').then(function(s){var f=document.getElementById('footer');f.textContent='uptime '+Math.floor(s.uptimeSec/60)+' min · cycles '+s.cycles+' · trades '+s.trades+' · HSKSwap trades '+s.hskswapTrades+' · routed $'+s.routedUsd+' · block '+s.blockNumber+' · '+(s.locked?'LOCKED':'unlocked')+' · gas '+s.gas.agentHsk+' HSK'}).catch(function(e){document.getElementById('err').textContent=String(e)});
 get('/api/view/ate_market_get').then(function(r){var t=document.getElementById('markets');t.textContent='';row(t,['market','oracle (Supra)','age s','APRO','pool','TWAP','dev bps','CEX mid','paused'],1);
  (r.ok?r.data.markets:[]).forEach(function(m){row(t,[m.market,px(m.oracle.price),m.oracle.ageSec,m.apro?px(m.apro.price):'-',px(m.pool.price),px(m.pool.twap),m.pool.deviationBps,m.cex?px(m.cex.mid):'-',m.vault.paused])})});
 get('/api/view/ate_positions').then(function(r){var t=document.getElementById('positions');t.textContent='';row(t,['market','qty','exposure $','avg entry','exit mark','realised $','unrealised (exit) $','unrealised (CEX) $','epoch left $'],1);
  (r.ok?r.data.markets:[]).forEach(function(p){row(t,[p.market,p.qty,p.exposureUsd,px(p.avgEntry),px(p.mark),p.realisedUsd,p.unrealisedExitUsd,p.unrealisedCexUsd,p.epoch.remainingUsd])})});
 get('/api/view/ate_journal_read?limit=30').then(function(r){var t=document.getElementById('journal');t.textContent='';row(t,['time','id','kind','engine','actor','verdict','rationale','tx'],1);
  (r.ok?r.data.entries:[]).forEach(function(e){var tx=e.execution&&e.execution.txHash?link(X+'/tx/'+e.execution.txHash,e.execution.txHash.slice(0,10)+'…'):(e.attestation?link(X+'/tx/'+e.attestation.txHash,'EAS'):'');
   var rat=String(e.rationale||'').replace(/^<untrusted_agent_text>|<\\/untrusted_agent_text>$/g,'');
   row(t,[new Date(e.at*1000).toISOString().slice(11,19),e.id,e.kind,e.engine,e.actor.kind+(e.actor.via?'/'+e.actor.via:''),e.verdict.code,rat.slice(0,160),tx])})});
}
refresh();setInterval(refresh,15000);
try{var ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/events?token='+encodeURIComponent(tok));
 ws.onmessage=function(m){var t=document.getElementById('events');var e=JSON.parse(m.data);var tr=el('tr');[new Date(e.at*1000).toISOString().slice(11,19),e.type,JSON.stringify(e.data).slice(0,200)].forEach(function(c){tr.appendChild(el('td',c))});t.insertBefore(tr,t.firstChild);if(e.type.indexOf('trade')===0)refresh()}}catch(e){}
})();
</script></body></html>`;
