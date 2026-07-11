package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"tc-storage-cli/internal/domain"
	"tc-storage-cli/internal/mist"
	"tc-storage-cli/internal/protocol"
	"tc-storage-cli/internal/sandbox"
)

type Config struct {
	SandboxRoot string
	StoreRoot   string
	StatePath   string
	RoomID      string
	NodeID      string
	Mist        mist.Client
	// Identity signs share envelopes. When set, NodeID defaults to its did:key.
	Identity protocol.DidIdentity
}

type Runtime struct {
	Sandbox   *sandbox.Sandbox
	mist      mist.Client
	statePath string
	roomID    string
	nodeID    string
	identity  protocol.DidIdentity

	eventMu     sync.Mutex
	subscribers map[int]chan protocol.ShareEnvelope
	nextSub     int
	eventLogger func(protocol.ShareEnvelope)
	eventReady  bool

	establishMu sync.Mutex
	established  bool

	syncMu        sync.Mutex
	folderKeys    map[string]string
	remoteFolders map[string]domain.FolderRecord
	remoteFiles   map[string]RemoteFile
}

// RemoteFile is metadata learned from peer folder-change messages before or
// after the encrypted content is fetched into the sandbox.
type RemoteFile struct {
	FolderID   string
	FolderName string
	FileID     string
	Name       string
	CID        string
	Size       int64
	Path       string
	SyncedPath string
}

// SyncEvent describes work performed by StartContentSync.
type SyncEvent struct {
	Type   string
	File   RemoteFile
	Result FolderShareResult
	Err    error
}

type runtimeState struct {
	FolderKeys    map[string]string              `json:"folderKeys,omitempty"`
	RemoteFolders map[string]domain.FolderRecord `json:"remoteFolders,omitempty"`
	RemoteFiles   map[string]RemoteFile          `json:"remoteFiles,omitempty"`
}

func (r *Runtime) NodeID() string { return r.nodeID }
func (r *Runtime) RoomID() string { return r.roomID }

// Connect joins the room and positions the node on the overlay, waiting briefly
// for a peer. Exposed so callers (and the connectivity E2E test) can establish
// a session without performing a storage transfer.
func (r *Runtime) Connect(ctx context.Context) error {
	return r.connect(ctx)
}

// ConnectedPeers returns the ids of peers currently in a connected state.
func (r *Runtime) ConnectedPeers(ctx context.Context) []string {
	var ids []string
	for _, node := range r.connectedNodes(ctx) {
		if strings.EqualFold(node.ConnectionState, "connected") {
			ids = append(ids, node.ID)
		}
	}
	return ids
}

func DefaultDataDir() (string, error) {
	if value := strings.TrimSpace(os.Getenv("TC_STORAGE_CLI_HOME")); value != "" {
		return filepath.Abs(value)
	}
	if value := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); value != "" {
		return filepath.Join(value, "tc-storage-cli"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "tc-storage-cli"), nil
}

func NewRuntime(config Config) (*Runtime, error) {
	if config.Mist == nil {
		return nil, fmt.Errorf("mist client is required")
	}
	box, err := sandbox.New(config.SandboxRoot)
	if err != nil {
		return nil, err
	}
	nodeID := strings.TrimSpace(config.NodeID)
	if nodeID == "" {
		if config.Identity.Did != "" {
			nodeID = config.Identity.Did
		} else {
			nodeID = "did:key:tc-storage-cli-local"
		}
	}
	roomID := strings.TrimSpace(config.RoomID)
	if roomID == "" {
		return nil, fmt.Errorf("room id is required")
	}
	statePath := strings.TrimSpace(config.StatePath)
	if statePath == "" && strings.TrimSpace(config.StoreRoot) != "" {
		statePath = filepath.Join(filepath.Dir(config.StoreRoot), "state.json")
	}
	r := &Runtime{
		Sandbox:       box,
		mist:          config.Mist,
		statePath:     statePath,
		roomID:        roomID,
		nodeID:        nodeID,
		identity:      config.Identity,
		subscribers:   map[int]chan protocol.ShareEnvelope{},
		folderKeys:    map[string]string{},
		remoteFolders: map[string]domain.FolderRecord{},
		remoteFiles:   map[string]RemoteFile{},
	}
	if err := r.loadSyncState(); err != nil {
		return nil, err
	}
	return r, nil
}

// SetEventLogger installs a hook called for every parsed incoming envelope (used
// by verbose mode). Safe to call before connecting.
func (r *Runtime) SetEventLogger(fn func(protocol.ShareEnvelope)) {
	r.eventMu.Lock()
	r.eventLogger = fn
	r.eventMu.Unlock()
	r.ensureEventCallback()
}

// ensureEventCallback installs a single mist event callback that parses incoming
// raw messages into envelopes, logs them, verifies signatures and fans them out
// to subscribers.
func (r *Runtime) ensureEventCallback() {
	r.eventMu.Lock()
	if r.eventReady {
		r.eventMu.Unlock()
		return
	}
	r.eventReady = true
	r.eventMu.Unlock()

	r.mist.SetEventCallback(func(_ uint32, _ string, data []byte) {
		env, ok := protocol.ParseEnvelopeBytes(data)
		if !ok {
			return
		}
		r.eventMu.Lock()
		logger := r.eventLogger
		subs := make([]chan protocol.ShareEnvelope, 0, len(r.subscribers))
		for _, ch := range r.subscribers {
			subs = append(subs, ch)
		}
		r.eventMu.Unlock()

		if logger != nil {
			logger(env)
		}
		if !protocol.VerifyEnvelope(env) {
			return // reject envelopes without a valid Ed25519 signature
		}
		for _, ch := range subs {
			select {
			case ch <- env:
			default:
			}
		}
	})
}

// subscribeEnvelopes returns a channel of verified incoming envelopes and a
// cancel func to unsubscribe.
func (r *Runtime) subscribeEnvelopes() (<-chan protocol.ShareEnvelope, func()) {
	r.ensureEventCallback()
	ch := make(chan protocol.ShareEnvelope, 32)
	r.eventMu.Lock()
	id := r.nextSub
	r.nextSub++
	r.subscribers[id] = ch
	r.eventMu.Unlock()
	return ch, func() {
		r.eventMu.Lock()
		delete(r.subscribers, id)
		r.eventMu.Unlock()
	}
}

// sendEnvelope signs the envelope and sends it to the target peer.
func (r *Runtime) sendEnvelope(ctx context.Context, target string, env protocol.ShareEnvelope) error {
	signed, err := protocol.SignEnvelope(env, r.identity)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(signed)
	if err != nil {
		return err
	}
	return r.mist.SendMessage(ctx, target, payload, 0)
}

// StartContentSync listens for verified peer envelopes and mirrors remote shared
// content into the sandbox whenever the CLI knows the folder key. It also keeps
// lightweight metadata so the TUI can show remote content immediately.
func (r *Runtime) StartContentSync(ctx context.Context) <-chan SyncEvent {
	events := make(chan SyncEvent, 16)
	envelopes, unsubscribe := r.subscribeEnvelopes()
	go func() {
		defer close(events)
		defer unsubscribe()
		for {
			select {
			case <-ctx.Done():
				return
			case env := <-envelopes:
				for _, event := range r.applySyncEnvelope(ctx, env) {
					select {
					case events <- event:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()
	return events
}

func (r *Runtime) applySyncEnvelope(ctx context.Context, env protocol.ShareEnvelope) []SyncEvent {
	switch env.Type {
	case "folder-state":
		if env.FolderID == "" || env.CID == "" {
			return nil
		}
		folderKey := r.folderKey(env.FolderID)
		if folderKey == "" {
			return nil
		}
		bundle, err := r.fetchFolderBundle(ctx, env.CID, folderKey)
		if err != nil {
			return []SyncEvent{{Type: env.Type, Err: err}}
		}
		r.rememberRemoteFolders(bundle)
		r.rememberRemoteFiles(bundle)
		// A folder-state bundle is the authoritative snapshot of the shared
		// tree, so drop anything we tracked that the bundle no longer lists
		// (e.g. files/folders a peer deleted while we were offline).
		r.reconcileFolderState(bundle)
		result, err := r.downloadBundleFiles(ctx, protocol.PendingShare{FolderID: env.FolderID, FolderName: env.FolderName}, bundle, folderKey, func(string, ...any) {})
		return []SyncEvent{{Type: env.Type, Result: result, Err: err}}
	case "folder-change":
		return r.applyFolderChange(ctx, env)
	default:
		return nil
	}
}

func (r *Runtime) applyFolderChange(ctx context.Context, env protocol.ShareEnvelope) []SyncEvent {
	if env.ChangeType == "folder-deleted" && env.Folder != nil {
		r.syncMu.Lock()
		// Resolve the folder's sandbox path before removing it from the map.
		folderParts := remoteFolderPathParts(r.remoteFolders, env.Folder.ID)
		delete(r.remoteFolders, env.Folder.ID)
		// Drop any synced files that lived under the deleted folder.
		var removedPaths []string
		for id, f := range r.remoteFiles {
			if f.FolderID == env.Folder.ID {
				if p := orDefault(f.SyncedPath, f.Path); p != "" {
					removedPaths = append(removedPaths, p)
				}
				delete(r.remoteFiles, id)
			}
		}
		r.syncMu.Unlock()
		if len(folderParts) > 0 {
			_ = r.Sandbox.Remove(filepath.ToSlash(filepath.Join(folderParts...)))
		}
		for _, p := range removedPaths {
			_ = r.Sandbox.Remove(p)
		}
		r.saveSyncState()
		return []SyncEvent{{Type: env.Type}}
	}
	if env.ChangeType == "folder-upserted" && env.Folder != nil {
		r.rememberRemoteFolder(*env.Folder)
		r.refreshRemoteFilePaths()
		return []SyncEvent{{Type: env.Type}}
	}
	if env.ChangeType == "file-deleted" && env.FileID != "" {
		r.syncMu.Lock()
		file, ok := r.remoteFiles[env.FileID]
		delete(r.remoteFiles, env.FileID)
		r.syncMu.Unlock()
		if ok {
			if p := orDefault(file.SyncedPath, file.Path); p != "" {
				_ = r.Sandbox.Remove(p)
			}
		}
		r.saveSyncState()
		return []SyncEvent{{Type: env.Type}}
	}
	if env.ChangeType != "file-upserted" || env.FileID == "" {
		return nil
	}
	file := RemoteFile{FolderID: env.FolderID, FolderName: env.FolderName, FileID: env.FileID, Name: env.FileName, CID: env.CID}
	if env.File != nil {
		file.FolderID = orDefault(env.File.FolderID, file.FolderID)
		file.Name = orDefault(env.File.Name, file.Name)
		file.CID = orDefault(env.File.LastCID, file.CID)
		file.Size = env.File.Size
	}
	if file.Name == "" {
		file.Name = file.FileID
	}
	file.Path = r.remoteFilePath(file)
	r.rememberRemoteFile(file)
	events := []SyncEvent{{Type: env.Type, File: file}}
	folderKey := r.folderKey(env.FolderID)
	if folderKey == "" || file.CID == "" {
		return events
	}
	file, err := r.fetchRemoteFileContent(ctx, file, folderKey)
	if err != nil {
		events = append(events, SyncEvent{Type: env.Type, File: file, Err: err})
		return events
	}
	events = append(events, SyncEvent{Type: env.Type, File: file})
	return events
}

// FetchRemoteFile downloads a remote file previously learned from folder-change.
// It requires that FetchFolderShare has already learned the folder key.
func (r *Runtime) FetchRemoteFile(ctx context.Context, fileID string) (RemoteFile, error) {
	r.syncMu.Lock()
	file, ok := r.remoteFiles[fileID]
	r.syncMu.Unlock()
	if !ok {
		return RemoteFile{}, fmt.Errorf("remote file %q is not known yet", fileID)
	}
	if file.SyncedPath != "" {
		return file, nil
	}
	folderKey := r.folderKey(file.FolderID)
	if folderKey == "" {
		return file, fmt.Errorf("folder key is not known yet; press f and fetch the folder share URL first")
	}
	return r.fetchRemoteFileContent(ctx, file, folderKey)
}

func (r *Runtime) fetchRemoteFileContent(ctx context.Context, file RemoteFile, folderKey string) (RemoteFile, error) {
	if file.CID == "" {
		return file, fmt.Errorf("remote file %q has no cid", file.Name)
	}
	data, err := r.fetchFileContent(ctx, file.CID, folderKey)
	if err != nil {
		return file, err
	}
	rel := file.Path
	if rel == "" {
		rel = r.remoteFilePath(file)
	}
	if _, err := r.writeSandboxFile(rel, data); err != nil {
		return file, err
	}
	file.Path = rel
	file.SyncedPath = rel
	r.rememberRemoteFile(file)
	return file, nil
}

func (r *Runtime) rememberFolderKey(folderID, key string) {
	if folderID == "" || key == "" {
		return
	}
	r.syncMu.Lock()
	r.folderKeys[folderID] = key
	r.syncMu.Unlock()
	r.saveSyncState()
}

func (r *Runtime) folderKey(folderID string) string {
	r.syncMu.Lock()
	defer r.syncMu.Unlock()
	return r.folderKeys[folderID]
}

func (r *Runtime) rememberRemoteFile(file RemoteFile) {
	if file.FileID == "" {
		return
	}
	if file.Path == "" {
		file.Path = r.remoteFilePath(file)
	}
	r.syncMu.Lock()
	r.remoteFiles[file.FileID] = file
	r.syncMu.Unlock()
	r.saveSyncState()
}

func (r *Runtime) rememberRemoteFolders(bundle domain.FolderBundle) {
	folders := bundle.Folders
	if len(folders) == 0 && bundle.Folder.ID != "" {
		folders = []domain.FolderRecord{bundle.Folder}
	}
	r.syncMu.Lock()
	for _, folder := range folders {
		if folder.ID != "" && folder.DeletedAt == "" {
			r.remoteFolders[folder.ID] = folder
		}
	}
	r.syncMu.Unlock()
	r.refreshRemoteFilePaths()
	r.saveSyncState()
}

func (r *Runtime) rememberRemoteFolder(folder domain.FolderRecord) {
	if folder.ID == "" || folder.DeletedAt != "" {
		return
	}
	r.syncMu.Lock()
	r.remoteFolders[folder.ID] = folder
	r.syncMu.Unlock()
	r.saveSyncState()
}

func (r *Runtime) rememberRemoteFiles(bundle domain.FolderBundle) {
	for _, file := range bundle.Files {
		if file.ID == "" || file.DeletedAt != "" {
			continue
		}
		cid := file.LastShareCID
		if cid == "" {
			cid = file.LastCID
		}
		r.rememberRemoteFile(RemoteFile{
			FolderID: file.FolderID,
			FileID:   file.ID,
			Name:     file.Name,
			CID:      cid,
			Size:     file.Size,
		})
	}
}

// reconcileFolderState removes tracked files and folders that fall within the
// bundle's shared tree but are absent from (or tombstoned in) the bundle. This
// is how deletes that happened while this node was offline get applied: the
// authoritative folder-state snapshot wins over locally remembered state.
func (r *Runtime) reconcileFolderState(bundle domain.FolderBundle) {
	inBundleFolder := map[string]bool{}
	for _, f := range bundle.Folders {
		if f.ID != "" && f.DeletedAt == "" {
			inBundleFolder[f.ID] = true
		}
	}
	if bundle.Folder.ID != "" {
		inBundleFolder[bundle.Folder.ID] = true
	}
	if len(inBundleFolder) == 0 {
		return
	}
	inBundleFile := map[string]bool{}
	for _, f := range bundle.Files {
		if f.ID != "" && f.DeletedAt == "" {
			inBundleFile[f.ID] = true
		}
	}

	var removedPaths []string
	r.syncMu.Lock()
	// withinTree reports whether folderID's ancestor chain reaches a bundle
	// folder, i.e. it belongs to this shared tree (snapshot before mutation).
	withinTree := func(folderID string) bool {
		visited := map[string]bool{}
		for folderID != "" && !visited[folderID] {
			visited[folderID] = true
			if inBundleFolder[folderID] {
				return true
			}
			folder, ok := r.remoteFolders[folderID]
			if !ok || folder.ParentID == nil {
				return false
			}
			folderID = *folder.ParentID
		}
		return false
	}
	for id, file := range r.remoteFiles {
		if withinTree(file.FolderID) && !inBundleFile[id] {
			if p := orDefault(file.SyncedPath, file.Path); p != "" {
				removedPaths = append(removedPaths, p)
			}
			delete(r.remoteFiles, id)
		}
	}
	for id := range r.remoteFolders {
		if !inBundleFolder[id] && withinTree(id) {
			if parts := remoteFolderPathParts(r.remoteFolders, id); len(parts) > 0 {
				removedPaths = append(removedPaths, filepath.ToSlash(filepath.Join(parts...)))
			}
			delete(r.remoteFolders, id)
		}
	}
	r.syncMu.Unlock()

	for _, p := range removedPaths {
		_ = r.Sandbox.Remove(p)
	}
	r.saveSyncState()
}

func (r *Runtime) refreshRemoteFilePaths() {
	r.syncMu.Lock()
	files := make([]RemoteFile, 0, len(r.remoteFiles))
	for _, file := range r.remoteFiles {
		files = append(files, file)
	}
	r.syncMu.Unlock()

	for _, file := range files {
		file.Path = r.remoteFilePath(file)
		r.syncMu.Lock()
		r.remoteFiles[file.FileID] = file
		r.syncMu.Unlock()
	}
}

func (r *Runtime) remoteFilePath(file RemoteFile) string {
	r.syncMu.Lock()
	folders := make(map[string]domain.FolderRecord, len(r.remoteFolders))
	for id, folder := range r.remoteFolders {
		folders[id] = folder
	}
	r.syncMu.Unlock()

	parts := remoteFolderPathParts(folders, file.FolderID)
	if len(parts) == 0 {
		parts = append(parts, sanitizeName(orDefault(file.FolderName, "shared-folder")))
	}
	parts = append(parts, sanitizeName(orDefault(file.Name, file.FileID)))
	return filepath.ToSlash(filepath.Join(parts...))
}

func remoteFolderPathParts(folders map[string]domain.FolderRecord, folderID string) []string {
	var parts []string
	visited := map[string]bool{}
	for folderID != "" {
		if visited[folderID] {
			break
		}
		visited[folderID] = true
		folder, ok := folders[folderID]
		if !ok || folder.DeletedAt != "" {
			break
		}
		parts = append([]string{sanitizeName(folder.Name)}, parts...)
		if folder.ParentID == nil {
			break
		}
		folderID = *folder.ParentID
	}
	return parts
}

func (r *Runtime) loadSyncState() error {
	if r.statePath == "" {
		return nil
	}
	raw, err := os.ReadFile(r.statePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("load state: %w", err)
	}
	var state runtimeState
	if err := json.Unmarshal(raw, &state); err != nil {
		return fmt.Errorf("load state: %w", err)
	}
	r.syncMu.Lock()
	if state.FolderKeys != nil {
		r.folderKeys = state.FolderKeys
	}
	if state.RemoteFolders != nil {
		r.remoteFolders = state.RemoteFolders
	}
	if state.RemoteFiles != nil {
		r.remoteFiles = state.RemoteFiles
	}
	r.syncMu.Unlock()
	r.refreshRemoteFilePaths()
	return nil
}

func (r *Runtime) saveSyncState() {
	if r.statePath == "" {
		return
	}
	r.syncMu.Lock()
	state := runtimeState{
		FolderKeys:    make(map[string]string, len(r.folderKeys)),
		RemoteFolders: make(map[string]domain.FolderRecord, len(r.remoteFolders)),
		RemoteFiles:   make(map[string]RemoteFile, len(r.remoteFiles)),
	}
	for id, key := range r.folderKeys {
		state.FolderKeys[id] = key
	}
	for id, folder := range r.remoteFolders {
		state.RemoteFolders[id] = folder
	}
	for id, file := range r.remoteFiles {
		state.RemoteFiles[id] = file
	}
	r.syncMu.Unlock()

	bytes, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(r.statePath), 0o700); err != nil {
		return
	}
	_ = os.WriteFile(r.statePath, bytes, 0o600)
}

// RemoteFiles returns the peer file metadata currently known to the runtime.
func (r *Runtime) RemoteFiles() []RemoteFile {
	r.syncMu.Lock()
	defer r.syncMu.Unlock()
	files := make([]RemoteFile, 0, len(r.remoteFiles))
	for _, file := range r.remoteFiles {
		files = append(files, file)
	}
	sort.Slice(files, func(i, j int) bool {
		left := orDefault(files[i].Path, files[i].Name)
		right := orDefault(files[j].Path, files[j].Name)
		return left < right
	})
	return files
}

type sharedFolderTarget struct {
	Root   domain.FolderRecord
	Folder domain.FolderRecord
	Key    string
}

func (r *Runtime) StoreLocalFile(ctx context.Context, sandboxName string) (RemoteFile, error) {
	data, info, err := r.Sandbox.ReadFile(sandboxName)
	if err != nil {
		return RemoteFile{}, err
	}
	target, err := r.sharedFolderTargetForPath(sandboxName)
	if err != nil {
		return RemoteFile{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	sum := sha256.Sum256(data)
	fileID := "file-" + hex.EncodeToString(sum[:8])
	sortOrder := float64(time.Now().UnixMilli())
	mimeType := detectMime(sandboxName, data)
	fileWithContent := domain.FileRecord{
		ID:        fileID,
		FolderID:  target.Folder.ID,
		SortOrder: &sortOrder,
		Name:      filepath.Base(sandboxName),
		MimeType:  mimeType,
		Size:      info.Size(),
		DataURL:   dataURL(mimeType, data),
		Checksum:  hex.EncodeToString(sum[:]),
		Version:   1,
		Starred:   false,
		CreatedAt: now,
		UpdatedAt: now,
	}
	bundle := domain.FileBundle{
		Version:    1,
		ExportedAt: now,
		OriginNode: r.nodeID,
		Folder:     target.Root,
		File:       fileWithContent,
	}
	encrypted, err := protocol.EncryptJSON(bundle, target.Key)
	if err != nil {
		return RemoteFile{}, err
	}
	bytes, err := json.Marshal(encrypted)
	if err != nil {
		return RemoteFile{}, err
	}
	if err := r.connect(ctx); err != nil {
		return RemoteFile{}, err
	}
	cid, err := r.mist.StorageAdd(ctx, fileID+".tc-file.enc.json", bytes)
	if err != nil {
		return RemoteFile{}, err
	}
	fileMeta := fileWithContent
	fileMeta.DataURL = ""
	fileMeta.LastCID = cid
	envelope := protocol.ShareEnvelope{
		Type:       "folder-change",
		From:       r.nodeID,
		RoomID:     r.roomID,
		SentAt:     time.Now().UTC().Format(time.RFC3339Nano),
		Clock:      time.Now().UnixMilli(),
		ChangeType: "file-upserted",
		FolderID:   target.Root.ID,
		FolderName: target.Root.Name,
		FileID:     fileMeta.ID,
		FileName:   fileMeta.Name,
		File:       &fileMeta,
		CID:        cid,
	}
	for _, peer := range r.ConnectedPeers(ctx) {
		_ = r.sendEnvelope(ctx, peer, envelope)
	}
	stored := RemoteFile{FolderID: fileMeta.FolderID, FolderName: target.Root.Name, FileID: fileMeta.ID, Name: fileMeta.Name, CID: cid, Size: fileMeta.Size, Path: filepath.ToSlash(sandboxName), SyncedPath: filepath.ToSlash(sandboxName)}
	// Track files we contribute to a shared folder so that a peer deleting them
	// (in real time or while we are offline) removes our local copy too.
	r.rememberRemoteFile(stored)
	return stored, nil
}

func (r *Runtime) DeleteLocalPath(ctx context.Context, sandboxName string) (string, error) {
	rel := filepath.ToSlash(filepath.Clean(sandboxName))
	if rel == "." || strings.HasPrefix(rel, "../") {
		return "", sandbox.ErrOutsideSandbox
	}
	info, err := os.Stat(filepath.Join(r.Sandbox.Root(), filepath.FromSlash(rel)))
	if err != nil {
		return "", err
	}
	if err := r.announceSharedDelete(ctx, rel, info.IsDir()); err != nil {
		return "", err
	}
	if err := r.Sandbox.Remove(rel); err != nil {
		return "", err
	}
	return "deleted " + rel, nil
}

func (r *Runtime) DeleteRemoteFile(ctx context.Context, fileID string) (string, error) {
	r.syncMu.Lock()
	file, ok := r.remoteFiles[fileID]
	r.syncMu.Unlock()
	if !ok {
		return "", fmt.Errorf("remote file %q is not known yet", fileID)
	}
	if err := r.announceFileDeleted(ctx, file); err != nil {
		return "", err
	}
	r.syncMu.Lock()
	delete(r.remoteFiles, fileID)
	r.syncMu.Unlock()
	r.saveSyncState()
	return "deleted " + orDefault(file.Path, file.Name), nil
}

func (r *Runtime) announceSharedDelete(ctx context.Context, rel string, isDir bool) error {
	if isDir {
		target, err := r.sharedFolderTargetForPath(rel)
		if err != nil {
			return nil
		}
		if target.Folder.ID == target.Root.ID {
			return nil
		}
		return r.announceFolderDeleted(ctx, target.Root, target.Folder)
	}
	for _, file := range r.RemoteFiles() {
		if filepath.ToSlash(file.SyncedPath) == rel || filepath.ToSlash(file.Path) == rel {
			return r.announceFileDeleted(ctx, file)
		}
	}
	return nil
}

func (r *Runtime) announceFileDeleted(ctx context.Context, file RemoteFile) error {
	target, err := r.sharedFolderTargetForPath(orDefault(file.Path, file.Name))
	if err != nil {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	deleted := domain.FileRecord{
		ID:        file.FileID,
		FolderID:  file.FolderID,
		Name:      file.Name,
		Size:      file.Size,
		LastCID:   file.CID,
		DeletedAt: now,
		UpdatedAt: now,
	}
	env := protocol.ShareEnvelope{
		Type:       "folder-change",
		From:       r.nodeID,
		RoomID:     r.roomID,
		SentAt:     now,
		Clock:      time.Now().UnixMilli(),
		ChangeType: "file-deleted",
		FolderID:   target.Root.ID,
		FolderName: target.Root.Name,
		FileID:     file.FileID,
		FileName:   file.Name,
		File:       &deleted,
		CID:        file.CID,
	}
	return r.broadcastEnvelope(ctx, env)
}

func (r *Runtime) announceFolderDeleted(ctx context.Context, root, folder domain.FolderRecord) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	deleted := folder
	deleted.DeletedAt = now
	deleted.UpdatedAt = now
	env := protocol.ShareEnvelope{
		Type:       "folder-change",
		From:       r.nodeID,
		RoomID:     r.roomID,
		SentAt:     now,
		Clock:      time.Now().UnixMilli(),
		ChangeType: "folder-deleted",
		FolderID:   root.ID,
		FolderName: root.Name,
		Folder:     &deleted,
	}
	return r.broadcastEnvelope(ctx, env)
}

func (r *Runtime) broadcastEnvelope(ctx context.Context, env protocol.ShareEnvelope) error {
	if err := r.connect(ctx); err != nil {
		return err
	}
	for _, peer := range r.ConnectedPeers(ctx) {
		if err := r.sendEnvelope(ctx, peer, env); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) sharedFolderTargetForPath(sandboxName string) (sharedFolderTarget, error) {
	clean := filepath.ToSlash(filepath.Clean(sandboxName))
	r.syncMu.Lock()
	folders := make(map[string]domain.FolderRecord, len(r.remoteFolders))
	keys := make(map[string]string, len(r.folderKeys))
	for id, folder := range r.remoteFolders {
		folders[id] = folder
	}
	for id, key := range r.folderKeys {
		keys[id] = key
	}
	r.syncMu.Unlock()

	var best domain.FolderRecord
	bestPath := ""
	for _, folder := range folders {
		parts := remoteFolderPathParts(folders, folder.ID)
		if len(parts) == 0 {
			continue
		}
		folderPath := filepath.ToSlash(filepath.Join(parts...))
		if clean == folderPath || strings.HasPrefix(clean, folderPath+"/") {
			if len(folderPath) > len(bestPath) {
				best = folder
				bestPath = folderPath
			}
		}
	}
	if best.ID == "" {
		return sharedFolderTarget{}, fmt.Errorf("%s is not inside a known shared folder; press f to fetch a folder share first", sandboxName)
	}
	root := sharedRootFolder(folders, best.ID)
	if root.ID == "" {
		root = best
	}
	key := keys[root.ID]
	if key == "" {
		return sharedFolderTarget{}, fmt.Errorf("shared folder key for %q is not known; press f and fetch the folder share URL first", root.Name)
	}
	return sharedFolderTarget{Root: root, Folder: best, Key: key}, nil
}

func sharedRootFolder(folders map[string]domain.FolderRecord, folderID string) domain.FolderRecord {
	folder := folders[folderID]
	visited := map[string]bool{}
	for folder.ID != "" && folder.ParentID != nil && !visited[folder.ID] {
		visited[folder.ID] = true
		parent := folders[*folder.ParentID]
		if parent.ID == "" {
			break
		}
		folder = parent
	}
	return folder
}

func (r *Runtime) PutFile(ctx context.Context, sandboxName string, passphrase string) (string, error) {
	data, info, err := r.Sandbox.ReadFile(sandboxName)
	if err != nil {
		return "", err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	sum := sha256.Sum256(data)
	fileID := "file-" + hex.EncodeToString(sum[:8])
	folderID := "folder-cli-sandbox"
	sortOrder := float64(time.Now().UnixMilli())
	folder := domain.FolderRecord{
		ID:           folderID,
		Name:         "CLI Sandbox",
		ParentID:     nil,
		SortOrder:    &sortOrder,
		Color:        "slate",
		Encrypted:    true,
		ShareEnabled: false,
		SharedRoomID: r.roomID,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	file := domain.FileRecord{
		ID:        fileID,
		FolderID:  folderID,
		SortOrder: &sortOrder,
		Name:      filepath.Base(sandboxName),
		MimeType:  detectMime(sandboxName, data),
		Size:      info.Size(),
		DataURL:   dataURL(detectMime(sandboxName, data), data),
		Checksum:  hex.EncodeToString(sum[:]),
		Version:   1,
		Starred:   false,
		CreatedAt: now,
		UpdatedAt: now,
	}
	bundle := domain.FileBundle{
		Version:    1,
		ExportedAt: now,
		OriginNode: r.nodeID,
		Folder:     folder,
		File:       file,
	}
	encrypted, err := protocol.EncryptJSON(bundle, strings.TrimSpace(passphrase))
	if err != nil {
		return "", err
	}
	bytes, err := json.Marshal(encrypted)
	if err != nil {
		return "", err
	}
	if err := r.connect(ctx); err != nil {
		return "", err
	}
	return r.mist.StorageAdd(ctx, file.ID+".tc-file.enc.json", bytes)
}

// connect initializes the mist node, joins the configured room and positions
// the node on the AOI overlay (matching the web app via positionForSharedRoom).
// Positioning is what lets peer connections form, so it must happen before any
// storage transfer. It then waits briefly for at least one connected peer.
// Storage retrieval over the real P2P network requires being connected first;
// for the local store backend these calls are cheap no-ops.
func (r *Runtime) connect(ctx context.Context) error {
	if err := r.establish(ctx); err != nil {
		return err
	}
	if r.mist.Networked() {
		r.waitForPeer(ctx, 20*time.Second)
	}
	return nil
}

// establish initializes the node, joins the room and positions it on the
// overlay, without waiting for peers. Safe to call once at startup to begin
// connecting immediately; re-calling re-asserts the overlay position.
func (r *Runtime) establish(ctx context.Context) error {
	r.establishMu.Lock()
	defer r.establishMu.Unlock()
	if r.established {
		// The mist node is a process-wide singleton; re-running Init/JoinRoom
		// tears down the live connection. Once established, only re-assert the
		// overlay position to keep the node present.
		x, y, z := positionForSharedRoom(r.roomID, r.nodeID)
		return r.mist.UpdatePosition(ctx, x, y, z)
	}
	if err := r.mist.Init(ctx, r.nodeID, `{"signaling":{"mode":"nostr","nostr":{"relays":[]}}}`); err != nil {
		return err
	}
	if err := r.mist.JoinRoom(ctx, r.roomID); err != nil {
		return err
	}
	x, y, z := positionForSharedRoom(r.roomID, r.nodeID)
	if err := r.mist.UpdatePosition(ctx, x, y, z); err != nil {
		return err
	}
	r.established = true
	return nil
}

// Establish begins a session (init + join + position) without blocking on
// peers. The TUI calls this at startup so the node starts connecting right away.
func (r *Runtime) Establish(ctx context.Context) error {
	return r.establish(ctx)
}

// Reposition re-asserts the overlay coordinate to keep the node present.
func (r *Runtime) Reposition(ctx context.Context) error {
	x, y, z := positionForSharedRoom(r.roomID, r.nodeID)
	return r.mist.UpdatePosition(ctx, x, y, z)
}

// Networked reports whether the backend talks to real peers.
func (r *Runtime) Networked() bool { return r.mist.Networked() }

// waitForPeer polls engine stats until at least one peer reaches a connected
// state or the timeout elapses. It never fails: a timeout just means the
// subsequent storage call proceeds and may itself fail if no seeder is present.
func (r *Runtime) waitForPeer(ctx context.Context, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if connectedPeers(r.connectedNodes(ctx)) > 0 {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func (r *Runtime) connectedNodes(ctx context.Context) []nodeStat {
	raw, err := r.mist.Stats(ctx)
	if err != nil {
		return nil
	}
	var stats struct {
		Nodes []nodeStat `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &stats); err != nil {
		return nil
	}
	return stats.Nodes
}

type nodeStat struct {
	ID              string `json:"id"`
	ConnectionState string `json:"connectionState"`
}

func connectedPeers(nodes []nodeStat) int {
	count := 0
	for _, node := range nodes {
		if strings.EqualFold(node.ConnectionState, "connected") {
			count++
		}
	}
	return count
}

func (r *Runtime) GetFile(ctx context.Context, cid string, passphrase string) (domain.FileRecord, error) {
	if err := r.connect(ctx); err != nil {
		return domain.FileRecord{}, err
	}
	bytes, err := r.mist.StorageGet(ctx, strings.TrimSpace(cid))
	if err != nil {
		return domain.FileRecord{}, err
	}
	var encrypted protocol.EncryptedPayload
	if err := json.Unmarshal(bytes, &encrypted); err != nil {
		return domain.FileRecord{}, err
	}
	bundle, err := protocol.DecryptJSON[domain.FileBundle](encrypted, strings.TrimSpace(passphrase))
	if err != nil {
		return domain.FileRecord{}, err
	}
	return bundle.File, nil
}

func ParseShareLink(raw string) (protocol.LinkedShare, error) {
	return protocol.ParseShareLink(raw)
}

func detectMime(name string, data []byte) string {
	if ext := filepath.Ext(name); ext != "" {
		if value := mime.TypeByExtension(ext); value != "" {
			return value
		}
	}
	return http.DetectContentType(data)
}

func dataURL(mimeType string, data []byte) string {
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data)
}
