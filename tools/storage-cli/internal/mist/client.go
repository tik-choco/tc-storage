package mist

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// LogFunc receives mistlib log lines (level is the native log level).
type LogFunc func(level uint32, message string)

// EventFunc receives mistlib events (peer join/leave, neighbors, raw messages).
type EventFunc func(eventType uint32, from string, data []byte)

type Client interface {
	Init(ctx context.Context, nodeID string, config string) error
	JoinRoom(ctx context.Context, roomID string) error
	UpdatePosition(ctx context.Context, x, y, z float32) error
	SendMessage(ctx context.Context, targetID string, data []byte, method int) error
	StorageAdd(ctx context.Context, name string, data []byte) (string, error)
	StorageGet(ctx context.Context, cid string) ([]byte, error)
	// Stats returns the engine stats JSON (EngineStats, camelCase). The local
	// backend returns an empty node list.
	Stats(ctx context.Context) ([]byte, error)
	// Networked reports whether the backend talks to real peers. The local
	// store backend returns false so callers can skip peer-connection waits.
	Networked() bool
	// SetLogCallback / SetEventCallback install verbose observers. Must be set
	// before Init so native registration happens before the engine starts.
	SetLogCallback(fn LogFunc)
	SetEventCallback(fn EventFunc)
}

type LocalClient struct {
	root string
}

func NewLocalClient(root string) *LocalClient {
	return &LocalClient{root: root}
}

func (c *LocalClient) Init(context.Context, string, string) error {
	return os.MkdirAll(c.root, 0o700)
}

func (c *LocalClient) JoinRoom(context.Context, string) error {
	return nil
}

func (c *LocalClient) UpdatePosition(context.Context, float32, float32, float32) error {
	return nil
}

func (c *LocalClient) Stats(context.Context) ([]byte, error) {
	return []byte(`{"nodes":[]}`), nil
}

func (c *LocalClient) Networked() bool { return false }

// SetLogCallback / SetEventCallback are no-ops: the local store emits no mist
// logs or peer events.
func (c *LocalClient) SetLogCallback(LogFunc)     {}
func (c *LocalClient) SetEventCallback(EventFunc) {}

func (c *LocalClient) SendMessage(context.Context, string, []byte, int) error {
	return nil
}

func (c *LocalClient) StorageAdd(_ context.Context, name string, data []byte) (string, error) {
	if err := os.MkdirAll(c.root, 0o700); err != nil {
		return "", err
	}
	sum := sha256.Sum256(append([]byte(name), data...))
	cid := "local-" + hex.EncodeToString(sum[:])
	if err := os.WriteFile(filepath.Join(c.root, cid+".bin"), data, 0o600); err != nil {
		return "", err
	}
	return cid, nil
}

func (c *LocalClient) StorageGet(_ context.Context, cid string) ([]byte, error) {
	if cid == "" || filepath.Base(cid) != cid {
		return nil, fmt.Errorf("invalid cid")
	}
	return os.ReadFile(filepath.Join(c.root, cid+".bin"))
}
