package app

import "strings"

// positionForSharedRoom mirrors src/p2p/p2pMist.ts exactly so the CLI lands on
// the same AOI overlay coordinate as the web app for a given room. Peer
// connections only form once a node is positioned, so this must stay in sync.
func positionForSharedRoom(roomID, nodeID string) (x, y, z float32) {
	normalized := strings.TrimSpace(roomID)
	if normalized == "" {
		normalized = "tc-storage-main"
	}
	node := strings.TrimSpace(nodeID)

	var nodeX, nodeY, nodeZ *uint32
	if node != "" {
		hx := hashString(node + ":x")
		hy := hashString(node + ":y")
		hz := hashString(node + ":z")
		nodeX, nodeY, nodeZ = &hx, &hy, &hz
	}

	x = coordinateFromHash(hashString(normalized+":x"), nodeX)
	y = coordinateFromHash(hashString(normalized+":y"), nodeY)
	z = coordinateFromHash(hashString(normalized+":z"), nodeZ)
	return x, y, z
}

func coordinateFromHash(roomHash uint32, nodeHash *uint32) float32 {
	base := float64(roomHash % 1000)
	offset := 0.0
	if nodeHash != nil {
		offset = (float64(*nodeHash%2001) - 1000) / 10000
	}
	value := base + offset
	if value > 999.999 {
		value = 999.999
	}
	if value < 0 {
		value = 0
	}
	return float32(value)
}

// hashString is the FNV-1a 32-bit variant used by the web app (Math.imul wraps
// at 32 bits; room/node ids are ASCII so byte iteration matches charCodeAt).
func hashString(value string) uint32 {
	var hash uint32 = 2166136261
	for i := 0; i < len(value); i++ {
		hash ^= uint32(value[i])
		hash *= 16777619
	}
	return hash
}
