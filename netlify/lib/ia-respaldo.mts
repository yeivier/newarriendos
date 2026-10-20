// Respaldo gratuito: se usa automáticamente cuando la IA principal (Anthropic)
// no tiene crédito, no tiene clave configurada, o falla por cualquier motivo.
//
// Usa OpenRouter (openrouter.ai), que da acceso gratuito a varios modelos de
// código abierto con una sola clave (OPENROUTER_API_KEY). No es tan preciso
// como Claude para instrumentos legales chilenos, así que:
//   - Se avisa SIEMPRE al inicio de la respuesta que es "modo gratuito".
//   - El system prompt se refuerza con una instrucción explícita de decir
//     "no sé" o "falta ese dato" en vez de inventar — más estricta todavía
//     que la regla normal, porque un modelo más chico se equivoca más fácil.
//   - Los PDF no se pueden leer directo en este modo (no todos los modelos
//     gratuitos con visión soportan PDF binario); solo imágenes y texto ya
//     extraído en el teléfono.
//
// El modelo exacto se puede cambiar sin tocar código: variable de entorno
// OPENROUTER_MODEL. Los catálogos de modelos gratuitos rotan con el tiempo;
// si el de por defecto deja de estar disponible, basta con cambiar la
// variable en Netlify, sin desplegar nada nuevo.

import { responderIA, type OpcionesIA } from './ia-stream.mts'

const API_RESPALDO = 'https://openrouter.ai/api/v1/chat/completions'
const MODELO_POR_DEFECTO = 'meta-llama/llama-3.3-70b-instruct:free'

const AVISO_MODO_GRATUITO =
  '⚠️ **Modo gratuito** — la IA principal no tiene crédito disponible en este momento. ' +
  'Esta respuesta la generó un modelo de código abierto gratuito, no Claude: puede ser menos precisa. ' +
  'Revisa los datos importantes antes de confiar en ellos.\n\n---\n\n'

const REFUERZO_HONESTIDAD = `

## Modo gratuito — regla extra, OBLIGATORIA
Estás corriendo como modelo de respaldo gratuito, no como el modelo principal. Por eso esta regla es todavía más estricta: si no tienes certeza de algo, o no viene en lo que te adjuntaron, dilo explícitamente ("no tengo ese dato" / "no estoy seguro, confírmalo") en vez de responder algo solo para completar la respuesta. Nunca inventes cifras, nombres, artículos de ley, fuentes ni datos de mercado.`

// Convierte un bloque de contenido estilo Anthropic (image/document/text) al
// formato que usan OpenAI y OpenRouter.
function convertirBloque(b: any): any {
  if (!b || typeof b === 'string') return { type: 'text', text: String(b || '') }
  if (b.type === 'text') return { type: 'text', text: String(b.text || '') }
  if (b.type === 'image' && b.source?.type === 'base64') {
    return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
  }
  if (b.type === 'document') {
    return { type: 'text', text: '[Se adjuntó un PDF que el modo gratuito no puede leer directamente. Si hay texto ya extraído del mismo archivo, úsalo.]' }
  }
  return { type: 'text', text: '' }
}

function convertirMensajes(mensajes: any[]): any[] {
  return mensajes.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: Array.isArray(m.content) ? m.content.map(convertirBloque) : String(m.content || ''),
  }))
}

function llamarRespaldo(key: string, maxTokens: number, topeMs: number | undefined, msRestante: number, mensajes: any[]): Promise<Response> {
  const modelo = Netlify.env.get('OPENROUTER_MODEL') || MODELO_POR_DEFECTO
  const tope = Math.max(8_000, Math.min(topeMs ?? 60_000, msRestante))
  return fetch(API_RESPALDO, {
    method: 'POST',
    signal: AbortSignal.timeout(tope),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://adminpropiedadescgvd.com',
      'X-Title': 'ArriendoPro',
    },
    body: JSON.stringify({ model: modelo, max_tokens: maxTokens, messages: mensajes, stream: true }),
  })
}

async function respaldoStream(o: OpcionesIA, key: string): Promise<Response> {
  const inicio = Date.now()
  const presupuesto = o.presupuestoMs ?? 140_000
  const maxRondas = o.maxRondas ?? 6
  const restante = () => presupuesto - (Date.now() - inicio)

  const mensajesBase = [{ role: 'system', content: o.system + REFUERZO_HONESTIDAD }, ...convertirMensajes(o.messages)]

  let r: Response
  try {
    r = await llamarRespaldo(key, o.maxTokens, o.topeMs, restante(), mensajesBase)
  } catch (e: any) {
    return Response.json({ error: 'No se pudo contactar el modelo de respaldo gratuito: ' + (e?.message || 'error de red') }, { status: 502 })
  }
  if (!r.ok || !r.body) {
    const j: any = await r.json().catch(() => ({}))
    return Response.json({ error: j?.error?.message || 'El modelo de respaldo gratuito no respondió.' }, { status: 502 })
  }

  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let algo = false
      const empujar = (t: string) => {
        if (t) { algo = true; controller.enqueue(enc.encode(t)) }
      }
      empujar(AVISO_MODO_GRATUITO)
      let acc = ''
      let resp: Response = r
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
          try { rc = await llamarRespaldo(key, o.maxTokens, o.topeMs, restante(), mensajesCont) }
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

// Punto de entrada: intenta Anthropic primero (si hay clave); si falla o no
// hay clave, cae automáticamente al modelo gratuito de respaldo. Si tampoco
// hay un respaldo configurado, devuelve un error claro explicando qué falta.
export async function responderConRespaldo(o: OpcionesIA): Promise<Response> {
  if (o.apiKey) {
    const r = await responderIA(o)
    if (r.ok) return r
  }
  const openRouterKey = Netlify.env.get('OPENROUTER_API_KEY')
  if (!openRouterKey) {
    return Response.json(
      {
        error: o.apiKey
          ? 'La IA principal no tiene crédito disponible, y no hay un respaldo gratuito configurado (falta OPENROUTER_API_KEY en Netlify).'
          : 'Falta configurar ANTHROPIC_API_KEY (IA principal) u OPENROUTER_API_KEY (respaldo gratuito) en Netlify.',
      },
      { status: 503 },
    )
  }
  return respaldoStream(o, openRouterKey)
}
