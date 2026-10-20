// Respaldo gratuito: se usa automáticamente cuando la IA principal (Anthropic)
// no tiene crédito, no tiene clave configurada, o falla por cualquier motivo.
//
// Cadena de respaldo, en este orden (se prueba cada una y se usa la primera
// que tenga clave configurada Y responda):
//   1. Gemini Flash (Google AI Studio) — y su variante Flash-Lite como
//      segundo intento dentro de Gemini.
//   2. Groq (Llama 3.3 70B).
//   3. OpenRouter (DeepSeek).
//   4. Pollinations — sin clave, gratis, pero solo texto (sin imágenes) y
//      menos confiable: es el último recurso, no el primero.
//
// Todas excepto Pollinations necesitan una clave gratuita guardada en
// Netlify (Site settings → Environment variables): GEMINI_API_KEY,
// GROQ_API_KEY, OPENROUTER_API_KEY. Mientras no esté guardada, esa opción
// simplemente se salta — no hace falta tenerlas todas, con una sola ya
// funciona el respaldo completo. Pollinations no necesita ninguna clave,
// pero su API no es tan estable como las otras, por eso va al final.
//
// En todos los casos:
//   - Se avisa SIEMPRE al inicio de la respuesta qué modelo gratuito
//     respondió, para que quede claro que no fue Claude.
//   - El system prompt se refuerza con una instrucción explícita de decir
//     "no sé" o "falta ese dato" en vez de inventar — más estricta todavía
//     que la regla normal, porque un modelo más chico se equivoca más fácil.
//   - Los PDF no se pueden leer directo en modo gratuito (no todos los
//     modelos de respaldo soportan PDF binario); solo imágenes (en los que
//     soportan visión) y texto ya extraído en el teléfono.
//
// Los modelos exactos se pueden cambiar sin tocar código, con variables de
// entorno (GEMINI_MODEL, GEMINI_MODEL_LITE, GROQ_MODEL, OPENROUTER_MODEL,
// POLLINATIONS_MODEL): los catálogos de modelos gratuitos rotan con el
// tiempo, y así se actualiza desde Netlify sin desplegar nada nuevo.

import { responderIA, type OpcionesIA } from './ia-stream.mts'

const REFUERZO_HONESTIDAD = `

## Modo gratuito — regla extra, OBLIGATORIA
Estás corriendo como modelo de respaldo gratuito, no como el modelo principal. Por eso esta regla es todavía más estricta: si no tienes certeza de algo, o no viene en lo que te adjuntaron, dilo explícitamente ("no tengo ese dato" / "no estoy seguro, confírmalo") en vez de responder algo solo para completar la respuesta. Nunca inventes cifras, nombres, artículos de ley, fuentes ni datos de mercado.`

type Proveedor = {
  nombre: string
  envKey?: string // si no tiene, no necesita clave (Pollinations)
  modeloEnv: string
  modeloPorDefecto: string
  url: string
  headers: (clave: string) => Record<string, string>
  soportaImagenes: boolean
}

const CADENA_RESPALDO: Proveedor[] = [
  {
    nombre: 'Gemini Flash',
    envKey: 'GEMINI_API_KEY',
    modeloEnv: 'GEMINI_MODEL',
    modeloPorDefecto: 'gemini-2.0-flash',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    headers: (k) => ({ authorization: `Bearer ${k}` }),
    soportaImagenes: true,
  },
  {
    nombre: 'Gemini Flash-Lite',
    envKey: 'GEMINI_API_KEY',
    modeloEnv: 'GEMINI_MODEL_LITE',
    modeloPorDefecto: 'gemini-2.0-flash-lite',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    headers: (k) => ({ authorization: `Bearer ${k}` }),
    soportaImagenes: true,
  },
  {
    nombre: 'Groq (Llama 3.3 70B)',
    envKey: 'GROQ_API_KEY',
    modeloEnv: 'GROQ_MODEL',
    modeloPorDefecto: 'llama-3.3-70b-versatile',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: (k) => ({ authorization: `Bearer ${k}` }),
    soportaImagenes: false,
  },
  {
    nombre: 'OpenRouter (DeepSeek)',
    envKey: 'OPENROUTER_API_KEY',
    modeloEnv: 'OPENROUTER_MODEL',
    modeloPorDefecto: 'deepseek/deepseek-chat-v3.1:free',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: (k) => ({ authorization: `Bearer ${k}`, 'HTTP-Referer': 'https://adminpropiedadescgvd.com', 'X-Title': 'ArriendoPro' }),
    soportaImagenes: true,
  },
  {
    nombre: 'Pollinations',
    modeloEnv: 'POLLINATIONS_MODEL',
    modeloPorDefecto: 'openai',
    url: 'https://text.pollinations.ai/openai',
    headers: () => ({}),
    soportaImagenes: false,
  },
]

// Convierte un bloque de contenido estilo Anthropic (image/document/text) al
// formato que usan las APIs compatibles con OpenAI (Gemini, Groq, OpenRouter,
// Pollinations). Si el proveedor no soporta imágenes, las reemplaza por un
// aviso en texto en vez de omitirlas en silencio.
function convertirBloque(b: any, soportaImagenes: boolean): any {
  if (!b || typeof b === 'string') return { type: 'text', text: String(b || '') }
  if (b.type === 'text') return { type: 'text', text: String(b.text || '') }
  if (b.type === 'image' && b.source?.type === 'base64') {
    if (!soportaImagenes) return { type: 'text', text: '[Se adjuntó una imagen que este modelo de respaldo no puede leer.]' }
    return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
  }
  if (b.type === 'document') {
    return { type: 'text', text: '[Se adjuntó un PDF que el modo gratuito no puede leer directamente. Si hay texto ya extraído del mismo archivo, úsalo.]' }
  }
  return { type: 'text', text: '' }
}

function convertirMensajes(mensajes: any[], soportaImagenes: boolean): any[] {
  return mensajes.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: Array.isArray(m.content) ? m.content.map((b: any) => convertirBloque(b, soportaImagenes)) : String(m.content || ''),
  }))
}

function llamarProveedor(prov: Proveedor, clave: string, maxTokens: number, topeMs: number, mensajes: any[]): Promise<Response> {
  const modelo = Netlify.env.get(prov.modeloEnv) || prov.modeloPorDefecto
  return fetch(prov.url, {
    method: 'POST',
    signal: AbortSignal.timeout(topeMs),
    headers: { 'content-type': 'application/json', ...prov.headers(clave) },
    body: JSON.stringify({ model: modelo, max_tokens: maxTokens, messages: mensajes, stream: true }),
  })
}

async function streamDesde(prov: Proveedor, primeraRespuesta: Response, o: OpcionesIA, clave: string, mensajesBase: any[]): Promise<Response> {
  const inicio = Date.now()
  const presupuesto = o.presupuestoMs ?? 140_000
  const maxRondas = o.maxRondas ?? 6
  const restante = () => presupuesto - (Date.now() - inicio)

  const aviso =
    `⚠️ **Modo gratuito** — la IA principal no tiene crédito disponible. ` +
    `Esta respuesta la generó **${prov.nombre}**, un modelo gratuito, no Claude: puede ser menos precisa. ` +
    `Revisa los datos importantes antes de confiar en ellos.\n\n---\n\n`

  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let algo = false
      const empujar = (t: string) => {
        if (t) { algo = true; controller.enqueue(enc.encode(t)) }
      }
      empujar(aviso)
      let acc = ''
      let resp: Response = primeraRespuesta
      let rondas = 0
      try {
        while (true) {
          const reader = resp.body!.getReader()
          const dec = new TextDecoder()
          let buf = ''
          let finReason: string | null = null
          let errStream = false
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
              const choice = ev.choices?.[0]
              const trozo = choice?.delta?.content
              if (trozo) { acc += trozo; empujar(trozo) }
              if (choice?.finish_reason) finReason = choice.finish_reason
              if (ev.error) errStream = true
            }
          }
          if (errStream) { empujar(algo ? '\n\n' + o.textos.corte : o.textos.vacio); break }
          if (finReason !== 'length') break // terminó de verdad
          rondas++
          if (rondas > maxRondas || !acc || restante() < 12_000) break
          const mensajesCont = [...mensajesBase, { role: 'assistant', content: acc }]
          let rc: Response
          try { rc = await llamarProveedor(prov, clave, o.maxTokens, Math.max(8_000, Math.min(o.topeMs ?? 60_000, restante())), mensajesCont) }
          catch { break }
          if (!rc.ok || !rc.body) break
          resp = rc
        }
        if (!algo) empujar(o.textos.vacio)
      } catch {
        empujar(algo ? '\n\n' + o.textos.corte : o.textos.demora)
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

// Punto de entrada: intenta Anthropic primero (si hay clave y responde);
// si falla, prueba cada proveedor gratuito de la cadena en orden, hasta que
// uno tenga clave configurada y responda. Si ninguno está disponible,
// devuelve un error claro explicando qué falta.
export async function responderConRespaldo(o: OpcionesIA): Promise<Response> {
  if (o.apiKey) {
    const r = await responderIA(o)
    if (r.ok) return r
  }

  const topeIntento = Math.min(15_000, o.topeMs ?? 60_000)
  const probados: string[] = []
  for (const prov of CADENA_RESPALDO) {
    const clave = prov.envKey ? Netlify.env.get(prov.envKey) : ''
    if (prov.envKey && !clave) continue // sin clave guardada: se salta, no es un error
    probados.push(prov.nombre)
    const mensajesProv = [
      { role: 'system', content: o.system + REFUERZO_HONESTIDAD },
      ...convertirMensajes(o.messages, prov.soportaImagenes),
    ]
    let r: Response
    try {
      r = await llamarProveedor(prov, clave || '', o.maxTokens, topeIntento, mensajesProv)
    } catch {
      continue // este proveedor no respondió a tiempo; prueba el siguiente
    }
    if (!r.ok || !r.body) continue
    return streamDesde(prov, r, o, clave || '', mensajesProv)
  }

  return Response.json(
    {
      error: probados.length
        ? `La IA principal no tiene crédito, y ninguno de los respaldos disponibles (${probados.join(', ')}) pudo responder en este momento.`
        : 'La IA principal no tiene crédito, y no hay ningún respaldo gratuito configurado todavía (falta GEMINI_API_KEY, GROQ_API_KEY u OPENROUTER_API_KEY en Netlify).',
    },
    { status: 503 },
  )
}
