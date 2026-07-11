package protocol

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// Matches src/crypto/accessGrantCrypto.ts: ECDH P-256 where the WebCrypto
// deriveKey(ECDH -> AES-GCM-256) uses the raw shared-secret X coordinate
// (32 bytes) directly as the AES-256 key (no KDF). Public keys are raw
// uncompressed points (65 bytes, 0x04 prefix) encoded base64url; cipherText and
// iv are standard base64.

// AccessRequestKey is the requester's ephemeral ECDH key pair.
type AccessRequestKey struct {
	Private   *ecdh.PrivateKey
	PublicKey string // base64url raw uncompressed point
}

// CreateAccessRequestKey generates an ECDH P-256 key pair for a folder-access-request.
func CreateAccessRequestKey() (AccessRequestKey, error) {
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return AccessRequestKey{}, err
	}
	return AccessRequestKey{
		Private:   priv,
		PublicKey: base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes()),
	}, nil
}

// DecryptFolderKeyGrant derives the AES key via ECDH and decrypts the folder key.
func DecryptFolderKeyGrant(cipherTextB64, ivB64 string, priv *ecdh.PrivateKey, peerPublicKeyB64url string) (string, error) {
	peerRaw, err := decodeBase64URL(peerPublicKeyB64url)
	if err != nil {
		return "", fmt.Errorf("grant public key: %w", err)
	}
	peerPub, err := ecdh.P256().NewPublicKey(peerRaw)
	if err != nil {
		return "", fmt.Errorf("grant public key: %w", err)
	}
	secret, err := priv.ECDH(peerPub)
	if err != nil {
		return "", err
	}
	// secret is the 32-byte X coordinate, used directly as the AES-256 key.
	block, err := aes.NewCipher(secret)
	if err != nil {
		return "", err
	}
	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv, err := base64.StdEncoding.DecodeString(ivB64)
	if err != nil {
		return "", fmt.Errorf("grant iv: %w", err)
	}
	cipherText, err := base64.StdEncoding.DecodeString(cipherTextB64)
	if err != nil {
		return "", fmt.Errorf("grant ciphertext: %w", err)
	}
	plain, err := aesgcm.Open(nil, iv, cipherText, nil)
	if err != nil {
		return "", err
	}
	var payload struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(plain, &payload); err != nil {
		return "", err
	}
	if payload.Key == "" {
		return "", fmt.Errorf("access grant did not contain a folder key")
	}
	return payload.Key, nil
}

func decodeBase64URL(value string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(value, "="))
}
