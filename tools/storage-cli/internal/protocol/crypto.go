package protocol

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"crypto/pbkdf2"
)

const (
	webCryptoIterations = 210000
	minIterations       = 100000
	maxIterations       = 1000000
)

type EncryptedPayload struct {
	Version    int    `json:"version"`
	Algorithm  string `json:"algorithm"`
	KDF        string `json:"kdf"`
	Iterations int    `json:"iterations"`
	Salt       string `json:"salt"`
	IV         string `json:"iv"`
	CipherText string `json:"cipherText"`
}

func EncryptJSON(value any, passphrase string) (EncryptedPayload, error) {
	if passphrase == "" {
		return EncryptedPayload{}, fmt.Errorf("passphrase is required")
	}
	plain, err := json.Marshal(value)
	if err != nil {
		return EncryptedPayload{}, err
	}
	salt, err := randomBytes(16)
	if err != nil {
		return EncryptedPayload{}, err
	}
	iv, err := randomBytes(12)
	if err != nil {
		return EncryptedPayload{}, err
	}
	key, err := pbkdf2.Key(sha256.New, passphrase, salt, webCryptoIterations, 32)
	if err != nil {
		return EncryptedPayload{}, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return EncryptedPayload{}, err
	}
	seal, err := cipher.NewGCM(block)
	if err != nil {
		return EncryptedPayload{}, err
	}
	return EncryptedPayload{
		Version:    1,
		Algorithm:  "AES-GCM",
		KDF:        "PBKDF2-SHA256",
		Iterations: webCryptoIterations,
		Salt:       base64.StdEncoding.EncodeToString(salt),
		IV:         base64.StdEncoding.EncodeToString(iv),
		CipherText: base64.StdEncoding.EncodeToString(seal.Seal(nil, iv, plain, nil)),
	}, nil
}

func DecryptJSON[T any](payload EncryptedPayload, passphrase string) (T, error) {
	var zero T
	if passphrase == "" {
		return zero, fmt.Errorf("passphrase is required")
	}
	if err := payload.Validate(); err != nil {
		return zero, err
	}
	salt, _ := base64.StdEncoding.DecodeString(payload.Salt)
	iv, _ := base64.StdEncoding.DecodeString(payload.IV)
	cipherText, _ := base64.StdEncoding.DecodeString(payload.CipherText)
	key, err := pbkdf2.Key(sha256.New, passphrase, salt, payload.Iterations, 32)
	if err != nil {
		return zero, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return zero, err
	}
	seal, err := cipher.NewGCM(block)
	if err != nil {
		return zero, err
	}
	plain, err := seal.Open(nil, iv, cipherText, nil)
	if err != nil {
		return zero, err
	}
	if err := json.Unmarshal(plain, &zero); err != nil {
		return zero, err
	}
	return zero, nil
}

func (p EncryptedPayload) Validate() error {
	if p.Version != 1 || p.Algorithm != "AES-GCM" || p.KDF != "PBKDF2-SHA256" {
		return fmt.Errorf("unsupported encryption format")
	}
	if p.Iterations < minIterations || p.Iterations > maxIterations {
		return fmt.Errorf("invalid encryption iterations")
	}
	salt, err := base64.StdEncoding.DecodeString(p.Salt)
	if err != nil || len(salt) != 16 {
		return fmt.Errorf("invalid salt")
	}
	iv, err := base64.StdEncoding.DecodeString(p.IV)
	if err != nil || len(iv) != 12 {
		return fmt.Errorf("invalid iv")
	}
	cipherText, err := base64.StdEncoding.DecodeString(p.CipherText)
	if err != nil || len(cipherText) == 0 {
		return fmt.Errorf("invalid ciphertext")
	}
	return nil
}

func randomBytes(size int) ([]byte, error) {
	data := make([]byte, size)
	_, err := rand.Read(data)
	return data, err
}
