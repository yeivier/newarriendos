import type { Config, Context } from '@netlify/functions'
import { quienLlama, sinAcceso } from '../lib/auth.mts'

// Calculadora de precio de arriendo para Chile.
//
// Recibe las características de la propiedad (región, comuna, sector, tipo, m²,
// dormitorios, baños, estacionamiento, bodega, año, estado, amoblado, gastos
// comunes, cercanía a metro/servicios, notas de plusvalía) y devuelve un precio
// sugerido con rango: mínimo, recomendado y máximo, más el análisis de por qué,
// qué sube el precio y qué riesgos hay. Es una estimación experta basada en el
// comportamiento del mercado por comuna y en los atributos de la propiedad; no
// es una tasación oficial ni un scraping de portales en vivo.
//
// La respuesta se transmite en vivo. Empieza con un bloque JSON con los tres
// números (para mostrarlos grandes) y sigue con la explicación en markdown.
//
// POST /api/arriendo-precio
//   { datos:{...}, messages?:[{role,content}] } -> stream de texto

const API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-5'
const TOPE_MS = 45_000

const EXPERTO = `Eres un tasador y corredor de propiedades chileno con años fijando precios de arriendo en todo Chile. Conoces cómo se mueve el mercado por región y por comuna, qué pesa en cada sector y cómo la oferta y la demanda mueven los valores. Hablas en español de Chile, de "tú", claro y simple. La persona no es técnica.

## Tu tarea
Con los datos de la propiedad, estimas el precio de arriendo mensual y entregas un RANGO realista: mínimo, recomendado y máximo. El recomendado es el precio al que conviene publicar para arrendar en un tiempo razonable sin dejar plata en la mesa.

## Cómo lo piensas (considera todo lo que aplique)
- **Ubicación**: región, comuna y sector/barrio. Es lo que más pesa. Un mismo departamento vale muy distinto en Las Condes que en Estación Central.
- **La propiedad**: tipo (departamento/casa), metros cuadrados, dormitorios y baños, estacionamiento, bodega, piso, orientación y vista, estado y año, si está amoblado.
- **Servicios y conectividad**: cercanía a metro, locomoción, colegios, comercio, áreas verdes.
- **Gastos comunes**: si son altos, presionan el arriendo hacia abajo.
- **Oferta y demanda**: cuánta competencia parecida hay en el sector y qué tan buscada es la zona. Si el sector está saturado, el precio baja; si hay poca oferta y mucha demanda, sube.
- **Plusvalía y proyección**: proyectos, metro nuevo, mejora del barrio.

## Formato de tu respuesta (MUY IMPORTANTE)
1) La PRIMERA línea es SOLO un bloque JSON en una línea, sin texto antes, con este formato exacto:
{"min":NUMERO,"reco":NUMERO,"max":NUMERO,"moneda":"CLP","confianza":"alta|media|baja"}
Los números son pesos chilenos mensuales, enteros, sin puntos ni símbolos (ej: 520000). Si crees que corresponde UF, igual convierte a CLP aproximado y ponlo en CLP.
2) Después del JSON, dejas una línea en blanco y escribes el análisis en markdown con estos títulos:

**📋 En simple**
Una o dos frases con el veredicto: a cuánto conviene publicarlo.

**💰 Por qué este rango**
Los factores que más pesaron en este caso puntual (ubicación, m², estado, etc.), en simple.

**📈 Cómo apuntar al máximo**
Qué mejoras o decisiones concretas suben el arriendo (amoblar, pintar, incluir estacionamiento aparte, etc.) y cuánto podrían sumar, aproximado.

**⚠️ Riesgos y a tener en cuenta**
Qué puede hacer que se arriende más lento o más barato (gastos comunes altos, sector saturado, temporada). Si algún dato importante falta, dilo y estima igual, marcando que es aproximado.

**✅ Recomendación**
Precio para publicar y una segunda opción si quiere arrendar más rápido.

## Honestidad
- Es una estimación experta, no una tasación oficial. Dilo al final en una frase, y sugiere contrastar con avisos parecidos en portales (Portal Inmobiliario, Yapo, Toctoc) y, si es una decisión grande, con un corredor local.
- No inventes un dato duro que no tienes (no des "hay 34 arriendos en la zona" si no lo sabes). Razona en términos de mercado sin fabricar cifras falsas.
- Si los datos son muy pocos, baja la confianza y ensancha el rango.`

const n = (v: any) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0 }
const s = (v: any, max = 120) => String(v ?? '').slice(0, max)

export default async (req: Request, _context: Context) => {
  const yo = await quienLlama(req)
  if (!yo) return sinAcceso()

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return Response.json({ error: 'Falta configurar ANTHROPIC_API_KEY en Netlify.' }, { status: 503 })

  let body: any
  try { body = await req.json() } catch { return Response.json({ error: 'Cuerpo inválido' }, { status: 400 }) }

  const d = body.datos || {}
  const ficha = [
    ['Región', s(d.region)],
    ['Comuna', s(d.comuna)],
    ['Sector / barrio', s(d.sector)],
    ['Tipo', s(d.tipo)],
    ['Superficie útil (m²)', n(d.m2) || ''],
    ['Superficie terreno (m²)', n(d.m2Terreno) || ''],
    ['Dormitorios', n(d.dorm) || ''],
    ['Baños', n(d.banos) || ''],
    ['Estacionamientos', n(d.estac) || ''],
    ['Bodega', d.bodega ? 'sí' : ''],
    ['Piso', s(d.piso, 20)],
    ['Orientación', s(d.orientacion, 30)],
    ['Vista', s(d.vista, 40)],
    ['Estado', s(d.estado, 40)],
    ['Año / antigüedad', s(d.ano, 30)],
    ['Amoblado', d.amoblado ? 'sí' : 'no'],
    ['Gastos comunes ($)', n(d.gc) || ''],
    ['Cercanía a metro / servicios', s(d.conectividad, 200)],
    ['Plusvalía / proyección', s(d.plusvalia, 200)],
    ['Otros datos', s(d.notas, 400)],
  ].filter(([, v]) => v !== '' && v !== 0)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n')

  if (!s(d.comuna) && !s(d.region)) {
    return Response.json({ error: 'Dime al menos la comuna (y ojalá el sector) para estimar bien.' }, { status: 400 })
  }

  const mensajes: any[] = (Array.isArray(body.messages) ? body.messages : []).slice(-10).map((m: any) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String((m && m.content) || '').slice(0, 3000),
  })).filter((m: any) => m.content)

  if (!mensajes.length) {
    mensajes.push({ role: 'user', content: `Estima el precio de arriendo mensual de esta propiedad y dame el rango (mínimo, recomendado y máximo). Datos:\n\n${ficha}` })
  }

  let r: Response
  try {
    r = await fetch(API, {
      method: 'POST',
      signal: AbortSignal.timeout(TOPE_MS),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2200,
        output_config: { effort: 'low' },
        system: EXPERTO,
        messages: mensajes,
        stream: true,
      }),
    })
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return Response.json({ text: 'Me demoré más de la cuenta 😅 Prueba de nuevo.' }, { status: 200 })
    }
    return Response.json({ error: 'No se pudo contactar la IA: ' + (e?.message || 'error de red') }, { status: 502 })
  }

  if (!r.ok || !r.body) {
    const j: any = await r.json().catch(() => ({}))
    return Response.json({ error: j?.error?.message || 'Error de la IA' }, { status: 502 })
  }

  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const reader = r.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let algo = false
      const empujar = (t: string) => { if (t) { algo = true; controller.enqueue(enc.encode(t)) } }
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lineas = buf.split('\n')
          buf = lineas.pop() || ''
          for (const linea of lineas) {
            const t = linea.trim()
            if (!t.startsWith('data:')) continue
            const carga = t.slice(5).trim()
            if (!carga || carga === '[DONE]') continue
            let ev: any
            try { ev = JSON.parse(carga) } catch { continue }
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') empujar(ev.delta.text || '')
            else if (ev.type === 'error') empujar(algo ? '\n\n(Se cortó el cálculo.)' : 'No pude calcularlo. Intenta de nuevo.')
          }
        }
        if (!algo) empujar('No alcancé a calcularlo. Intenta de nuevo.')
      } catch {
        empujar(algo ? '\n\n(Se cortó el cálculo. Intenta de nuevo.)' : 'Me demoré más de la cuenta 😅 Prueba de nuevo.')
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

export const config: Config = { path: '/api/arriendo-precio', method: ['POST'] }
