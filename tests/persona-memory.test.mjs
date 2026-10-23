import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

test('custom persona ids that match object prototype keys keep isolated memory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-persona-memory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registered = new Map()
  const ctx = {
    tools: {
      register(tool) {
        registered.set(tool.name, tool)
      },
    },
    on() {},
  }
  const memoryPath = join(root, 'memory.json')

  apply(ctx, {
    activePersona: '__proto__',
    statePath: join(root, 'state.json'),
    memoryPath,
    personas: [
      {
        id: '__proto__',
        name: 'Prototype Persona',
        prompt: 'Keep this persona active.',
      },
    ],
  })

  const remembered = await registered.get('persona_remember').execute({
    text: 'remember this safely',
  })
  const recalled = await registered.get('persona_recall').execute({})
  const persisted = JSON.parse(await readFile(memoryPath, 'utf8'))

  assert.deepEqual(remembered, {
    persona: '__proto__',
    name: 'Prototype Persona',
    text: 'remember this safely',
    count: 1,
  })
  assert.equal(recalled.notes.length, 1)
  assert.equal(recalled.notes[0].text, 'remember this safely')
  assert.equal(persisted.memories.__proto__[0].text, 'remember this safely')
})
