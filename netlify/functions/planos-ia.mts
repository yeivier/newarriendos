import type { Config, Context } from '@netlify/functions'
import { quienLlama, sinAcceso } from '../lib/auth.mts'

// Agente experto en lectura de planos de arquitectura.
//
// Recibe una imagen de un plano (o un PDF) y una pregunta, y devuelve una
// lectura profesional: qué tipo de plano es, qué se ve, medidas y superficies
// si están acotadas, y sugerencias de mejora con criterio. Requiere sesión: lo
// usan el dueño y el arquitecto, no está abierto al público.
//
// POST /api/planos-ia
//   { messages:[{role,content}], plano?:{media,data,name}, contexto?:string } -> { text }

const API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-5'
// La respuesta se transmite en vivo (streaming). Mientras van llegando letras,
// la función de Netlify sigue abierta, así que ya no se corta a los ~10 s como
// antes (esa era la causa del "me demoré más de la cuenta"). El tope es un
// resguardo generoso por si la IA se cuelga del todo.
const TOPE_MS = 55_000
const MAX_B64 = 5_500_000

const EXPERTO = `Eres un arquitecto chileno con años leyendo e interpretando planos. Analizas el plano que te muestran y respondes con criterio profesional, en español de Chile, tratando de "tú". Directo y claro: nada de rodeos ni de repetir la pregunta.

## Qué haces con un plano
1. **Lo identificas.** Dices qué tipo de plano es (planta de arquitectura, elevación, corte, emplazamiento, planta de fundaciones, instalación sanitaria o eléctrica, plano de loteo, etc.) y a qué escala parece estar si aparece.
2. **Lo lees.** Enumeras los recintos que se distinguen (dormitorios, baños, cocina, estar-comedor, logia, terraza), la orientación si hay norte marcado, accesos y circulaciones, y las medidas o superficies que estén acotadas. Si algo no se alcanza a leer, dilo en vez de inventar.
3. **Calculas cuando puedes.** Si hay cotas, estimas superficies aproximadas y lo dices como aproximación, nunca como dato exacto.
4. **Sugieres mejoras** con ojo de arquitecto: aprovechamiento del espacio, iluminación y ventilación natural, circulaciones, relación público-privado, accesibilidad, orientación, posibles ampliaciones. Señala también lo que convendría revisar en terreno o con un especialista (estructura, normativa, factibilidad sanitaria).
5. **Marcas lo normativo con cuidado.** En Chile intervienen la OGUC, el plan regulador comunal, la Dirección de Obras Municipales, rasantes y distanciamientos, constructibilidad y ocupación de suelo. No afirmes que algo "cumple" o "no cumple": di qué habría que verificar y con quién.

## Cómo respondes
- Empieza por lo más útil: qué es el plano y lo que salta a la vista.
- Cifras y superficies cuando el plano las permita, siempre como estimación.
- Si te piden solo una cosa (por ejemplo, "¿cuántos m2 tiene?"), respóndela primero y breve.
- No inventes medidas, nombres de recintos ni datos que no estén en el plano. Si el plano está borroso o incompleto, dilo.
- Un plano no reemplaza el trabajo en terreno ni la revisión municipal: recuérdalo cuando corresponda, sin ser pesado.`

export default async (req: Request, _context: Context) => {
  const yo = await quienLlama(req)
  if (!yo) return sinAcceso()

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return Response.json({ error: 'Falta configurar ANTHROPIC_API_KEY en Netlify.' }, { status: 503 })

  let body: any
  try { body = await req.json() } catch { return Response.json({ error: 'Cuerpo inválido' }, { status: 400 }) }

  const mensajes: any[] = (Array.isArray(body.messages) ? body.messages : []).slice(-12).map((m: any) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String((m && m.content) || '').slice(0, 4000),
  })).filter((m: any) => m.content)
  if (!mensajes.length) return Response.json({ error: 'Sin mensajes' }, { status: 400 })

  // El plano: imagen (jpeg/png/webp/gif) o PDF en base64.
  const plano = body.plano
  if (plano && plano.data) {
    const data = String(plano.data || '')
    const media = String(plano.media || 'image/jpeg')
    let bloque: any = null
    if (data.length <= MAX_B64) {
      if (media === 'application/pdf') bloque = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      else if (/^image\/(jpeg|png|gif|webp)$/.test(media)) bloque = { type: 'image', source: { type: 'base64', media_type: media, data } }
    }
    if (bloque) {
      const ult = mensajes[mensajes.length - 1]
      ult.content = [bloque, { type: 'text', text: String(ult.content || 'Analiza este plano.') }]
    }
  }

  const ctx = body.contexto && String(body.contexto).trim()
    ? `\n\n## Contexto de la propiedad\n${String(body.contexto).slice(0, 1500)}`
    : ''

  let r: Response
  try {
    r = await fetch(API, {
      method: 'POST',
      signal: AbortSignal.timeout(TOPE_MS),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        // Esfuerzo bajo = primera letra rápida; el plano se lee igual de bien y
        // ya no depende de terminar antes de que Netlify corte la función,
        // porque la respuesta va saliendo en vivo.
        max_tokens: 1600,
        output_config: { effort: 'low' },
        system: EXPERTO + ctx,
        messages: mensajes,
        stream: true,
      }),
    })
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return Response.json({ text: 'Me demoré más de la cuenta con el plano 😅 Prueba de nuevo, o con una imagen más liviana.' }, { status: 200 })
    }
    return Response.json({ error: 'No se pudo contactar la IA: ' + (e?.message || 'error de red') }, { status: 502 })
  }

  // Si la API rechazó la petición antes de empezar a responder, avisamos con un
  // JSON normal (el navegador lo lee por !r.ok).
  if (!r.ok || !r.body) {
    const j: any = await r.json().catch(() => ({}))
    return Response.json({ error: j?.error?.message || 'Error de la IA' }, { status: 502 })
  }

  // Reenvía el flujo SSE de Anthropic como texto plano, letra por letra. Así la
  // ventana ve el plano "escribiéndose" y la función no se cae por tiempo.
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
            else if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'refusal' && !algo) empujar('Prefiero no responder eso. Muéstrame un plano y te lo leo.')
            else if (ev.type === 'error') empujar(algo ? '\n\n(Se cortó la lectura del plano.)' : 'No pude leer el plano. Intenta de nuevo con una foto más nítida.')
          }
        }
        if (!algo) empujar('No alcancé a leer el plano. Prueba con una foto más nítida o más liviana.')
      } catch {
        empujar(algo ? '\n\n(Se cortó la lectura del plano. Intenta de nuevo.)' : 'Me demoré más de la cuenta con el plano 😅 Prueba de nuevo, o con una imagen más liviana.')
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

export const config: Config = { path: '/api/planos-ia', method: ['POST'] }
