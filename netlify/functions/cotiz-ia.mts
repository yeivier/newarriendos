import type { Config, Context } from '@netlify/functions'
import { quienLlama, sinAcceso } from '../lib/auth.mts'

// Asesor que compara presupuestos y elige el mejor, preguntando lo que le
// falte. No decide a ciegas: si el caso lo amerita, hace una o dos preguntas
// (¿es urgente?, ¿te importa más ahorrar o que dure?, ¿ya trabajaste con
// alguno?) y recién entonces recomienda, con el motivo en palabras claras.
// Requiere sesión: lo usa el dueño, no está abierto al público.
//
// POST /api/cotiz-ia
//   { ofertas:[{prov,total,iva,dias,garantia,nota}], titulo, contexto,
//     messages:[{role,content}] } -> { text }

const API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-5'
const TOPE_MS = 9500

const ASESOR = `Eres un asesor con experiencia administrando propiedades en Chile, y estás ayudando a decidir entre varios presupuestos (cotizaciones) para un trabajo: una reparación, una pintura, una mantención, lo que sea. Hablas en español de Chile, tratando de "tú", claro y directo, sin rodeos.

## Cómo trabajas
1. **Comparas con criterio.** Todos los montos que te paso ya están con IVA incluido, así que son comparables. Miras el precio, el plazo de entrega, la garantía y lo que incluye o no cada uno.
2. **Preguntas lo justo antes de decidir.** Si con lo que tienes no alcanza para recomendar bien, haces UNA o DOS preguntas cortas y concretas —nunca más de dos a la vez— para entender qué le importa a la persona: si el trabajo es urgente, si prefiere gastar menos o que dure más, si ya trabajó con alguno, si hay un tope de plata. No preguntes cosas que ya se ven en los datos.
3. **Recomiendas claro.** Cuando ya tienes lo necesario, dices cuál conviene y por qué, en dos o tres frases. Nombras al proveedor, das el número que zanja la decisión (cuánto más caro/barato, cuántos días antes, cuánta garantía) y, si corresponde, adviertes de un riesgo ("el más barato no da garantía"). Cierra con una recomendación, no con un "depende".

## Cómo respondes
- Breve. Dos o tres frases por turno.
- Si vas a preguntar, hazlo al final, con la pregunta bien marcada.
- Si ya recomiendas, parte por el nombre del que conviene y luego el motivo.
- No inventes datos que no te pasé (no supongas precios, plazos ni calidad que no estén). Si algo falta y es importante, pídelo.
- Un presupuesto no lo es todo: si ves una bandera roja (garantía cero, plazo larguísimo, precio sospechosamente bajo), dilo.`

export default async (req: Request, _context: Context) => {
  const yo = await quienLlama(req)
  if (!yo) return sinAcceso()

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return Response.json({ error: 'Falta configurar ANTHROPIC_API_KEY en Netlify.' }, { status: 503 })

  let body: any
  try { body = await req.json() } catch { return Response.json({ error: 'Cuerpo inválido' }, { status: 400 }) }

  const ofertas = (Array.isArray(body.ofertas) ? body.ofertas : []).slice(0, 12).map((o: any) => ({
    prov: String(o?.prov || 'Sin nombre').slice(0, 80),
    total: Number(o?.total) || 0,
    dias: Number(o?.dias) || 0,
    garantia: Number(o?.garantia) || 0,
    nota: String(o?.nota || '').slice(0, 300),
  }))
  if (ofertas.length < 2) return Response.json({ error: 'Necesito al menos dos presupuestos para comparar.' }, { status: 400 })

  const titulo = String(body.titulo || 'un trabajo').slice(0, 160)
  const contexto = String(body.contexto || '').slice(0, 300)

  const tabla = ofertas
    .map((o: any, i: number) =>
      `${i + 1}. ${o.prov} — total con IVA $${o.total.toLocaleString('es-CL')}` +
      (o.dias ? ` · ${o.dias} días` : ' · plazo no indicado') +
      (o.garantia ? ` · ${o.garantia} meses de garantía` : ' · sin garantía') +
      (o.nota ? ` · incluye: ${o.nota}` : ''))
    .join('\n')

  const contextoBloque =
    `\n\n## El trabajo\nSe está cotizando: ${titulo}${contexto ? ` (${contexto})` : ''}.\n\n## Los presupuestos (todos con IVA)\n${tabla}\n\nUsa exactamente estos datos. Si te falta algo para decidir, pregunta; si ya alcanza, recomienda.`

  const mensajes: any[] = (Array.isArray(body.messages) ? body.messages : []).slice(-12).map((m: any) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String((m && m.content) || '').slice(0, 2000),
  })).filter((m: any) => m.content)
  // Arranque: si no hay conversación aún, se le pide que abra.
  if (!mensajes.length) mensajes.push({ role: 'user', content: 'Compara estos presupuestos. Si necesitas saber algo para elegir bien, pregúntame; si no, dime cuál conviene y por qué.' })

  try {
    const r = await fetch(API, {
      method: 'POST',
      signal: AbortSignal.timeout(TOPE_MS),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        output_config: { effort: 'medium' },
        system: ASESOR + contextoBloque,
        messages: mensajes,
      }),
    })
    const j: any = await r.json()
    if (!r.ok) return Response.json({ error: j?.error?.message || 'Error de la IA' }, { status: 502 })
    if (j.stop_reason === 'refusal') return Response.json({ text: 'Prefiero no responder eso. Pregúntame sobre los presupuestos.' })
    const texto = (j.content || []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n')
    return Response.json({ text: texto || 'No alcancé a responder. Inténtalo de nuevo.' })
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return Response.json({ text: 'Me demoré más de la cuenta 😅 Vuelve a preguntármelo.' })
    }
    return Response.json({ error: 'No se pudo contactar la IA: ' + (e?.message || 'error de red') }, { status: 502 })
  }
}

export const config: Config = { path: '/api/cotiz-ia', method: ['POST'] }
