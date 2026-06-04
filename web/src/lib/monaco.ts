// Offline, minimal Monaco setup.
//
// By default @monaco-editor/react lazy-loads Monaco from cdn.jsdelivr.net,
// which fails on air-gapped machines. We instead bundle a *minimal* Monaco
// (editor core + YAML highlighting only) from the local npm package and wire
// its single worker through Vite's ?worker import. Nothing is fetched at
// runtime. Importing the full `monaco-editor` would pull in ~80 languages and
// four heavy language workers (the TS worker alone is ~7 MB) — we don't need
// them for editing docker-compose YAML.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'

// YAML highlighting is Monarch-based (main thread); only the base editor
// worker is required.
self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker()
  },
}

loader.config({ monaco })

export {}
