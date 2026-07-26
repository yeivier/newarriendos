import type { Context, Config } from '@netlify/functions'

// ─────────────────────────────────────────────────────────────────────────────
// Asesor inmobiliario digital de New Arriendos.
//
// Esta función es un proxy hacia la API de Anthropic. La clave nunca sale del
// servidor: se lee de la variable de entorno ANTHROPIC_API_KEY.
//
// ¿Por qué las herramientas se ejecutan en el navegador y no aquí?
// El catálogo de propiedades vive en el navegador (localStorage), no en una
// base de datos. Si copiáramos el catálogo dentro del prompt, el asesor
// respondería con datos congelados. En cambio:
//
//   1. El navegador manda la conversación aquí.
//   2. Esta función se la pasa al modelo junto con las herramientas.
//   3. Si el modelo pide usar una herramienta, devolvemos esa petición.
//   4. El navegador la ejecuta contra los datos VIVOS y manda el resultado.
//   5. Se repite hasta que el modelo entrega su respuesta final.
//
// Así los precios y la disponibilidad siempre salen del estado real, y cada
// llamada a esta función es corta (no se agota el tiempo de la función).
//
// POST /api/asesor
//   { messages:[...bloques de Anthropic...], contexto:{...} } -> { stop_reason, content }
// ─────────────────────────────────────────────────────────────────────────────

const API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-5'

// Esfuerzo bajo: el asesor debe sentirse rápido en una conversación. El modelo
// sigue razonando (lo dejamos activo a propósito: con el razonamiento apagado
// puede escribir la llamada a una herramienta como texto plano y la búsqueda
// nunca se ejecutaría), pero de forma breve.
const EFFORT = 'low'

const PERSONALIDAD = `Eres el asesor inmobiliario digital de New Arriendos, una plataforma chilena de arriendo y venta de propiedades.

## Cómo hablas
Eres un asesor de verdad, no un formulario. Hablas como una persona con experiencia en el rubro: cercano, directo y profesional. Español de Chile, tratando de "tú".

- Respuestas cortas. Dos o tres frases bastan casi siempre.
- Nada de sonar a robot: no repitas la pregunta del usuario, no digas "entiendo que buscas...", no enumeres lo que vas a hacer antes de hacerlo.
- Una pregunta a la vez. Nunca dispares un cuestionario.
- Usa emojis con moderación (uno por mensaje como máximo, y solo cuando aporte).
- No inventes propiedades, precios, comisiones ni condiciones. Si no lo sabes, dilo y ofrece derivar a un asesor humano.

## Qué haces
Acompañas a la persona desde la búsqueda hasta el contacto con un ejecutivo:
buscar propiedades, recomendar alternativas parecidas, comparar dos opciones,
calcular cuánto cuesta entrar a un arriendo, explicar requisitos y gastos
comunes, agendar visitas y dejar el contacto registrado.

## Memoria de la conversación
Recuerda todo lo que la persona ya te dijo (comuna, presupuesto, dormitorios,
nombre, si tiene mascota). **Jamás vuelvas a preguntar un dato que ya tienes.**
Si dijo "Ñuñoa" y luego "hasta 1.200.000", ya tienes ambos: busca.

## Cómo buscas
En cuanto tengas lo mínimo para buscar (idealmente comuna o tipo, más un
presupuesto aproximado), **usa la herramienta buscar_propiedades de inmediato**.
No pidas todos los datos antes de mostrar algo: es mejor mostrar 3 opciones y
luego afinar.

Interpreta el lenguaje natural chileno:
- "900 lucas", "900 mil" = 900000. "1,2 palos" = 1200000.
- "2D" = 2 dormitorios. "2D2B" = 2 dormitorios, 2 baños.
- "depto", "depa" = Departamento.
- Presupuesto sin más contexto en arriendo = valor mensual.

## Buscar en internet
Tienes búsqueda web. Úsala para ampliar la ayuda más allá del catálogo propio.

**Barre el mercado completo, no un solo portal.** Cuando busques propiedades
publicadas o precios de mercado en Chile, no te quedes con el primer resultado
ni con un único sitio: haz varias búsquedas y cubre los portales grandes
(Portal Inmobiliario, Yapo, TocToc, Goplaceit, Mercado Libre, Doomos,
Chilepropiedades, Icasas, Properati, Emol Propiedades, Enlace Inmobiliario,
Zoom Inmobiliario, AsesorProp), las corredoras con presencia nacional
(Fundamenta, Enlace, Bracco, Casaideal, Boetsch, Vivocorp, Assetplan, Rentas
Capital), los portales de las inmobiliarias que venden directo, y también los
avisos que circulan por redes sociales y Marketplace. Si la comuna tiene
corredoras locales conocidas, inclúyelas.

Cruza lo que encuentres: si dos portales muestran precios muy distintos para lo
mismo, dilo. Cuando des un precio de mercado, apóyalo en más de una fuente y
señala el rango (desde–hasta), no un número suelto.

Cuándo usarla:

- **Siempre parte por buscar_propiedades (el catálogo propio).** Es lo que
  administramos y lo que podemos mostrar, agendar y arrendar de inmediato.
- **Después usa la web** cuando aporte de verdad: si el catálogo no tiene nada
  que calce, si preguntan por el precio de mercado de una comuna, por el
  entorno (metro, colegios, supermercados, seguridad), o si piden derechamente
  ver otras opciones publicadas.
- Para "cerca del metro", "buena locomoción" o preguntas del barrio, búscalo en
  la web en vez de decir que no tienes el dato.
- Si te pasan el enlace de una publicación, léelo con web_fetch y compáralo con
  lo nuestro.

**Sé transparente sobre el origen.** Distingue siempre entre "esta es nuestra"
y "esta la encontré publicada en internet". Nunca presentes una propiedad de
otro portal como si fuera de la cartera propia, y no ofrezcas agendar visitas
ni prometer condiciones sobre propiedades que no son nuestras: para esas,
entrega la referencia y ofrece buscar algo equivalente en nuestro catálogo o
derivar a un asesor.

Cuando cites precios de mercado sacados de internet, di de dónde salen y de
cuándo son, porque cambian.

Si la búsqueda no arroja nada, no te quedes ahí: vuelve a buscar ampliando el
presupuesto un 15-20% o sumando comunas vecinas, y ofrécelo como alternativa
("En Providencia con ese presupuesto no me aparece nada, pero en Ñuñoa sí…").

## Propiedades arrendadas
Esta es una cartera en administración, así que buena parte del catálogo está
arrendado en este momento. La búsqueda te devuelve ambas cosas: fíjate en el
campo "disponible" y en "disponibles_ahora".

- Parte siempre por lo que está disponible.
- Si lo que calza mejor está arrendado, no lo escondas ni lo ofrezcas como si
  estuviera libre: dilo con naturalidad y usa la fecha de "disponible_desde"
  ("Ese está arrendado hasta el 31 de diciembre, pero si te acomoda esa fecha
  te puedo anotar para avisarte apenas se libere").
- Si no hay nada disponible ahora, ofrece dejar el contacto registrado para
  avisar en cuanto se desocupe algo que calce. Eso es un buen resultado, no un
  fracaso.

## Requisitos de arriendo (información oficial de la plataforma)
Cédula de identidad, últimas 3 liquidaciones de sueldo con renta líquida de al
menos 3 veces el arriendo, y según el caso un aval o codeudor. Independientes:
últimas 6 boletas o carpeta tributaria. La garantía habitual es de 1 mes de
arriendo. El gasto común se paga aparte del arriendo, salvo que la publicación
diga lo contrario.

## Cuándo derivar a un humano
Usa derivar_asesor cuando aparezca: frustración o molestia, un reclamo, una
consulta legal, una negociación de precio, o cuando la persona lo pida. No
insistas con el bot: deriva y avisa que un asesor la contactará.

## Antes de derivar o agendar
Necesitas al menos nombre y un medio de contacto (teléfono o correo). Pídelos
de forma natural, no como formulario: "¿A qué nombre y teléfono te contacto?".
Cuando los tengas, usa registrar_lead. Si además hay fecha para visita, usa
agendar_visita.`

// Las herramientas se declaran aquí (única fuente de verdad) y las ejecuta el
// navegador contra los datos reales. Si agregas una, impleméntala también en
// index.html dentro de ejecutarHerramienta().
const TOOLS = [
  {
    name: 'buscar_propiedades',
    description:
      'Busca en el catálogo real de New Arriendos. Úsala apenas tengas una pista de lo que la persona busca (comuna, tipo o presupuesto). Devuelve las propiedades que se muestran como tarjetas con foto y precio. Todos los filtros son opcionales: mientras menos filtros, más resultados.',
    input_schema: {
      type: 'object',
      properties: {
        comuna: { type: 'string', description: 'Comuna, por ejemplo "Las Condes". Acepta varias separadas por coma.' },
        region: { type: 'string', description: 'Región, por ejemplo "Región Metropolitana".' },
        tipo: { type: 'string', description: 'Tipo de propiedad: Departamento, Casa, Oficina, Local, Bodega, Terreno, Estacionamiento.' },
        operacion: { type: 'string', enum: ['arriendo', 'venta'], description: 'Qué busca la persona. Por omisión, arriendo.' },
        precio_max: { type: 'number', description: 'Precio máximo en pesos. En arriendo es el valor mensual.' },
        precio_min: { type: 'number', description: 'Precio mínimo en pesos.' },
        dormitorios_min: { type: 'number' },
        banos_min: { type: 'number' },
        estacionamiento: { type: 'boolean', description: 'true si necesita al menos un estacionamiento.' },
        bodega: { type: 'boolean', description: 'true si necesita bodega.' },
        superficie_min: { type: 'number', description: 'Metros cuadrados construidos mínimos.' },
        solo_disponibles: { type: 'boolean', description: 'Déjalo sin definir salvo que la persona insista en que solo le sirve algo disponible de inmediato. Por omisión la búsqueda también trae las arrendadas, indicando desde cuándo se liberan, y pone primero las disponibles.' },
        limite: { type: 'number', description: 'Máximo de resultados a devolver. Por omisión 4.' },
      },
    },
  },
  {
    name: 'ver_propiedad',
    description: 'Trae la ficha completa de una propiedad por su id: superficie, orientación, año, gasto común, garantía, estacionamiento y bodega. Úsala cuando pregunten por el detalle de una opción concreta.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Id de la propiedad tal como vino en la búsqueda.' } },
      required: ['id'],
    },
  },
  {
    name: 'propiedades_similares',
    description: 'Busca alternativas parecidas a una propiedad dada. Úsala cuando pidan "algo parecido pero más barato" o "otras opciones como esta".',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id de la propiedad de referencia.' },
        mas_barata: { type: 'boolean', description: 'true para limitar a opciones de menor precio.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'comparar_propiedades',
    description: 'Compara dos o tres propiedades lado a lado (precio, dormitorios, baños, superficie, gasto común, estacionamiento). Se muestra como tabla comparativa.',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Entre 2 y 3 ids.' } },
      required: ['ids'],
    },
  },
  {
    name: 'calcular_costos',
    description: 'Calcula cuánto cuesta entrar a un arriendo: primer mes, garantía, gasto común y total inicial, además de la renta líquida mínima sugerida (3 veces el arriendo).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id de la propiedad. Si no lo tienes, usa monto_arriendo.' },
        monto_arriendo: { type: 'number', description: 'Arriendo mensual en pesos, si se calcula sin una propiedad concreta.' },
      },
    },
  },
  {
    name: 'registrar_lead',
    description: 'Guarda a la persona como contacto en el CRM para que un ejecutivo la siga. Úsala apenas tengas nombre y un medio de contacto. Si el contacto ya existe en esta conversación, vuelve a llamarla para actualizar sus datos.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        telefono: { type: 'string' },
        email: { type: 'string' },
        comuna: { type: 'string', description: 'Comuna de interés.' },
        presupuesto: { type: 'number', description: 'Presupuesto en pesos.' },
        dormitorios: { type: 'number' },
        tipo_busqueda: { type: 'string', enum: ['arriendo', 'compra'] },
        propiedad_id: { type: 'string', description: 'Id de la propiedad que le interesa, si hay una.' },
        notas: { type: 'string', description: 'Resumen breve de lo que busca y cualquier detalle relevante (mascotas, fecha de mudanza, etc.).' },
      },
      required: ['nombre'],
    },
  },
  {
    name: 'agendar_visita',
    description: 'Agenda una visita a una propiedad. Requiere que la persona ya esté registrada con registrar_lead.',
    input_schema: {
      type: 'object',
      properties: {
        propiedad_id: { type: 'string' },
        fecha: { type: 'string', description: 'Fecha en formato AAAA-MM-DD.' },
        hora: { type: 'string', description: 'Hora en formato HH:MM (24 horas).' },
        notas: { type: 'string' },
      },
      required: ['fecha'],
    },
  },
  {
    name: 'derivar_asesor',
    description: 'Deriva la conversación a un asesor humano y entrega sus datos de contacto y un enlace de WhatsApp. Úsala ante frustración, reclamos, consultas legales, negociación de precio, o si la persona lo pide.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Por qué se deriva, en una frase. Lo lee el ejecutivo.' },
      },
      required: ['motivo'],
    },
  },
]

// Herramientas de Anthropic que corren en su servidor (no las ejecuta el
// navegador). Dan al asesor acceso a internet: buscar publicaciones y precios
// de mercado, y leer un aviso concreto si el usuario pega el enlace.
//
// Ojo: la búsqueda web se puede deshabilitar a nivel de organización desde la
// consola de Anthropic. Si está apagada, la petición completa falla con 400;
// por eso más abajo reintentamos una vez sin estas herramientas, para que el
// asesor siga funcionando con el catálogo propio.
const WEB_TOOLS = [
  {
    type: 'web_search_20260318',
    name: 'web_search',
    // Barrer varios portales exige varias búsquedas por respuesta. Cada una se
    // cobra aparte de los tokens, así que el tope acota el costo sin impedir
    // que compare fuentes.
    max_uses: 12,
    user_location: { type: 'approximate', country: 'CL', timezone: 'America/Santiago' },
  },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 },
]

const esErrorDeWeb = (msg: string) => /web[ _-]?(search|fetch)/i.test(String(msg || ''))

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Método no permitido' }, { status: 405 })
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return Response.json(
      {
        error:
          'Falta configurar ANTHROPIC_API_KEY en Netlify (Site configuration → Environment variables) y volver a desplegar el sitio.',
      },
      { status: 503 },
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }

  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : []
  if (!messages.length) return Response.json({ error: 'Sin mensajes' }, { status: 400 })

  // Contexto liviano del catálogo: le da al asesor una noción de qué hay
  // (comunas, rangos, cuántas propiedades) para que converse con criterio sin
  // tener que buscar en cada turno. El detalle exacto siempre sale de las
  // herramientas.
  const c = body.contexto || {}
  const contexto = [
    `\n\n## Contexto de hoy (${c.fecha || 'sin fecha'})`,
    c.empresa ? `Empresa: ${c.empresa}.` : '',
    c.total != null ? `Catálogo: ${c.total} propiedades cargadas, ${c.disponibles ?? 0} disponibles para arrendar ahora.` : '',
    c.comunas?.length ? `Comunas con propiedades: ${c.comunas.join(', ')}.` : '',
    c.tipos?.length ? `Tipos disponibles: ${c.tipos.join(', ')}.` : '',
    c.rango ? `Arriendos entre ${c.rango.min} y ${c.rango.max} pesos mensuales.` : '',
    c.uf ? `Valor UF de hoy: ${c.uf} pesos.` : '',
    c.contacto ? `Asesor humano de respaldo: ${c.contacto}.` : '',
    c.lead ? `Ya registraste a esta persona en el CRM: ${c.lead}. No vuelvas a pedirle esos datos.` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const pedir = (tools: any[]) =>
    fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        // Holgado a propósito: el razonamiento del modelo se descuenta de este
        // mismo tope, y quedarse corto cortaría la respuesta a la mitad.
        max_tokens: 8192,
        output_config: { effort: EFFORT },
        system: PERSONALIDAD + contexto,
        tools,
        messages,
      }),
    })

  try {
    let r = await pedir([...TOOLS, ...WEB_TOOLS])
    let j: any = await r.json()

    // Si la organización tiene la búsqueda web deshabilitada, reintentamos solo
    // con las herramientas propias en lugar de dejar caído al asesor.
    if (!r.ok && r.status === 400 && esErrorDeWeb(j?.error?.message)) {
      r = await pedir(TOOLS)
      j = await r.json()
    }

    if (!r.ok) {
      return Response.json({ error: j?.error?.message || 'Error de la API de IA' }, { status: 502 })
    }
    if (j.stop_reason === 'refusal') {
      return Response.json({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: 'Prefiero no responder eso por aquí. Si quieres, te derivo con un asesor para que lo veas directamente con una persona.',
          },
        ],
      })
    }

    return Response.json({ stop_reason: j.stop_reason, content: j.content || [] })
  } catch (e: any) {
    return Response.json(
      { error: 'No se pudo contactar la IA: ' + (e?.message || 'error de red') },
      { status: 502 },
    )
  }
}

export const config: Config = {
  path: '/api/asesor',
  method: ['POST'],
}
