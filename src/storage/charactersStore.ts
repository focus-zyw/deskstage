// 角色库持久层:data/characters.json。角色是独立实体(手动创建或酒馆卡导入入库),
// 通过 config.slotBindings 投影到 A/B/C 槽位(见 src/characters/bind.ts)——
// 库是事实源,槽位配置(names/genders/persona)是投影结果。
// 容量 ≤50;withFileLock + localStorage `vc-characters` 降级,静默容错。
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { withFileLock } from './writeLock'
import { inTauri } from './configStore'

export type CharacterSource = 'manual' | 'card'

export interface CharacterDef {
  id: string
  /** ≤12 字(保存时截断,与 config.names 清洗一致) */
  name: string
  gender: '女' | '男'
  /** ≤8000 字;**内置条目留空 = 跟随内置模板**(defaultPersonaText 按当前名替换) */
  persona: string
  source: CharacterSource
  createdAt: number
  /** 内置角色(甲/乙/丙)的家槽:persona 留空跟随模板、不可删除;编辑人设即固化 */
  builtin?: 'a' | 'b' | 'c'
  /** 卡导入来源元数据 */
  card?: { spec: string; creator?: string; characterVersion?: string }
}

export interface CharactersData {
  version: 1
  characters: CharacterDef[]
}

export const MAX_CHARACTERS = 50
const NAME_CAP = 12
const PERSONA_CAP = 8000

const LS_KEY = 'vc-characters'
const FILE_NAME = 'characters.json'

let cache: CharactersData | null = null

function genId(): string {
  return `chr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

function sanitizeCharacter(v: unknown): CharacterDef | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  const id = asText(c.id)
  const name = asText(c.name).slice(0, NAME_CAP)
  if (!id || !name) return null // 无 id / 无名 = 不是角色
  const cardRaw = c.card as Record<string, unknown> | undefined
  return {
    id,
    name,
    gender: c.gender === '男' ? '男' : '女',
    persona: asText(c.persona).slice(0, PERSONA_CAP),
    source: c.source === 'card' ? 'card' : 'manual',
    createdAt: typeof c.createdAt === 'number' && c.createdAt > 0 ? c.createdAt : Date.now(),
    ...(c.builtin === 'a' || c.builtin === 'b' || c.builtin === 'c' ? { builtin: c.builtin } : {}),
    ...(cardRaw && typeof cardRaw === 'object' && typeof cardRaw.spec === 'string'
      ? {
          card: {
            spec: cardRaw.spec.slice(0, 40),
            ...(typeof cardRaw.creator === 'string' && cardRaw.creator ? { creator: cardRaw.creator.slice(0, 80) } : {}),
            ...(typeof cardRaw.characterVersion === 'string' && cardRaw.characterVersion
              ? { characterVersion: cardRaw.characterVersion.slice(0, 40) }
              : {}),
          },
        }
      : {}),
  }
}

/** 幂等清洗(测试与读档共用) */
export function sanitizeCharactersData(v: unknown): CharactersData {
  const o = (v ?? {}) as Record<string, unknown>
  const list = Array.isArray(o.characters)
    ? (o.characters.map(sanitizeCharacter).filter((c): c is CharacterDef => c !== null)).slice(-MAX_CHARACTERS)
    : []
  // id 去重(后到者胜)
  const byId = new Map<string, CharacterDef>()
  for (const c of list) byId.set(c.id, c)
  return { version: 1, characters: [...byId.values()] }
}

async function readFile(): Promise<CharactersData> {
  if (!inTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return sanitizeCharactersData(JSON.parse(raw))
    } catch {
      // 坏数据按空库处理
    }
    return { version: 1, characters: [] }
  }
  try {
    const file = await join(await appDataDir(), 'data', FILE_NAME)
    if (await exists(file)) return sanitizeCharactersData(JSON.parse(await readTextFile(file)))
  } catch (e) {
    console.warn('角色库读取失败(按空库处理)', e)
  }
  return { version: 1, characters: [] }
}

let version = 0
const listeners = new Set<() => void>()

function bumpVersion(): void {
  version += 1
  for (const l of listeners) l()
}

/** 角色库变更订阅(useSyncExternalStore 用):新增/删除/编辑/种子都会 bump */
export function subscribeCharacters(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function charactersVersion(): number {
  return version
}

async function writeFile(data: CharactersData): Promise<void> {
  cache = data
  bumpVersion()
  if (!inTauri) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(data))
    } catch {
      /* ignore */
    }
    return
  }
  try {
    const dir = await join(await appDataDir(), 'data')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    await writeTextFile(await join(dir, FILE_NAME), JSON.stringify(data, null, 2))
  } catch (e) {
    console.warn('角色库落盘失败(静默)', e)
  }
}

/** 角色库全量(按创建时间升序) */
export async function listCharacters(): Promise<CharacterDef[]> {
  if (!cache) cache = await readFile()
  return [...cache.characters].sort((a, b) => a.createdAt - b.createdAt)
}

/** 按 id 取角色 */
export async function getCharacter(id: string): Promise<CharacterDef | null> {
  return (await listCharacters()).find((c) => c.id === id) ?? null
}

/** 保存角色:有 id 更新,无 id 新增(容量满报错) */
export async function saveCharacter(input: Partial<Omit<CharacterDef, 'id' | 'createdAt'>> & { id?: string }): Promise<CharacterDef> {
  await withFileLock('characters', async () => {
    if (!cache) cache = await readFile()
  })
  const existing = input.id ? cache!.characters.find((c) => c.id === input.id) : undefined
  if (!existing && !input.id && cache!.characters.length >= MAX_CHARACTERS) {
    throw new Error(`角色库已满(上限 ${MAX_CHARACTERS} 个),请先删除不需要的角色`)
  }
  const def: CharacterDef = {
    id: input.id ?? existing?.id ?? genId(),
    name: asText(input.name ?? existing?.name).slice(0, NAME_CAP),
    gender: (input.gender ?? existing?.gender) === '男' ? '男' : '女',
    persona: asText(input.persona ?? existing?.persona).slice(0, PERSONA_CAP),
    source: input.source ?? existing?.source ?? 'manual',
    createdAt: existing?.createdAt ?? Date.now(),
    ...(existing?.builtin ? { builtin: existing.builtin } : {}),
    ...(input.card ?? existing?.card ? { card: input.card ?? existing!.card } : {}),
  }
  if (!def.name) throw new Error('角色名不能为空')
  await withFileLock('characters', async () => {
    if (!cache) cache = await readFile()
    const others = cache!.characters.filter((c) => c.id !== def.id)
    await writeFile({ version: 1, characters: [...others, def] })
  })
  return def
}

/** 删除角色(绑定解除由调用方先做投影,这里只删库);内置角色不可删除 */
export async function deleteCharacter(id: string): Promise<void> {
  const target = (await listCharacters()).find((c) => c.id === id)
  if (target?.builtin) throw new Error('内置角色不可删除')
  await withFileLock('characters', async () => {
    if (!cache) cache = await readFile()
    await writeFile({ version: 1, characters: cache!.characters.filter((c) => c.id !== id) })
  })
}

/** 种子快照:名字/性别取 config 覆盖值或默认;config 已有自定义人设的槽直接固化该文本 */
export interface SeedConfigSnapshot {
  names: { a: string; b: string; c: string }
  genders: { a: string; b: string; c: string }
  persona: { a: string; b: string; c: string }
  personaSource: { a: string; b: string; c: string }
}

const BUILTIN_SEEDS: Array<{ slot: 'a' | 'b' | 'c'; builtin: 'a' | 'b' | 'c'; fallbackName: string; fallbackGender: '女' | '男' }> = [
  { slot: 'a', builtin: 'a', fallbackName: '甲', fallbackGender: '女' },
  { slot: 'b', builtin: 'b', fallbackName: '乙', fallbackGender: '男' },
  { slot: 'c', builtin: 'c', fallbackName: '丙', fallbackGender: '女' },
]

let seeded = false

/** 补种三个内置角色(甲/乙/丙):已有则不动。老用户无损——config 里已自定义的
 *  名字/性别/人设直接固化为种子;人设仍为默认的槽 persona 留空(跟随内置模板) */
export async function ensureSeeded(cfg?: SeedConfigSnapshot): Promise<void> {
  if (seeded) return
  await withFileLock('characters', async () => {
    if (!cache) cache = await readFile()
    const missing = BUILTIN_SEEDS.filter((s) => !cache!.characters.some((c) => c.builtin === s.builtin))
    if (missing.length === 0) {
      seeded = true
      return
    }
    const created: CharacterDef[] = missing.map((s) => {
      const customPersona = cfg?.personaSource?.[s.slot] === 'custom' ? asText(cfg?.persona?.[s.slot]) : ''
      return {
        id: `chr_builtin_${s.builtin}`,
        name: asText(cfg?.names?.[s.slot]).slice(0, NAME_CAP) || s.fallbackName,
        gender: cfg?.genders?.[s.slot] === '男' ? '男' : s.fallbackGender,
        persona: customPersona.slice(0, PERSONA_CAP),
        source: 'manual' as const,
        createdAt: Date.now(),
        builtin: s.builtin,
      }
    })
    await writeFile({ version: 1, characters: [...cache!.characters, ...created].slice(-MAX_CHARACTERS) })
    seeded = true
  })
}

/** 清空角色库(测试/设置复位用);内置种子标记一并复位 */
export async function resetCharacters(): Promise<void> {
  seeded = false
  await withFileLock('characters', async () => {
    await writeFile({ version: 1, characters: [] })
  })
}
