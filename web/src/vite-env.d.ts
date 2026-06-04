/// <reference types="vite/client" />

// The deep ESM entry has the same API as the package root; map its types so we
// can import the minimal editor core (instead of the full monaco bundle).
declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor'
}
