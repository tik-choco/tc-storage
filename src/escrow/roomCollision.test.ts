import { afterEach, expect, it, vi } from 'vitest'
import { useMistShare } from '../p2p/p2p'
import { FolderEscrowController } from '../app/folderEscrowController'
import { createMistEscrowTransport } from '../escrow/mistTransport'
import { encodeEscrowMessage, parseEscrowMessage } from '../escrow/protocol'
import { makeFolder } from '../storage/domain'
import type { MistModule, NetworkState } from '../p2p/p2pTypes'

const h = vi.hoisted(() => ({ api: null as unknown as MistModule,
  state: null as unknown as NetworkState }))
vi.mock('preact/hooks', () => ({
  useRef: (current: unknown) => ({ current }), useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useState: (initial: NetworkState) => {
    h.state = initial
    return [initial, (next: NetworkState | ((old: NetworkState) => NetworkState)) => {
      h.state = typeof next === 'function' ? next(h.state) : next
    }]
  },
}))
vi.mock('../storage/mistStorage', () => ({
  loadMistModule: async () => h.api, ensureMistRuntimeInitialized: () => {},
}))
vi.mock('../p2p/p2pEnvelope', async original => ({
  ...await original<typeof import('../p2p/p2pEnvelope')>(),
  signShareEnvelope: async (value: unknown) => value,
}))
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals()
})
it.each([false, true])('collision yields escrow before app join, then uses ordinary app peers (collision: %s)', async collision => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval })
  let emit: (...args: unknown[]) => void = () => {}
  const joined = new Set<string>(), providers = new Set<string>()
  const sent: { room: string; to: string; type: string }[] = []
  h.api = {
    register_event_callback: (cb: typeof emit) => { emit = cb },
    join_room_async: async (room: string) => { joined.add(room) },
    leave_room_id: (room: string) => { joined.delete(room) },
    update_position_in_room: () => {},
    get_neighbors_in_room: (room: string) => JSON.stringify(
      joined.has(room) && providers.has(room) ? ['mistl-daemon'] : []),
    send_message_in_room: (room: string, to: string, bytes: Uint8Array) => {
      sent.push({ room, to, type: JSON.parse(new TextDecoder().decode(bytes)).type })
      const request = parseEscrowMessage(bytes)
      if (request?.type === 'escrow_hello') {
        providers.add(room)
        emit(0, 'mistl-daemon', encodeEscrowMessage({ v: 1,
          type: 'escrow_provider', version: 1, maxBlob: 32 * 1024 * 1024 }), room)
      }
      if (request?.type === 'escrow_get') emit(0, 'mistl-daemon',
        encodeEscrowMessage({ v: 1, type: 'escrow_head', id: request.id,
          slot: request.slot, head: null }), room)
    },
  } as unknown as MistModule
  const settings = { nodeId: 'did:key:z6MkvTZ4FTCtXPiZ7M6MQoFNGgXYhEyX65Y5C6HQ8GFsv24w',
    roomId: 'app-A', autoConnect: false, profileName: 'review',
    avatarUrl: '', avatarFileId: '', identity: null }
  const appRooms = ['app-A']
  const folder = { ...makeFolder({ id: 'root', name: 'Root', parentId: null,
    color: 'teal', roomId: 'app-A', now: '2026-10-12T00:00:00.000Z',
    nodeId: settings.nodeId }), shareEnabled: true }
  const controller = new FolderEscrowController({
    folderId: 'root', key: 'secret', appRoom: 'app-A',
    appRoomIds: () => appRooms, nodeId: settings.nodeId,
    setting: { mode: 'custom', room: 'app-B' },
    snapshot: () => ({ folders: [folder], files: [], activity: [], clock: 1, originNode: 'a' }),
    merge: () => {}, readFile: async () => new Uint8Array(), changed: () => {},
    transport: p => createMistEscrowTransport(settings.nodeId, p, async () => h.api),
    loadLocal: () => ({ lastSeq: 0, lastHash: null, providerSeen: false, savedAt: 0 }),
    persist: () => {},
  })
  cleanup.push(() => controller.dispose())
  await controller.start()
  expect(joined.has('app-B')).toBe(true)
  if (collision) appRooms.push('app-B')
  // Acquire app leases, then run the controller's late-collision guard.
  const joinRoom = h.api.join_room_async
  h.api.join_room_async = async (room: string) => {
    if (collision && room === 'app-B') {
      expect(controller.view.status).toBe('error')
      expect(controller.view.reason).toContain('conflicts with an app room')
      expect(joined.has('app-B')).toBe(false)
    }
    await joinRoom(room)
  }
  const network = useMistShare(settings, [...appRooms], () => {})
  await network.connect()
  cleanup.push(() => network.disconnect(true))
  // Collision must be terminal immediately; no observe/poll is needed.
  if (collision) expect(controller.view.status).toBe('error')
  controller.observe()
  await vi.advanceTimersByTimeAsync(3100)
  if (collision) {
    expect(h.state.peers).toContain('mistl-daemon')
    expect(sent.some(s => s.type === 'hello' && s.to === 'mistl-daemon')).toBe(true)
  } else {
    expect(h.state.peers).not.toContain('mistl-daemon')
    expect(sent.filter(s => s.type === 'hello' && s.to === 'mistl-daemon')).toEqual([])
  }
  expect(sent.some(s => s.type.startsWith('app-membership-'))).toBe(false)
})
