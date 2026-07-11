package app

import "testing"

// These expected values are computed by the web app's positionForSharedRoom
// (src/p2p/p2pMist.ts) and reproduced independently (FNV-1a + coordinateFromHash)
// to lock the CLI onto the same AOI overlay coordinate. Peer connections only
// form once both nodes are positioned identically, so any drift here is exactly
// the bug that prevented web<->CLI connection.
func TestPositionForSharedRoomMatchesWebApp(t *testing.T) {
	cases := []struct {
		name    string
		room    string
		node    string
		x, y, z float32
	}{
		{
			name: "room and node",
			room: "tc-storage-fixture-room",
			node: "did:key:zFixtureNode",
			x:    438.0361, y: 56.9595, z: 199.9892,
		},
		{
			name: "room only (no node offset)",
			room: "tc-storage-main",
			node: "",
			// base = hash(room:axis) % 1000, no node offset.
			x: float32(hashString("tc-storage-main:x") % 1000),
			y: float32(hashString("tc-storage-main:y") % 1000),
			z: float32(hashString("tc-storage-main:z") % 1000),
		},
		{
			name: "empty room falls back to tc-storage-main",
			room: "   ",
			node: "",
			x:    float32(hashString("tc-storage-main:x") % 1000),
			y:    float32(hashString("tc-storage-main:y") % 1000),
			z:    float32(hashString("tc-storage-main:z") % 1000),
		},
	}

	const eps = 0.001
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			x, y, z := positionForSharedRoom(tc.room, tc.node)
			if diff := absf(x - tc.x); diff > eps {
				t.Errorf("x = %v, want %v (diff %v)", x, tc.x, diff)
			}
			if diff := absf(y - tc.y); diff > eps {
				t.Errorf("y = %v, want %v (diff %v)", y, tc.y, diff)
			}
			if diff := absf(z - tc.z); diff > eps {
				t.Errorf("z = %v, want %v (diff %v)", z, tc.z, diff)
			}
		})
	}
}

// TestHashStringFNV1a pins the hash to the known FNV-1a 32-bit output so the
// algorithm cannot silently diverge from the web app's implementation.
func TestHashStringFNV1a(t *testing.T) {
	// FNV-1a 32-bit of "x" over a single byte 0x78.
	if got := hashString("x"); got != 0xfd0c5087 {
		t.Fatalf("hashString(\"x\") = %#x, want 0xfd0c5087", got)
	}
}

func absf(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}
