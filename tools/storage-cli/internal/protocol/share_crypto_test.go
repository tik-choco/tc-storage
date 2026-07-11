package protocol

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
)

func sealAESGCMForTest(t *testing.T, key, iv, plain []byte) []byte {
	t.Helper()
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	return aesgcm.Seal(nil, iv, plain, nil)
}

const (
	sampleFolder  = "folder-00000000-0000-4000-8000-000000000001"
	sampleKeyHash = "0000000000000000000000000000000000000000000000000000000000000001"
)

func TestParseFolderShareLink(t *testing.T) {
	owner, err := GenerateDidIdentity()
	if err != nil {
		t.Fatal(err)
	}
	url := folderShareURLForTest(t, owner.Did)
	ls, err := ParseShareLink(url)
	if err != nil {
		t.Fatal(err)
	}
	if ls.Share.Type != "folder-share" || ls.Share.FolderID != sampleFolder ||
		ls.Share.OwnerNodeID != owner.Did || ls.Share.FolderKeyHash != sampleKeyHash ||
		ls.Share.AccessGrantMode != "owner" {
		t.Fatalf("unexpected parsed share: %+v", ls.Share)
	}
}

func folderShareURLForTest(t *testing.T, ownerDidKey string) string {
	t.Helper()
	payload := shareLinkPayload{
		Version:         1,
		Type:            "folder-share",
		RoomID:          "tc-storage-fixture-room",
		FolderID:        sampleFolder,
		FolderName:      "Fixture Folder",
		OwnerNodeID:     ownerDidKey,
		AccessGrantMode: "owner",
		FolderKeyHash:   sampleKeyHash,
		SenderProfile:   &ShareProfile{Name: "fixture-user"},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return "https://example.test/#tc-share=" + base64.RawURLEncoding.EncodeToString(raw)
}

func TestEd25519DidKeyRoundTrip(t *testing.T) {
	id, err := GenerateDidIdentity()
	if err != nil {
		t.Fatal(err)
	}
	pub, ok := Ed25519PubFromDidKey(id.Did)
	if !ok {
		t.Fatalf("failed to parse generated did:key")
	}
	if len(pub) != 32 {
		t.Fatalf("ed25519 public key must be 32 bytes, got %d", len(pub))
	}
	if got := DidKeyFromEd25519Pub(pub); got != id.Did {
		t.Fatalf("re-encoded did:key mismatch:\n got %s\nwant %s", got, id.Did)
	}
	if IsEd25519DidKey("did:key:tc-storage-cli-local") {
		t.Fatalf("non-canonical did:key must be rejected")
	}
}

func TestGenerateSignVerify(t *testing.T) {
	id, err := GenerateDidIdentity()
	if err != nil {
		t.Fatal(err)
	}
	env := ShareEnvelope{Type: "folder-access-request", From: id.Did, RoomID: "r", SentAt: "t", Clock: 0, FolderID: sampleFolder}
	signed, err := SignEnvelope(env, id)
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyEnvelope(signed) {
		t.Fatalf("signed envelope failed verification")
	}
	// Tampering invalidates the signature.
	signed.FolderID = "other"
	if VerifyEnvelope(signed) {
		t.Fatalf("tampered envelope must not verify")
	}
}

// A persisted seed reproduces the same did:key and signing key.
func TestSeedRoundTrip(t *testing.T) {
	id, err := GenerateDidIdentity()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := NewDidIdentityFromSeed(id.Seed())
	if err != nil {
		t.Fatal(err)
	}
	if restored.Did != id.Did {
		t.Fatalf("seed did not restore did: %s != %s", restored.Did, id.Did)
	}
	if id.Sign("payload") != restored.Sign("payload") {
		t.Fatalf("restored identity produced a different signature")
	}
}

func TestFolderKeyHashMatchesSampleFormat(t *testing.T) {
	// The hash is deterministic; a wrong passphrase must not match the sample.
	if MatchesFolderKeyHash(sampleFolder, "definitely-wrong-key", sampleKeyHash) {
		t.Fatalf("unexpected folder key hash match")
	}
	if len(FolderKeyHash(sampleFolder, "k")) != 64 {
		t.Fatalf("folder key hash must be 64 hex chars")
	}
}

// Mirrors the web app's encryptFolderKeyForRequest: ECDH P-256 shared X used
// directly as the AES-256-GCM key. We encrypt in Go the same way and confirm
// DecryptFolderKeyGrant recovers the folder key.
func TestAccessGrantRoundTrip(t *testing.T) {
	requester, err := CreateAccessRequestKey()
	if err != nil {
		t.Fatal(err)
	}
	folderKey := "super-secret-folder-key"
	cipherTextB64, ivB64, grantPubB64 := encryptGrantForTest(t, folderKey, requester.PublicKey)

	got, err := DecryptFolderKeyGrant(cipherTextB64, ivB64, requester.Private, grantPubB64)
	if err != nil {
		t.Fatal(err)
	}
	if got != folderKey {
		t.Fatalf("recovered folder key mismatch: %q != %q", got, folderKey)
	}
}

func encryptGrantForTest(t *testing.T, folderKey, requesterPubB64url string) (cipherTextB64, ivB64, grantPubB64url string) {
	t.Helper()
	reqRaw, err := base64.RawURLEncoding.DecodeString(requesterPubB64url)
	if err != nil {
		t.Fatal(err)
	}
	reqPub, err := ecdh.P256().NewPublicKey(reqRaw)
	if err != nil {
		t.Fatal(err)
	}
	grantPriv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := grantPriv.ECDH(reqPub)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]string{"key": folderKey})
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		t.Fatal(err)
	}
	ct := sealAESGCMForTest(t, secret, iv, payload)
	return base64.StdEncoding.EncodeToString(ct),
		base64.StdEncoding.EncodeToString(iv),
		base64.RawURLEncoding.EncodeToString(grantPriv.PublicKey().Bytes())
}
