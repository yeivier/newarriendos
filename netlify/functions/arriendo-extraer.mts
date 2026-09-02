import type { Config, Context } from '@netlify/functions'
import { quienLlama, sinAcceso } from '../lib/auth.mts'

// Lee un archivo (aviso, ficha, foto de la publicación, PDF) y extrae los datos
// de la propiedad para autocompletar la calculadora de arriendo. Devuelve un
// objeto JSON con los campos; lo que no aparezca queda vacío. Es rápido y no va
// en streaming: solo saca datos, no redacta.
//
// POST /api/arriendo-extraer
//   { archivos:[{media,data,name}], texto? } -> { datos:{...} }

const API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-5'
const TOPE_MS = 9200
const MAX_B64_TOTAL = 7_000_000

const SYS = `Extraes los datos de una propiedad desde el documento que te muestran (un aviso de arriendo, una ficha, una foto de la publicación, un PDF, una captura) para llenar una calculadora de arriendo en Chile. Devuelves SOLO un objeto JSON válido, sin ningún texto antes ni después, sin explicaciones y sin bloque de código. Formato exacto de las claves:
{"region":"","comuna":"","sector":"","tipo":"Departamento","m2":0,"dorm":0,"banos":0,"estac":0,"bodega":false,"estado":"","ano":"","amoblado":false,"gc":0,"conectividad":"","plusvalia":"","notas":""}
Reglas:
- Rellena SOLO lo que aparezca o se deduzca claramente del documento. Lo que no encuentres déjalo en "" (texto), 0 (número) o false (sí/no). No inventes datos.
- "tipo": uno de Departamento, Casa, Oficina u Otro.
- "region": el nombre de la región chilena si se deduce de la comuna (ej: comuna Ñuñoa o Providencia -> "Metropolitana de Santiago"; Viña del Mar -> "Valparaíso").
- "m2": metros cuadrados útiles o construidos, solo el número entero. "gc": gastos comunes en pesos, solo el número entero.
- "amoblado" y "bodega": true solo si el documento lo dice.
- "ano": año de construcción o antigüedad tal como aparezca (texto).
- "conectividad": cercanía a metro, locomoción o servicios si se menciona.
- "notas": datos útiles que no tengan campo propio (orientación, piso, vista, terraza, bodega, etc.).
Responde únicamente el JSON.`

const clamp = (o: any) => {
  const s = (v: any, m = 200) => (v == null ? '' : String(v).slice(0, m))
  const n = (v: any) => { const x = Math.round(Number(v)); return Number.isFinite(x) && x >= 0 ? x : 0 }
  const tipos = ['Departamento', 'Casa', 'Oficina', 'Otro']
  const tipo = tipos.includes(s(o?.tipo, 20)) ? s(o?.tipo, 20) : ''
  return {
    region: s(o?.region), comuna: s(o?.comuna), sector: s(o?.sector),
    tipo: tipo || 'Departamento',
    m2: n(o?.m2), dorm: n(o?.dorm), banos: n(o?.banos), estac: n(o?.estac),
    bodega: o?.bodega === true, estado: s(o?.estado, 60), ano: s(o?.ano, 30),
    amoblado: o?.amoblado === true, gc: n(o?.gc),
    conectividad: s(o?.conectividad, 300), plusvalia: s(o?.plusvalia, 300), notas: s(o?.notas, 600),
  }
}

export default async (req: Request, _context: Context) => {
  const yo = await quienLlama(req)
  if (!yo) return sinAcceso()

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return Response.json({ error: 'Falta configurar ANTHROPIC_API_KEY en Netlify.' }, { status: 503 })

  let body: any
  try { body = await req.json() } catch { return Response.json({ error: 'Cuerpo inválido' }, { status: 400 }) }

  const archivos = (Array.isArray(body.archivos) ? body.archivos : []).slice(0, 6)
  const bloques: any[] = []
  let suma = 0
  for (const a of archivos) {
    const data = String(a?.data || ''); const media = String(a?.media || 'image/jpeg')
    if (!data || suma + data.length > MAX_B64_TOTAL) continue
    if (media === 'application/pdf') { bloques.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }); suma += data.length }
    else if (/^image\/(jpeg|png|gif|webp)$/.test(media)) { bloques.push({ type: 'image', source: { type: 'base64', media_type: media, data } }); suma += data.length }
  }
  const texto = String(body.texto || '').slice(0, 16000)
  if (!bloques.length && !texto.trim()) return Response.json({ error: 'No recibí un archivo legible. Prueba con una foto, un PDF o texto.' }, { status: 400 })

  const partes: any[] = [...bloques]
  partes.push({ type: 'text', text: 'Saca los datos de esta propiedad y devuélvelos como JSON.' + (texto ? '\n\nTexto del archivo:\n' + texto : '') })

  let r: Response
  try {
    r = await fetch(API, {
      method: 'POST',
      signal: AbortSignal.timeout(TOPE_MS),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, output_config: { effort: 'low' }, system: SYS, messages: [{ role: 'user', content: partes }] }),
    })
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return Response.json({ error: 'Me demoré leyendo el archivo. Prueba con una imagen más liviana o completa los datos a mano.' }, { status: 200 })
    return Response.json({ error: 'No se pudo contactar la IA: ' + (e?.message || 'error de red') }, { status: 502 })
  }

  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) return Response.json({ error: j?.error?.message || 'Error de la IA' }, { status: 502 })
  const txt = (j.content || []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('')
  const m = /\{[\s\S]*\}/.exec(txt || '')
  if (!m) return Response.json({ error: 'No pude sacar los datos del archivo. Compléta lo que falte a mano.' }, { status: 200 })
  let datos: any
  try { datos = JSON.parse(m[0]) } catch { return Response.json({ error: 'El archivo no venía claro. Completa los datos a mano.' }, { status: 200 }) }
  return Response.json({ datos: clamp(datos) })
}

export const config: Config = { path: '/api/arriendo-extraer', method: ['POST'] }
