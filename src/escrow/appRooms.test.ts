import { beforeEach, expect, it, vi } from 'vitest'
import type { VNode } from 'preact'
import { FolderEscrowSettings } from '../components/FolderEscrowSettings'
import { makeFolder } from '../storage/domain'
import { customEscrowRoomError, escrowAppRooms } from './appRooms'
import { escrowMessages } from './i18n'

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
vi.mock('preact/hooks', async importOriginal => ({
  ...await importOriginal<typeof import('preact/hooks')>(),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = next }]
  },
}))
beforeEach(() => { hooks.values = []; hooks.cursor = 0 })
const folder = () => makeFolder({ id: 'root', name: 'Root', parentId: null, color: 'teal', roomId: 'folder-room', now: '2026-10-12T00:00:00.000Z', nodeId: 'node-a' })
function nodes(value: unknown): VNode<any>[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const node = value as VNode<any>
  return [node, ...nodes(node.props.children)]
}
it('includes home, joined and all retained shared folder IDs, with exact case-sensitive comparison', () => {
  const folders = [folder(), { ...folder(), sharedRoomId: 'unjoined-room', shareEnabled: false }]
  const rooms = escrowAppRooms(['home-room', 'joined-room', 'home-room'], folders)
  expect(rooms).toEqual(['folder-room', 'home-room', 'joined-room', 'unjoined-room'])
  expect(customEscrowRoomError('Home-room', rooms)).toBeUndefined()
  expect(customEscrowRoomError('bad room', rooms)).toBe('invalidRoom')
})
it.each(['home-room', 'joined-room', 'folder-room', 'unjoined-room'])(
  'Custom UI rejects collision with %s and shows a clear reason', room => {
    const onChange = vi.fn()
    const props = {
      folder: { ...folder(), escrow: { mode: 'custom' as const, room } },
      appRoomIds: escrowAppRooms(['home-room', 'joined-room'], [folder(), { ...folder(), sharedRoomId: 'unjoined-room' }]),
      onChange, onCopy: () => {},
    }
    const render = () => { hooks.cursor = 0; return nodes(FolderEscrowSettings(props)) }
    render().find(node => node.type === 'button' && node.props.children === escrowMessages().apply)!.props.onClick()
    expect(onChange).not.toHaveBeenCalled()
    expect(render().find(node => node.props.role === 'alert')?.props.children).toBe(escrowMessages().roomCollision)
  },
)
it('Custom UI accepts a separate valid room', () => {
  const onChange = vi.fn()
  const tree = nodes(FolderEscrowSettings({ folder: { ...folder(), escrow: { mode: 'custom', room: 'escrow-room' } }, appRoomIds: ['folder-room'], onChange, onCopy: () => {} }))
  tree.find(node => node.type === 'button' && node.props.children === escrowMessages().apply)!.props.onClick()
  expect(onChange).toHaveBeenCalledWith({ mode: 'custom', room: 'escrow-room' })
})
it.each(['en', 'ja', 'zh-CN', 'zh-TW'])('provides the room collision message in %s', locale => {
  expect(escrowMessages(locale).roomCollision).toBeTruthy()
})
