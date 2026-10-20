import type { Config, Context } from '@netlify/functions'
import { quienLlama, sinAcceso } from '../lib/auth.mts'
import { responderConRespaldo } from '../lib/ia-respaldo.mts'

// Investigación de mercado inmobiliario chileno, con búsqueda web REAL — a
// diferencia de la calculadora de arriendo (arriendo-precio.mts), que estima
// con el conocimiento general del modelo, esta función busca en internet de
// verdad (Google Custom Search) y solo resume lo que encontró, citando la
// fuente de cada dato. Así cumple con "que no invente nada": si la búsqueda
// no trae nada relevante, la IA tiene que decirlo en vez de inventar un precio
// o una noticia.
//
// Requiere dos variables de entorno nuevas en Netlify (gratuitas, hasta 100
// búsquedas al día): GOOGLE_SEARCH_API_KEY y GOOGLE_SEARCH_CX (el "motor de
// búsqueda programable" de Google, configurado para buscar en todo el web).
//
// POST /api/mercado
//   { consulta, messages?:[{role,content}] } -> stream de texto

const MODEL = 'claude-opus-5'
const TOPE_MS = 45_000
const MAX_TOKENS = 3_500
const MAX_CONSULTA = 300

const SISTEMA = `Eres un analista de mercado inmobiliario chileno. Tu única fuente de información son los resultados de búsqueda reales que se te entregan abajo — NUNCA uses lo que "recuerdas" de tu entrenamiento para precios, noticias o eventos, porque puede estar desactualizado o ser falso. Hablas en español de Chile, directo y claro, para una propietaria sin conocimientos técnicos.

## Regla de oro — OBLIGATORIA
Solo puedes afirmar algo si aparece en los resultados de búsqueda que se te dieron. Para cada dato concreto que menciones (un precio, una cifra, una noticia, un evento), cita de cuál resultado lo sacaste, con su enlace. Si los resultados no alcanzan para responder la pregunta, dilo explícitamente: "No encontré información confiable sobre esto" — nunca completes con una suposición o con lo que "normalmente" pasa.

## Formato de tu respuesta
Empieza con un resumen directo de 2-3 frases respondiendo la consulta. Luego, si corresponde, un detalle por punto, cada uno con su fuente entre paréntesis al final, como un enlace en markdown. Cierra, si tiene sentido, con una recomendación práctica para alguien que administra propiedades en arriendo — pero solo si los datos la sustentan.`

async function buscarGoogle(consulta: string, apiKey: string, cx: string) {
  const url = new URL('https://www.googleapis.com/customsearch/v1')
  url.searchParams.set('key', apiKey)
  url.searchParams.set('cx', cx)
  url.searchParams.set('q', consulta)
  url.searchParams.set('num', '8')
  url.searchParams.set('hl', 'es')
  url.searchParams.set('gl', 'cl')
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) {
    const j: any = await r.json().catch(() => ({}))
    throw new Error(j?.error?.message || `Google Search respondió ${r.status}`)
  }
  const j: any = await r.json()
  const items = Array.isArray(j.items) ? j.items : []
  return items.slice(0, 8).map((it: any) => ({
    titulo: String(it.title || ''),
    resumen: String(it.snippet || ''),
    enlace: String(it.link || ''),
  }))
}

export default async (req: Request, _context: Context) => {
  const yo = await quienLlama(req)
  if (!yo) return sinAcceso()

  const googleKey = Netlify.env.get('GOOGLE_SEARCH_API_KEY')
  const googleCx = Netlify.env.get('GOOGLE_SEARCH_CX')
  if (!googleKey || !googleCx) {
    return Response.json(
      { error: 'Falta configurar GOOGLE_SEARCH_API_KEY y GOOGLE_SEARCH_CX en Netlify para poder buscar en internet.' },
      { status: 503 },
    )
  }

  let body: any
  try { body = await req.json() } catch { return Response.json({ error: 'Cuerpo inválido' }, { status: 400 }) }

  const consulta = String(body.consulta || '').trim().slice(0, MAX_CONSULTA)
  const mensajes: any[] = (Array.isArray(body.messages) ? body.messages : []).slice(-8).map((m: any) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String((m && m.content) || '').slice(0, 2000),
  })).filter((m: any) => m.content)

  if (!mensajes.length && !consulta) {
    return Response.json({ error: 'Cuéntame qué quieres investigar: un precio, una comuna, una noticia del rubro.' }, { status: 400 })
  }

  // Siempre se busca en Google con la consulta más reciente (la pregunta de
  // seguimiento, si la hay, o la consulta inicial), para que cada respuesta
  // esté grounded en resultados frescos y no solo en la primera búsqueda.
  const consultaBusqueda = mensajes.length ? String(mensajes[mensajes.length - 1].content) : consulta

  let resultados: { titulo: string; resumen: string; enlace: string }[] = []
  let errorBusqueda = ''
  try {
    resultados = await buscarGoogle(`mercado inmobiliario Chile ${consultaBusqueda}`, googleKey, googleCx)
  } catch (e: any) {
    errorBusqueda = e?.message || 'No se pudo completar la búsqueda.'
  }

  const bloqueResultados = resultados.length
    ? resultados.map((r, i) => `${i + 1}. [${r.titulo}](${r.enlace})\n${r.resumen}`).join('\n\n')
    : '(La búsqueda no devolvió resultados.)'

  const contexto = `## Resultados de búsqueda reales (${new Date().toLocaleDateString('es-CL', { timeZone: 'America/Santiago' })})\n${errorBusqueda ? `Error al buscar: ${errorBusqueda}` : bloqueResultados}`

  if (!mensajes.length) {
    mensajes.push({ role: 'user', content: `${consulta}\n\n${contexto}` })
  } else {
    mensajes.push({ role: 'user', content: `(Nueva búsqueda para esta pregunta)\n\n${contexto}` })
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')

  return responderConRespaldo({
    apiKey: apiKey || '',
    model: MODEL,
    maxTokens: MAX_TOKENS,
    effort: 'low',
    system: SISTEMA,
    messages: mensajes,
    topeMs: TOPE_MS,
    textos: {
      refusal: 'Prefiero no responder eso.',
      vacio: 'No alcancé a investigarlo. Intenta de nuevo con una pregunta más concreta.',
      corte: '\n\n*(Se cortó la respuesta. Intenta de nuevo.)*',
      demora: 'Me demoré más de la cuenta investigando 😅 Prueba de nuevo.',
    },
  })
}

export const config: Config = { path: '/api/mercado', method: ['POST'] }
