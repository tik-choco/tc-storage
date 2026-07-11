package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"tc-storage-cli/internal/domain"
	"tc-storage-cli/internal/protocol"
)

// FolderShareResult summarizes a completed folder-share download.
type FolderShareResult struct {
	FolderName string
	Files      []string // sandbox-relative paths written
	Skipped    []string // file names skipped (no content cid / decode error)
}

// FetchFolderShare runs the full web-app folder-share receive flow: it requests
// access from the owner, waits for the owner's manual approval (grant), decrypts
// the folder key, fetches the folder manifest and every file, decrypts them and
// writes the contents into the sandbox. progress (optional) receives status lines.
func (r *Runtime) FetchFolderShare(ctx context.Context, shareURL string, progress func(string)) (FolderShareResult, error) {
	log := func(format string, args ...any) {
		if progress != nil {
			progress(fmt.Sprintf(format, args...))
		}
	}

	linked, err := protocol.ParseShareLink(shareURL)
	if err != nil {
		return FolderShareResult{}, err
	}
	share := linked.Share
	if share.Type != "folder-share" {
		return FolderShareResult{}, fmt.Errorf("not a folder-share link (type %q)", share.Type)
	}
	if !protocol.IsEd25519DidKey(share.OwnerNodeID) {
		return FolderShareResult{}, fmt.Errorf("share owner is not a valid did:key")
	}
	if share.FolderID == "" || share.FolderKeyHash == "" {
		return FolderShareResult{}, fmt.Errorf("share link missing folderId/folderKeyHash")
	}
	if share.RoomID != r.roomID {
		return FolderShareResult{}, fmt.Errorf("share room %q does not match --room %q", share.RoomID, r.roomID)
	}
	if !r.mist.Networked() {
		return FolderShareResult{}, fmt.Errorf("folder-share requires the native mistlib build")
	}

	envelopes, unsubscribe := r.subscribeEnvelopes()
	defer unsubscribe()

	if err := r.establish(ctx); err != nil {
		return FolderShareResult{}, err
	}
	log("connecting to owner %s…", protocol.Short(share.OwnerNodeID))
	if err := r.waitForOwner(ctx, share.OwnerNodeID, 40*time.Second); err != nil {
		return FolderShareResult{}, err
	}

	reqKey, err := protocol.CreateAccessRequestKey()
	if err != nil {
		return FolderShareResult{}, err
	}
	requestID := fmt.Sprintf("access-%d-%s", time.Now().UnixMilli(), hex.EncodeToString(randSuffix()))
	request := protocol.ShareEnvelope{
		Type:            "folder-access-request",
		From:            r.nodeID,
		RoomID:          r.roomID,
		SentAt:          time.Now().UTC().Format(time.RFC3339Nano),
		Clock:           0,
		FolderID:        share.FolderID,
		FolderName:      share.FolderName,
		AccessGrantMode: orDefault(share.AccessGrantMode, "owner"),
		FolderKeyHash:   share.FolderKeyHash,
		TargetNodeID:    share.OwnerNodeID,
		RequestID:       requestID,
		AccessPublicKey: reqKey.PublicKey,
		SenderProfile:   &protocol.ShareProfile{Name: "tc-storage-cli"},
	}

	folderKey, grantCID, err := r.requestAndAwaitGrant(ctx, share, request, reqKey, envelopes, log)
	if err != nil {
		return FolderShareResult{}, err
	}
	r.rememberFolderKey(share.FolderID, folderKey)

	cid := grantCID
	if cid == "" {
		log("waiting for folder-state…")
		cid, err = r.awaitFolderStateCID(ctx, share, envelopes, 60*time.Second)
		if err != nil {
			return FolderShareResult{}, err
		}
	}

	log("fetching folder manifest (%s)…", protocol.Short(cid))
	bundle, err := r.fetchFolderBundle(ctx, cid, folderKey)
	if err != nil {
		return FolderShareResult{}, err
	}

	return r.downloadBundleFiles(ctx, share, bundle, folderKey, log)
}

// requestAndAwaitGrant sends the access request (re-sending periodically while
// waiting, since the owner must approve manually) until a matching grant
// arrives, then decrypts and validates the folder key.
func (r *Runtime) requestAndAwaitGrant(
	ctx context.Context,
	share protocol.PendingShare,
	request protocol.ShareEnvelope,
	reqKey protocol.AccessRequestKey,
	envelopes <-chan protocol.ShareEnvelope,
	log func(string, ...any),
) (folderKey, cid string, err error) {
	if err := r.sendEnvelope(ctx, share.OwnerNodeID, request); err != nil {
		return "", "", err
	}
	log("access request sent — waiting for owner approval…")

	resend := time.NewTicker(5 * time.Second)
	defer resend.Stop()
	deadline := time.After(5 * time.Minute)

	for {
		select {
		case <-ctx.Done():
			return "", "", ctx.Err()
		case <-deadline:
			return "", "", fmt.Errorf("timed out waiting for owner approval")
		case <-resend.C:
			_ = r.sendEnvelope(ctx, share.OwnerNodeID, request)
		case env := <-envelopes:
			if env.Type == "folder-access-denied" && env.RequestID == request.RequestID {
				return "", "", fmt.Errorf("owner denied the access request")
			}
			if env.Type != "folder-access-grant" || env.RequestID != request.RequestID {
				continue
			}
			if env.From != share.OwnerNodeID {
				continue
			}
			if env.AccessGrantPublicKey == "" || env.AccessGrantIv == "" || env.AccessGrantCipherText == "" {
				continue
			}
			key, decErr := protocol.DecryptFolderKeyGrant(env.AccessGrantCipherText, env.AccessGrantIv, reqKey.Private, env.AccessGrantPublicKey)
			if decErr != nil {
				return "", "", fmt.Errorf("decrypt grant: %w", decErr)
			}
			if !protocol.MatchesFolderKeyHash(share.FolderID, key, share.FolderKeyHash) {
				return "", "", fmt.Errorf("granted folder key failed hash verification")
			}
			log("access granted — folder key received")
			return key, env.CID, nil
		}
	}
}

func (r *Runtime) awaitFolderStateCID(ctx context.Context, share protocol.PendingShare, envelopes <-chan protocol.ShareEnvelope, timeout time.Duration) (string, error) {
	deadline := time.After(timeout)
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-deadline:
			return "", fmt.Errorf("timed out waiting for folder-state")
		case env := <-envelopes:
			if env.Type == "folder-state" && env.FolderID == share.FolderID && env.CID != "" {
				return env.CID, nil
			}
		}
	}
}

func (r *Runtime) fetchFolderBundle(ctx context.Context, cid, folderKey string) (domain.FolderBundle, error) {
	raw, err := r.mist.StorageGet(ctx, cid)
	if err != nil {
		return domain.FolderBundle{}, err
	}
	var payload protocol.EncryptedPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return domain.FolderBundle{}, fmt.Errorf("folder bundle parse: %w", err)
	}
	return protocol.DecryptJSON[domain.FolderBundle](payload, folderKey)
}

func (r *Runtime) downloadBundleFiles(ctx context.Context, share protocol.PendingShare, bundle domain.FolderBundle, folderKey string, log func(string, ...any)) (FolderShareResult, error) {
	folderName := orDefault(orDefault(bundle.Folder.Name, share.FolderName), "shared-folder")
	result := FolderShareResult{FolderName: folderName}
	log("folder %q: %d file(s)", folderName, len(bundle.Files))
	r.rememberRemoteFolders(bundle)
	r.rememberRemoteFiles(bundle)
	folders := map[string]domain.FolderRecord{}
	for _, folder := range bundle.Folders {
		if folder.ID != "" && folder.DeletedAt == "" {
			folders[folder.ID] = folder
		}
	}
	if len(folders) == 0 && bundle.Folder.ID != "" {
		folders[bundle.Folder.ID] = bundle.Folder
	}

	for _, file := range bundle.Files {
		if file.DeletedAt != "" {
			continue
		}
		cid := file.LastShareCID
		if cid == "" {
			cid = file.LastCID
		}
		if cid == "" {
			result.Skipped = append(result.Skipped, file.Name+" (no content cid)")
			continue
		}
		data, err := r.fetchFileContent(ctx, cid, folderKey)
		if err != nil {
			result.Skipped = append(result.Skipped, fmt.Sprintf("%s (%v)", file.Name, err))
			continue
		}
		parts := remoteFolderPathParts(folders, file.FolderID)
		if len(parts) == 0 {
			parts = append(parts, sanitizeName(folderName))
		}
		parts = append(parts, sanitizeName(file.Name))
		rel := filepath.ToSlash(filepath.Join(parts...))
		if _, err := r.writeSandboxFile(rel, data); err != nil {
			return result, err
		}
		if file.Checksum != "" {
			if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != file.Checksum {
				result.Skipped = append(result.Skipped, file.Name+" (checksum mismatch)")
				continue
			}
		}
		result.Files = append(result.Files, rel)
		log("saved %s (%d bytes)", rel, len(data))
	}
	return result, nil
}

// fetchFileContent retrieves an encrypted file bundle and returns the decoded
// file bytes from its data URL.
func (r *Runtime) fetchFileContent(ctx context.Context, cid, folderKey string) ([]byte, error) {
	raw, err := r.mist.StorageGet(ctx, cid)
	if err != nil {
		return nil, err
	}
	var payload protocol.EncryptedPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("file bundle parse: %w", err)
	}
	bundle, err := protocol.DecryptJSON[domain.FileBundle](payload, folderKey)
	if err != nil {
		return nil, err
	}
	return decodeDataURL(bundle.File.DataURL)
}

func (r *Runtime) waitForOwner(ctx context.Context, ownerNodeID string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, id := range r.ConnectedPeers(ctx) {
			if id == ownerNodeID {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
	return fmt.Errorf("owner %s did not connect within %s", protocol.Short(ownerNodeID), timeout)
}

func (r *Runtime) writeSandboxFile(name string, data []byte) (string, error) {
	path, err := r.Sandbox.Resolve(name)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return name, nil
}

func decodeDataURL(dataURL string) ([]byte, error) {
	if dataURL == "" {
		return nil, fmt.Errorf("file has no content")
	}
	comma := strings.IndexByte(dataURL, ',')
	if !strings.HasPrefix(dataURL, "data:") || comma < 0 {
		return nil, fmt.Errorf("invalid data url")
	}
	meta, body := dataURL[5:comma], dataURL[comma+1:]
	if strings.Contains(meta, "base64") {
		return base64.StdEncoding.DecodeString(body)
	}
	return []byte(body), nil
}

func sanitizeName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, "\\", "_")
	if name == "" || name == "." || name == ".." {
		return "untitled"
	}
	return name
}

func orDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func randSuffix() []byte {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return b
}
