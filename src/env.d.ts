declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}

interface ImportMetaEnv {
  /** Set to "1" only for the end-to-end build (`npm run build:e2e`); enables the service worker's test hooks. */
  readonly WXT_E2E_HOOKS?: string;
}
