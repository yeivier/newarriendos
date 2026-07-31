import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

// Sirve la ficha pública de una propiedad como una página web atractiva y
// autocontenida en /p/<id>. Incluye etiquetas Open Graph (vista previa con foto
// al compartir en WhatsApp/redes), galería de fotos, recorrido virtual 360°,
// mapa de ubicación y contacto directo por WhatsApp con la sociedad propietaria.
// Nunca expone nombre, RUT ni contacto del arrendatario o del propietario.

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const CLP = (n: number) =>
  '$' + Math.round(Number(n) || 0).toLocaleString('es-CL')

const notFound = () =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ficha no disponible</title><style>body{font-family:system-ui,Segoe UI,sans-serif;background:#0f1115;color:#e7e9ee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center;padding:24px}.b{max-width:440px}h1{font-size:22px;margin:0 0 10px}p{color:#9aa3b2;line-height:1.6}</style></head><body><div class="b"><h1>Esta ficha no está disponible</h1><p>El enlace puede haber expirado o la propiedad ya no está publicada. Pídele a quien te lo envió que comparta la ficha nuevamente.</p></div></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )

export default async (req: Request, context: Context) => {
  const id = String((context.params as Record<string, string>)?.id || '').replace(/[^a-z0-9]/gi, '')
  if (!id) return notFound()

  const store = getStore('fichas')
  const f: any = await store.get(id, { type: 'json' })
  if (!f) return notFound()

  const origin = new URL(req.url).origin
  const abs = (u: string) => (u && u.startsWith('/') ? origin + u : u)

  const fotos: string[] = Array.isArray(f.fotos) ? f.fotos : []
  const panoramas: { url: string; name?: string }[] = Array.isArray(f.panoramas) ? f.panoramas : []
  const cover = fotos[0] ? abs(fotos[0]) : ''
  const title = f.name || 'Propiedad en arriendo'
  const place = [f.comuna, f.region].filter(Boolean).join(', ')

  const desc =
    f.descripcion ||
    `${title}${place ? ' en ' + place : ''}. ${[
      f.bedrooms ? f.bedrooms + ' dormitorios' : '',
      f.bathrooms ? f.bathrooms + ' baños' : '',
      f.surfaceBuilt ? f.surfaceBuilt + ' m² construidos' : '',
    ]
      .filter(Boolean)
      .join(' · ')}`.trim()

  const specs: [string, string, string][] = [
    ['🛏️', 'Dormitorios', f.bedrooms],
    ['🛁', 'Baños', f.bathrooms],
    ['📐', 'm² construidos', f.surfaceBuilt],
    ['🌳', 'm² terreno', f.surfaceTerrain],
    ['🚗', 'Estacionamientos', f.parking],
    ['📦', 'Bodegas', f.bodega],
    ['🏗️', 'Año', f.constructionYear],
    ['🏠', 'Tipo', f.type],
  ].filter(([, , v]) => v !== undefined && v !== null && v !== '' && v !== 0) as [string, string, string][]

  const soc = f.sociedad || {}
  const waNum = String(soc.whatsapp || soc.telefono || '').replace(/[^\d]/g, '')
  const waMsg = encodeURIComponent(`Hola, me interesa la propiedad "${title}" (${origin}/p/${id}). ¿Podemos coordinar una visita?`)

  const galleryHtml = fotos
    .map(
      (u, i) =>
        `<button class="ph" data-i="${i}" style="background-image:url('${esc(abs(u))}')" aria-label="Foto ${i + 1}"></button>`,
    )
    .join('')

  const panoBtns = panoramas
    .map((p, i) => `<button class="pbtn${i === 0 ? ' on' : ''}" data-pi="${i}">${esc(p.name || 'Ambiente ' + (i + 1))}</button>`)
    .join('')

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}${place ? ' — ' + esc(place) : ''}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}${place ? ' — ' + esc(place) : ''}">
<meta property="og:description" content="${esc(desc)}">
${cover ? `<meta property="og:image" content="${esc(cover)}">` : ''}
<meta property="og:url" content="${esc(origin + '/p/' + id)}">
<meta name="twitter:card" content="${cover ? 'summary_large_image' : 'summary'}">
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
${panoramas.length ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.css">' : ''}
<style>
:root{--ink:#0c1018;--red:#9c1c1c;--green:#1f6b38;--muted:#5b6573;--line:#e3e7ee}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Public Sans',system-ui,Segoe UI,sans-serif;color:var(--ink);background:#eef0f3;line-height:1.55}
.wrap{max-width:920px;margin:0 auto;background:#fff;min-height:100vh;box-shadow:0 0 60px rgba(0,0,0,.08)}
.hero{position:relative;height:${cover ? '52vh' : '180px'};min-height:${cover ? '340px' : '180px'};background:${cover ? `#1a1f2b center/cover no-repeat url('${esc(cover)}')` : 'linear-gradient(135deg,#9c1c1c,#5c1010)'};display:flex;align-items:flex-end;color:#fff}
.hero::after{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(8,10,15,.82),rgba(8,10,15,.15) 55%,rgba(8,10,15,.35))}
.hero-in{position:relative;z-index:2;padding:32px 34px;width:100%}
.tag{display:inline-block;background:rgba(255,255,255,.16);backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,.25);padding:5px 13px;border-radius:30px;font-size:13px;font-weight:700;letter-spacing:.3px;margin-bottom:12px}
.hero h1{font-size:34px;font-weight:900;letter-spacing:-.5px;line-height:1.1;text-shadow:0 2px 18px rgba(0,0,0,.4)}
.hero .loc{font-size:16px;font-weight:600;opacity:.95;margin-top:8px}
.price{padding:22px 34px;background:var(--green);color:#fff;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.price .n{font-size:30px;font-weight:900;letter-spacing:-.5px}
.price .l{font-size:14px;font-weight:700;opacity:.9}
.section{padding:26px 34px;border-bottom:1px solid var(--line)}
.section h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--red);font-weight:800;margin-bottom:16px}
.specs{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.spec{background:#f6f8fb;border:1px solid var(--line);border-radius:14px;padding:16px 12px;text-align:center}
.spec .e{font-size:24px}
.spec .v{font-size:20px;font-weight:900;margin-top:4px}
.spec .k{font-size:12px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-top:2px}
.desc{font-size:17px;color:#2a323f;white-space:pre-line}
.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.ph{aspect-ratio:4/3;border-radius:12px;border:none;cursor:pointer;background:#e7ebf1 center/cover no-repeat;transition:.15s}
.ph:hover{transform:scale(1.02);filter:brightness(1.05)}
#pano{width:100%;height:440px;border-radius:14px;overflow:hidden;background:#0c1018}
.panobar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.pbtn{border:2px solid var(--line);background:#fff;border-radius:10px;padding:8px 14px;font-family:inherit;font-weight:700;font-size:14px;cursor:pointer}
.pbtn.on{border-color:var(--red);color:var(--red);background:#fbeaea}
.map iframe{width:100%;height:320px;border:none;border-radius:14px}
.contact{padding:30px 34px;background:#0c1018;color:#fff;text-align:center}
.contact h2{color:#fff;font-size:22px;font-weight:900;margin-bottom:6px}
.contact p{color:#aab2c0;margin-bottom:18px}
.btn{display:inline-flex;align-items:center;gap:9px;padding:15px 26px;border-radius:13px;font-weight:800;font-size:17px;text-decoration:none;cursor:pointer;border:none}
.btn-wa{background:#25d366;color:#073b1b}
.btn-out2{background:transparent;border:2px solid rgba(255,255,255,.3);color:#fff;font-size:15px;padding:13px 22px}
.foot{padding:20px 34px;text-align:center;font-size:13px;color:var(--muted)}
.lb{position:fixed;inset:0;background:rgba(6,8,12,.94);display:none;align-items:center;justify-content:center;z-index:99;flex-direction:column}
.lb.on{display:flex}
.lb img{max-width:94vw;max-height:82vh;border-radius:10px}
.lb .nav{position:absolute;top:0;bottom:0;width:46%;cursor:pointer}
.lb .nav.l{left:0}.lb .nav.r{right:0}
.lb .x{position:absolute;top:18px;right:22px;color:#fff;font-size:34px;cursor:pointer;z-index:2}
.lb .cap{color:#cfd5df;margin-top:14px;font-weight:600}
/* Barra para volver: solo aparece si se llegó desde la plataforma. */
#volver{display:none;position:sticky;top:0;z-index:60;background:#0c1018;padding:9px 16px}
#volver a{display:inline-flex;align-items:center;gap:8px;color:#fff;text-decoration:none;font-weight:800;font-size:14.5px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.24);border-radius:11px;padding:9px 15px}
@media(max-width:640px){.hero h1{font-size:26px}.specs{grid-template-columns:repeat(2,1fr)}.gallery{grid-template-columns:repeat(2,1fr)}.section,.hero-in,.price,.contact{padding-left:20px;padding-right:20px}}
</style>
</head>
<body>
<div id="volver"><a href="${esc(origin)}/" id="volverA">← Volver a la plataforma</a></div>
<div class="wrap">
  <div class="hero"><div class="hero-in">
    <span class="tag">🔑 ${esc(f.use === 'arriendo' ? 'En arriendo' : 'Propiedad')}</span>
    <h1>${esc(title)}</h1>
    ${place ? `<div class="loc">📍 ${esc(f.address ? f.address + ' · ' : '')}${esc(place)}</div>` : ''}
  </div></div>

  ${f.mostrarValor && f.rent ? `<div class="price"><span class="n">${esc(CLP(f.rent))}</span><span class="l">/ mes${f.rentUF ? ' · ' + esc(f.rentUF) + ' UF' : ''}</span>${f.mostrarDeudas && f.gastoComun ? `<span class="l">· Gasto común ${esc(CLP(f.gastoComun))}</span>` : ''}</div>` : ''}

  ${
    f.mostrarInfo && specs.length
      ? `<div class="section"><h2>Características</h2><div class="specs">${specs
          .map(([e, k, v]) => `<div class="spec"><div class="e">${e}</div><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`)
          .join('')}</div></div>`
      : ''
  }

  <div class="section"><h2>Descripción</h2><div class="desc">${esc(desc)}</div></div>

  ${fotos.length ? `<div class="section"><h2>Galería · ${fotos.length} foto${fotos.length > 1 ? 's' : ''}</h2><div class="gallery">${galleryHtml}</div></div>` : ''}

  ${
    panoramas.length
      ? `<div class="section"><h2>Recorrido virtual 360°</h2><div class="panobar">${panoBtns}</div><div id="pano"></div><p style="font-size:13px;color:var(--muted);margin-top:10px">Arrastra para mirar en todas las direcciones, como si estuvieras dentro de la propiedad.</p></div>`
      : f.virtualTour
        ? `<div class="section"><h2>Recorrido virtual</h2><a class="btn btn-wa" style="background:var(--red);color:#fff" href="${esc(f.virtualTour)}" target="_blank" rel="noopener">🏠 Ver recorrido 360°</a></div>`
        : ''
  }

  ${
    f.lat && f.lng
      ? `<div class="section map"><h2>Ubicación</h2><iframe loading="lazy" src="https://maps.google.com/maps?q=${esc(f.lat)},${esc(f.lng)}&hl=es&z=16&output=embed"></iframe></div>`
      : ''
  }

  <div class="contact">
    <h2>¿Te interesa esta propiedad?</h2>
    <p>Coordina una visita con ${esc(soc.name || 'la administración')}.</p>
    ${waNum ? `<a class="btn btn-wa" href="https://wa.me/${esc(waNum)}?text=${waMsg}" target="_blank" rel="noopener">💬 Contactar por WhatsApp</a>` : ''}
    ${soc.email ? `<div style="margin-top:14px"><a class="btn btn-out2" href="mailto:${esc(soc.email)}?subject=${encodeURIComponent('Consulta: ' + title)}">✉️ Escribir un correo</a></div>` : ''}
  </div>

  <div class="foot">Ficha generada con ArriendoPro · ${esc(soc.name || '')}</div>
</div>

<div class="lb" id="lb"><span class="x" id="lbx">×</span><span class="nav l" id="lbl"></span><img id="lbimg" src="" alt=""><span class="nav r" id="lbr"></span><div class="cap" id="lbcap"></div></div>

<script>
(function(){
  if(location.search.indexOf('print=1')>=0){ window.addEventListener('load',function(){ setTimeout(function(){ try{window.print();}catch(e){} },700); }); }
  /* Quien administra llega aquí desde la plataforma y necesita volver. Quien
     recibe el enlace compartido no ve esta barra: la ficha es para él. */
  try{
    var desdeLaPlataforma = document.referrer && document.referrer.indexOf(location.origin)===0;
    if(desdeLaPlataforma){
      var b=document.getElementById('volver'); b.style.display='block';
      document.getElementById('volverA').addEventListener('click',function(e){
        if(history.length>1){ e.preventDefault(); history.back(); }
      });
    }
  }catch(e){}
  var fotos=${JSON.stringify(fotos.map(abs))};
  if(fotos.length){
    var lb=document.getElementById('lb'),img=document.getElementById('lbimg'),cap=document.getElementById('lbcap'),cur=0;
    function show(i){cur=(i+fotos.length)%fotos.length;img.src=fotos[cur];cap.textContent=(cur+1)+' / '+fotos.length;lb.classList.add('on');}
    document.querySelectorAll('.ph').forEach(function(b){b.addEventListener('click',function(){show(+b.dataset.i);});});
    document.getElementById('lbx').onclick=function(){lb.classList.remove('on');};
    document.getElementById('lbr').onclick=function(){show(cur+1);};
    document.getElementById('lbl').onclick=function(){show(cur-1);};
    lb.addEventListener('click',function(e){if(e.target===lb)lb.classList.remove('on');});
    document.addEventListener('keydown',function(e){if(!lb.classList.contains('on'))return;if(e.key==='Escape')lb.classList.remove('on');if(e.key==='ArrowRight')show(cur+1);if(e.key==='ArrowLeft')show(cur-1);});
  }
})();
</script>
${
    panoramas.length
      ? `<script src="https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.js"></script>
<script>
(function(){
  var panos=${JSON.stringify(panoramas.map((p) => ({ url: abs(p.url), name: p.name || '' })))};
  var viewer=null;
  function load(i){
    if(viewer){viewer.destroy();viewer=null;}
    viewer=pannellum.viewer('pano',{type:'equirectangular',panorama:panos[i].url,autoLoad:true,showControls:true,autoRotate:-2});
    document.querySelectorAll('.pbtn').forEach(function(b){b.classList.toggle('on',+b.dataset.pi===i);});
  }
  document.querySelectorAll('.pbtn').forEach(function(b){b.addEventListener('click',function(){load(+b.dataset.pi);});});
  load(0);
})();
</script>`
      : ''
  }
</body>
</html>`

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  })
}

export const config: Config = {
  path: '/p/:id',
  method: 'GET',
}
