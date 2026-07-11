package protocol

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Matches src/crypto/folderKeyProof.ts.
const (
	folderKeyHashPrefix    = "tc-storage-folder-key-v1"
	accessGrantProofPrefix = "tc-storage-folder-access-grant-v1"
)

// FolderKeyHash = hex(sha256("tc-storage-folder-key-v1\0folderId\0passphrase")).
func FolderKeyHash(folderID, passphrase string) string {
	sum := sha256.Sum256([]byte(folderKeyHashPrefix + "\x00" + folderID + "\x00" + strings.TrimSpace(passphrase)))
	return hex.EncodeToString(sum[:])
}

// MatchesFolderKeyHash reports whether the passphrase reproduces expectedHash.
func MatchesFolderKeyHash(folderID, passphrase, expectedHash string) bool {
	return expectedHash != "" && FolderKeyHash(folderID, passphrase) == expectedHash
}

// FolderAccessGrantProof = hex(hmacSha256(passphrase, "...\0folderId\0requestId\0targetNodeId")).
func FolderAccessGrantProof(passphrase, folderID, requestID, targetNodeID string) string {
	mac := hmac.New(sha256.New, []byte(strings.TrimSpace(passphrase)))
	mac.Write([]byte(accessGrantProofPrefix + "\x00" + folderID + "\x00" + requestID + "\x00" + targetNodeID))
	return hex.EncodeToString(mac.Sum(nil))
}
