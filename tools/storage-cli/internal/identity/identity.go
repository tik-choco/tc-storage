// Package identity persists the CLI's Ed25519 did:key identity so the node
// keeps a stable signed identity across runs (required for signing share
// envelopes that the web app verifies).
package identity

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"

	"tc-storage-cli/internal/protocol"
)

type storedIdentity struct {
	Did  string `json:"did"`
	Seed string `json:"seed"` // base64 std of the 32-byte Ed25519 seed
}

// LoadOrCreate returns the identity stored at path, minting and persisting a new
// one if none exists or the stored value is invalid.
func LoadOrCreate(path string) (protocol.DidIdentity, error) {
	if id, ok := load(path); ok {
		return id, nil
	}
	id, err := protocol.GenerateDidIdentity()
	if err != nil {
		return protocol.DidIdentity{}, err
	}
	if err := save(path, id); err != nil {
		return protocol.DidIdentity{}, err
	}
	return id, nil
}

func load(path string) (protocol.DidIdentity, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return protocol.DidIdentity{}, false
	}
	var stored storedIdentity
	if err := json.Unmarshal(data, &stored); err != nil {
		return protocol.DidIdentity{}, false
	}
	seed, err := base64.StdEncoding.DecodeString(stored.Seed)
	if err != nil {
		return protocol.DidIdentity{}, false
	}
	id, err := protocol.NewDidIdentityFromSeed(seed)
	if err != nil || id.Did != stored.Did {
		return protocol.DidIdentity{}, false
	}
	return id, true
}

func save(path string, id protocol.DidIdentity) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(storedIdentity{
		Did:  id.Did,
		Seed: base64.StdEncoding.EncodeToString(id.Seed()),
	})
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}
