import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { resolve, join, relative } from 'path'

const { VITE_BASE } = process.env

// Single source of truth for the client-side version (Settings → About /
// update check). Injected as a define so package.json stays authoritative.
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'))

// GitHub Pages base path — set via VITE_BASE env var.
//   VITE_BASE=/CherryAgent/ npm run build:pages → GitHub Pages
//   npm run build                                  → normal (no prefix)
const GH_PAGES_BASE = VITE_BASE || '/'

// PWA metadata cannot resolve CSS variables. Generate concrete colors for
// the initial browser chrome and install splash from the default CSS palette.
function pwaThemePlugin() {
  const themeFile = resolve('src/theme.css')
  const manifestFile = resolve('src/pwa-manifest.json')
  const readDefaultColor = () => {
    const css = readFileSync(themeFile, 'utf-8')
    const color = css.match(/^\s*--color-bg:\s*([^;]+);/m)?.[1].trim()
    if (!color) throw new Error('Missing default --color-bg in src/theme.css')
    return color
  }
  const readManifest = () => {
    const color = readDefaultColor()
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'))
    return JSON.stringify({ ...manifest, background_color: color, theme_color: color }, null, 2)
  }
  let manifestPath

  return {
    name: 'pwa-theme',
    configResolved(config) {
      manifestPath = `${config.base}manifest.json`
    },
    transformIndexHtml() {
      return [
        { tag: 'link', attrs: { rel: 'manifest', href: manifestPath }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'theme-color', content: readDefaultColor() }, injectTo: 'head' },
      ]
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== manifestPath) return next()
        res.setHeader('Content-Type', 'application/manifest+json')
        res.end(readManifest())
      })
    },
    buildStart() {
      this.addWatchFile(themeFile)
      this.addWatchFile(manifestFile)
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: readManifest() })
    },
  }
}

/**
 * Vite plugin: generate service worker with precache manifest.
 * After build, scans dist/ for all emitted files and injects them
 * into sw.js so they are precached on install.
 */
function swPrecachePlugin() {
  return {
    name: 'sw-precache',
    apply: 'build',
    closeBundle() {
      const distDir = resolve('dist')
      const allFiles = []

      // Recursively collect all files in dist/
      function walk(dir) {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry)
          if (statSync(full).isDirectory()) {
            walk(full)
          } else {
            const rel = relative(distDir, full).replace(/\\/g, '/')
            // Skip the sw.js itself
            if (rel !== 'sw.js') allFiles.push(rel)
          }
        }
      }
      walk(distDir)

      // Read the sw.js template from public/ and replace placeholders
      const swTemplate = readFileSync(resolve('public/sw.js'), 'utf-8')
      const cacheVersion = `cherry-agent-${Date.now()}`
      const swContent = swTemplate
        .replace(
          /const CACHE_NAME = '[^']*'/,
          `const CACHE_NAME = '${cacheVersion}'`
        )
        .replace(
          /const APP_SHELL = \[[^\]]*\]/s,
          `const APP_SHELL = [\n${allFiles.map(f => `  self.location.origin + BASE + '${f}',`).join('\n')}\n]`
        )
        .replace(
          /const BASE = '[^']*'/,
          `const BASE = '${GH_PAGES_BASE}'`
        )

      writeFileSync(join(distDir, 'sw.js'), swContent)
      console.log(`\n  SW precache: ${allFiles.length} files cached`)
    },
  }
}

// Shared proxy config for agent API
const agentProxy = {
  '/agent': {
    target: 'http://localhost:3099',
    changeOrigin: true,
    ws: true,
  },
}

// https://vite.dev/config/
export default defineConfig(() => {
  return {
    base: GH_PAGES_BASE,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [basicSsl(), react(), pwaThemePlugin(), swPrecachePlugin()],
    server: {
      port: 5173,
      https: true,
      proxy: agentProxy,
    },
    preview: {
      port: 5173,
      proxy: agentProxy,
    },
  }
})
