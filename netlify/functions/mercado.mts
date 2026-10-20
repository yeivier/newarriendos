import type { Config, Context } from '@netlify/functions'
import { quienLlama, sinAcceso } from '../lib/auth.mts'
import { responderIA } from '../lib/ia-stream.mts'
import { responderConRespaldo } from '../lib/ia-respaldo.mts'

// Investigación de mercado inmobiliario chileno, con búsqueda web REAL — a
// diferencia de la calculadora de arriendo (arriendo-precio.mts), que estima
// con el conocimiento general del modelo, esta función busca en internet de
// verdad antes de responder sobre precios, comunas o noticias del rubro, y
// cita la fuente de cada dato. Así cumple con "que no invente nada": si la
// búsqueda no trae nada relevante, la IA tiene que decirlo en vez de inventar.
//
// Camino principal: la herramienta de búsqueda web nativa de Claude
// (web_search / web_fetch). No necesita ninguna cuenta ni clave aparte — usa
// la misma ANTHROPIC_API_KEY que ya está configurada, y hace las búsquedas
// que hagan falta por su cuenta antes de escribir la respuesta.
//
// Camino de respaldo (si Claude no tiene crédito): Google Custom Search, si
// está configurado (GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX, gratis hasta
// 100 búsquedas al día) — se buscan los resultados aquí mismo y se le pasan
// ya encontrados al modelo de respaldo gratuito para que solo los resuma.
//
// POST /api/mercado
//   { consulta, messages?:[{role,content}] } -> stream de texto

const MODEL = 'claude-opus-5'
const TOPE_MS = 55_000
const MAX_TOKENS = 3_500
const MAX_CONSULTA = 300

const WEB_TOOLS = [
  {
    type: 'web_search_20260318',
    name: 'web_search',
    max_uses: 6,
    user_location: { type: 'approximate', country: 'CL', timezone: 'America/Santiago' },
  },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 },
]

const SISTEMA_BUSQUEDA = `Eres un analista de mercado inmobiliario chileno. Antes de responder, usa tu herramienta de búsqueda web para buscar información real y actual — nunca respondas con lo que "recuerdas" de tu entrenamiento para precios, noticias o eventos, porque puede estar desactualizado o ser falso. Hablas en español de Chile, directo y claro, para una propietaria sin conocimientos técnicos.

## Regla de oro — OBLIGATORIA
Solo puedes afirmar algo si lo encontraste en una búsqueda real que hiciste recién. Haz las búsquedas que hagan falta (varias si la pregunta lo amerita: distintos portales, distintas comunas, la noticia y su fuente original) antes de escribir tu respuesta. Para cada dato concreto que menciones (un precio, una cifra, una noticia, un evento), cita de dónde lo sacaste, con su enlace directo en markdown. Si después de buscar no encuentras nada confiable, dilo explícitamente: "No encontré información confiable sobre esto" — nunca completes con una suposición.

## Qué puedes investigar
Precios de arriendo o venta por comuna o tipo de propiedad, comparaciones entre comunas, noticias y tendencias del mercado inmobiliario chileno, cambios normativos, tasas de interés y su impacto en el arriendo, proyectos o eventos que afecten una zona. Si piden un "estudio" o "análisis" de mercado, busca en varias fuentes, compara y arma un panorama completo — no entregues una sola cifra suelta.

## Formato de tu respuesta
Empieza con un resumen directo de 2-3 frases respondiendo la consulta. Luego, si corresponde, un detalle por punto, cada uno con su fuente al final como un enlace en markdown. Cierra, si tiene sentido, con una recomendación práctica para alguien que administra propiedades en arriendo — pero solo si los datos la sustentan.`

const SISTEMA_RESPALDO = `Eres un analista de mercado inmobiliario chileno. Tu única fuente de información son los resultados de búsqueda reales que se te entregan abajo — NUNCA uses lo que "recuerdas" de tu entrenamiento para precios, noticias o eventos, porque puede estar desactualizado o ser falso. Hablas en español de Chile, directo y claro, para una propietaria sin conocimientos técnicos.

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

const TEXTOS = {
  refusal: 'Prefiero no responder eso.',
  vacio: 'No alcancé a investigarlo. Intenta de nuevo con una pregunta más concreta.',
  corte: '\n\n*(Se cortó la respuesta. Intenta de nuevo.)*',
  demora: 'Me demoré más de la cuenta investigando 😅 Prueba de nuevo.',
}

export default async (req: Request, _context: Context) => {
  const yo = await quienLlama(req)
  if (!yo) return sinAcceso()

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
  if (!mensajes.length) mensajes.push({ role: 'user', content: consulta })

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')

  // Camino principal: Claude busca por su cuenta con su herramienta nativa de
  // búsqueda web, sin necesitar ninguna cuenta ni clave aparte.
  if (apiKey) {
    const r = await responderIA({
      apiKey,
      model: MODEL,
      maxTokens: MAX_TOKENS,
      effort: 'low',
      system: SISTEMA_BUSQUEDA,
      messages: mensajes,
      tools: WEB_TOOLS,
      topeMs: TOPE_MS,
      textos: TEXTOS,
    })
    if (r.ok) return r
  }

  // Camino de respaldo: Claude no tiene crédito. Si hay Google Custom Search
  // configurado, se busca aquí y se le pasan los resultados ya encontrados al
  // modelo gratuito de respaldo para que solo los resuma (los modelos
  // gratuitos no tienen su propia herramienta de búsqueda web).
  const googleKey = Netlify.env.get('GOOGLE_SEARCH_API_KEY')
  const googleCx = Netlify.env.get('GOOGLE_SEARCH_CX')
  if (!googleKey || !googleCx) {
    return Response.json(
      {
        error: apiKey
          ? 'La IA principal no tiene crédito ahora mismo, y no hay un respaldo de búsqueda configurado (GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_CX en Netlify). Intenta de nuevo más tarde.'
          : 'Falta configurar ANTHROPIC_API_KEY (o, como respaldo, GOOGLE_SEARCH_API_KEY y GOOGLE_SEARCH_CX) en Netlify para poder buscar en internet.',
      },
      { status: 503 },
    )
  }

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

  const mensajesRespaldo = [...mensajes]
  mensajesRespaldo[mensajesRespaldo.length - 1] = {
    ...mensajesRespaldo[mensajesRespaldo.length - 1],
    content: `${mensajesRespaldo[mensajesRespaldo.length - 1].content}\n\n${contexto}`,
  }

  return responderConRespaldo({
    apiKey: '', // ya se intentó arriba; esto fuerza ir directo a la cadena gratuita
    model: MODEL,
    maxTokens: MAX_TOKENS,
    effort: 'low',
    system: SISTEMA_RESPALDO,
    messages: mensajesRespaldo,
    topeMs: TOPE_MS,
    textos: TEXTOS,
  })
}

export const config: Config = { path: '/api/mercado', method: ['POST'] }
