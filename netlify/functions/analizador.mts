import type { Config, Context } from '@netlify/functions'
import { quienLlama, sinAcceso } from '../lib/auth.mts'
import { responderIA } from '../lib/ia-stream.mts'

// Analizador universal con IA. Un solo cerebro para varios lectores:
//   - plano        : lectura de planos de arquitectura
//   - propuesta    : propuestas, proyectos, contratos, informes
//   - cotizacion   : una o varias cotizaciones / presupuestos, para comparar y decidir
//   - impuestos    : situación tributaria (contribuciones, renta por arriendo, IVA, DFL2)
//   - general      : cualquier documento; el agente identifica qué es y lo analiza
//
// Recibe archivos (imágenes y/o PDF en base64) y/o texto ya extraído en el
// teléfono (de un .zip, .txt, una carpeta, subtítulos o notas), más un contexto
// opcional de la propiedad. Responde SIEMPRE con la misma estructura clara:
// resumen simple -> análisis -> puntos clave -> contras e incongruencias con su
// solución -> recomendaciones -> decisión sugerida.
//
// La respuesta se transmite en vivo (streaming), así la función de Netlify no se
// corta a los ~10 s y el análisis va "escribiéndose" en pantalla.
//
// POST /api/analizador
//   { modo, archivos:[{media,data,name}], texto?, contexto?, titulo?,
//     messages?:[{role,content}] } -> stream de texto

const MODEL = 'claude-opus-5'
const TOPE_MS = 60_000
// Tope alto de tokens: un análisis completo (con sus 7 secciones) termina de una
// sola vez. Y si aun así se pasara, el motor de streaming continúa solo hasta el
// final, así el análisis nunca queda cortado por largo que sea.
const MAX_TOKENS = 8_000
const MAX_B64_TOTAL = 9_000_000   // suma de todos los archivos (base64)
const MAX_ARCHIVOS = 8
const MAX_TEXTO = 24_000

type Modo = 'plano' | 'propuesta' | 'cotizacion' | 'presupuesto' | 'impuestos' | 'general'

const norm = (m: string): Modo => {
  const s = String(m || '').toLowerCase()
  if (s.startsWith('plano')) return 'plano'
  if (s.startsWith('propu')) return 'propuesta'
  if (s.startsWith('cotiz') || s.startsWith('presu')) return 'cotizacion'
  if (s.startsWith('impue') || s.startsWith('trib') || s.startsWith('contrib')) return 'impuestos'
  return 'general'
}

// Tronco común: cómo se comporta y responde en TODOS los modos. Aquí vive la
// exigencia del dueño: análisis avanzado pero simple de entender, y que SIEMPRE
// diga los contras, las incongruencias y cómo resolverlas.
const BASE = `Eres un asesor experto que ayuda a administrar propiedades en Chile. Hablas en español de Chile, de "tú", claro y directo. Tu trabajo es leer lo que te adjuntan y orientar a la persona para que tome la mejor decisión posible. La persona no es técnica: explica con palabras simples, pero sin perder profundidad.

## Regla de oro
Analizas a fondo, pero respondes fácil de entender. Nada de jerga sin explicar. Si usas un término técnico, lo aclaras en una frase.

## Estructura de tu respuesta (usa estos títulos, en este orden, con markdown)
Empieza SIEMPRE con un resumen de dos o tres frases, y luego:

**📋 Resumen**
En 2–3 frases: qué es esto y lo más importante que la persona debe saber.

**🔍 Análisis**
Lo detallado y avanzado, pero explicado simple. Cifras, cálculos y comparaciones cuando el material lo permita (siempre como estimación si no es un dato exacto).

**✅ Puntos clave**
Lista corta de lo que más pesa para decidir.

**⚠️ Contras y cosas a mejorar**
Lo negativo, los riesgos, lo que conviene tener en cuenta. Sé honesto: si algo está mal o es dudoso, dilo con claridad.

**🧩 Incongruencias detectadas**
Si algo no cuadra (montos que no suman, fechas imposibles, IVA mal aplicado, medidas que se contradicen, datos que faltan), dilo claramente Y en la misma línea di **cómo resolverlo o mejorarlo**. Si no encuentras ninguna, escribe "No detecté incongruencias." y no inventes.

**💡 Recomendaciones**
Qué harías tú, con pasos concretos.

**🎯 Decisión sugerida**
Cierra con una recomendación clara (no un "depende"). Si de verdad falta un dato para decidir, pide ese dato específico.

## Honestidad
- No inventes datos que no estén en el material. Si algo no se alcanza a leer o falta, dilo en vez de suponer.
- Si el documento está borroso, incompleto o es sospechoso, adviértelo.
- Cuando toques temas legales, municipales, estructurales o tributarios, di qué conviene verificar y con quién (DOM, contador, SII, especialista), sin afirmar que algo "cumple" o "no cumple".`

const POR_MODO: Record<Modo, string> = {
  plano: `\n\n## Foco: PLANOS
Eres además arquitecto con años leyendo planos. Identifica el tipo de plano (planta, elevación, corte, emplazamiento, fundaciones, sanitario, eléctrico, loteo) y su escala si aparece. Enumera recintos, orientación, accesos y circulaciones, y las cotas/superficies que estén acotadas (siempre como estimación). Sugiere mejoras con ojo de arquitecto (aprovechamiento, luz y ventilación natural, circulaciones, accesibilidad, ampliaciones). En "Incongruencias", ojo con cotas que no cuadran, recintos sin ventilación, escaleras imposibles, superficies que no suman. En lo normativo (OGUC, plan regulador, rasantes, constructibilidad) di qué verificar y con quién, sin declarar cumplimiento.`,
  propuesta: `\n\n## Foco: PROPUESTAS / PROYECTOS / CONTRATOS
Lee la propuesta, proyecto, contrato o informe. Explica qué ofrecen, alcance, plazos, condiciones, precio y qué queda fuera. En "Contras", cuida letra chica, cláusulas desfavorables, plazos irreales, cosas ambiguas o que faltan. En "Incongruencias", montos que no suman con el detalle, fechas que se contradicen, condiciones que chocan entre sí, y cómo resolver cada una (qué cláusula pedir cambiar, qué aclaración exigir). Cierra diciendo si conviene aceptar, negociar o rechazar, y qué negociar.`,
  cotizacion: `\n\n## Foco: COTIZACIONES Y PRESUPUESTOS
Lee una o varias cotizaciones/presupuestos (de reparación, remodelación, servicios, materiales, lo que sea). Si hay varias, compáralas de verdad: precio, qué incluye y qué no, plazos, garantía, forma de pago. Ojo con el IVA: di si los precios lo incluyen o no, y si no son comparables, normalízalos y explícalo. En "Contras", banderas rojas: garantía cero, precio sospechosamente bajo o alto, plazos larguísimos, ítems vagos ("varios", "otros"). En "Incongruencias", sumas que no dan, IVA mal calculado, cantidades x precio unitario que no cuadran, y cómo corregirlo. Cierra recomendando cuál conviene y por qué, con el número que zanja la decisión.`,
  presupuesto: `\n\n## Foco: COTIZACIONES Y PRESUPUESTOS
(igual que cotización)`,
  impuestos: `\n\n## Foco: SITUACIÓN TRIBUTARIA (CHILE)
Ayudas a entender y ordenar la situación de impuestos de propiedades en Chile. Cubre lo que aplique al material: contribuciones (impuesto territorial, avalúo fiscal, sobretasa, exenciones), impuesto a la renta por arriendos (renta efectiva vs presunta, gastos deducibles), beneficio DFL2, e IVA en arriendos (amoblado con servicios vs vivienda sin amoblar). Explica en simple qué debe pagar, cuándo y cómo, y detecta si algo está mal declarado o si hay un beneficio que no está usando. En "Incongruencias", cruces que no cuadran (renta declarada vs arriendos reales, avalúo vs contribuciones, IVA cobrado sin corresponder) y cómo regularizarlo. Da recomendaciones concretas de ahorro y cumplimiento. IMPORTANTE: no eres el SII ni reemplazas a un contador; cuando el caso lo amerite, di claramente que conviene confirmarlo con un contador o en el SII, y qué preguntar exactamente.`,
  general: `\n\n## Foco: DOCUMENTO GENERAL
Primero identifica qué es lo que te adjuntaron (plano, cotización, propuesta, contrato, boleta, factura, cartola, informe, foto de un problema, etc.) y dilo. Luego analízalo con la estructura de siempre, adaptando el análisis a lo que sea. Si son varios archivos distintos, míralos como un conjunto y relaciónalos.`,
}

export default async (req: Request, _context: Context) => {
  const yo = await quienLlama(req)
  if (!yo) return sinAcceso()

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return Response.json({ error: 'Falta configurar ANTHROPIC_API_KEY en Netlify.' }, { status: 503 })

  let body: any
  try { body = await req.json() } catch { return Response.json({ error: 'Cuerpo inválido' }, { status: 400 }) }

  const modo = norm(body.modo)
  const titulo = String(body.titulo || '').slice(0, 200)

  // Conversación (para preguntas de seguimiento). En el primer turno viene vacía.
  const mensajes: any[] = (Array.isArray(body.messages) ? body.messages : []).slice(-12).map((m: any) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String((m && m.content) || '').slice(0, 4000),
  })).filter((m: any) => m.content)

  // Archivos: imágenes (jpeg/png/webp/gif) y PDF en base64. Se acumulan hasta un
  // tope total para no reventar el límite de la API.
  const archivos = (Array.isArray(body.archivos) ? body.archivos : []).slice(0, MAX_ARCHIVOS)
  const bloques: any[] = []
  let suma = 0
  let omitidos = 0
  for (const a of archivos) {
    const data = String(a?.data || '')
    const media = String(a?.media || 'image/jpeg')
    if (!data) continue
    if (suma + data.length > MAX_B64_TOTAL) { omitidos++; continue }
    if (media === 'application/pdf') { bloques.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }); suma += data.length }
    else if (/^image\/(jpeg|png|gif|webp)$/.test(media)) { bloques.push({ type: 'image', source: { type: 'base64', media_type: media, data } }); suma += data.length }
    else omitidos++
  }

  // Texto ya extraído en el teléfono (de un .zip, .txt, una carpeta, etc.).
  const textoExtra = String(body.texto || '').slice(0, MAX_TEXTO)

  // Instrucción del primer turno.
  const pedido = mensajes.length
    ? ''
    : (modo === 'cotizacion'
        ? 'Analiza y compara lo que te adjunto. Si hay varias cotizaciones, dime cuál conviene y por qué.'
        : modo === 'impuestos'
          ? 'Analiza esta situación tributaria y dime qué hacer, qué conviene pagar y qué revisar.'
          : modo === 'plano'
            ? 'Lee este plano y dime todo lo relevante.'
            : 'Analiza lo que te adjunto.')

  const partesUsuario: any[] = [...bloques]
  const encabezado: string[] = []
  if (titulo) encabezado.push(`Título: ${titulo}`)
  if (textoExtra) encabezado.push(`\nTexto adjunto (extraído del archivo):\n${textoExtra}`)
  if (omitidos) encabezado.push(`\n(Nota: ${omitidos} archivo(s) no se pudieron incluir por tamaño o formato; pídelos más livianos o en imagen/PDF si eran importantes.)`)
  const textoUsuario = [pedido, ...encabezado].filter(Boolean).join('\n')
  if (textoUsuario) partesUsuario.push({ type: 'text', text: textoUsuario })

  if (mensajes.length) {
    // Seguimiento: adjunta archivos (si vinieron) al último mensaje del usuario.
    const ult = mensajes[mensajes.length - 1]
    if (partesUsuario.length > (textoUsuario ? 1 : 0)) {
      ult.content = [...bloques, { type: 'text', text: String(ult.content || pedido) + (textoUsuario ? '\n\n' + textoUsuario : '') }]
    }
  } else {
    if (!partesUsuario.length) return Response.json({ error: 'No recibí nada para analizar. Adjunta un archivo o escribe el detalle.' }, { status: 400 })
    mensajes.push({ role: 'user', content: partesUsuario })
  }

  const ctx = body.contexto && String(body.contexto).trim()
    ? `\n\n## Contexto de la propiedad\n${String(body.contexto).slice(0, 1500)}`
    : ''
  const system = BASE + POR_MODO[modo] + ctx

  // El motor de streaming reenvía la respuesta en vivo y, si el modelo se corta
  // por tope de tokens, continúa solo hasta terminar: el análisis nunca queda
  // cortado, del largo que sea.
  return responderIA({
    apiKey,
    model: MODEL,
    maxTokens: MAX_TOKENS,
    effort: 'low',
    system,
    messages: mensajes,
    topeMs: TOPE_MS,
    textos: {
      refusal: 'Prefiero no responder eso. Adjúntame el documento y lo analizo.',
      vacio: 'No alcancé a analizarlo. Prueba con archivos más nítidos o más livianos.',
      corte: '(Se cortó el análisis. Intenta de nuevo.)',
      demora: 'Me demoré más de la cuenta con el análisis 😅 Prueba de nuevo, o con archivos más livianos.',
    },
  })
}

export const config: Config = { path: '/api/analizador', method: ['POST'] }
