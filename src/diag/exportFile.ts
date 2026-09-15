import { appDataDir, join } from '@tauri-apps/api/path'
import { mkdir, writeTextFile } from '@tauri-apps/plugin-fs'

interface DiagExportFileDeps {
  appDataDir(): Promise<string>
  join(...paths: string[]): Promise<string>
  mkdir(path: string, options: { recursive: boolean }): Promise<void>
  writeTextFile(path: string, contents: string): Promise<void>
  now(): number
}

const DEFAULT_DEPS: DiagExportFileDeps = {
  appDataDir,
  join,
  mkdir,
  writeTextFile,
  now: Date.now,
}

/** Write a diagnostic bundle under the application's data directory. */
export async function writeDiagExportFile(
  json: string,
  deps: DiagExportFileDeps = DEFAULT_DEPS,
): Promise<string> {
  const dir = await deps.appDataDir()
  const dataDir = await deps.join(dir, 'data')
  await deps.mkdir(dataDir, { recursive: true }).catch(() => {})
  const file = await deps.join(dataDir, `diag-export-${deps.now()}.json`)
  await deps.writeTextFile(file, json)
  return file
}
