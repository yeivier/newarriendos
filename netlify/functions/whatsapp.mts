import type { Config, Context } from '@netlify/functions'
import { quienLlama, sinAcceso } from '../lib/auth.mts'

// Lector de chats de WhatsApp exportados.
//
// Recibe la transcripción de un chat (con marcadores de los archivos adjuntos
// intercalados, por ejemplo «[ARCHIVO: IMG-0001.jpg — imagen]») y la lista de
// propiedades de la persona. Devuelve un JSON con un resumen y una lista de
// "cosas para ingresar": gastos, incidencias, notas de bitácora, presupuestos y
// documentos de recepción municipal, fotos y archivos — cada uno diciendo a qué
// propiedad va y qué archivos del chat hay que adjuntarle. La plataforma después
// ejecuta esas acciones y sube los archivos.
//
// Requiere sesión: la IA cuesta, la usa quien entró con la clave.
//
// POST /api/whatsapp
//   { transcripcion:string, propiedades?:[{id,nombre,direccion,comuna}], propiedadId?:string } -> { resumen, coincidenciaId, items:[...] }

const API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-5'
// Igual que la lectura de documentos (que ya funciona): esfuerzo bajo y una
// entrada acotada para que quepa en el tiempo de la función. El cliente además
// manda solo un tramo del chat si es enorme.
const TOPE_MS = 24_000
const MAX_TRANS = 16_000

const SISTEMA = `Eres un asistente que ordena chats de WhatsApp para una administradora de propiedades chilena. Te paso la transcripción de un grupo o conversación (a veces de una obra, un arreglo, un arriendo o la administración de una propiedad), con los archivos adjuntos marcados en el texto como «[ARCHIVO: nombre — tipo]» justo donde aparecieron.

Tu trabajo es leer TODO y devolver SOLO un objeto JSON válido (sin markdown, sin texto fuera del JSON) con esta forma exacta:

{
 "resumen": "3 a 6 frases en español de Chile: de qué trata el chat, quiénes participan y lo más importante que se acordó o pasó",
 "coincidenciaId": "id de la propiedad de la lista que coincide con el chat, o null",
 "items": [
   {
     "accion": "gasto" | "bitacora" | "incidencia" | "recep_presupuesto" | "recep_doc" | "foto" | "archivo" | "ninguna",
     "propiedadId": "id de la propiedad a la que va, o null",
     "titulo": "título corto y claro",
     "detalle": "lo que quedará guardado: qué se dijo, con montos, fechas y nombres relevantes",
     "monto": 0,
     "moneda": "CLP" | "UF",
     "periodo": "mes" | "año" | "una vez",
     "contratista": "nombre de quien cotiza o hace el trabajo, si aplica",
     "fecha": "AAAA-MM-DD si el chat la señala, o null",
     "medios": ["nombre exacto de cada [ARCHIVO] del chat que hay que adjuntar a este item"]
   }
 ]
}

Cuándo usar cada acción:
- "incidencia": se reporta un problema, daño, filtración, falla o reclamo de la propiedad. Adjunta las fotos del problema en "medios".
- "recep_presupuesto": alguien manda un PRESUPUESTO o COTIZACIÓN por un trabajo. "contratista" = quién cotiza, "monto"/"moneda" = lo cotizado, "medios" = el PDF/imagen del presupuesto.
- "recep_doc": es uno de los papeles de la RECEPCIÓN MUNICIPAL (permiso de edificación, planos timbrados, certificado SEC/TE1, sanitario, gas, etc.). "titulo" = el nombre del documento, "medios" = el archivo.
- "gasto": se pagó o se comprometió un costo (materiales, mano de obra, gasto común, etc.). "monto" y "periodo".
- "bitacora": conviene dejar constancia de un acuerdo, visita, coordinación, fecha o comunicación importante. Adjunta en "medios" las fotos o audios que respalden la nota.
- "foto": una o varias fotos que muestran estado/avance/terreno y no calzan con una incidencia. Junta las fotos relacionadas en un mismo item, "medios" = esas fotos.
- "archivo": un documento (PDF, Word, Excel, planilla) que conviene guardar y no es presupuesto ni papel de recepción.
- "ninguna": no aporta nada útil (saludos, coordinaciones triviales). No generes items "ninguna" salvo que expliques en "detalle" por qué lo descartas; mejor omítelos.

Reglas:
- Cada archivo marcado en el chat debería quedar asignado a algún item (por su nombre exacto en "medios"), salvo que de verdad no sirva. No inventes nombres de archivo: usa solo los que aparezcan entre corchetes.
- Agrupa con criterio: varias fotos del mismo problema van en un item; no hagas un item por cada foto si son lo mismo.
- Montos en números sin puntos ni símbolos; fechas ISO AAAA-MM-DD.
- No inventes datos que el chat no diga. Si un monto o una fecha no está, deja el campo en 0 o null.
- Si te indican una propiedad de destino, usa ese id en "propiedadId" de todos los items salvo que el chat diga claramente que algo es de otra.
- Ordena "items" de lo más importante a lo menos. Entre 1 y 25 items.`

const num = (v: any) => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''))
  return isNaN(n) ? 0 : n
}

export default async (req: Request, _context: Context) => {
  const yo = await quienLlama(req)
  if (!yo) return sinAcceso()

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return Response.json({ error: 'Falta configurar ANTHROPIC_API_KEY en Netlify.' }, { status: 503 })

  let body: any
  try { body = await req.json() } catch { return Response.json({ error: 'Cuerpo inválido' }, { status: 400 }) }

  const transcripcion = String(body.transcripcion || '').slice(0, MAX_TRANS)
  if (!transcripcion.trim()) return Response.json({ error: 'El chat llegó vacío' }, { status: 400 })

  const props = Array.isArray(body.propiedades) ? body.propiedades.slice(0, 60) : []
  const destino = body.propiedadId && String(body.propiedadId).trim()
    ? `\n\nPROPIEDAD DE DESTINO indicada por la persona (usa este id en "propiedadId"): ${String(body.propiedadId).trim()}`
    : ''
  const lista = props.length
    ? `\n\nPropiedades existentes en la plataforma (para "coincidenciaId" y "propiedadId"): ${JSON.stringify(props).slice(0, 4000)}`
    : ''

  try {
    const r = await fetch(API, {
      method: 'POST',
      signal: AbortSignal.timeout(TOPE_MS),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3500,
        output_config: { effort: 'low' },
        system: SISTEMA + lista + destino,
        messages: [{ role: 'user', content: `Aquí está el chat de WhatsApp exportado. Léelo y devuelve el JSON en el formato indicado.\n\n---\n${transcripcion}\n---` }],
      }),
    })
    const j: any = await r.json()
    if (!r.ok) return Response.json({ error: j?.error?.message || 'Error de la IA' }, { status: 502 })
    if (j.stop_reason === 'refusal') return Response.json({ error: 'No puedo procesar este chat.' }, { status: 200 })

    const texto = (j.content || []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n')
    const limpio = texto.replace(/```json|```/g, '').trim()
    let datos: any = null
    try {
      const ini = limpio.indexOf('{')
      const fin = limpio.lastIndexOf('}')
      datos = JSON.parse(limpio.slice(ini, fin + 1))
    } catch {
      return Response.json({ resumen: 'Leí el chat pero no pude ordenarlo en acciones. Resumen:\n' + limpio.slice(0, 1200), coincidenciaId: null, items: [] })
    }

    // Se saneia la salida para que el navegador reciba siempre la misma forma.
    const acciones = new Set(['gasto', 'bitacora', 'incidencia', 'recep_presupuesto', 'recep_doc', 'foto', 'archivo', 'ninguna'])
    const items = (Array.isArray(datos.items) ? datos.items : []).slice(0, 25).map((it: any) => ({
      accion: acciones.has(it?.accion) ? it.accion : 'bitacora',
      propiedadId: it?.propiedadId != null ? String(it.propiedadId) : null,
      titulo: String(it?.titulo || '').slice(0, 200) || 'Del chat de WhatsApp',
      detalle: String(it?.detalle || '').slice(0, 2000),
      monto: num(it?.monto),
      moneda: it?.moneda === 'UF' ? 'UF' : 'CLP',
      periodo: ['mes', 'año', 'una vez'].includes(it?.periodo) ? it.periodo : 'una vez',
      contratista: String(it?.contratista || '').slice(0, 160),
      fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(it?.fecha || '')) ? it.fecha : null,
      medios: Array.isArray(it?.medios) ? it.medios.map((m: any) => String(m || '')).filter(Boolean).slice(0, 40) : [],
    })).filter((it: any) => it.accion !== 'ninguna')

    return Response.json({
      resumen: String(datos.resumen || 'Chat leído.').slice(0, 2000),
      coincidenciaId: datos.coincidenciaId != null ? String(datos.coincidenciaId) : null,
      items,
    })
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return Response.json({ error: 'El chat es muy largo y me demoré demasiado. Prueba con un tramo más corto.' }, { status: 200 })
    }
    return Response.json({ error: 'No se pudo contactar la IA: ' + (e?.message || 'error de red') }, { status: 502 })
  }
}

export const config: Config = { path: '/api/whatsapp', method: ['POST'] }
