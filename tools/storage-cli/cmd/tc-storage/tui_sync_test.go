package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tc-storage-cli/internal/app"
	"tc-storage-cli/internal/domain"
	"tc-storage-cli/internal/mist"
	"tc-storage-cli/internal/protocol"

	tea "github.com/charmbracelet/bubbletea"
)

func TestTUIShowsRemoteSyncedMetadata(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	rt, err := app.NewRuntime(app.Config{
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
	m := newModel(ctx, rt)
	client.emit(t, signedTUIEnvelope(t, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "file-upserted",
		FolderID:   "folder-1",
		FolderName: "Shared",
		FileID:     "file-1",
		FileName:   "hello.txt",
		CID:        "cid-1",
		File:       &domain.FileRecord{ID: "file-1", FolderID: "folder-1", Name: "hello.txt", Size: 5, LastCID: "cid-1"},
	}))
	event := waitTUISyncEvent(t, m.syncEvents)
	updated, _ := m.Update(syncMsg{event: event})
	m = updated.(model)

	view := m.View()
	if !strings.Contains(view, "Shared/") {
		t.Fatalf("remote folder not rendered in TUI view:\n%s", view)
	}
	m = enterSelected(t, m)
	view = m.View()
	if !strings.Contains(view, "remote") || !strings.Contains(view, "hello.txt") {
		t.Fatalf("remote file not rendered after opening folder:\n%s", view)
	}
}

func TestTUIRemovesRemoteFileWhenPeerDeletes(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	rt, err := app.NewRuntime(app.Config{
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
	m := newModel(ctx, rt)
	m = emitTUISync(t, m, client, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "file-upserted",
		FolderID:   "folder-1",
		FolderName: "Shared",
		FileID:     "file-1",
		FileName:   "hello.txt",
		CID:        "cid-1",
		File:       &domain.FileRecord{ID: "file-1", FolderID: "folder-1", Name: "hello.txt", Size: 5, LastCID: "cid-1"},
	})
	m = enterSelected(t, m)
	view := m.View()
	if !strings.Contains(view, "hello.txt") {
		t.Fatalf("remote file not rendered before delete:\n%s", view)
	}

	m = emitTUISync(t, m, client, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "file-deleted",
		FolderID:   "folder-1",
		FolderName: "Shared",
		FileID:     "file-1",
		FileName:   "hello.txt",
		File:       &domain.FileRecord{ID: "file-1", FolderID: "folder-1", Name: "hello.txt", DeletedAt: "now"},
	})
	view = m.View()
	if strings.Contains(view, "hello.txt") {
		t.Fatalf("remote file should disappear after peer delete:\n%s", view)
	}
}

func TestTUIRemovesSyncedLocalFileWhenPeerDeletes(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	sandboxRoot := filepath.Join(root, "sandbox")
	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: sandboxRoot,
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a file the peer previously shared and we downloaded into the
	// sandbox (so it shows up as a local file in the TUI).
	syncedPath := filepath.Join(sandboxRoot, "Shared", "hello.txt")
	if err := os.MkdirAll(filepath.Dir(syncedPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(syncedPath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newModel(ctx, rt)
	m = emitTUISync(t, m, client, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "file-upserted",
		FolderID:   "folder-1",
		FolderName: "Shared",
		FileID:     "file-1",
		FileName:   "hello.txt",
		CID:        "cid-1",
		File:       &domain.FileRecord{ID: "file-1", FolderID: "folder-1", Name: "hello.txt", Size: 5, LastCID: "cid-1"},
	})

	m = emitTUISync(t, m, client, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "file-deleted",
		FolderID:   "folder-1",
		FolderName: "Shared",
		FileID:     "file-1",
		FileName:   "hello.txt",
		File:       &domain.FileRecord{ID: "file-1", FolderID: "folder-1", Name: "hello.txt", DeletedAt: "now"},
	})

	m = enterSelected(t, m)
	view := m.View()
	if strings.Contains(view, "hello.txt") {
		t.Fatalf("synced file should disappear from TUI after peer delete:\n%s", view)
	}
	if _, err := os.Stat(syncedPath); !os.IsNotExist(err) {
		t.Fatalf("synced sandbox file should be removed after peer delete: %v", err)
	}
}

func TestTUIShowsNestedRemoteSyncedMetadata(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	rt, err := app.NewRuntime(app.Config{
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
	m := newModel(ctx, rt)
	rootID := "folder-root"
	client.emit(t, signedTUIEnvelope(t, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "folder-upserted",
		FolderID:   rootID,
		FolderName: "Shared",
		Folder:     &domain.FolderRecord{ID: rootID, Name: "Shared", CreatedAt: "now", UpdatedAt: "now"},
	}))
	event := waitTUISyncEvent(t, m.syncEvents)
	updated, _ := m.Update(syncMsg{event: event})
	m = updated.(model)
	client.emit(t, signedTUIEnvelope(t, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "folder-upserted",
		FolderID:   rootID,
		FolderName: "Shared",
		Folder:     &domain.FolderRecord{ID: "folder-child", Name: "Assets", ParentID: &rootID, CreatedAt: "now", UpdatedAt: "now"},
	}))
	event = waitTUISyncEvent(t, m.syncEvents)
	updated, _ = m.Update(syncMsg{event: event})
	m = updated.(model)
	client.emit(t, signedTUIEnvelope(t, protocol.ShareEnvelope{
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
	event = waitTUISyncEvent(t, m.syncEvents)
	updated, _ = m.Update(syncMsg{event: event})
	m = updated.(model)

	view := m.View()
	if !strings.Contains(view, "Shared/") {
		t.Fatalf("root remote folder not rendered in TUI view:\n%s", view)
	}
	m = enterSelected(t, m)
	view = m.View()
	if !strings.Contains(view, "Assets/") {
		t.Fatalf("nested remote folder not rendered after opening root:\n%s", view)
	}
	m = enterSelected(t, m)
	view = m.View()
	if !strings.Contains(view, "remote") || !strings.Contains(view, "logo.png") {
		t.Fatalf("nested remote file not rendered after opening folder:\n%s", view)
	}
}

func TestTUIShowsAllRemoteSharedFolderContents(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	rt, err := app.NewRuntime(app.Config{
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
	m := newModel(ctx, rt)
	rootID := "folder-root"
	assetsID := "folder-assets"
	docsID := "folder-docs"
	yearID := "folder-2026"

	for _, folder := range []domain.FolderRecord{
		{ID: rootID, Name: "Shared", CreatedAt: "now", UpdatedAt: "now"},
		{ID: assetsID, Name: "Assets", ParentID: &rootID, CreatedAt: "now", UpdatedAt: "now"},
		{ID: docsID, Name: "Docs", ParentID: &rootID, CreatedAt: "now", UpdatedAt: "now"},
		{ID: yearID, Name: "2026", ParentID: &docsID, CreatedAt: "now", UpdatedAt: "now"},
	} {
		m = emitTUISync(t, m, client, protocol.ShareEnvelope{
			Type:       "folder-change",
			RoomID:     "room-1",
			ChangeType: "folder-upserted",
			FolderID:   rootID,
			FolderName: "Shared",
			Folder:     &folder,
		})
	}

	for _, file := range []domain.FileRecord{
		{ID: "file-readme", FolderID: rootID, Name: "README.md", Size: 11, LastCID: "cid-readme"},
		{ID: "file-logo", FolderID: assetsID, Name: "logo.png", Size: 4, LastCID: "cid-logo"},
		{ID: "file-banner", FolderID: assetsID, Name: "banner.png", Size: 6, LastCID: "cid-banner"},
		{ID: "file-plan", FolderID: yearID, Name: "plan.txt", Size: 9, LastCID: "cid-plan"},
	} {
		file := file
		m = emitTUISync(t, m, client, protocol.ShareEnvelope{
			Type:       "folder-change",
			RoomID:     "room-1",
			ChangeType: "file-upserted",
			FolderID:   rootID,
			FolderName: "Shared",
			FileID:     file.ID,
			FileName:   file.Name,
			CID:        file.LastCID,
			File:       &file,
		})
	}

	view := m.View()
	if !strings.Contains(view, "Shared/") {
		t.Fatalf("shared root not rendered in TUI view:\n%s", view)
	}
	m = enterSelected(t, m)
	view = m.View()
	for _, want := range []string{"README.md", "Assets/", "Docs/"} {
		if !strings.Contains(view, want) {
			t.Fatalf("shared folder entry %q not rendered after opening root:\n%s", want, view)
		}
	}
	m = moveToEntry(t, m, "Assets")
	m = enterSelected(t, m)
	view = m.View()
	for _, want := range []string{"logo.png", "banner.png"} {
		if !strings.Contains(view, want) {
			t.Fatalf("assets entry %q not rendered after opening folder:\n%s", want, view)
		}
	}
	updated, _ := m.Update(keyMsg("backspace"))
	m = updated.(model)
	m = moveToEntry(t, m, "Docs")
	m = enterSelected(t, m)
	m = enterSelected(t, m)
	view = m.View()
	if !strings.Contains(view, "plan.txt") {
		t.Fatalf("nested doc not rendered after navigating folders:\n%s", view)
	}
}

func TestTUIHidesRemoteWhenLocalPathExists(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	sandboxRoot := filepath.Join(root, "sandbox")
	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: sandboxRoot,
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	localPath := filepath.Join(sandboxRoot, "Shared", "README.md")
	if err := os.MkdirAll(filepath.Dir(localPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(localPath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newModel(ctx, rt)
	m = emitTUISync(t, m, client, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "file-upserted",
		FolderID:   "folder-1",
		FolderName: "Shared",
		FileID:     "file-readme",
		FileName:   "README.md",
		CID:        "cid-readme",
		File:       &domain.FileRecord{ID: "file-readme", FolderID: "folder-1", Name: "README.md", Size: 5, LastCID: "cid-readme"},
	})

	m = enterSelected(t, m)
	view := m.View()
	if got := countRemoteRows(view); got != 0 {
		t.Fatalf("remote duplicate should be hidden when local path exists; remote rows=%d:\n%s", got, view)
	}
	if !strings.Contains(view, "local") || !strings.Contains(view, "README.md") {
		t.Fatalf("local file not rendered in TUI view:\n%s", view)
	}
}

type tuiTestClient struct {
	*mist.LocalClient
	callback  mist.EventFunc
	sent      []protocol.ShareEnvelope
	initCalls int
	joinCalls int
}

func newTUITestClient(root string) *tuiTestClient {
	return &tuiTestClient{LocalClient: mist.NewLocalClient(root)}
}

func (c *tuiTestClient) Init(ctx context.Context, nodeID, config string) error {
	c.initCalls++
	return c.LocalClient.Init(ctx, nodeID, config)
}

func (c *tuiTestClient) JoinRoom(ctx context.Context, roomID string) error {
	c.joinCalls++
	return c.LocalClient.JoinRoom(ctx, roomID)
}

func (c *tuiTestClient) Networked() bool                    { return true }
func (c *tuiTestClient) SetEventCallback(fn mist.EventFunc) { c.callback = fn }
func (c *tuiTestClient) Stats(context.Context) ([]byte, error) {
	return []byte(`{"nodes":[{"id":"peer","connectionState":"connected"}]}`), nil
}
func (c *tuiTestClient) SendMessage(_ context.Context, _ string, data []byte, _ int) error {
	var env protocol.ShareEnvelope
	if err := json.Unmarshal(data, &env); err == nil {
		c.sent = append(c.sent, env)
	}
	return nil
}
func (c *tuiTestClient) emit(t *testing.T, payload []byte) {
	t.Helper()
	if c.callback == nil {
		t.Fatal("event callback was not registered")
	}
	c.callback(0, "peer", payload)
}

func signedTUIEnvelope(t *testing.T, env protocol.ShareEnvelope) []byte {
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

func countRemoteRows(view string) int {
	count := 0
	for _, line := range strings.Split(view, "\n") {
		if strings.Contains(line, "-r--r--r-- remote") {
			count++
		}
	}
	return count
}

func emitTUISync(t *testing.T, m model, client *tuiTestClient, env protocol.ShareEnvelope) model {
	t.Helper()
	client.emit(t, signedTUIEnvelope(t, env))
	event := waitTUISyncEvent(t, m.syncEvents)
	updated, _ := m.Update(syncMsg{event: event})
	return updated.(model)
}

func waitTUISyncEvent(t *testing.T, events <-chan app.SyncEvent) app.SyncEvent {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for sync event")
		return app.SyncEvent{}
	}
}

func TestTUIBrowseCanOpenFolderAndReturnToParent(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	sandboxRoot := filepath.Join(root, "sandbox")
	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: sandboxRoot,
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(sandboxRoot, "Shared", "Docs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sandboxRoot, "Shared", "Docs", "note.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newModel(ctx, rt)
	view := m.View()
	if !strings.Contains(view, "Shared/") || strings.Contains(view, "note.txt") {
		t.Fatalf("root should show folder but not nested file:\n%s", view)
	}
	m = enterSelected(t, m)
	view = m.View()
	if !strings.Contains(view, "Docs/") || !strings.Contains(view, string(filepath.Separator)+"Shared") {
		t.Fatalf("opening folder should show child folder and path:\n%s", view)
	}
	m = enterSelected(t, m)
	view = m.View()
	if !strings.Contains(view, "note.txt") {
		t.Fatalf("opening nested folder should show file:\n%s", view)
	}
	updated, _ := m.Update(keyMsg("backspace"))
	m = updated.(model)
	if m.browseDir != "Shared" {
		t.Fatalf("backspace should return to parent browseDir, got %q", m.browseDir)
	}
}

func TestTUIDeleteRequiresConfirmationAndRemovesLocalFile(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	sandboxRoot := filepath.Join(root, "sandbox")
	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: sandboxRoot,
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	localPath := filepath.Join(sandboxRoot, "note.txt")
	if err := os.WriteFile(localPath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newModel(ctx, rt)

	updated, cmd := m.Update(keyMsg("delete"))
	m = updated.(model)
	if m.screen != screenConfirm || cmd != nil {
		t.Fatalf("delete should open confirmation without command: screen=%v cmdNil=%v", m.screen, cmd == nil)
	}
	updated, cmd = m.Update(keyMsg("enter"))
	m = updated.(model)
	if m.screen != screenRunning || m.act.title != "delete local path" || cmd == nil {
		t.Fatalf("confirm should start delete action: screen=%v action=%q cmdNil=%v", m.screen, m.act.title, cmd == nil)
	}
	updated, _ = m.Update(cmd())
	m = updated.(model)
	if _, err := os.Stat(localPath); !os.IsNotExist(err) {
		t.Fatalf("file still exists or unexpected stat error: %v", err)
	}
	if !strings.Contains(m.View(), "deleted note.txt") {
		t.Fatalf("delete status not shown:\n%s", m.View())
	}
}

func TestTUIShiftDeleteSkipsConfirmation(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	sandboxRoot := filepath.Join(root, "sandbox")
	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: sandboxRoot,
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sandboxRoot, "note.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newModel(ctx, rt)

	updated, cmd := m.Update(keyMsg("shift+delete"))
	m = updated.(model)
	if m.screen != screenRunning || m.act.title != "delete local path" || cmd == nil {
		t.Fatalf("shift+delete should start delete without confirmation: screen=%v action=%q cmdNil=%v", m.screen, m.act.title, cmd == nil)
	}
}

func TestTUIAddFilePickerCanOpenParentAndAddFile(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	client := newTUITestClient(filepath.Join(root, "store"))
	sandboxRoot := filepath.Join(root, "sandbox")
	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: sandboxRoot,
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	docsDir := filepath.Join(root, "docs")
	if err := os.MkdirAll(docsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(docsDir, "source.txt")
	if err := os.WriteFile(sourcePath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newModel(ctx, rt)
	updated, _ := m.Update(keyMsg("a"))
	m = updated.(model)
	if m.screen != screenPicker || m.pickDir != root {
		t.Fatalf("a did not open add file picker at cwd: screen=%v pickDir=%q", m.screen, m.pickDir)
	}
	if !strings.Contains(m.View(), "docs/") {
		t.Fatalf("picker did not list child folder:\n%s", m.View())
	}

	updated, _ = m.Update(keyMsg("down"))
	m = updated.(model)
	updated, _ = m.Update(keyMsg("enter"))
	m = updated.(model)
	if m.screen != screenPicker || m.pickDir != docsDir {
		t.Fatalf("enter on folder should open it: screen=%v pickDir=%q", m.screen, m.pickDir)
	}
	updated, _ = m.Update(keyMsg("backspace"))
	m = updated.(model)
	if m.pickDir != root {
		t.Fatalf("backspace should return to parent: pickDir=%q", m.pickDir)
	}

	updated, _ = m.Update(keyMsg("down"))
	m = updated.(model)
	updated, _ = m.Update(keyMsg("enter"))
	m = updated.(model)
	updated, _ = m.Update(keyMsg("down"))
	m = updated.(model)
	updated, cmd := m.Update(keyMsg("enter"))
	m = updated.(model)
	if m.screen != screenRunning || cmd == nil {
		t.Fatalf("enter on file did not start add command: screen=%v cmdNil=%v", m.screen, cmd == nil)
	}
	updated, _ = m.Update(cmd())
	m = updated.(model)
	view := m.View()
	if m.screen != screenBrowse || !strings.Contains(view, "source.txt") || !strings.Contains(view, "added source.txt") {
		t.Fatalf("add file should return to browse with new file and status: screen=%v view:\n%s", m.screen, view)
	}
}

func TestTUIAddFileImportsIntoCurrentBrowseFolder(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	client := newTUITestClient(filepath.Join(root, "store"))
	sandboxRoot := filepath.Join(root, "sandbox")
	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: sandboxRoot,
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(sandboxRoot, "Shared"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sandboxRoot, "Shared", ".keep"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(root, "source.txt")
	if err := os.WriteFile(sourcePath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newModel(ctx, rt)
	m = enterSelected(t, m)
	if m.browseDir != "Shared" {
		t.Fatalf("expected to be inside Shared, got %q", m.browseDir)
	}
	updated, _ := m.Update(keyMsg("a"))
	m = updated.(model)
	if m.screen != screenPicker || m.pickTargetDir != "Shared" {
		t.Fatalf("picker target dir = %q, screen=%v", m.pickTargetDir, m.screen)
	}
	m = moveToPickerEntry(t, m, "source.txt")
	updated, cmd := m.Update(keyMsg("enter"))
	m = updated.(model)
	if m.screen != screenRunning || cmd == nil {
		t.Fatalf("enter on file did not start add command: screen=%v cmdNil=%v", m.screen, cmd == nil)
	}
	updated, _ = m.Update(cmd())
	m = updated.(model)
	view := m.View()
	if m.screen != screenBrowse || !strings.Contains(view, "added Shared/source.txt") || !strings.Contains(view, "source.txt") {
		t.Fatalf("add file should import into current folder and return there: screen=%v view:\n%s", m.screen, view)
	}
	data, _, err := rt.Sandbox.ReadFile("Shared/source.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" {
		t.Fatalf("imported data = %q", data)
	}
}


func TestTUIAddFileInSharedFolderPublishesToPeer(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	client := newTUITestClient(filepath.Join(root, "store"))
	sandboxRoot := filepath.Join(root, "sandbox")
	statePath := filepath.Join(root, "state.json")
	stateBytes, err := json.Marshal(map[string]any{
		"folderKeys": map[string]string{"folder-root": "folder-passphrase"},
		"remoteFolders": map[string]domain.FolderRecord{
			"folder-root": {ID: "folder-root", Name: "Shared", CreatedAt: "now", UpdatedAt: "now"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, stateBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	id, err := protocol.GenerateDidIdentity()
	if err != nil {
		t.Fatal(err)
	}
	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: sandboxRoot,
		StatePath:   statePath,
		RoomID:      "room-1",
		Mist:        client,
		Identity:    id,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(sandboxRoot, "Shared"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sandboxRoot, "Shared", ".keep"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(root, "source.txt")
	if err := os.WriteFile(sourcePath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newModel(ctx, rt)
	m = enterSelected(t, m)
	updated, _ := m.Update(keyMsg("a"))
	m = updated.(model)
	m = moveToPickerEntry(t, m, "source.txt")
	updated, cmd := m.Update(keyMsg("enter"))
	m = updated.(model)
	if cmd == nil {
		t.Fatal("enter on file did not start add command")
	}
	updated, _ = m.Update(cmd())
	m = updated.(model)
	view := m.View()
	if !strings.Contains(view, "added Shared/source.txt; shared Shared/source.txt") {
		t.Fatalf("add should show shared status:\n%s", view)
	}
	if len(client.sent) != 1 {
		t.Fatalf("sent messages = %d, want 1", len(client.sent))
	}
	env := client.sent[0]
	if env.Type != "folder-change" || env.ChangeType != "file-upserted" || env.FolderID != "folder-root" || env.File == nil || env.File.Name != "source.txt" || env.File.LastCID == "" {
		t.Fatalf("unexpected add publish envelope: %+v", env)
	}
}

func TestTUIAddFileDoesNotReinitMistSession(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	client := newTUITestClient(filepath.Join(root, "store"))
	sandboxRoot := filepath.Join(root, "sandbox")
	statePath := filepath.Join(root, "state.json")
	stateBytes, err := json.Marshal(map[string]any{
		"folderKeys": map[string]string{"folder-root": "folder-passphrase"},
		"remoteFolders": map[string]domain.FolderRecord{
			"folder-root": {ID: "folder-root", Name: "Shared", CreatedAt: "now", UpdatedAt: "now"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, stateBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	id, err := protocol.GenerateDidIdentity()
	if err != nil {
		t.Fatal(err)
	}
	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: sandboxRoot,
		StatePath:   statePath,
		RoomID:      "room-1",
		Mist:        client,
		Identity:    id,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(sandboxRoot, "Shared"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sandboxRoot, "Shared", ".keep"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(root, "source.txt")
	if err := os.WriteFile(sourcePath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// TUI establishes the mist session once at startup.
	if err := rt.Establish(ctx); err != nil {
		t.Fatal(err)
	}
	initAfterStartup := client.initCalls
	joinAfterStartup := client.joinCalls

	m := newModel(ctx, rt)
	m = enterSelected(t, m)
	updated, _ := m.Update(keyMsg("a"))
	m = updated.(model)
	m = moveToPickerEntry(t, m, "source.txt")
	updated, cmd := m.Update(keyMsg("enter"))
	m = updated.(model)
	if cmd == nil {
		t.Fatal("enter on file did not start add command")
	}
	updated, _ = m.Update(cmd())
	m = updated.(model)

	if client.initCalls != initAfterStartup {
		t.Fatalf("adding a file re-initialized the mist session (dropping the connection): init calls %d -> %d", initAfterStartup, client.initCalls)
	}
	if client.joinCalls != joinAfterStartup {
		t.Fatalf("adding a file re-joined the room: join calls %d -> %d", joinAfterStartup, client.joinCalls)
	}
}

func TestTUIRemovesOwnAddedFileWhenPeerDeletes(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	client := newTUITestClient(filepath.Join(root, "store"))
	sandboxRoot := filepath.Join(root, "sandbox")
	statePath := filepath.Join(root, "state.json")
	stateBytes, err := json.Marshal(map[string]any{
		"folderKeys": map[string]string{"folder-root": "folder-passphrase"},
		"remoteFolders": map[string]domain.FolderRecord{
			"folder-root": {ID: "folder-root", Name: "Shared", CreatedAt: "now", UpdatedAt: "now"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, stateBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	id, err := protocol.GenerateDidIdentity()
	if err != nil {
		t.Fatal(err)
	}
	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: sandboxRoot,
		StatePath:   statePath,
		RoomID:      "room-1",
		Mist:        client,
		Identity:    id,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(sandboxRoot, "Shared"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sandboxRoot, "Shared", ".keep"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(root, "source.txt")
	if err := os.WriteFile(sourcePath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newModel(ctx, rt)
	m = enterSelected(t, m)
	updated, _ := m.Update(keyMsg("a"))
	m = updated.(model)
	m = moveToPickerEntry(t, m, "source.txt")
	updated, cmd := m.Update(keyMsg("enter"))
	m = updated.(model)
	if cmd == nil {
		t.Fatal("enter on file did not start add command")
	}
	updated, _ = m.Update(cmd())
	m = updated.(model)
	if len(client.sent) != 1 {
		t.Fatalf("expected our add to publish once, sent=%d", len(client.sent))
	}
	fileID := client.sent[0].FileID

	// The peer deletes the file we contributed and echoes a file-deleted change.
	m = emitTUISync(t, m, client, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "file-deleted",
		FolderID:   "folder-root",
		FolderName: "Shared",
		FileID:     fileID,
		FileName:   "source.txt",
		File:       &domain.FileRecord{ID: fileID, FolderID: "folder-root", Name: "source.txt", DeletedAt: "now"},
	})

	for _, entry := range m.entries {
		if entry.name == "source.txt" {
			t.Fatalf("our added file should disappear from the listing after peer deletes it:\n%s", m.View())
		}
	}
	if _, err := os.Stat(filepath.Join(sandboxRoot, "Shared", "source.txt")); !os.IsNotExist(err) {
		t.Fatalf("our added file should be removed from sandbox after peer delete: %v", err)
	}
}

func TestTUIEnterOnRemoteRunsRetrieveAction(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	rt, err := app.NewRuntime(app.Config{
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
	m := newModel(ctx, rt)
	client.emit(t, signedTUIEnvelope(t, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "file-upserted",
		FolderID:   "folder-1",
		FolderName: "Shared",
		FileID:     "file-1",
		FileName:   "hello.txt",
		CID:        "cid-1",
		File:       &domain.FileRecord{ID: "file-1", FolderID: "folder-1", Name: "hello.txt", Size: 5, LastCID: "cid-1"},
	}))
	event := waitTUISyncEvent(t, m.syncEvents)
	updated, _ := m.Update(syncMsg{event: event})
	m = updated.(model)

	m = enterSelected(t, m)
	updated, cmd := m.Update(keyMsg("enter"))
	m = updated.(model)
	if m.screen != screenRunning || m.act.title != "retrieve from storage" || cmd == nil {
		t.Fatalf("enter did not start remote retrieve: screen=%v action=%q cmdNil=%v", m.screen, m.act.title, cmd == nil)
	}
}

func TestTUIEnterOnLocalShowsAvailableAction(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	sandboxRoot := filepath.Join(root, "sandbox")
	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: sandboxRoot,
		RoomID:      "room-1",
		NodeID:      "did:key:test",
		Mist:        client,
	})
	if err != nil {
		t.Fatal(err)
	}
	localPath := filepath.Join(sandboxRoot, "note.txt")
	if err := os.MkdirAll(filepath.Dir(localPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(localPath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newModel(ctx, rt)
	updated, cmd := m.Update(keyMsg("enter"))
	m = updated.(model)
	if m.screen != screenRunning || m.act.title != "available on this PC" || cmd == nil {
		t.Fatalf("enter on local should show available action: screen=%v action=%q cmdNil=%v", m.screen, m.act.title, cmd == nil)
	}
	updated, _ = m.Update(cmd())
	m = updated.(model)
	view := m.View()
	if m.screen != screenBrowse || !strings.Contains(view, "available "+localPath) {
		t.Fatalf("local enter should return to browse with status: screen=%v view:\n%s", m.screen, view)
	}
}

func TestTUIStoreLocalPublishesKnownSharedFolderFile(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	sandboxRoot := filepath.Join(root, "sandbox")
	statePath := filepath.Join(root, "state.json")
	stateBytes, err := json.Marshal(map[string]any{
		"folderKeys": map[string]string{"folder-root": "folder-passphrase"},
		"remoteFolders": map[string]domain.FolderRecord{
			"folder-root": {ID: "folder-root", Name: "Shared", CreatedAt: "now", UpdatedAt: "now"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, stateBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	id, err := protocol.GenerateDidIdentity()
	if err != nil {
		t.Fatal(err)
	}
	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: sandboxRoot,
		StatePath:   statePath,
		RoomID:      "room-1",
		Mist:        client,
		Identity:    id,
	})
	if err != nil {
		t.Fatal(err)
	}
	localPath := filepath.Join(sandboxRoot, "Shared", "local.txt")
	if err := os.MkdirAll(filepath.Dir(localPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(localPath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newModel(ctx, rt)
	m = enterSelected(t, m)
	updated, cmd := m.Update(keyMsg("p"))
	m = updated.(model)
	if m.screen != screenRunning || m.act.title != "store local in shared folder" || cmd == nil {
		t.Fatalf("p should start shared-folder store action: screen=%v action=%q cmdNil=%v", m.screen, m.act.title, cmd == nil)
	}
	updated, _ = m.Update(cmd())
	m = updated.(model)
	view := m.View()
	if m.screen != screenBrowse || !strings.Contains(view, "stored Shared/local.txt") {
		t.Fatalf("store local should return to browse with stored status: screen=%v view:\n%s", m.screen, view)
	}
}

func TestTUIInlineActionErrorReturnsToBrowse(t *testing.T) {
	root := t.TempDir()
	client := newTUITestClient(filepath.Join(root, "store"))
	rt, err := app.NewRuntime(app.Config{
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
	m := newModel(ctx, rt)
	client.emit(t, signedTUIEnvelope(t, protocol.ShareEnvelope{
		Type:       "folder-change",
		RoomID:     "room-1",
		ChangeType: "file-upserted",
		FolderID:   "folder-1",
		FolderName: "Shared",
		FileID:     "file-1",
		FileName:   "hello.txt",
		CID:        "cid-1",
		File:       &domain.FileRecord{ID: "file-1", FolderID: "folder-1", Name: "hello.txt", Size: 5, LastCID: "cid-1"},
	}))
	event := waitTUISyncEvent(t, m.syncEvents)
	updated, _ := m.Update(syncMsg{event: event})
	m = updated.(model)
	m = enterSelected(t, m)
	updated, cmd := m.Update(keyMsg("enter"))
	m = updated.(model)
	if cmd == nil {
		t.Fatal("enter on remote did not start retrieve command")
	}
	updated, _ = m.Update(cmd())
	m = updated.(model)
	view := m.View()
	if m.screen != screenBrowse || !strings.Contains(view, "error:") {
		t.Fatalf("inline retrieve error should return to browse with status: screen=%v view:\n%s", m.screen, view)
	}
}

func enterSelected(t *testing.T, m model) model {
	t.Helper()
	updated, _ := m.Update(keyMsg("enter"))
	return updated.(model)
}

func moveToEntry(t *testing.T, m model, name string) model {
	t.Helper()
	for i, entry := range m.entries {
		if entry.name == name || entry.display == name {
			m.cursor = i
			return m
		}
	}
	t.Fatalf("entry %q not found in %+v", name, m.entries)
	return m
}

func moveToPickerEntry(t *testing.T, m model, name string) model {
	t.Helper()
	for i, entry := range m.pickEntries {
		if entry.name == name {
			m.pickCursor = i
			return m
		}
	}
	t.Fatalf("picker entry %q not found in %+v", name, m.pickEntries)
	return m
}

func keyMsg(value string) tea.KeyMsg {
	switch value {
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case "backspace":
		return tea.KeyMsg{Type: tea.KeyBackspace}
	case "delete":
		return tea.KeyMsg{Type: tea.KeyDelete}
	case "shift+delete":
		return tea.KeyMsg{Type: tea.KeyDelete, Alt: true}
	}
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(value)}
}
