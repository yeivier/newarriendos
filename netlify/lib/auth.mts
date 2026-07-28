import { getStore } from '@netlify/blobs'

// Control de acceso de la plataforma.
//
// Antes cualquiera que llegara a la dirección del sitio podía leer y escribir
// todos los datos (arrendatarios, contratos, cuentas bancarias). Ahora hay una
// clave: el servidor guarda solo su huella (PBKDF2 con sal, nunca la clave) y
// entrega un token de sesión que el navegador manda en cada llamada.
//
// Roles:
//   dueño   -> puede ver y guardar todo
//   lectura -> puede ver, no puede guardar (para la mamá, el contador, etc.)

const TIENDA_AUTH = 'app-auth'
const TIENDA_SES = 'app-sesiones'
const LLAVE = 'config'
const DIAS_SESION = 30

export type Rol = 'dueño' | 'lectura'
export type Acceso = { rol: Rol; nombre: string; token: string }
export type AccesoInvitado = { id: string; nombre: string; rol: Rol; salt: string; hash: string; creado: number }
export type ConfigAuth = { salt: string; hash: string; creado: number; invitados: AccesoInvitado[] }

const enc = new TextEncoder()
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

export const nuevoId = () => crypto.randomUUID().replace(/-/g, '')

/** Huella de la clave. PBKDF2 con 120.000 vueltas: hace lento probar claves. */
export async function huella(clave: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(clave), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 120000, hash: 'SHA-256' },
    key,
    256,
  )
  return hex(bits)
}

/** Comparación de tiempo constante: no delata la clave por lo que demora. */
export function iguales(a: string, b: string) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

const tiendaAuth = () => getStore({ name: TIENDA_AUTH, consistency: 'strong' })
const tiendaSes = () => getStore({ name: TIENDA_SES, consistency: 'strong' })

export async function leerConfig(): Promise<ConfigAuth | null> {
  const c = (await tiendaAuth().get(LLAVE, { type: 'json' }).catch(() => null)) as ConfigAuth | null
  if (!c) return null
  return { ...c, invitados: Array.isArray(c.invitados) ? c.invitados : [] }
}

export async function guardarConfig(c: ConfigAuth) {
  await tiendaAuth().setJSON(LLAVE, c)
}

export async function crearSesion(rol: Rol, nombre: string) {
  const token = nuevoId() + nuevoId()
  await tiendaSes().setJSON(token, { rol, nombre, exp: Date.now() + DIAS_SESION * 86400000 })
  return token
}

export async function cerrarSesion(token: string) {
  await tiendaSes().delete(token).catch(() => {})
}

/** Devuelve quién está llamando, o null si no tiene sesión válida. */
export async function quienLlama(req: Request): Promise<Acceso | null> {
  const cab = req.headers.get('authorization') || ''
  const token = cab.replace(/^Bearer\s+/i, '').trim()
  if (!token || token.length < 20) return null
  const s = (await tiendaSes().get(token, { type: 'json' }).catch(() => null)) as
    | { rol: Rol; nombre: string; exp: number }
    | null
  if (!s || !s.exp || s.exp < Date.now()) return null
  return { rol: s.rol === 'lectura' ? 'lectura' : 'dueño', nombre: s.nombre || '', token }
}

export const sinAcceso = () =>
  Response.json({ error: 'Necesitas ingresar con tu clave', codigo: 'sin_acceso' }, { status: 401 })

export const soloDueno = () =>
  Response.json({ error: 'Este acceso es de solo lectura', codigo: 'solo_lectura' }, { status: 403 })
