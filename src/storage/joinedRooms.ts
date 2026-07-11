export type JoinedRoom = {
  roomId: string
  label: string
  joinedAt: string
}

const joinedRoomsKey = 'tc-storage-joined-rooms-v1'
const maxJoinedRooms = 20

export function loadJoinedRooms(): JoinedRoom[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(joinedRoomsKey) ?? '[]') as unknown
    return normalizeJoinedRooms(parsed)
  } catch {
    return []
  }
}

export function saveJoinedRooms(rooms: JoinedRoom[]): void {
  localStorage.setItem(joinedRoomsKey, JSON.stringify(normalizeJoinedRooms(rooms)))
}

/** Adds (or refreshes) a joined room, keeping the most recently joined rooms first. Never tracks `ownRoomId` itself. */
export function upsertJoinedRoom(rooms: JoinedRoom[], room: JoinedRoom, ownRoomId: string): JoinedRoom[] {
  if (room.roomId === ownRoomId) return rooms
  const withoutExisting = rooms.filter((item) => item.roomId !== room.roomId)
  return [room, ...withoutExisting].slice(0, maxJoinedRooms)
}

export function removeJoinedRoom(rooms: JoinedRoom[], roomId: string): JoinedRoom[] {
  return rooms.filter((item) => item.roomId !== roomId)
}

/** The room ids the app should maintain connectivity with: the user's own room first, then joined rooms (deduplicated). */
export function roomIdsToMaintain(ownRoomId: string, rooms: JoinedRoom[]): string[] {
  const seen = new Set<string>([ownRoomId])
  const ids = [ownRoomId]
  for (const room of rooms) {
    if (seen.has(room.roomId)) continue
    seen.add(room.roomId)
    ids.push(room.roomId)
  }
  return ids
}

function normalizeJoinedRooms(value: unknown): JoinedRoom[] {
  if (!Array.isArray(value)) return []
  const rooms: JoinedRoom[] = []
  for (const entry of value) {
    const candidate = entry as Partial<JoinedRoom> | null
    const roomId = candidate?.roomId?.trim()
    if (!roomId) continue
    rooms.push({
      roomId,
      label: candidate?.label?.trim() || roomId,
      joinedAt: typeof candidate?.joinedAt === 'string' ? candidate.joinedAt : new Date().toISOString(),
    })
  }
  return rooms.slice(0, maxJoinedRooms)
}
