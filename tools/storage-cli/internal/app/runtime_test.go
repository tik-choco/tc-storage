package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"tc-storage-cli/internal/domain"
	"tc-storage-cli/internal/mist"
	"tc-storage-cli/internal/protocol"
)

func TestRuntimePutGetFile(t *testing.T) {
	root := t.TempDir()
	rt, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox"),
		StoreRoot:   filepath.Join(root, "store"),
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        mist.NewLocalClient(filepath.Join(root, "store")),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "source.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := rt.Sandbox.ImportFile(filepath.Join(root, "source.txt")); err != nil {
		t.Fatal(err)
	}
	cid, err := rt.PutFile(context.Background(), "source.txt", "secret")
	if err != nil {
		t.Fatal(err)
	}
	file, err := rt.GetFile(context.Background(), cid, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if file.Name != "source.txt" || file.Size != 5 || file.DataURL == "" {
		t.Fatalf("unexpected file: %+v", file)
	}
}

func TestRuntimeContentSyncRemembersRemoteFileMetadata(t *testing.T) {
	root := t.TempDir()
	client := newSyncTestClient(filepath.Join(root, "store"))
	rt, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox"),
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := rt.StartContentSync(ctx)

	client.emit(t, signedEnvelope(t, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		SentAt:     time.Now().UTC().Format(time.RFC3339Nano),
		ChangeType: "file-upserted",
		FolderID:   "folder-1",
		FolderName: "Shared",
		FileID:     "file-1",
		FileName:   "hello.txt",
		CID:        "cid-1",
		File:       &domain.FileRecord{ID: "file-1", FolderID: "folder-1", Name: "hello.txt", Size: 5, LastCID: "cid-1"},
	}))

	event := waitSyncEvent(t, events)
	if event.File.Name != "hello.txt" || event.File.CID != "cid-1" {
		t.Fatalf("unexpected sync event: %+v", event)
	}
	files := rt.RemoteFiles()
	if len(files) != 1 || files[0].Name != "hello.txt" || files[0].FolderName != "Shared" {
		t.Fatalf("remote files not remembered: %+v", files)
	}
}

func TestRuntimeContentSyncFetchesKnownFolderFile(t *testing.T) {
	root := t.TempDir()
	client := newSyncTestClient(filepath.Join(root, "store"))
	rt, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox"),
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	folderKey := "folder-passphrase"
	rt.rememberFolderKey("folder-1", folderKey)
	cid := storeEncryptedFileBundle(t, client, folderKey, domain.FileRecord{
		ID:       "file-1",
		FolderID: "folder-1",
		Name:     "hello.txt",
		Size:     5,
		DataURL:  dataURL("text/plain", []byte("hello")),
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := rt.StartContentSync(ctx)
	client.emit(t, signedEnvelope(t, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		SentAt:     time.Now().UTC().Format(time.RFC3339Nano),
		ChangeType: "file-upserted",
		FolderID:   "folder-1",
		FolderName: "Shared",
		FileID:     "file-1",
		FileName:   "hello.txt",
		CID:        cid,
		File:       &domain.FileRecord{ID: "file-1", FolderID: "folder-1", Name: "hello.txt", Size: 5, LastCID: cid},
	}))

	waitSyncEvent(t, events) // metadata event
	event := waitSyncEvent(t, events)
	if event.Err != nil {
		t.Fatal(event.Err)
	}
	if event.File.SyncedPath != "Shared/hello.txt" {
		t.Fatalf("synced path = %q", event.File.SyncedPath)
	}
	data, _, err := rt.Sandbox.ReadFile("Shared/hello.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" {
		t.Fatalf("synced data = %q", data)
	}
}

func TestRuntimeFolderStatePreservesNestedFolderStructure(t *testing.T) {
	root := t.TempDir()
	client := newSyncTestClient(filepath.Join(root, "store"))
	rt, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox"),
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	folderKey := "folder-passphrase"
	rt.rememberFolderKey("folder-root", folderKey)
	fileCID := storeEncryptedFileBundle(t, client, folderKey, domain.FileRecord{
		ID:       "file-logo",
		FolderID: "folder-child",
		Name:     "logo.png",
		Size:     4,
		DataURL:  dataURL("image/png", []byte("logo")),
	})
	rootID := "folder-root"
	bundleCID := storeEncryptedFolderBundle(t, client, folderKey, domain.FolderBundle{
		Version:    1,
		ExportedAt: time.Now().UTC().Format(time.RFC3339Nano),
		OriginNode: "peer",
		Folder:     domain.FolderRecord{ID: rootID, Name: "Shared", CreatedAt: "now", UpdatedAt: "now"},
		Folders: []domain.FolderRecord{
			{ID: rootID, Name: "Shared", CreatedAt: "now", UpdatedAt: "now"},
			{ID: "folder-child", Name: "Assets", ParentID: &rootID, CreatedAt: "now", UpdatedAt: "now"},
		},
		Files: []domain.FileRecord{{ID: "file-logo", FolderID: "folder-child", Name: "logo.png", Size: 4, LastCID: fileCID}},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := rt.StartContentSync(ctx)
	client.emit(t, signedEnvelope(t, protocol.ShareEnvelope{
		Type:       "folder-state",
		RoomID:     "room-1",
		SentAt:     time.Now().UTC().Format(time.RFC3339Nano),
		FolderID:   rootID,
		FolderName: "Shared",
		CID:        bundleCID,
	}))

	event := waitSyncEvent(t, events)
	if event.Err != nil {
		t.Fatal(event.Err)
	}
	if len(event.Result.Files) != 1 || event.Result.Files[0] != "Shared/Assets/logo.png" {
		t.Fatalf("result files = %+v", event.Result.Files)
	}
	data, _, err := rt.Sandbox.ReadFile("Shared/Assets/logo.png")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "logo" {
		t.Fatalf("synced data = %q", data)
	}
	files := rt.RemoteFiles()
	if len(files) != 1 || files[0].Path != "Shared/Assets/logo.png" {
		t.Fatalf("remote path not remembered: %+v", files)
	}
}

func TestRuntimeFolderStateReconcilesOfflineDeletes(t *testing.T) {
	root := t.TempDir()
	client := newSyncTestClient(filepath.Join(root, "store"))
	rt, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox"),
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	folderKey := "folder-passphrase"
	rootID := "folder-root"
	rt.rememberFolderKey(rootID, folderKey)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := rt.StartContentSync(ctx)

	// First folder-state: two files synced while we were online.
	keepCID := storeEncryptedFileBundle(t, client, folderKey, domain.FileRecord{
		ID: "file-keep", FolderID: rootID, Name: "keep.txt", Size: 4, DataURL: dataURL("text/plain", []byte("keep")),
	})
	goneCID := storeEncryptedFileBundle(t, client, folderKey, domain.FileRecord{
		ID: "file-gone", FolderID: rootID, Name: "gone.txt", Size: 4, DataURL: dataURL("text/plain", []byte("gone")),
	})
	bundleCID := storeEncryptedFolderBundle(t, client, folderKey, domain.FolderBundle{
		Version: 1, ExportedAt: time.Now().UTC().Format(time.RFC3339Nano), OriginNode: "peer",
		Folder:  domain.FolderRecord{ID: rootID, Name: "Shared", CreatedAt: "now", UpdatedAt: "now"},
		Folders: []domain.FolderRecord{{ID: rootID, Name: "Shared", CreatedAt: "now", UpdatedAt: "now"}},
		Files: []domain.FileRecord{
			{ID: "file-keep", FolderID: rootID, Name: "keep.txt", Size: 4, LastCID: keepCID},
			{ID: "file-gone", FolderID: rootID, Name: "gone.txt", Size: 4, LastCID: goneCID},
		},
	})
	client.emit(t, signedEnvelope(t, protocol.ShareEnvelope{
		Type: "folder-state", RoomID: "room-1", SentAt: time.Now().UTC().Format(time.RFC3339Nano),
		FolderID: rootID, FolderName: "Shared", CID: bundleCID,
	}))
	if event := waitSyncEvent(t, events); event.Err != nil {
		t.Fatal(event.Err)
	}
	if _, _, err := rt.Sandbox.ReadFile("Shared/gone.txt"); err != nil {
		t.Fatalf("gone.txt should have been synced first: %v", err)
	}

	// While we were offline a peer deleted gone.txt. On reconnect the peer
	// republishes the authoritative folder-state, now omitting that file.
	bundleCID2 := storeEncryptedFolderBundle(t, client, folderKey, domain.FolderBundle{
		Version: 2, ExportedAt: time.Now().UTC().Format(time.RFC3339Nano), OriginNode: "peer",
		Folder:  domain.FolderRecord{ID: rootID, Name: "Shared", CreatedAt: "now", UpdatedAt: "later"},
		Folders: []domain.FolderRecord{{ID: rootID, Name: "Shared", CreatedAt: "now", UpdatedAt: "later"}},
		Files: []domain.FileRecord{
			{ID: "file-keep", FolderID: rootID, Name: "keep.txt", Size: 4, LastCID: keepCID},
		},
	})
	client.emit(t, signedEnvelope(t, protocol.ShareEnvelope{
		Type: "folder-state", RoomID: "room-1", SentAt: time.Now().UTC().Format(time.RFC3339Nano),
		FolderID: rootID, FolderName: "Shared", CID: bundleCID2,
	}))
	if event := waitSyncEvent(t, events); event.Err != nil {
		t.Fatal(event.Err)
	}

	for _, f := range rt.RemoteFiles() {
		if f.FileID == "file-gone" {
			t.Fatalf("offline-deleted file still tracked after folder-state reconcile: %+v", rt.RemoteFiles())
		}
	}
	if _, _, err := rt.Sandbox.ReadFile("Shared/gone.txt"); !os.IsNotExist(err) {
		t.Fatalf("offline-deleted file should be removed from sandbox: %v", err)
	}
	if _, _, err := rt.Sandbox.ReadFile("Shared/keep.txt"); err != nil {
		t.Fatalf("surviving file should remain: %v", err)
	}
}

func TestRuntimeFolderChangesPreserveNestedRemotePath(t *testing.T) {
	root := t.TempDir()
	client := newSyncTestClient(filepath.Join(root, "store"))
	rt, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox"),
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	rootID := "folder-root"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := rt.StartContentSync(ctx)
	client.emit(t, signedEnvelope(t, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "folder-upserted",
		FolderID:   rootID,
		FolderName: "Shared",
		Folder:     &domain.FolderRecord{ID: rootID, Name: "Shared", CreatedAt: "now", UpdatedAt: "now"},
	}))
	waitSyncEvent(t, events)
	client.emit(t, signedEnvelope(t, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "folder-upserted",
		FolderID:   rootID,
		FolderName: "Shared",
		Folder:     &domain.FolderRecord{ID: "folder-child", Name: "Assets", ParentID: &rootID, CreatedAt: "now", UpdatedAt: "now"},
	}))
	waitSyncEvent(t, events)
	client.emit(t, signedEnvelope(t, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "file-upserted",
		FolderID:   rootID,
		FolderName: "Shared",
		FileID:     "file-logo",
		FileName:   "logo.png",
		CID:        "cid-logo",
		File:       &domain.FileRecord{ID: "file-logo", FolderID: "folder-child", Name: "logo.png", Size: 4, LastCID: "cid-logo"},
	}))

	event := waitSyncEvent(t, events)
	if event.File.Path != "Shared/Assets/logo.png" {
		t.Fatalf("remote path = %q", event.File.Path)
	}
}

func TestRuntimePersistsRemoteCatalogAcrossRestart(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "state.json")
	rootID := "folder-root"
	rt, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox-a"),
		StoreRoot:   filepath.Join(root, "store"),
		StatePath:   statePath,
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        mist.NewLocalClient(filepath.Join(root, "store")),
	})
	if err != nil {
		t.Fatal(err)
	}
	rt.rememberFolderKey(rootID, "folder-passphrase")
	rt.rememberRemoteFolder(domain.FolderRecord{ID: rootID, Name: "Shared", CreatedAt: "now", UpdatedAt: "now"})
	rt.rememberRemoteFolder(domain.FolderRecord{ID: "folder-child", Name: "Assets", ParentID: &rootID, CreatedAt: "now", UpdatedAt: "now"})
	rt.rememberRemoteFile(RemoteFile{FolderID: "folder-child", FileID: "file-logo", Name: "logo.png", CID: "cid-logo", Size: 4})

	restarted, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox-b"),
		StoreRoot:   filepath.Join(root, "store"),
		StatePath:   statePath,
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        mist.NewLocalClient(filepath.Join(root, "store")),
	})
	if err != nil {
		t.Fatal(err)
	}
	if restarted.folderKey(rootID) != "folder-passphrase" {
		t.Fatalf("folder key was not restored")
	}
	files := restarted.RemoteFiles()
	if len(files) != 1 || files[0].Path != "Shared/Assets/logo.png" {
		t.Fatalf("remote catalog was not restored: %+v", files)
	}
}

func TestRuntimeStoreLocalFilePublishesSharedFolderChange(t *testing.T) {
	root := t.TempDir()
	client := newSyncTestClient(filepath.Join(root, "store"))
	id, err := protocol.GenerateDidIdentity()
	if err != nil {
		t.Fatal(err)
	}
	rt, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox"),
		RoomID:      "room-1",
		Mist:        client,
		Identity:    id,
	})
	if err != nil {
		t.Fatal(err)
	}
	folderKey := "folder-passphrase"
	rt.rememberFolderKey("folder-root", folderKey)
	rt.rememberRemoteFolder(domain.FolderRecord{ID: "folder-root", Name: "Shared", CreatedAt: "now", UpdatedAt: "now"})
	if _, err := rt.writeSandboxFile("Shared/local.txt", []byte("hello")); err != nil {
		t.Fatal(err)
	}

	file, err := rt.StoreLocalFile(context.Background(), "Shared/local.txt")
	if err != nil {
		t.Fatal(err)
	}
	if file.SyncedPath != "Shared/local.txt" || file.CID == "" {
		t.Fatalf("unexpected stored file: %+v", file)
	}
	if len(client.sent) != 1 {
		t.Fatalf("sent messages = %d, want 1", len(client.sent))
	}
	env := client.sent[0]
	if env.Type != "folder-change" || env.ChangeType != "file-upserted" || env.FolderID != "folder-root" || env.File == nil {
		t.Fatalf("unexpected folder-change envelope: %+v", env)
	}
	if env.File.FolderID != "folder-root" || env.File.Name != "local.txt" || env.File.LastCID != file.CID || env.File.DataURL != "" {
		t.Fatalf("unexpected file metadata: %+v", env.File)
	}
	data, err := rt.fetchFileContent(context.Background(), file.CID, folderKey)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" {
		t.Fatalf("stored data = %q", data)
	}
}

func TestRuntimeDeleteLocalSharedFilePublishesFolderChange(t *testing.T) {
	root := t.TempDir()
	client := newSyncTestClient(filepath.Join(root, "store"))
	id, err := protocol.GenerateDidIdentity()
	if err != nil {
		t.Fatal(err)
	}
	rt, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox"),
		RoomID:      "room-1",
		Mist:        client,
		Identity:    id,
	})
	if err != nil {
		t.Fatal(err)
	}
	rt.rememberFolderKey("folder-root", "folder-passphrase")
	rt.rememberRemoteFolder(domain.FolderRecord{ID: "folder-root", Name: "Shared", ShareEnabled: true, CreatedAt: "now", UpdatedAt: "now"})
	rt.rememberRemoteFile(RemoteFile{FolderID: "folder-root", FileID: "file-local", Name: "local.txt", CID: "cid-local", Size: 5, Path: "Shared/local.txt", SyncedPath: "Shared/local.txt"})
	if _, err := rt.writeSandboxFile("Shared/local.txt", []byte("hello")); err != nil {
		t.Fatal(err)
	}

	result, err := rt.DeleteLocalPath(context.Background(), "Shared/local.txt")
	if err != nil {
		t.Fatal(err)
	}
	if result != "deleted Shared/local.txt" {
		t.Fatalf("delete result = %q", result)
	}
	if _, err := os.Stat(filepath.Join(root, "sandbox", "Shared", "local.txt")); !os.IsNotExist(err) {
		t.Fatalf("local file still exists or unexpected stat error: %v", err)
	}
	if len(client.sent) != 1 {
		t.Fatalf("sent messages = %d, want 1", len(client.sent))
	}
	env := client.sent[0]
	if env.Type != "folder-change" || env.ChangeType != "file-deleted" || env.FileID != "file-local" || env.File == nil || env.File.DeletedAt == "" {
		t.Fatalf("unexpected delete envelope: %+v", env)
	}
}

func TestRuntimeDeleteLocalSharedFolderPublishesFolderChange(t *testing.T) {
	root := t.TempDir()
	client := newSyncTestClient(filepath.Join(root, "store"))
	id, err := protocol.GenerateDidIdentity()
	if err != nil {
		t.Fatal(err)
	}
	rt, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox"),
		RoomID:      "room-1",
		Mist:        client,
		Identity:    id,
	})
	if err != nil {
		t.Fatal(err)
	}
	rootID := "folder-root"
	rt.rememberFolderKey(rootID, "folder-passphrase")
	rt.rememberRemoteFolder(domain.FolderRecord{ID: rootID, Name: "Shared", ShareEnabled: true, CreatedAt: "now", UpdatedAt: "now"})
	rt.rememberRemoteFolder(domain.FolderRecord{ID: "folder-child", Name: "Child", ParentID: &rootID, CreatedAt: "now", UpdatedAt: "now"})
	if _, err := rt.writeSandboxFile("Shared/Child/local.txt", []byte("hello")); err != nil {
		t.Fatal(err)
	}

	if _, err := rt.DeleteLocalPath(context.Background(), "Shared/Child"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "sandbox", "Shared", "Child")); !os.IsNotExist(err) {
		t.Fatalf("local folder still exists or unexpected stat error: %v", err)
	}
	if len(client.sent) != 1 {
		t.Fatalf("sent messages = %d, want 1", len(client.sent))
	}
	env := client.sent[0]
	if env.Type != "folder-change" || env.ChangeType != "folder-deleted" || env.Folder == nil || env.Folder.ID != "folder-child" || env.Folder.DeletedAt == "" {
		t.Fatalf("unexpected folder delete envelope: %+v", env)
	}
}

func TestRuntimeFetchRemoteFileRequiresKnownFolderKey(t *testing.T) {
	root := t.TempDir()
	rt, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox"),
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        mist.NewLocalClient(filepath.Join(root, "store")),
	})
	if err != nil {
		t.Fatal(err)
	}
	rt.rememberRemoteFile(RemoteFile{FolderID: "folder-1", FileID: "file-1", Name: "hello.txt", CID: "cid-1"})
	if _, err := rt.FetchRemoteFile(context.Background(), "file-1"); err == nil {
		t.Fatal("FetchRemoteFile succeeded without a folder key")
	}
}

func TestRuntimeFetchRemoteFileDownloadsKnownRemote(t *testing.T) {
	root := t.TempDir()
	client := newSyncTestClient(filepath.Join(root, "store"))
	rt, err := NewRuntime(Config{
		SandboxRoot: filepath.Join(root, "sandbox"),
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	folderKey := "folder-passphrase"
	rt.rememberFolderKey("folder-1", folderKey)
	cid := storeEncryptedFileBundle(t, client, folderKey, domain.FileRecord{
		ID:       "file-1",
		FolderID: "folder-1",
		Name:     "hello.txt",
		Size:     5,
		DataURL:  dataURL("text/plain", []byte("hello")),
	})
	rt.rememberRemoteFile(RemoteFile{FolderID: "folder-1", FolderName: "Shared", FileID: "file-1", Name: "hello.txt", CID: cid})

	file, err := rt.FetchRemoteFile(context.Background(), "file-1")
	if err != nil {
		t.Fatal(err)
	}
	if file.SyncedPath != "Shared/hello.txt" {
		t.Fatalf("synced path = %q", file.SyncedPath)
	}
	data, _, err := rt.Sandbox.ReadFile("Shared/hello.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" {
		t.Fatalf("synced data = %q", data)
	}
}

type syncTestClient struct {
	*mist.LocalClient
	callback mist.EventFunc
	sent     []protocol.ShareEnvelope
}

func newSyncTestClient(root string) *syncTestClient {
	return &syncTestClient{LocalClient: mist.NewLocalClient(root)}
}

func (c *syncTestClient) Networked() bool                    { return true }
func (c *syncTestClient) SetEventCallback(fn mist.EventFunc) { c.callback = fn }
func (c *syncTestClient) Stats(context.Context) ([]byte, error) {
	return []byte(`{"nodes":[{"id":"peer","connectionState":"connected"}]}`), nil
}
func (c *syncTestClient) SendMessage(_ context.Context, _ string, data []byte, _ int) error {
	var env protocol.ShareEnvelope
	if err := json.Unmarshal(data, &env); err == nil {
		c.sent = append(c.sent, env)
	}
	return nil
}

func (c *syncTestClient) emit(t *testing.T, payload []byte) {
	t.Helper()
	if c.callback == nil {
		t.Fatal("event callback was not registered")
	}
	c.callback(0, "peer", payload)
}

func signedEnvelope(t *testing.T, env protocol.ShareEnvelope) []byte {
	t.Helper()
	id, err := protocol.GenerateDidIdentity()
	if err != nil {
		t.Fatal(err)
	}
	env.From = id.Did
	if env.SentAt == "" {
		env.SentAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	signed, err := protocol.SignEnvelope(env, id)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(signed)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func storeEncryptedFileBundle(t *testing.T, client *syncTestClient, passphrase string, file domain.FileRecord) string {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	payload, err := protocol.EncryptJSON(domain.FileBundle{
		Version:    1,
		ExportedAt: now,
		OriginNode: "peer",
		Folder:     domain.FolderRecord{ID: file.FolderID, Name: "Shared", CreatedAt: now, UpdatedAt: now},
		File:       file,
	}, passphrase)
	if err != nil {
		t.Fatal(err)
	}
	bytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	cid, err := client.StorageAdd(context.Background(), file.Name+".enc.json", bytes)
	if err != nil {
		t.Fatal(err)
	}
	return cid
}

func storeEncryptedFolderBundle(t *testing.T, client *syncTestClient, passphrase string, bundle domain.FolderBundle) string {
	t.Helper()
	payload, err := protocol.EncryptJSON(bundle, passphrase)
	if err != nil {
		t.Fatal(err)
	}
	bytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	cid, err := client.StorageAdd(context.Background(), bundle.Folder.ID+".tc-folder.enc.json", bytes)
	if err != nil {
		t.Fatal(err)
	}
	return cid
}

func waitSyncEvent(t *testing.T, events <-chan SyncEvent) SyncEvent {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for sync event")
		return SyncEvent{}
	}
}
