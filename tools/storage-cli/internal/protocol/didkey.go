package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"math/big"
	"strings"
)

// did:key support for Ed25519 keys, matching src/crypto/didIdentity.ts:
// multibase base58btc ("z" prefix) of multicodec 0xed01 || 32-byte public key.
// Envelope signatures are Ed25519 over the UTF-8 payload, base64url (no padding).

var ed25519Multicodec = []byte{0xed, 0x01}

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// DidIdentity is an Ed25519 did:key identity used to sign share envelopes.
type DidIdentity struct {
	Did     string
	private ed25519.PrivateKey
}

// GenerateDidIdentity mints a fresh Ed25519 did:key identity.
func GenerateDidIdentity() (DidIdentity, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return DidIdentity{}, err
	}
	return DidIdentity{Did: DidKeyFromEd25519Pub(pub), private: priv}, nil
}

// NewDidIdentityFromSeed reconstructs an identity from a 32-byte Ed25519 seed.
func NewDidIdentityFromSeed(seed []byte) (DidIdentity, error) {
	if len(seed) != ed25519.SeedSize {
		return DidIdentity{}, fmt.Errorf("ed25519 seed must be %d bytes", ed25519.SeedSize)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	return DidIdentity{Did: DidKeyFromEd25519Pub(pub), private: priv}, nil
}

// Seed returns the 32-byte Ed25519 seed for persistence.
func (d DidIdentity) Seed() []byte { return d.private.Seed() }

// Sign returns the base64url (no padding) Ed25519 signature of payload.
func (d DidIdentity) Sign(payload string) string {
	sig := ed25519.Sign(d.private, []byte(payload))
	return base64.RawURLEncoding.EncodeToString(sig)
}

// DidKeyFromEd25519Pub encodes a 32-byte public key as a did:key string.
func DidKeyFromEd25519Pub(pub ed25519.PublicKey) string {
	return "did:key:" + encodeMultibaseEd25519(pub)
}

func encodeMultibaseEd25519(pub []byte) string {
	return "z" + base58Encode(append(append([]byte{}, ed25519Multicodec...), pub...))
}

// Ed25519PubFromDidKey extracts the 32-byte public key from a did:key string.
func Ed25519PubFromDidKey(did string) ([]byte, bool) {
	if !strings.HasPrefix(did, "did:key:") {
		return nil, false
	}
	mb := strings.TrimPrefix(did, "did:key:")
	if !strings.HasPrefix(mb, "z") {
		return nil, false
	}
	decoded, err := base58Decode(mb[1:])
	if err != nil || len(decoded) != 34 || decoded[0] != ed25519Multicodec[0] || decoded[1] != ed25519Multicodec[1] {
		return nil, false
	}
	return decoded[2:], true
}

// IsEd25519DidKey reports whether did is a valid Ed25519 did:key.
func IsEd25519DidKey(did string) bool {
	_, ok := Ed25519PubFromDidKey(did)
	return ok
}

// VerifyWithDid verifies a base64url Ed25519 signature against a did:key.
func VerifyWithDid(did, payload, signatureB64url string) bool {
	pub, ok := Ed25519PubFromDidKey(did)
	if !ok {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(signatureB64url, "="))
	if err != nil {
		return false
	}
	return ed25519.Verify(pub, []byte(payload), sig)
}

func base58Encode(input []byte) string {
	var zeros int
	for zeros < len(input) && input[zeros] == 0 {
		zeros++
	}
	num := new(big.Int).SetBytes(input)
	radix := big.NewInt(58)
	mod := new(big.Int)
	var out []byte
	for num.Sign() > 0 {
		num.DivMod(num, radix, mod)
		out = append(out, base58Alphabet[mod.Int64()])
	}
	for i := 0; i < zeros; i++ {
		out = append(out, base58Alphabet[0])
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

func base58Decode(input string) ([]byte, error) {
	num := new(big.Int)
	radix := big.NewInt(58)
	for _, r := range input {
		idx := strings.IndexRune(base58Alphabet, r)
		if idx < 0 {
			return nil, fmt.Errorf("invalid base58 character %q", r)
		}
		num.Mul(num, radix)
		num.Add(num, big.NewInt(int64(idx)))
	}
	decoded := num.Bytes()
	var zeros int
	for zeros < len(input) && input[zeros] == base58Alphabet[0] {
		zeros++
	}
	return append(make([]byte, zeros), decoded...), nil
}
