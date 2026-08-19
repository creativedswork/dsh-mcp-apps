export type AppSurface = 'inline' | 'fullscreen'

export interface AppInstanceController {
  sessionId: string
  callId: string
  publicToolName: string
  ready: boolean
  surface: AppSurface
  requestSurface(surface: AppSurface): void
  locate(): void
}

export interface AppInstanceSnapshot {
  sessionId: string
  callId: string
  publicToolName: string
  ready: boolean
  surface: AppSurface
}

export interface SessionAppSnapshot {
  activeCallId?: string
  instances: readonly AppInstanceSnapshot[]
}

interface SessionState {
  activeCallId?: string
  controllers: Map<string, AppInstanceController>
}

const EMPTY_SNAPSHOT: SessionAppSnapshot = Object.freeze({
  instances: Object.freeze([]),
})

export class SessionAppRegistry {
  private readonly sessions = new Map<string, SessionState>()
  private readonly snapshots = new Map<string, SessionAppSnapshot>()
  private readonly listeners = new Map<string, Set<() => void>>()

  register(controller: AppInstanceController): () => void {
    const state = this.sessions.get(controller.sessionId) ?? {
      controllers: new Map<string, AppInstanceController>(),
    }
    this.sessions.set(controller.sessionId, state)
    state.controllers.set(controller.callId, controller)
    state.activeCallId ??= controller.callId
    this.publish(controller.sessionId)

    return () => {
      const current = this.sessions.get(controller.sessionId)
      if (current?.controllers.get(controller.callId) !== controller) return
      current.controllers.delete(controller.callId)
      if (current.activeCallId === controller.callId) {
        current.activeCallId = [...current.controllers.keys()].at(-1)
      }
      if (current.controllers.size === 0) this.sessions.delete(controller.sessionId)
      this.publish(controller.sessionId)
    }
  }

  changed(controller: AppInstanceController): void {
    if (this.sessions.get(controller.sessionId)?.controllers.get(controller.callId) !== controller) return
    this.publish(controller.sessionId)
  }

  activate(sessionId: string, callId: string): boolean {
    const state = this.sessions.get(sessionId)
    if (state?.controllers.has(callId) !== true) return false
    state.activeCallId = callId
    this.publish(sessionId)
    return true
  }

  requestSurface(sessionId: string, callId: string, surface: AppSurface): boolean {
    const state = this.sessions.get(sessionId)
    const target = state?.controllers.get(callId)
    if (state === undefined || target === undefined) return false
    if (surface === 'fullscreen') {
      for (const controller of state.controllers.values()) {
        if (controller !== target && controller.surface === 'fullscreen') {
          controller.requestSurface('inline')
        }
      }
    }
    state.activeCallId = callId
    target.requestSurface(surface)
    this.publish(sessionId)
    return true
  }

  locate(sessionId: string, callId: string): boolean {
    const state = this.sessions.get(sessionId)
    const target = state?.controllers.get(callId)
    if (state === undefined || target === undefined) return false
    state.activeCallId = callId
    target.locate()
    this.publish(sessionId)
    return true
  }

  snapshot(sessionId: string): SessionAppSnapshot {
    return this.snapshots.get(sessionId) ?? EMPTY_SNAPSHOT
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
    this.listeners.set(sessionId, listeners)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }

  clear(): void {
    const sessionIds = new Set([...this.sessions.keys(), ...this.listeners.keys()])
    this.sessions.clear()
    this.snapshots.clear()
    for (const sessionId of sessionIds) {
      for (const listener of this.listeners.get(sessionId) ?? []) listener()
    }
  }

  private publish(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      this.snapshots.delete(sessionId)
    } else {
      this.snapshots.set(sessionId, Object.freeze({
        ...(state.activeCallId === undefined ? {} : { activeCallId: state.activeCallId }),
        instances: Object.freeze([...state.controllers.values()].map(controller => Object.freeze({
          sessionId: controller.sessionId,
          callId: controller.callId,
          publicToolName: controller.publicToolName,
          ready: controller.ready,
          surface: controller.surface,
        }))),
      }))
    }
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }
}

export const appRegistry = new SessionAppRegistry()
