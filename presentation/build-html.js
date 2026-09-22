// Builds a self-contained, presentable HTML deck from content.js
const fs = require("fs");
const path = require("path");
const C = require("./content.js");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// markdown-lite: `code`, **bold**, *italic*
function md(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function callout(c) {
  if (!c) return "";
  return `<div class="callout"><span class="callout-label">${md(c.label)}</span><p>${md(c.text)}</p></div>`;
}
function cards(list, compact) {
  return `<div class="cards${compact ? " compact" : ""}">` + list.map((c) => `
      <div class="card">
        ${c.n ? `<span class="pip">${esc(c.n)}</span>` : ""}
        <h3>${md(c.head)}</h3>
        ${c.sub ? `<p class="sub">${md(c.sub)}</p>` : ""}
        <p>${md(c.text)}</p>
      </div>`).join("") + `</div>`;
}
function codeBlock(code) {
  const rows = code.lines.map(([text, door, note]) => {
    const cls = door ? ` d${door}` : "";
    return `<div class="cl${cls}"><span class="ct">${esc(text)}</span>${note ? `<span class="cn">← ${esc(note)}</span>` : ""}</div>`;
  }).join("");
  return `<div class="code"><div class="code-cap">${esc(code.caption)}</div>${rows}</div>`;
}
function table(t, wide) {
  return `<table class="${wide ? "t3" : "t2"}"><thead><tr>${t.head.map((h) => `<th>${md(h)}</th>`).join("")}</tr></thead><tbody>` +
    t.rows.map((r) => `<tr>${r.map((c) => `<td>${md(c)}</td>`).join("")}</tr>`).join("") + `</tbody></table>`;
}

function body(s) {
  switch (s.layout) {
    case "table2":
      return table(s.table) + callout(s.callout);
    case "code-cards":
      return `<div class="split split-code">${codeBlock(s.code)}<div class="side">${cards(s.cards, true)}${callout(s.callout)}</div></div>`;
    case "quote-cards":
      return `<blockquote>${md(s.quote)}</blockquote><p class="lead">${md(s.lead)}</p>${cards(s.cards)}${callout(s.callout)}`;
    case "cards-callout":
      return cards(s.cards) + callout(s.callout) + `<p class="lead tail">${md(s.lead)}</p>`;
    case "two-col":
      return `<p class="lead">${md(s.lead)}</p><div class="cols">` + s.columns.map((c) => `
        <div class="col"><h3>${md(c.head)}</h3><p>${md(c.text)}</p><p class="foot">${md(c.foot)}</p></div>`).join("") + `</div>` + callout(s.callout);
    case "story":
      return `<div class="split"><div class="story">${s.story.map((p) => `<p>${md(p)}</p>`).join("")}</div><div class="side">${cards(s.cards, true)}</div></div>${callout(s.callout)}`;
    case "table3":
      return table(s.table, true) + callout(s.callout);
    case "steps":
      return `<div class="steps">` + s.steps.map((st, i) => `
        <div class="step"><span class="pip">${i + 1}</span><div><h3>${md(st.head)}</h3><p>${md(st.text)}</p></div></div>`).join("") + `</div>
        <div class="next"><span class="callout-label">${md(s.next.label)}</span><div class="links">` +
        s.next.items.map(([name, href, blurb]) => `<a href="${C.meta.site}${href}" target="_blank" rel="noopener"><strong>${esc(name)}</strong><span>${esc(blurb)}</span></a>`).join("") +
        `</div></div>`;
    default:
      return "";
  }
}

const slides = [
  `<section class="slide cover">
     <div class="cover-in">
       <h1>${esc(C.meta.title)}</h1>
       <p class="sub">${md(C.meta.subtitle)}</p>
       <p class="phrases">${C.meta.phrases.map((p) => `<span>${esc(p)}</span>`).join("<i>·</i>")}</p>
       <p class="foot">${esc(C.meta.footer)}</p>
     </div>
   </section>`,
  ...C.slides.map((s) => `
   <section class="slide">
     <p class="eyebrow">${esc(s.eyebrow)}</p>
     <h2>${md(s.title)}</h2>
     ${s.kicker ? `<p class="kicker">${md(s.kicker)}</p>` : ""}
     <div class="body">${body(s)}</div>
   </section>`),
];

const notes = ["Title slide — set the frame: this is not a Kubernetes tour, it is three questions and a way to read failures. Say out loud that no devops background is assumed and that every concept will be anchored to something they have already built.",
  ...C.slides.map((s) => s.notes)];

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(C.meta.title)}</title>
<style>
:root{
  --navy:#102A43; --navy2:#243B53; --slate:#486581; --mute:#829AB1;
  --mist:#D9E2EC; --mist2:#F0F4F8; --paper:#fff;
  --blue:#2680C2; --blueD:#0A558C; --blueL:#4098D7;
  --serif:"Cambria",Georgia,"Times New Roman",serif;
  --sans:"Calibri","Segoe UI",system-ui,-apple-system,sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#0b1a2b;font-family:var(--sans);overflow:hidden}
#stage{position:absolute;inset:0;display:grid;place-items:center}
#deck{width:1280px;height:720px;position:relative;transform-origin:center center;box-shadow:0 24px 80px rgba(0,0,0,.55);border-radius:6px;overflow:hidden}
.slide{position:absolute;inset:0;background:var(--paper);padding:52px 64px;display:none;flex-direction:column}
.slide.on{display:flex}
.eyebrow{margin:0 0 6px;font-size:14px;font-weight:700;letter-spacing:.14em;color:var(--blueD)}
h2{font-family:var(--serif);font-size:44px;line-height:1.08;margin:0 0 10px;color:var(--navy);font-weight:700}
.kicker{margin:0 0 18px;font-size:19px;line-height:1.4;color:var(--slate);font-style:italic;max-width:1050px}
.body{flex:1;min-height:0;display:flex;flex-direction:column;gap:16px}
p{margin:0}
code{font-family:"Consolas","SF Mono",ui-monospace,monospace;font-size:.92em;background:var(--mist2);border:1px solid var(--mist);border-radius:4px;padding:1px 5px;color:var(--navy)}
strong{color:var(--navy)}
/* cover */
.cover{background:var(--navy);justify-content:center}
.cover-in{max-width:1000px}
.cover h1{font-family:var(--serif);font-size:66px;line-height:1.05;margin:0 0 22px;color:#fff;font-weight:700;letter-spacing:-.5px}
.cover .sub{font-size:22px;line-height:1.5;color:var(--mist);max-width:880px}
.cover .phrases{margin:36px 0 0;font-size:20px;font-weight:700;color:var(--blueL);letter-spacing:.02em}
.cover .phrases i{font-style:normal;opacity:.5;margin:0 14px}
.cover .foot{position:absolute;left:64px;bottom:52px;font-size:15px;color:var(--mute)}
/* tables */
table{width:100%;border-collapse:collapse;font-size:17px}
th{text-align:left;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--blueD);padding:0 14px 8px;border-bottom:2px solid var(--mist)}
td{padding:9px 14px;vertical-align:top;border-bottom:1px solid var(--mist2);color:var(--slate);line-height:1.35}
td:first-child{color:var(--navy);width:44%}
.t3 td:first-child{width:30%}
.t3 td:nth-child(2){width:15%;color:var(--blueD);font-weight:700}
.t3{font-size:16px}
/* callout */
.callout{background:var(--mist2);border:1px solid var(--mist);border-radius:8px;padding:14px 18px}
.callout-label{display:block;font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--blueD);margin-bottom:5px}
.callout p{font-size:17px;line-height:1.42;color:var(--navy)}
/* cards */
.cards{display:flex;gap:16px}
.cards .card{flex:1;background:var(--mist2);border:1px solid var(--mist);border-radius:8px;padding:16px 18px}
.cards.compact .card{padding:12px 14px}
.card h3{margin:0 0 6px;font-size:19px;color:var(--navy);font-family:var(--sans);font-weight:700}
.cards.compact .card h3{font-size:17px}
.card .sub{font-size:16px;color:var(--blueD);font-style:italic;margin-bottom:6px}
.card p{font-size:16px;line-height:1.4;color:var(--slate)}
.cards.compact .card p{font-size:14.5px;line-height:1.38}
.pip{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:var(--blue);color:#fff;font-weight:700;font-size:15px;margin-bottom:8px}
/* split */
.split{display:flex;gap:22px;flex:1;min-height:0}
.split .side{flex:1;display:flex;flex-direction:column;gap:14px}
.split .side .cards{flex-direction:column}
.split-code .code{flex:0 0 648px}
.story{flex:0 0 480px;display:flex;flex-direction:column;justify-content:center;gap:14px}
.story p{font-size:18px;line-height:1.5;color:var(--slate)}
.story p:first-child{color:var(--navy)}
/* code */
.code{background:var(--navy);border-radius:8px;padding:14px 16px;font-family:"Consolas","SF Mono",ui-monospace,monospace;font-size:12.5px;line-height:1.52;overflow:hidden}
.code-cap{color:var(--mute);font-size:12px;margin-bottom:8px;font-family:var(--sans);letter-spacing:.06em;text-transform:uppercase}
.cl{white-space:pre;color:#C6D4E1}
.cl .cn{font-family:var(--sans);font-size:12px;font-style:italic;opacity:.95}
.cl.d1{color:#9BD1F5}.cl.d1 .cn{color:#9BD1F5}
.cl.d2{color:#A7E0C4}.cl.d2 .cn{color:#A7E0C4}
.cl.d3{color:#F3CE8E}.cl.d3 .cn{color:#F3CE8E}
/* quote */
blockquote{margin:0;font-family:var(--serif);font-size:33px;line-height:1.22;color:var(--navy);font-weight:700;max-width:1040px}
.lead{font-size:18px;line-height:1.45;color:var(--slate);max-width:1080px}
.lead.tail{font-size:17px}
/* two-col */
.cols{display:flex;gap:20px;flex:1}
.col{flex:1;background:var(--mist2);border:1px solid var(--mist);border-radius:8px;padding:18px 20px;display:flex;flex-direction:column;gap:10px}
.col h3{margin:0;font-size:21px;color:var(--navy)}
.col p{font-size:17px;line-height:1.42;color:var(--slate)}
.col .foot{margin-top:auto;font-size:15.5px;color:var(--blueD);font-style:italic}
/* steps */
.steps{display:grid;grid-template-columns:1fr 1fr;gap:22px 28px;flex:1;align-content:center}
.step{display:flex;gap:12px;align-items:flex-start}
.step .pip{flex:0 0 26px;margin:2px 0 0}
.step h3{margin:0 0 5px;font-size:19px;color:var(--navy)}
.step p{font-size:16px;line-height:1.42;color:var(--slate)}
.next{margin-top:auto;background:var(--mist2);border:1px solid var(--mist);border-radius:8px;padding:14px 18px}
.links{display:flex;gap:12px;margin-top:8px}
.links a{flex:1;text-decoration:none;color:var(--navy);border-left:0;display:block}
.links a strong{display:block;font-size:16px;color:var(--blueD)}
.links a span{display:block;font-size:14px;color:var(--slate);line-height:1.32;margin-top:2px}
/* chrome */
#bar{position:fixed;left:0;top:0;height:3px;background:var(--blueL);width:0;transition:width .18s ease;z-index:5}
#hud{position:fixed;right:14px;bottom:12px;color:#7e93a8;font-size:13px;z-index:5;user-select:none}
#hud b{color:#cfe0ee;font-weight:600}
#hint{position:fixed;left:14px;bottom:12px;color:#5D738A;font-size:12px;z-index:5}
#notes{position:fixed;left:0;right:0;bottom:0;max-height:38%;overflow:auto;background:#0B1A2B;border-top:1px solid #1D3A55;padding:16px 22px;color:#C8D6E4;font-size:15px;line-height:1.5;display:none;z-index:6}
#notes.on{display:block}
#notes h4{margin:0 0 6px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--blueL)}
#grid{position:fixed;inset:0;background:rgba(8,20,33,.97);display:none;z-index:7;padding:28px;overflow:auto}
#grid.on{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;align-content:start}
#grid button{background:#12293f;border:1px solid #1e3a55;border-radius:6px;color:#cfe0ee;text-align:left;padding:14px;font:inherit;font-size:14px;cursor:pointer}
#grid button:hover{border-color:var(--blueL)}
#grid button b{display:block;color:#fff;font-size:15px;margin-bottom:4px}
#grid button span{color:#7e93a8;font-size:12px}
@media print{
  html,body{overflow:visible;background:#fff;height:auto}
  #stage{position:static;display:block}
  #deck{width:1280px;height:720px;box-shadow:none;page-break-after:always;transform:none!important}
  .slide{display:flex!important;position:relative;page-break-after:always}
  #bar,#hud,#hint,#notes,#grid{display:none!important}
}
</style>
</head>
<body>
<div id="stage"><div id="deck">
${slides.join("\n")}
</div></div>
<div id="bar"></div>
<div id="hud"><b id="cur">1</b> / ${slides.length}</div>
<div id="hint">← → navigate · N notes · O overview · F fullscreen</div>
<aside id="notes"><h4>Speaker notes</h4><p id="nt"></p></aside>
<div id="grid"></div>
<script>
(function(){
  var slides=[].slice.call(document.querySelectorAll('.slide'));
  var NOTES=${JSON.stringify(notes)};
  var i=0, deck=document.getElementById('deck');
  function fit(){
    var pad=36, k=Math.min((innerWidth-pad)/1280,(innerHeight-78)/720);
    var n=document.getElementById('notes');
    if(n.classList.contains('on')) k=Math.min(k,(innerHeight*0.60-pad)/720);
    deck.style.transform='scale('+k+')';
  }
  function show(n){
    i=Math.max(0,Math.min(slides.length-1,n));
    slides.forEach(function(s,x){ s.classList.toggle('on',x===i); });
    document.getElementById('cur').textContent=i+1;
    document.getElementById('bar').style.width=((i)/(slides.length-1)*100)+'%';
    document.getElementById('nt').textContent=NOTES[i]||'';
    if(location.hash!=='#'+(i+1)) history.replaceState(null,'','#'+(i+1));
  }
  addEventListener('keydown',function(e){
    var k=e.key;
    if(k==='ArrowRight'||k==='PageDown'||k===' '||k==='Enter'){show(i+1);e.preventDefault();}
    else if(k==='ArrowLeft'||k==='PageUp'){show(i-1);e.preventDefault();}
    else if(k==='Home'){show(0);} else if(k==='End'){show(slides.length-1);}
    else if(k==='n'||k==='N'){document.getElementById('notes').classList.toggle('on');fit();}
    else if(k==='o'||k==='O'){document.getElementById('grid').classList.toggle('on');}
    else if(k==='f'||k==='F'){ if(!document.fullscreenElement){document.documentElement.requestFullscreen();} else {document.exitFullscreen();} }
    else if(k==='Escape'){document.getElementById('grid').classList.remove('on');}
    else if(/^[0-9]$/.test(k)){show(parseInt(k,10)-1);}
  });
  addEventListener('resize',fit);
  // overview
  var g=document.getElementById('grid');
  slides.forEach(function(s,x){
    var h=s.querySelector('h1,h2');
    var b=document.createElement('button');
    b.innerHTML='<b>'+(x+1)+'. '+(h?h.textContent:'Title')+'</b><span>'+((s.querySelector('.eyebrow')||{}).textContent||'')+'</span>';
    b.onclick=function(){show(x);g.classList.remove('on');};
    g.appendChild(b);
  });
  var start=parseInt((location.hash||'#1').slice(1),10);
  fit(); show(isNaN(start)?0:start-1);
})();
</script>
</body>
</html>`;

fs.writeFileSync(path.join(__dirname, "index.html"), html);
console.log("index.html written:", html.length, "bytes,", slides.length, "slides");
