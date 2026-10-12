import { afterEach, expect, it, vi } from 'vitest'
import { useMistShare } from '../p2p/p2p'
import { FolderEscrowController } from '../app/folderEscrowController'
import { createMistEscrowTransport } from './mistTransport'
import { parseEscrowMessage, encodeEscrowMessage } from './protocol'
import { makeFolder } from '../storage/domain'
import { deriveAutoRoom } from './crypto'
import { APP, folderInput } from '../folder/folderCheckpoint'
import { mistRuntime } from '../p2p/mistRuntime'
import type { MistModule, NetworkState } from '../p2p/p2pTypes'
import type { AppSettings } from '../storage/localSettings'

// Drive the exposed hook API; retain refs/state and leave mount effects idle.
const h = vi.hoisted(() => ({
  api: null as unknown as MistModule,
  state: null as unknown as NetworkState,
}))
vi.mock('preact/hooks', () => ({
  useRef: (current: unknown) => ({ current }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useState: (initial: NetworkState) => {
    h.state = initial
    return [initial, (next: NetworkState | ((old: NetworkState) => NetworkState)) => {
      h.state = typeof next === 'function' ? next(h.state) : next
    }]
  },
}))
vi.mock('../storage/mistStorage', () => ({
  loadMistModule: async () => h.api,
  ensureMistRuntimeInitialized: () => {},
}))
vi.mock('../p2p/p2pEnvelope', async importOriginal => ({
  ...await importOriginal<typeof import('../p2p/p2pEnvelope')>(),
  // Signing is irrelevant to room routing; preserve the outgoing payload.
  signShareEnvelope: async (value: unknown) => value,
}))
const settings: AppSettings = {
  nodeId: 'did:key:z6MkvTZ4FTCtXPiZ7M6MQoFNGgXYhEyX65Y5C6HQ8GFsv24w',
  roomId: 'app-A', autoConnect: false, profileName: 'review',
  avatarUrl: '', avatarFileId: '', identity: null,
}
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function runtime() {
  let emit: (...args: unknown[]) => void = () => {}
  const joined = new Set<string>(), left: string[] = []
  // Model daemon discovery only after an admitted escrow lease sends its hello.
  const providers = new Set<string>()
  const sent: { room: string; to: string; payload: any }[] = []
  h.api = {
    init_with_config: () => true,
    register_event_callback: (cb: typeof emit) => { emit = cb },
    join_room_async: async (room: string) => { joined.add(room) },
    leave_room_id: (room: string) => { joined.delete(room); left.push(room) },
    update_position_in_room: () => {},
    get_neighbors_in_room: (room: string) =>
      JSON.stringify(providers.has(room) ? ['mistl-daemon'] : []),
    send_message_in_room: (room: string, to: string, bytes: Uint8Array) => {
      sent.push({ room, to, payload: JSON.parse(new TextDecoder().decode(bytes)) })
      const request = parseEscrowMessage(bytes)
      if (request?.type === 'escrow_hello') {
        providers.add(room)
        emit(
        0, 'mistl-daemon', encodeEscrowMessage({
          v: 1, type: 'escrow_provider', version: 1,
          maxBlob: 32 * 1024 * 1024,
        }), room,
      )
      }
      if (request?.type === 'escrow_get') emit(
        0, 'mistl-daemon', encodeEscrowMessage({
          v: 1, type: 'escrow_head', id: request.id,
          slot: request.slot, head: null,
        }), room,
      )
    },
  } as unknown as MistModule
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval })
  return { joined, left, sent, emit: (...args: unknown[]) => emit(...args) }
}

it.each([false, true])(
  'escrow provider stays out of app peers and HELLO (overlapping Custom room: %s)',
  async overlap => {
    vi.useFakeTimers()
    const r = runtime()
    const onEnvelope = vi.fn()
    const network = useMistShare(
      settings, overlap ? ['app-A', 'app-B'] : ['app-A'], onEnvelope,
    )
    await network.connect()
    cleanups.push(() => network.disconnect(true))
    const snapshot = {
      folders: [{
        ...makeFolder({
          id: 'root', name: 'Root', parentId: null,
          color: 'teal', roomId: 'app-A',
          now: '2026-10-12T00:00:00.000Z', nodeId: settings.nodeId,
        }),
        shareEnabled: true,
      }],
      files: [], activity: [], clock: 1, originNode: settings.nodeId,
    }
    const controller = new FolderEscrowController({
      folderId: 'root', key: 'secret-folder-key',
      appRoom: 'app-A', nodeId: settings.nodeId,
      appRoomIds: () => overlap ? ['app-A', 'app-B'] : ['app-A'],
      setting: { mode: 'custom', room: 'app-B' },
      snapshot: () => snapshot,
      merge: () => {}, readFile: async () => new Uint8Array(),
      changed: () => {},
      transport: provider => createMistEscrowTransport(
        settings.nodeId, provider, async () => h.api,
      ),
      loadLocal: () => ({
        lastSeq: 0, lastHash: null, providerSeen: false, savedAt: 0,
      }),
      persist: () => {},
    })
    cleanups.push(() => controller.dispose())
    await controller.start()
    if (overlap) {
      expect.soft(controller.view.status).toBe('error')
      expect.soft(controller.view.reason).toContain('app room')
      expect.soft(r.sent.filter(s => s.room === 'app-B' && parseEscrowMessage(new TextEncoder().encode(JSON.stringify(s.payload))))).toEqual([])
    } else {
      expect(controller.view.status).not.toBe('error')
    }
    // Unrelated escrow events must not feed app peers or greetings.
    r.emit(5, 'mistl-daemon', new Uint8Array(), 'escrow-only')
    r.emit(6, 'mistl-daemon', new Uint8Array(), 'escrow-only')
    r.emit(0, 'mistl-daemon', new TextEncoder().encode(JSON.stringify({ type: 'hello', from: 'mistl-daemon', roomId: 'app-A', sentAt: '2026-10-12T00:00:00.000Z', clock: 1 })), 'escrow-only')
    await vi.advanceTimersByTimeAsync(3100)
    expect(onEnvelope).not.toHaveBeenCalled()
    expect(h.state.messagesReceived).toBe(0)
    expect.soft(h.state.peers).not.toContain('mistl-daemon')
    expect(r.sent.filter(
      s => s.payload.type === 'hello' && s.to === 'mistl-daemon',
    )).toEqual([])
  },
)

it.each([false, true])(
  'disconnect cleanup respects the current session (new connection during flush: %s)',
  async reconnect => {
    const r = runtime()
    let release!: () => void
    const flushing = new Promise<void>(resolve => { release = resolve })
    const network = useMistShare(settings, ['app-A'], () => {}, () => flushing)
    await network.connect()
    expect(h.state.mode).toBe('mistlib')
    network.disconnect() // Begins a pending escrow flush.
    if (reconnect) {
      await network.connect() // A reconnect/settings change finishes first.
      expect(h.state.mode).toBe('mistlib')
      expect(r.joined.has('app-A')).toBe(true)
    }
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    cleanups.push(() => network.disconnect(true))
    expect.soft(h.state.mode).toBe(reconnect ? 'mistlib' : 'idle')
    expect(r.joined.has('app-A')).toBe(reconnect)
  },
)

it.each(['home', 'joined', 'shared-folder'])(
  'rejects a Custom room colliding with a %s app room before acquiring a lease',
  async source => {
    const r = runtime()
    const appRooms = source === 'shared-folder' ? ['app-A'] : ['app-A', 'app-B']
    const snapshot = {
      folders: [{ ...makeFolder({ id: 'other', name: 'Other', parentId: null, color: 'teal', roomId: 'app-B', now: '2026-10-12T00:00:00.000Z', nodeId: settings.nodeId }), shareEnabled: true }],
      files: [], activity: [], clock: 1, originNode: settings.nodeId,
    }
    if (source !== 'shared-folder') snapshot.folders = []
    const controller = new FolderEscrowController({
      folderId: 'root', key: 'secret', appRoom: 'app-A', nodeId: settings.nodeId,
      appRoomIds: () => appRooms, setting: { mode: 'custom', room: 'app-B' }, snapshot: () => snapshot,
      merge: () => {}, readFile: async () => new Uint8Array(), changed: () => {},
      transport: provider => createMistEscrowTransport(settings.nodeId, provider, async () => h.api),
    })
    cleanups.push(() => controller.dispose())
    await controller.start()
    expect(controller.view.status).toBe('error')
    expect(controller.view.reason).toContain('app-B')
    expect(r.joined.size).toBe(0)
    expect(r.sent).toEqual([])
  },
)

it.each(['joined', 'shared-folder'])(
  'stops and releases an existing escrow lease when a %s room is added later',
  async source => {
    const r = runtime()
    const appRooms = ['app-A']
    const snapshot = { folders: [] as ReturnType<typeof makeFolder>[], files: [], activity: [], clock: 1, originNode: settings.nodeId }
    const controller = new FolderEscrowController({
      folderId: 'root', key: 'secret', appRoom: 'app-A', nodeId: settings.nodeId,
      appRoomIds: () => appRooms, setting: { mode: 'custom', room: 'app-B' }, snapshot: () => snapshot,
      merge: () => {}, readFile: async () => new Uint8Array(), changed: () => {},
      transport: provider => createMistEscrowTransport(settings.nodeId, provider, async () => h.api),
      loadLocal: () => ({ lastSeq: 0, lastHash: null, providerSeen: false, savedAt: 0 }), persist: () => {},
    })
    cleanups.push(() => controller.dispose())
    await controller.start()
    expect(r.joined.has('app-B')).toBe(true)
    if (source === 'joined') appRooms.push('app-B')
    else snapshot.folders.push({ ...makeFolder({ id: 'other', name: 'Other', parentId: null, color: 'teal', roomId: 'app-B', now: '2026-10-12T00:00:00.000Z', nodeId: settings.nodeId }), shareEnabled: true })
    controller.observe()
    expect(controller.view.status).toBe('error')
    expect(controller.view.reason).toContain('app room')
    expect(r.joined.has('app-B')).toBe(false)
    const count = r.sent.length
    await controller.flush()
    expect(r.sent).toHaveLength(count)
    expect(controller.view.status).toBe('error')
  },
)

it('releases a pending join if a room collision appears before join completion', async () => {
  const r = runtime()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  h.api.join_room_async = async room => { await pending; r.joined.add(room) }
  const appRooms = ['app-A']
  const controller = new FolderEscrowController({
    folderId: 'root', key: 'secret', appRoom: 'app-A', nodeId: settings.nodeId,
    appRoomIds: () => appRooms, setting: { mode: 'custom', room: 'app-B' },
    snapshot: () => ({ folders: [], files: [], activity: [], clock: 1, originNode: settings.nodeId }),
    merge: () => {}, readFile: async () => new Uint8Array(), changed: () => {},
    transport: provider => createMistEscrowTransport(settings.nodeId, provider, async () => h.api),
    loadLocal: () => ({ lastSeq: 0, lastHash: null, providerSeen: false, savedAt: 0 }), persist: () => {},
  })
  cleanups.push(() => controller.dispose())
  const starting = controller.start()
  await new Promise(resolve => setTimeout(resolve, 0))
  appRooms.push('app-B')
  controller.observe()
  release()
  await starting
  expect(controller.view.status).toBe('error')
  expect(r.joined.has('app-B')).toBe(false)
  expect(r.left).toContain('app-B')
})

it('applies runtime collision policy to the derived Auto room as well', async () => {
  const r = runtime()
  const room = await deriveAutoRoom(APP, folderInput('root', 'secret'))
  const controller = new FolderEscrowController({
    folderId: 'root', key: 'secret', appRoom: 'app-A', nodeId: settings.nodeId,
    appRoomIds: () => ['app-A', room], setting: { mode: 'auto', room: '' },
    snapshot: () => ({ folders: [], files: [], activity: [], clock: 1, originNode: settings.nodeId }),
    merge: () => {}, readFile: async () => new Uint8Array(), changed: () => {},
    transport: provider => createMistEscrowTransport(settings.nodeId, provider, async () => h.api),
  })
  cleanups.push(() => controller.dispose())
  await controller.start()
  expect(controller.view.room).toBe(room)
  expect(controller.view.status).toBe('error')
  expect(r.joined.size).toBe(0)
})

it('collision cleanup releases escrow owners while retaining the app room lease', async () => {
  const r = runtime()
  const appRooms = ['app-A']
  const controller = new FolderEscrowController({
    folderId: 'root', key: 'secret', appRoom: 'app-A', nodeId: settings.nodeId,
    appRoomIds: () => appRooms, setting: { mode: 'custom', room: 'app-B' },
    snapshot: () => ({ folders: [], files: [], activity: [], clock: 1, originNode: settings.nodeId }),
    merge: () => {}, readFile: async () => new Uint8Array(), changed: () => {},
    transport: provider => createMistEscrowTransport(settings.nodeId, provider, async () => h.api),
    loadLocal: () => ({ lastSeq: 0, lastHash: null, providerSeen: false, savedAt: 0 }), persist: () => {},
  })
  cleanups.push(() => controller.dispose())
  await controller.start()
  const appOwner = Symbol('app connection')
  const broker = mistRuntime(h.api)
  await broker.acquire('app-B', appOwner)
  cleanups.push(() => broker.releaseOwner(appOwner))
  appRooms.push('app-B')
  controller.observe()
  expect(controller.view.status).toBe('error')
  expect(r.joined.has('app-B')).toBe(true)
  broker.releaseOwner(appOwner)
  expect(r.joined.has('app-B')).toBe(false)
})
