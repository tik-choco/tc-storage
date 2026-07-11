package protocol

import "testing"

func TestEncryptDecryptJSON(t *testing.T) {
	type payload struct {
		Name string `json:"name"`
	}
	encrypted, err := EncryptJSON(payload{Name: "test"}, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if encrypted.Iterations != webCryptoIterations || encrypted.Algorithm != "AES-GCM" || encrypted.KDF != "PBKDF2-SHA256" {
		t.Fatalf("unexpected encryption header: %+v", encrypted)
	}
	decrypted, err := DecryptJSON[payload](encrypted, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if decrypted.Name != "test" {
		t.Fatalf("decrypted.Name = %q", decrypted.Name)
	}
}
