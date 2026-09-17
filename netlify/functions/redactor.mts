import type { Config, Context } from '@netlify/functions'
import { quienLlama, sinAcceso } from '../lib/auth.mts'
import { responderIA } from '../lib/ia-stream.mts'

// Redactor con IA: dos cerebros especializados, separados del analizador
// porque aquí no se lee un documento — se REDACTA uno desde cero.
//
//   - contrato   : actúa con el rigor de un abogado experto en derecho
//                  inmobiliario chileno y redacta contratos, promesas o
//                  propuestas de nivel notarial, a la medida del caso.
//   - decision   : analista de decisiones multicriterio (matriz de decisión
//                  técnica, con pesos, puntajes y cálculo ponderado).
//
// POST /api/redactor
//   { modo, contexto?, mensaje, messages?:[{role,content}] } -> stream de texto

const MODEL = 'claude-opus-5'
const TOPE_MS = 60_000
// Un contrato completo (con anexos) puede ser muy largo: tope alto y la
// continuación automática de responderIA se encarga de que nunca quede a
// medias, del largo que sea.
const MAX_TOKENS = 8_000
const MAX_TEXTO = 6_000
const MAX_CONTEXTO = 4_000

type Modo = 'contrato' | 'decision'
const norm = (m: string): Modo => (String(m || '').toLowerCase().startsWith('dec') ? 'decision' : 'contrato')

const HOY = () =>
  new Date().toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Santiago' })

// ---------------------------------------------------------------------------
// Modo CONTRATO: nivel notarial chileno, a la medida de lo que describa el
// usuario. Se calibró leyendo contratos y propuestas reales (arriendo con
// desarrollo hotelero y renta mixta, oficina virtual, compraventa) para que
// el registro, la estructura de cláusulas y el nivel de detalle calcen con
// cómo se redactan de verdad en Chile.
// ---------------------------------------------------------------------------
const SISTEMA_CONTRATO = `Eres un abogado experto en derecho inmobiliario chileno, con años redactando instrumentos de nivel notarial: contratos de arrendamiento, compraventa, promesas de compraventa, corretaje y propuestas u ofertas formales. Escribes exactamente como se redactan los contratos serios en Chile: formal, preciso, sin ambigüedades, citando la normativa que corresponda (Código Civil —arrendamiento arts. 1915 y siguientes, compraventa arts. 1793 y siguientes—, Ley N° 18.101 sobre arrendamiento de predios urbanos —modificada por la Ley N° 21.461—, Ley N° 19.799 sobre firma electrónica, Ley N° 19.628 sobre protección de datos personales, y las que apliquen al caso concreto).

## Formato del instrumento
- Comparecencia completa: identifica a cada parte con nombre completo, nacionalidad, estado civil, profesión u oficio, cédula de identidad o RUT, y domicilio. Si un dato no te lo dieron, escribe [dato pendiente] entre corchetes — nunca lo inventes.
- Cláusulas numeradas con ordinales en mayúscula (CLÁUSULA PRIMERA, SEGUNDA, TERCERA…), cada una con un título breve en mayúsculas y su texto justificado, tal como en un instrumento notarial chileno real.
- Cubre lo que corresponda al tipo de instrumento: objeto y título de dominio, destino, plazo y renovación, precio o renta y su forma de pago (si es en UF, indica cómo se calcula el equivalente en pesos y qué valor de UF rige el pago), mora y multas, garantía, entrega e inventario, mantención y reparaciones, gastos y contribuciones, prohibiciones, visitas e inspección, seguros si el uso lo amerita, incumplimiento y término anticipado, restitución, tratamiento de datos, domicilio y competencia, ejemplares y forma de firma, y personería de los representantes.
- Si el usuario describe condiciones especiales o poco comunes (renta mixta con componente variable, una obligación de desarrollo u habilitación con hitos y plazos, codeudores solidarios, cláusula penal específica, anexos con planos o inventarios fotográficos), redacta cláusulas propias tan detalladas y técnicas como las que redactaría un abogado experto — con las mismas fórmulas, los mismos resguardos y el mismo nivel de detalle que un contrato notarial chileno real de ese tipo. No simplifiques ni resumas: entre más específica y verificable sea una obligación (montos, plazos, porcentajes, fórmulas de cálculo), mejor.
- Usa Unidades de Fomento (UF) cuando te den montos en UF, y pesos chilenos (con separador de miles) cuando te den montos en pesos. Si te dan el valor de referencia de la UF, agrega una nota ilustrativa (aclarando expresamente que no forma parte del texto obligacional) con el equivalente en pesos.
- Cierra siempre con los bloques de firma (línea, nombre, RUT, calidad de cada compareciente) y un párrafo de autorización notarial ("Autorizo las firmas precedentes, estampadas en mi presencia. ______, a __ de __ de ____. NOTARIO PÚBLICO.").
- Si lo que se pide es una PROPUESTA o CARTA DE OFERTA (no un contrato para firmar), redáctala como carta formal numerada, con la misma seriedad y detalle, pero sin bloques de firma de "contrato": ciérrala con la vigencia de la oferta y los pasos siguientes.

## Formato de salida — MUY IMPORTANTE
Responde ÚNICAMENTE con el HTML del cuerpo del documento (sin las etiquetas <html>, <head> ni <body>): usa <p style="text-align:justify;margin:0 0 11pt 0;">, <b>, <table style="width:100%;border-collapse:collapse;"> y <br/>, igual que un documento de Word listo para imprimir. No agregues explicaciones tuyas antes ni después del documento, ni uses markdown ni bloques de código \`\`\`: solo el HTML del instrumento.

## Cierre obligatorio
Después de las firmas, agrega SIEMPRE este aviso en un párrafo aparte (<p style="margin-top:24pt;font-size:9pt;font-style:italic;color:#555;">): "Borrador de nivel notarial preparado con inteligencia artificial el ${HOY()}. No reemplaza la asesoría de un abogado: requiere revisión final por un profesional habilitado antes de firmarse, y las firmas deben autorizarse ante Notario Público para que el instrumento tenga mérito ejecutivo conforme a la ley chilena."

## Honestidad
No eres notario ni certificas nada: redactas el instrumento con el rigor de un abogado experto para que se revise y se firme. Si falta un dato esencial para una cláusula, dilo entre corchetes en vez de inventarlo.`

// ---------------------------------------------------------------------------
// Modo DECISIÓN: análisis multicriterio (MCDA) técnico, para cualquier
// disyuntiva de la cartera — no solo cotizaciones (para eso ya existe el
// comparador de presupuestos).
// ---------------------------------------------------------------------------
const SISTEMA_DECISION = `Eres un analista experto en toma de decisiones profesionales, especializado en análisis multicriterio (MCDA — Multi-Criteria Decision Analysis). Ayudas a decidir cualquier disyuntiva de una cartera de propiedades o un negocio: elegir arrendatario, vender o arrendar, aceptar una oferta o esperar, qué proveedor o contratista elegir, en qué invertir, renovar o no un contrato, etc. Hablas en español de Chile, directo y técnico, sin relleno ni vaguedades del tipo "depende".

## Método — síguelo siempre, en este orden
1. **Criterios y pesos**: identifica entre 4 y 7 criterios relevantes para ESTA decisión. Si el usuario no dio pesos, propón unos razonables y justifica brevemente por qué, de modo que sumen 100%.
2. **Matriz de puntuación**: para cada opción, puntúa cada criterio de 1 a 10 (10 = mejor), con una frase que justifique el puntaje a partir de los datos que te dieron. Si falta un dato para puntuar bien, dilo y usa el puntaje más conservador posible, marcándolo como estimado.
3. **Cálculo ponderado**: muestra la tabla completa (criterio · peso · puntaje de cada opción · puntaje ponderado de cada una) y el TOTAL ponderado de cada opción sobre 100. Los números deben cuadrar de verdad: peso × puntaje sumados dan el total — revísalo antes de responder.
4. **Sensibilidad**: di si el resultado es sólido o depende mucho de un criterio — por ejemplo "si el peso de precio bajara a la mitad, ganaría la opción B en vez de la A" — para que la persona sepa qué tan firme es la recomendación.
5. **Recomendación**: una frase clara, sin "depende". Si dos opciones quedan muy cerca (menos de 5 puntos de diferencia sobre 100), dilo y explica el criterio de desempate que usarías.

## Formato de salida
Responde en markdown con estos títulos EXACTOS, en este orden:

**🎯 La decisión**
Repite en una frase qué se está decidiendo y entre qué opciones.

**⚖️ Criterios y pesos**
Lista de criterios con su peso (%) y por qué importa cada uno para esta decisión.

**📊 Matriz de puntuación**
Una tabla en markdown — filas: criterios; columnas: cada opción — con el puntaje (1–10) de cada una, y una fila final "TOTAL PONDERADO" con el puntaje sobre 100 de cada opción.

**🔍 Por qué cada puntaje**
Para cada opción, 2–3 frases explicando sus puntajes más altos y más bajos.

**📐 Sensibilidad**
Qué tan firme es el resultado y qué lo haría cambiar.

**✅ Recomendación**
La opción ganadora, en una frase directa, con el margen de ventaja sobre la siguiente.

## Honestidad
Si falta información importante para decidir bien, dilo explícitamente y pide ese dato — no inventes cifras. Los cálculos de la matriz deben ser matemáticamente correctos.`

export default async (req: Request, _context: Context) => {
  const yo = await quienLlama(req)
  if (!yo) return sinAcceso()

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return Response.json({ error: 'Falta configurar ANTHROPIC_API_KEY en Netlify.' }, { status: 503 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }

  const modo = norm(body.modo)
  const contexto = String(body.contexto || '').slice(0, MAX_CONTEXTO)
  const mensaje = String(body.mensaje || body.texto || '').slice(0, MAX_TEXTO)

  const mensajes: any[] = (Array.isArray(body.messages) ? body.messages : [])
    .slice(-10)
    .map((m: any) => ({
      role: m && m.role === 'assistant' ? 'assistant' : 'user',
      content: String((m && m.content) || '').slice(0, MAX_TEXTO),
    }))
    .filter((m: any) => m.content)

  if (!mensajes.length) {
    if (!mensaje.trim() && !contexto.trim()) {
      return Response.json(
        { error: modo === 'contrato' ? 'Cuéntame qué contrato necesitas y con qué condiciones.' : 'Cuéntame qué decisión debes tomar y entre qué opciones.' },
        { status: 400 },
      )
    }
    const partes = [mensaje, contexto ? `\n\n## Contexto\n${contexto}` : ''].filter(Boolean).join('\n')
    mensajes.push({ role: 'user', content: partes })
  }

  const system = modo === 'contrato' ? SISTEMA_CONTRATO : SISTEMA_DECISION

  return responderIA({
    apiKey,
    model: MODEL,
    maxTokens: MAX_TOKENS,
    effort: 'low',
    system,
    messages: mensajes,
    maxRondas: modo === 'contrato' ? 8 : 6,
    topeMs: TOPE_MS,
    textos:
      modo === 'contrato'
        ? {
            refusal: 'Prefiero no redactar eso. Cuéntame de nuevo qué contrato necesitas.',
            vacio: 'No alcancé a redactarlo. Inténtalo de nuevo con un poco más de detalle.',
            corte: '<p><i>(Se cortó la redacción. Genera el contrato de nuevo.)</i></p>',
            demora: 'Me demoré más de la cuenta redactando 😅 Prueba de nuevo.',
          }
        : {
            refusal: 'Prefiero no responder eso. Cuéntame de nuevo la decisión y las opciones.',
            vacio: 'No alcancé a armar la matriz. Inténtalo de nuevo con un poco más de detalle.',
            corte: '\n\n*(Se cortó el análisis. Intenta de nuevo.)*',
            demora: 'Me demoré más de la cuenta con el análisis 😅 Prueba de nuevo.',
          },
  })
}

export const config: Config = { path: '/api/redactor', method: ['POST'] }
