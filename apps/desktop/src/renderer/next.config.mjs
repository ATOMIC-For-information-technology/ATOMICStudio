/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  // Relative asset paths are REQUIRED for the exported build: Electron loads index.html over
  // file://, where a root-absolute /_next/... resolves to the filesystem root and 404s.
  // They must NOT be set in dev: the Turbopack dev runtime derives its chunk base from
  // assetPrefix, and './' leaves that base empty — dynamic imports then never resolve
  // ("chunk path empty but not in a worker"), so next/dynamic sits on its loading placeholder
  // forever and the window renders black.
  assetPrefix: process.env.NODE_ENV === 'production' ? './' : undefined,
  agentRules: false,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false
}

export default config
