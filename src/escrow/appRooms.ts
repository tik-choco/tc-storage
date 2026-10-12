import type { FolderRecord } from '../storage/domain.js'

/** Include retained folder room IDs even when their room is not currently joined. */
export function escrowAppRooms(roomIds: readonly string[], folders: readonly FolderRecord[]): string[] {
  return [...new Set([...roomIds, ...folders.map((folder) => folder.sharedRoomId ?? '')].filter(Boolean))].sort()
}

export function customEscrowRoomError(room: string, appRooms: readonly string[]): 'invalidRoom' | 'roomCollision' | undefined {
  if (!/^[A-Za-z0-9_./:-]{1,96}$/.test(room)) return 'invalidRoom'
  if (appRooms.includes(room)) return 'roomCollision'
}
