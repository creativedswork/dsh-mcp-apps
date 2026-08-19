import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionAppRegistry } from '../src/client/app-registry.ts'

function controller(sessionId, callId, publicToolName) {
  const events = []
  return {
    sessionId,
    callId,
    publicToolName,
    ready: false,
    surface: 'inline',
    events,
    requestSurface(surface) {
      this.surface = surface
      events.push(surface)
    },
    locate() {
      this.surface = 'inline'
      events.push('locate')
    },
  }
}

test('isolates App instances and snapshots by Session', () => {
  const registry = new SessionAppRegistry()
  const editorA = controller('session-a', 'call-1', 'threejs_editor')
  const editorB = controller('session-b', 'call-1', 'shader_editor')
  let updatesA = 0
  const unsubscribe = registry.subscribe('session-a', () => { updatesA += 1 })

  const removeA = registry.register(editorA)
  registry.register(editorB)
  editorA.ready = true
  registry.changed(editorA)

  assert.equal(registry.snapshot('session-a').instances.length, 1)
  assert.equal(registry.snapshot('session-a').instances[0].publicToolName, 'threejs_editor')
  assert.equal(registry.snapshot('session-a').instances[0].ready, true)
  assert.equal(registry.snapshot('session-b').instances[0].publicToolName, 'shader_editor')
  assert.equal(registry.requestSurface('session-b', editorA.callId, 'fullscreen'), true)
  assert.deepEqual(editorA.events, [])
  assert.deepEqual(editorB.events, ['fullscreen'])
  assert.ok(updatesA >= 2)

  removeA()
  assert.equal(registry.snapshot('session-a').instances.length, 0)
  unsubscribe()
})

test('keeps one fullscreen App active and routes Locate to the selected instance', () => {
  const registry = new SessionAppRegistry()
  const first = controller('session-a', 'call-1', 'threejs_editor')
  const second = controller('session-a', 'call-2', 'material_editor')
  first.ready = true
  second.ready = true
  registry.register(first)
  registry.register(second)

  assert.equal(registry.requestSurface('session-a', first.callId, 'fullscreen'), true)
  assert.equal(registry.requestSurface('session-a', second.callId, 'fullscreen'), true)
  assert.equal(first.surface, 'inline')
  assert.equal(second.surface, 'fullscreen')
  assert.equal(registry.snapshot('session-a').activeCallId, second.callId)
  assert.deepEqual(first.events, ['fullscreen', 'inline'])
  assert.deepEqual(second.events, ['fullscreen'])

  assert.equal(registry.locate('session-a', first.callId), true)
  assert.equal(registry.snapshot('session-a').activeCallId, first.callId)
  assert.deepEqual(first.events, ['fullscreen', 'inline', 'locate'])
  assert.equal(registry.locate('session-b', first.callId), false)
})

test('does not let a stale disposer remove a replacement controller', () => {
  const registry = new SessionAppRegistry()
  const first = controller('session-a', 'call-1', 'first')
  const replacement = controller('session-a', 'call-1', 'replacement')
  const removeFirst = registry.register(first)
  registry.register(replacement)

  removeFirst()
  assert.equal(registry.snapshot('session-a').instances[0].publicToolName, 'replacement')

  let updates = 0
  registry.subscribe('session-a', () => { updates += 1 })
  registry.clear()
  assert.equal(registry.snapshot('session-a').instances.length, 0)
  assert.equal(updates, 1)
})
