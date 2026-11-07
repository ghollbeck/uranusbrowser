/**
 * The companions and their memory, per profile (chrome.storage.local): which one is active,
 * the ones the user made, and each one's notes. Plain functions on plain data, so what the
 * panel can do (and refuse) is testable without a browser. Built-in roles live in code
 * (shared/companions.ts); only the user's own companions and every companion's notes are saved.
 */
import {
  GENERAL_ID,
  MAX_CUSTOM,
  MAX_NOTES,
  PRESETS,
  checkCompanion,
  checkNote,
  cleanLine,
  type Companion,
  type CompanionContext,
  type MemoryNote,
} from '../../shared/companions';
import { MAX_FILES, cleanContextText, cleanFileName, kindOf, type CompanionFile } from '../../shared/knowledge';
import { MAX_SKILLS, checkSkill, cleanSource, type Skill, type SkillSource } from '../../shared/skills';

export const COMPANIONS_KEY = 'companions';

export interface CompanionsState {
  active: string;
  custom: Companion[];
  /** Notes by companion id (built-in or custom). */
  memory: Record<string, MemoryNote[]>;
  /** Project context by companion id. */
  context: Record<string, string>;
  /** Attached files by companion id: names and sizes only. Each file's text is saved under fileKey(id). */
  files: Record<string, CompanionFile[]>;
  /** Skills by companion id. */
  skills: Record<string, Skill[]>;
}

export const DEFAULT_STATE: CompanionsState = { active: GENERAL_ID, custom: [], memory: {}, context: {}, files: {}, skills: {} };

/** Where one file's text is saved (kept apart, so the companions list stays small to load). */
export const fileKey = (fileId: string) => `companionFile:${fileId}`;

export type Fail = { ok: false; reason: string };
export type Result<Extra extends object = object> = ({ ok: true; state: CompanionsState } & Extra) | Fail;

export const allCompanions = (state: CompanionsState): Companion[] => [...PRESETS, ...state.custom];
export const findCompanion = (state: CompanionsState, id: string) => allCompanions(state).find((c) => c.id === id);
export const activeCompanion = (state: CompanionsState): Companion => findCompanion(state, state.active) ?? PRESETS[0];
export const notesFor = (state: CompanionsState, id: string): MemoryNote[] => state.memory[id] ?? [];

/** Saved state, checked: anything odd is dropped, and the active companion always exists. */
export function restore(saved: unknown): CompanionsState {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<CompanionsState>;
  const taken = new Set<string>(PRESETS.map((p) => p.id));
  const custom: Companion[] = [];
  for (const raw of Array.isArray(s.custom) ? s.custom : []) {
    const id = typeof raw?.id === 'string' ? raw.id.slice(0, 64) : '';
    const checked = checkCompanion(raw);
    if (!id || taken.has(id) || !checked.ok || custom.length >= MAX_CUSTOM) continue;
    taken.add(id);
    custom.push({ id, ...checked.value });
  }
  const memory: Record<string, MemoryNote[]> = {};
  for (const [id, list] of Object.entries(s.memory && typeof s.memory === 'object' ? s.memory : {})) {
    if (!taken.has(id) || !Array.isArray(list)) continue;
    const notes: MemoryNote[] = [];
    for (const n of list) {
      const checked = checkNote(n?.text);
      if (checked.ok && typeof n.id === 'string' && n.id && notes.length < MAX_NOTES) notes.push({ id: n.id.slice(0, 64), text: checked.text, at: Number.isFinite(n.at) ? Number(n.at) : 0 });
    }
    if (notes.length) memory[id] = notes;
  }
  const context: Record<string, string> = {};
  for (const [id, text] of Object.entries(s.context && typeof s.context === 'object' ? s.context : {})) {
    const clean = cleanContextText(text);
    if (taken.has(id) && clean) context[id] = clean;
  }
  const files: Record<string, CompanionFile[]> = {};
  for (const [id, list] of Object.entries(s.files && typeof s.files === 'object' ? s.files : {})) {
    if (!taken.has(id) || !Array.isArray(list)) continue;
    const kept: CompanionFile[] = [];
    for (const f of list) {
      const kind = f && typeof f === 'object' ? (['pdf', 'document', 'text'].includes(f.kind) ? f.kind : kindOf(String(f.name ?? ''))) : undefined;
      if (!kind || typeof f.id !== 'string' || !f.id || kept.length >= MAX_FILES) continue;
      kept.push({ id: f.id.slice(0, 64), name: cleanFileName(f.name), kind, chars: Math.max(0, Number(f.chars) || 0), ...(f.truncated ? { truncated: true } : {}), addedAt: Number.isFinite(f.addedAt) ? Number(f.addedAt) : 0 });
    }
    if (kept.length) files[id] = kept;
  }
  const skills: Record<string, Skill[]> = {};
  for (const [id, list] of Object.entries(s.skills && typeof s.skills === 'object' ? s.skills : {})) {
    if (!taken.has(id) || !Array.isArray(list)) continue;
    const kept: Skill[] = [];
    for (const k of list) {
      const checked = checkSkill(k);
      if (!checked.ok || typeof k.id !== 'string' || !k.id || kept.length >= MAX_SKILLS) continue;
      kept.push({ id: k.id.slice(0, 64), ...checked.value, source: cleanSource(k.source), createdAt: Number(k.createdAt) || 0, updatedAt: Number(k.updatedAt) || 0 });
    }
    if (kept.length) skills[id] = kept;
  }
  return { active: typeof s.active === 'string' && taken.has(s.active) ? s.active : GENERAL_ID, custom, memory, context, files, skills };
}

export function select(state: CompanionsState, id: string): Result {
  return findCompanion(state, id) ? { ok: true, state: { ...state, active: id } } : { ok: false, reason: 'That companion doesn’t exist.' };
}

/** Makes or edits one of the user's own companions. Built-in roles can't be edited. */
export function saveCompanion(state: CompanionsState, input: unknown, newId: () => string): Result<{ id: string }> {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<Companion>;
  const checked = checkCompanion(raw);
  if (!checked.ok) return checked;
  const existing = typeof raw.id === 'string' && raw.id ? raw.id : undefined;
  if (existing) {
    if (PRESETS.some((p) => p.id === existing)) return { ok: false, reason: 'Built-in companions can’t be edited. Make a copy instead.' };
    if (!state.custom.some((c) => c.id === existing)) return { ok: false, reason: 'That companion doesn’t exist.' };
    const custom = state.custom.map((c) => (c.id === existing ? { id: existing, ...checked.value } : c));
    return { ok: true, state: { ...state, custom }, id: existing };
  }
  if (state.custom.length >= MAX_CUSTOM) return { ok: false, reason: `You can have up to ${MAX_CUSTOM} companions of your own.` };
  const id = newId();
  return { ok: true, state: { ...state, custom: [...state.custom, { id, ...checked.value }], active: id }, id };
}

const without = <T>(record: Record<string, T>, id: string): Record<string, T> => {
  const { [id]: _gone, ...rest } = record;
  return rest;
};

/** Removes one of the user's companions and everything it remembered and knew (the caller deletes the files' text). */
export function removeCompanion(state: CompanionsState, id: string): Result<{ removedFiles: string[] }> {
  if (!state.custom.some((c) => c.id === id)) return { ok: false, reason: 'Only companions you made can be removed.' };
  return {
    ok: true,
    state: {
      active: state.active === id ? GENERAL_ID : state.active,
      custom: state.custom.filter((c) => c.id !== id),
      memory: without(state.memory, id),
      context: without(state.context, id),
      files: without(state.files, id),
      skills: without(state.skills, id),
    },
    removedFiles: (state.files[id] ?? []).map((f) => f.id),
  };
}

// ---- knowledge: project context and files -------------------------------------------------

export function setContext(state: CompanionsState, companionId: string, text: unknown): Result {
  if (!findCompanion(state, companionId)) return { ok: false, reason: 'That companion doesn’t exist any more.' };
  const clean = cleanContextText(text);
  const context = clean ? { ...state.context, [companionId]: clean } : without(state.context, companionId);
  return { ok: true, state: { ...state, context } };
}

export const filesFor = (state: CompanionsState, id: string): CompanionFile[] => state.files[id] ?? [];

/** Adds a file's entry (its text is saved by the caller under fileKey). */
export function addFile(state: CompanionsState, companionId: string, file: Omit<CompanionFile, 'id' | 'addedAt'>, newId: () => string, now = Date.now()): Result<{ file: CompanionFile }> {
  if (!findCompanion(state, companionId)) return { ok: false, reason: 'That companion doesn’t exist any more.' };
  const list = filesFor(state, companionId);
  if (list.length >= MAX_FILES) return { ok: false, reason: `A companion can have up to ${MAX_FILES} files. Remove one first.` };
  if (!file.chars) return { ok: false, reason: `“${cleanFileName(file.name)}” has no text that can be read (a scanned PDF, say).` };
  const entry: CompanionFile = { id: newId(), name: cleanFileName(file.name), kind: file.kind, chars: file.chars, ...(file.truncated ? { truncated: true } : {}), addedAt: now };
  return { ok: true, state: { ...state, files: { ...state.files, [companionId]: [...list, entry] } }, file: entry };
}

export function removeFile(state: CompanionsState, companionId: string, fileId: string): Result {
  const list = filesFor(state, companionId);
  if (!list.some((f) => f.id === fileId)) return { ok: false, reason: 'That file is already gone.' };
  const rest = list.filter((f) => f.id !== fileId);
  return { ok: true, state: { ...state, files: rest.length ? { ...state.files, [companionId]: rest } : without(state.files, companionId) } };
}

// ---- skills -------------------------------------------------------------------------------

export const skillsFor = (state: CompanionsState, id: string): Skill[] => state.skills[id] ?? [];

/** Makes or edits a skill. `input.id` names one to edit; a new one gets an id. */
export function saveSkill(state: CompanionsState, companionId: string, input: unknown, source: SkillSource, newId: () => string, now = Date.now()): Result<{ skill: Skill }> {
  if (!findCompanion(state, companionId)) return { ok: false, reason: 'That companion doesn’t exist any more.' };
  const checked = checkSkill(input);
  if (!checked.ok) return checked;
  const list = skillsFor(state, companionId);
  const editing = typeof (input as Partial<Skill>)?.id === 'string' ? list.find((k) => k.id === (input as Skill).id) : undefined;
  if (editing) {
    const skill: Skill = { ...editing, ...checked.value, updatedAt: now };
    return { ok: true, state: { ...state, skills: { ...state.skills, [companionId]: list.map((k) => (k.id === skill.id ? skill : k)) } }, skill };
  }
  if (list.some((k) => k.name.toLowerCase() === checked.value.name.toLowerCase())) return { ok: false, reason: `There is already a skill called “${checked.value.name}”. Pick another name, or edit that one.` };
  if (list.length >= MAX_SKILLS) return { ok: false, reason: `A companion can have up to ${MAX_SKILLS} skills. Remove one first.` };
  const skill: Skill = { id: newId(), ...checked.value, source, createdAt: now, updatedAt: now };
  return { ok: true, state: { ...state, skills: { ...state.skills, [companionId]: [...list, skill] } }, skill };
}

export function removeSkill(state: CompanionsState, companionId: string, skillId: string): Result {
  const list = skillsFor(state, companionId);
  if (!list.some((k) => k.id === skillId)) return { ok: false, reason: 'That skill is already gone.' };
  const rest = list.filter((k) => k.id !== skillId);
  return { ok: true, state: { ...state, skills: rest.length ? { ...state.skills, [companionId]: rest } : without(state.skills, companionId) } };
}

export function addNote(state: CompanionsState, companionId: string, text: unknown, newId: () => string, now = Date.now()): Result<{ note: MemoryNote }> {
  if (!findCompanion(state, companionId)) return { ok: false, reason: 'That companion doesn’t exist any more.' };
  const checked = checkNote(text);
  if (!checked.ok) return checked;
  const list = notesFor(state, companionId);
  if (list.some((n) => n.text.toLowerCase() === checked.text.toLowerCase())) return { ok: false, reason: 'It already remembers that.' };
  if (list.length >= MAX_NOTES) return { ok: false, reason: `Memory is full (${MAX_NOTES} notes). Remove one first.` };
  const note = { id: newId(), text: checked.text, at: now };
  return { ok: true, state: { ...state, memory: { ...state.memory, [companionId]: [...list, note] } }, note };
}

export function removeNote(state: CompanionsState, companionId: string, noteId: string): Result {
  const list = notesFor(state, companionId);
  if (!list.some((n) => n.id === noteId)) return { ok: false, reason: 'That note is already gone.' };
  const rest = list.filter((n) => n.id !== noteId);
  const memory = { ...state.memory };
  if (rest.length) memory[companionId] = rest;
  else delete memory[companionId];
  return { ok: true, state: { ...state, memory } };
}

export function clearNotes(state: CompanionsState, companionId: string): CompanionsState {
  return { ...state, memory: without(state.memory, companionId) };
}

/**
 * What the native host gets with a message: the active companion, its notes (oldest first),
 * its project context, its files' names and its skills. `pickedSkill` is the skill the user
 * picked with "/", kept only if this companion has it.
 */
export function contextFor(state: CompanionsState, pickedSkill?: string): CompanionContext {
  const c = activeCompanion(state);
  const skills = skillsFor(state, c.id).map(({ id, name, when, steps }) => ({ id, name, when, steps }));
  return {
    id: c.id,
    name: c.name,
    role: c.role,
    instructions: c.instructions,
    memory: notesFor(state, c.id).map((n) => n.text),
    context: state.context[c.id] ?? '',
    files: filesFor(state, c.id).map(({ id, name, chars }) => ({ id, name, chars })),
    skills,
    ...(pickedSkill && skills.some((k) => k.id === pickedSkill) ? { pickedSkill } : {}),
  };
}

/** Storage as this module uses it, so tests can hand it a fake. */
export interface CompanionsStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function loadState(storage: CompanionsStorage) {
  return restore((await storage.get(COMPANIONS_KEY))[COMPANIONS_KEY]);
}

export const saveState = (storage: CompanionsStorage, state: CompanionsState) => storage.set({ [COMPANIONS_KEY]: state });

/** A short name for a duplicate: "Sales copy". */
export const copyName = (name: string) => cleanLine(`${name} copy`, 40);
