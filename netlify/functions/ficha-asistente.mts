import type { Config, Context } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

// Asistente de la Ficha de Levantamiento.
//
// La ficha es pública (se le manda el enlace a quien tenga que llenarla), así
// que este asistente NO usa la clave de la plataforma ni ve los datos privados
// del panel: solo conoce lo que la persona está escribiendo en la ficha y sabe
// del rubro inmobiliario chileno. Para no dejar la puerta abierta a que
// cualquiera gaste la cuenta, hay un tope de mensajes por hora y por conexión.
//
// POST /api/ficha-asistente
//   { messages:[{role,content}], ficha?:{...campos llenados...},
//     files?:[{media,data,name}|{texto,name}] }  -> { text }

const API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-5'
const TOPE_HORA = 40
const TOPE_MS = 8500

const PERSONALIDAD = `Eres el asistente de la Ficha de Levantamiento de Propiedad de New Arriendos, y además un asesor inmobiliario chileno con experiencia.

## Cómo hablas
Cercano, directo y profesional. Español de Chile, tratando de "tú". Respuestas cortas: dos o tres frases bastan casi siempre, y solo te extiendes cuando la pregunta lo pide. Nada de sonar a robot ni de repetir la pregunta. Un emoji como máximo por mensaje, y solo si aporta.

## Qué haces
1. **Ayudas a llenar la ficha.** Explicas qué va en cada campo, con ejemplos concretos, y dices dónde se consigue cada documento o dato.
2. **Explicas cualquier concepto del rubro** en palabras simples: CIP (Certificado de Informaciones Previas, lo emite la Dirección de Obras de la municipalidad), certificado de avalúo fiscal y rol del SII, contribuciones (4 cuotas al año: abril, junio, septiembre y noviembre), Conservador de Bienes Raíces, dominio vigente, hipotecas y gravámenes, inscripción con fojas/número/año, UF y UTM, DFL 2, permiso de edificación y recepción final, plan regulador, constructibilidad, tasación, gasto común, garantía, Ley 18.101 y Ley 21.461, corretaje y comisiones.
3. **Lees los archivos que te manden** (fotos, pantallazos, PDF, Word, Excel): dices qué documento es, resumes lo importante y señalas qué datos de ahí sirven para llenar la ficha y en qué campo van. Si algo no se alcanza a leer, dilo en vez de adivinar.
4. **Asesoras**: si te preguntan cuánto podrían arrendar o vender, qué conviene reparar antes de publicar, qué documentos pedirle a un arrendatario, cómo se calcula el reajuste en UF o qué revisar antes de comprar, respondes con criterio profesional.

## Cómo respondes
- Al grano, con cifras y plazos cuando corresponda.
- Si la ficha ya tiene datos cargados, úsalos: te los paso más abajo. Si notas que falta algo importante, dilo.
- No inventes datos de la propiedad ni cifras oficiales. Si no lo sabes, dilo y explica dónde se consigue.
- No tienes acceso al panel privado de New Arriendos (propiedades, arrendatarios, cobros): si te preguntan por eso, di que esa información está en la plataforma y que hay que entrar con la clave.

## Sobre el arriendo en UF
Los arriendos se pactan en UF y se pagan en pesos según el valor de la UF: por eso se reajustan solos, sin trámite. Lo habitual en Chile es cobrar con la UF del día en que se paga; algunos contratos usan la del día 1 o la del último día del mes anterior. Lo importante es que la regla quede escrita en el contrato.`

/** Tope por hora y por conexión, para que un enlace público no se vuelva un gasto abierto. */
async function pasaElTope(ip: string) {
  if (!ip) return true
  try {
    const store = getStore({ name: 'ficha-limite', consistency: 'strong' })
    const hora = new Date().toISOString().slice(0, 13)
    const llave = 'ip-' + ip.replace(/[^0-9a-zA-Z.:_-]/g, '')
    const dato = (await store.get(llave, { type: 'json' }).catch(() => null)) as { hora: string; n: number } | null
    const n = dato && dato.hora === hora ? dato.n + 1 : 1
    await store.setJSON(llave, { hora, n })
    return n <= TOPE_HORA
  } catch {
    return true // si el contador falla, no se deja a la persona sin asistente
  }
}

export default async (req: Request, context: Context) => {
  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return Response.json({ error: 'Falta configurar ANTHROPIC_API_KEY en Netlify.' }, { status: 503 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }

  const ip = (context as any)?.ip || req.headers.get('x-nf-client-connection-ip') || ''
  if (!(await pasaElTope(String(ip)))) {
    return Response.json(
      { error: 'Llegaste al máximo de consultas por hora. Inténtalo de nuevo más tarde.' },
      { status: 429 },
    )
  }

  const mensajes: any[] = (Array.isArray(body.messages) ? body.messages : []).slice(-14).map((m: any) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String((m && m.content) || '').slice(0, 4000),
  })).filter((m: any) => m.content)
  if (!mensajes.length) return Response.json({ error: 'Sin mensajes' }, { status: 400 })

  // Archivos adjuntos del chat. Las fotos y los PDF llegan en base64; de Word,
  // Excel y texto el navegador ya extrajo el contenido y lo manda como texto.
  const MAX_B64 = 5_500_000
  const adjuntos = (Array.isArray(body.files) ? body.files : []).slice(0, 4).map((f: any) => {
    if (!f) return null
    if (f.texto) return { type: 'text', text: `--- Contenido de "${String(f.name || 'archivo')}" ---\n${String(f.texto).slice(0, 60000)}` }
    const data = String(f.data || '')
    if (!data || data.length > MAX_B64) return null
    const media = String(f.media || f.media_type || 'image/jpeg')
    if (media === 'application/pdf') {
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    }
    if (!/^image\/(jpeg|png|gif|webp)$/.test(media)) return null
    return { type: 'image', source: { type: 'base64', media_type: media, data } }
  }).filter(Boolean)

  if (adjuntos.length) {
    // Van pegados al último mensaje, que es el que los acompaña.
    const ult = mensajes[mensajes.length - 1]
    ult.content = [...adjuntos, { type: 'text', text: String(ult.content || 'Revisa estos archivos.') }]
  }

  const ficha = body.ficha && typeof body.ficha === 'object'
    ? `\n\n## Lo que ya está escrito en la ficha\n${JSON.stringify(body.ficha).slice(0, 3000)}\nUsa estos datos para responder con lo que la persona ya cargó, y para avisarle si falta algo importante.`
    : '\n\n## La ficha todavía está vacía\nAyúdala a partir: dile por dónde conviene empezar y qué documentos tener a mano.'

  try {
    const r = await fetch(API, {
      method: 'POST',
      signal: AbortSignal.timeout(TOPE_MS),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        output_config: { effort: 'low' },
        system: PERSONALIDAD + ficha,
        messages: mensajes,
      }),
    })
    const j: any = await r.json()
    if (!r.ok) return Response.json({ error: j?.error?.message || 'Error de la IA' }, { status: 502 })
    if (j.stop_reason === 'refusal') {
      return Response.json({ text: 'Prefiero no responder eso. Pregúntame algo sobre la propiedad o la ficha.' })
    }
    const texto = (j.content || []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n')
    return Response.json({ text: texto || 'No alcancé a responder. Inténtalo de nuevo.' })
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return Response.json({ text: 'Me demoré más de la cuenta 😅 Vuelve a preguntármelo, si puede ser más corto.' })
    }
    return Response.json({ error: 'No se pudo contactar la IA: ' + (e?.message || 'error de red') }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/ficha-asistente',
  method: ['POST'],
}
