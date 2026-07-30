// Paso de compilación para Netlify.
//
// El problema: index.html traía todo su JavaScript como JSX y lo transpilaba
// EN EL NAVEGADOR con @babel/standalone en cada carga. Con el archivo ya sobre
// los 600 KB, en un celular eso tardaba muchísimo o dejaba la página en blanco.
//
// Este script hace esa transpilación una sola vez, al desplegar, y publica el
// código ya listo (JavaScript plano). El navegador ya no carga Babel ni
// transpila nada, así que abre al instante.
//
// El código fuente sigue siendo index.html (con su bloque <script type="text/
// babel">): se edita igual que siempre. Lo que cambia es que lo servido sale
// de la carpeta dist/, generada aquí.

import fs from 'fs'
import path from 'path'
import babel from '@babel/standalone'

const root = process.cwd()
const out = path.join(root, 'dist')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

// Todo lo estático se copia a dist/. Las funciones (netlify/functions) las
// compila Netlify aparte, así que no van aquí.
const SALTAR = new Set(['.git', 'node_modules', 'dist', 'netlify', 'build.mjs', 'package.json', 'package-lock.json', 'scratchpad'])
function copiar(src, dst) {
  for (const nombre of fs.readdirSync(src)) {
    if (SALTAR.has(nombre)) continue
    const s = path.join(src, nombre), d = path.join(dst, nombre)
    const st = fs.statSync(s)
    if (st.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copiar(s, d) }
    else fs.copyFileSync(s, d)
  }
}
copiar(root, out)

// Pre-transpila el bloque JSX de index.html.
const idx = path.join(out, 'index.html')
let html = fs.readFileSync(idx, 'utf8')
let transpilado = false
html = html.replace(/<script type="text\/babel">([\s\S]*?)<\/script>/, (m, code) => {
  transpilado = true
  const js = babel.transform(code, { presets: [['react', { runtime: 'classic' }]], compact: false }).code
  return '<script>\n' + js + '\n</script>'
})
if (!transpilado) throw new Error('No encontré el bloque <script type="text/babel"> en index.html')
// El navegador ya no necesita Babel: se saca el CDN.
html = html.replace(/\s*<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone[^"]*"><\/script>/, '')
fs.writeFileSync(idx, html)

console.log('Build listo: index.html pre-transpilado, Babel quitado del navegador.')
