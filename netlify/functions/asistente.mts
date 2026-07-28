import type { Context, Config } from '@netlify/functions'
import { quienLlama, sinAcceso } from '../lib/auth.mts'

// Asistente de IA de ArriendoPro (proxy seguro hacia la API de Anthropic).
// La clave nunca sale del servidor: se lee de la variable ANTHROPIC_API_KEY.
//
// POST /api/asistente
//   { system, messages:[{role,content}], files?:[{media_type,data,name}] }        -> { text }
//   { mode:"extraer", files:[{media_type,data,name}], propiedades?:[{id,nombre,direccion}] } -> { text, datos }

const API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-5'

// Un archivo llega de dos formas: como adjunto nativo (imagen o PDF, en base64)
// o como texto ya extraído en el navegador (Word, Excel, planillas), porque la
// API no lee esos formatos directamente.
type Archivo = { media_type?: string; data?: string; name?: string; texto?: string }

const bloqueArchivo = (f: Archivo) => {
  if (f.texto) {
    return { type: 'text', text: `--- Contenido de "${f.name || 'archivo'}" ---\n${f.texto}` }
  }
  const media = String(f.media_type || 'image/jpeg')
  const data = String(f.data || '')
  if (media === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
  }
  return { type: 'image', source: { type: 'base64', media_type: media, data } }
}

const EXTRACCION = `Eres un lector experto de documentos inmobiliarios chilenos (contratos de arriendo, escrituras, certificados de dominio vigente, avalúos del SII, informes Equifax/DICOM e InfoCheck, liquidaciones de sueldo).
Lee los archivos adjuntos con máxima precisión y devuelve SOLO un objeto JSON válido (sin comentarios, sin markdown, sin texto adicional) con esta estructura exacta; omite las claves que el documento no permita completar con certeza:
{
 "resumen": "3 a 5 frases en español describiendo qué documento es y sus datos clave",
 "coincidenciaId": "id de la propiedad existente que coincide con el documento, o null",
 "propiedad": { "nombre": "", "direccion": "", "comuna": "", "region": "", "tipo": "", "rolSII": "", "inscripcion": "fojas/número/año y CBR", "superficieConstruida": "", "superficieTerreno": "", "dormitorios": "", "banos": "", "estacionamientos": "", "bodega": "", "anoConstruccion": "", "avaluoFiscal": "" },
 "arriendo": { "rentaUF": 0, "rentaCLP": 0, "diaPago": 0, "multaPct": 0, "fechaInicio": "AAAA-MM-DD", "fechaTermino": "AAAA-MM-DD", "reajuste": "UF|IPC" },
 "garantia": { "montoCLP": 0, "montoUF": 0, "fecha": "AAAA-MM-DD" },
 "arrendatario": { "nombre": "", "rut": "", "email": "", "telefono": "", "profesion": "", "nacionalidad": "" },
 "arrendador": { "nombre": "", "rut": "", "representante": "", "repRut": "" },
 "aval": { "nombre": "", "rut": "" },
 "antecedentes": { "equifaxScore": "", "morosidades": "", "protestos": "", "infocheckPuntaje": "", "rentaLiquida": "" }
}
Reglas: montos en números sin puntos ni signos; fechas en formato ISO AAAA-MM-DD; RUT con guion; si la renta está en UF indica rentaUF y calcula rentaCLP solo si el documento lo señala. No inventes datos.

Además, SIEMPRE incluye la clave "sugerencias": una lista de acciones concretas
que la plataforma puede ejecutar con este documento. Es especialmente
importante cuando el documento NO trae datos de propiedad ni de arrendatario
(por ejemplo una declaración de impuestos, una boleta o un comprobante): en ese
caso el usuario no debe quedarse sin nada que hacer, así que propón dónde
guardar la información y por qué.

"sugerencias": [
  {
    "accion": "gasto" | "bitacora" | "incidencia" | "ninguna",
    "propiedadId": "id de la propiedad de la lista de existentes, o null si no aplica a una sola",
    "titulo": "título corto de la anotación, gasto o incidencia",
    "detalle": "texto que quedará guardado, con las cifras y fechas relevantes",
    "monto": 0,
    "periodo": "mes" | "año" | "una vez",
    "porque": "una frase explicando por qué propones esto"
  }
]

Cuándo usar cada acción:
- "gasto": el documento implica un pago o costo recurrente o puntual asociado a
  una propiedad (contribuciones, gasto común, seguro, mantención, impuestos).
- "bitacora": conviene dejar constancia de algo con fecha (una declaración
  presentada, un trámite, una comunicación, un certificado emitido).
- "incidencia": el documento reporta un problema, daño o reclamo.
- "ninguna": el documento no tiene relación con la administración de
  propiedades. Igual explica en "porque" qué es y qué haría el usuario con él.

Propón entre 1 y 5 sugerencias, la más útil primero. El usuario puede marcar
varias y ejecutarlas juntas, así que si el documento da pie a más de una cosa
útil (por ejemplo, registrar el gasto Y dejar constancia en la bitácora, o una
acción por cada archivo adjunto), propónlas todas por separado en vez de
juntarlas en una sola. No repitas la misma acción dos veces.

Si el documento sí trae datos de propiedad o arrendatario, las sugerencias son
opcionales y complementarias.

## Cuando te preguntan en vez de mandarte un documento
El mismo cuadro sirve para preguntarte cosas, con o sin archivos. Eres además
un asesor inmobiliario chileno con experiencia: sabes de arriendos y
compraventa, contratos y la Ley 18.101 (y la 21.461), garantías, reajustes en
UF e IPC, contribuciones y el SII, el Conservador de Bienes Raíces, permisos y
recepción municipal, CIP, DFL 2, tasaciones, gastos comunes, corretaje,
comisiones, morosidad y cobranza, y del mercado de arriendo y venta en Chile.

Si la persona te hace una pregunta o te pide un consejo, respóndele en la clave
"resumen" con una respuesta completa, clara y en español de Chile: al grano,
con cifras y plazos cuando corresponda, y con un ejemplo si ayuda. Usa el
contexto de la plataforma que viene más abajo para responder con SUS datos
reales (valor de la UF de hoy, cuántas propiedades tiene, cuánto suman sus
arriendos, en qué comunas). No inventes cifras que no tengas: si un dato no
está, dilo y explica dónde se consigue.

En ese caso deja "propiedad", "arriendo" y las demás claves vacías (no
inventes campos), y agrega en "sugerencias" solo lo que de verdad convenga
guardar en la plataforma a partir de esa conversación. Si además la pregunta
implica corregir algo del formulario abierto, sí devuelve esos campos.`

export default async (req: Request, _context: Context) => {
  // La IA cuesta dinero: solo la usa quien entró con la clave.
  if (!(await quienLlama(req))) return sinAcceso()

  if (req.method !== 'POST') {
    return Response.json({ error: 'Método no permitido' }, { status: 405 })
  }
  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return Response.json(
      { error: 'Falta configurar ANTHROPIC_API_KEY en Netlify (Site settings → Environment variables) y volver a desplegar' },
      { status: 503 },
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }

  const files: Archivo[] = Array.isArray(body.files) ? body.files.slice(0, 8) : []
  const adjuntos = files.filter((f) => f && (f.data || f.texto)).map(bloqueArchivo)

  try {
    if (body.mode === 'extraer') {
      const instruccion = String(body.instruccion || '').trim()
      // Se puede trabajar solo con la instrucción escrita: sin archivos, la IA
      // corrige o completa el formulario con lo que el usuario le dicta.
      if (!adjuntos.length && !instruccion) {
        return Response.json({ error: 'Adjunta un archivo o escribe qué quieres que haga la IA' }, { status: 400 })
      }
      const hint = Array.isArray(body.propiedades) && body.propiedades.length
        ? `\nPropiedades ya existentes en la plataforma (para "coincidenciaId" y "propiedadId"): ${JSON.stringify(body.propiedades).slice(0, 4000)}`
        : ''
      const formulario = body.formulario && typeof body.formulario === 'object'
        ? `\nLo que ya está escrito en el formulario abierto (corrige solo lo que corresponda y deja el resto igual): ${JSON.stringify(body.formulario).slice(0, 2000)}`
        : ''
      // Instrucción libre del usuario: manda por sobre el criterio por defecto.
      const orden = instruccion
        ? `\n\nINSTRUCCIÓN DEL USUARIO (tiene prioridad, síguela al pie de la letra): ${instruccion.slice(0, 2000)}`
        : ''
      const contexto = body.contexto && typeof body.contexto === 'object'
        ? `\n\n## Contexto de la plataforma (datos reales de esta persona)\n${JSON.stringify(body.contexto).slice(0, 1500)}\nLos montos van en pesos chilenos. "uf", "utm" y "dolar" son los valores de hoy; "ipc" es la variación mensual.`
        : ''
      const sinArchivos = !adjuntos.length
        ? '\n\nEn esta consulta NO hay archivos adjuntos: trabaja solo con lo que escribió el usuario. Si es una instrucción para corregir o completar el formulario, devuelve esos campos y explica en "resumen" qué cambiaste. Si es una pregunta o una consulta del rubro, respóndela completa en "resumen" usando el contexto de la plataforma, y deja los campos vacíos. Nunca respondas que no encontraste datos: siempre responde algo útil.'
        : ''
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: MODEL,
          // Las funciones de Netlify se cortan a los ~10 segundos, así que la
          // lectura tiene que ser rápida: esfuerzo bajo y un tope de salida
          // ajustado al JSON que esperamos (el razonamiento se descuenta del
          // mismo tope). El cliente además manda los archivos de a uno.
          max_tokens: 4096,
          output_config: { effort: 'low' },
          system: EXTRACCION + hint + formulario + contexto + orden + sinArchivos,
          messages: [{
            role: 'user',
            content: [
              ...adjuntos,
              { type: 'text', text: adjuntos.length
                ? 'Extrae los datos de estos documentos según el formato indicado.'
                : 'Aplica la instrucción sobre el formulario actual y devuelve el JSON en el formato indicado.' },
            ],
          }],
        }),
      })
      const j: any = await r.json()
      if (!r.ok) return Response.json({ error: j?.error?.message || 'Error de la API de IA' }, { status: 502 })
      const texto = (j.content || []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n')
      const limpio = texto.replace(/```json|```/g, '').trim()
      let datos: any = null
      try {
        const ini = limpio.indexOf('{')
        const fin = limpio.lastIndexOf('}')
        datos = JSON.parse(limpio.slice(ini, fin + 1))
      } catch {
        return Response.json({ text: 'Leí el documento pero no pude estructurar los datos. Resumen:\n' + limpio.slice(0, 1200), datos: null })
      }
      return Response.json({ text: datos.resumen || 'Documento leído correctamente.', datos })
    }

    // Modo chat normal (con o sin archivos adjuntos)
    const msgs: any[] = Array.isArray(body.messages) ? body.messages.slice(-24) : []
    if (!msgs.length) return Response.json({ error: 'Sin mensajes' }, { status: 400 })
    const contenido: any[] = msgs.map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }))
    if (adjuntos.length) {
      const ult = contenido[contenido.length - 1]
      ult.content = [...adjuntos, { type: 'text', text: String(ult.content || 'Analiza los archivos adjuntos.') }]
    }
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        // Incluye el razonamiento del modelo, por eso el tope es holgado.
        max_tokens: 8192,
        system: String(body.system || 'Eres el asistente experto de la plataforma chilena de administración de propiedades ArriendoPro. Responde en español, claro, concreto y con cifras cuando corresponda.'),
        messages: contenido,
      }),
    })
    const j: any = await r.json()
    if (!r.ok) return Response.json({ error: j?.error?.message || 'Error de la API de IA' }, { status: 502 })
    if (j.stop_reason === 'refusal') {
      return Response.json({ text: 'No puedo responder esa consulta. Reformúlala o pregunta algo distinto sobre tus propiedades.' })
    }
    const texto = (j.content || []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n')
    return Response.json({ text: texto || 'Sin respuesta.' })
  } catch (e: any) {
    return Response.json({ error: 'No se pudo contactar la IA: ' + (e?.message || 'error de red') }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/asistente',
  method: ['POST'],
}
