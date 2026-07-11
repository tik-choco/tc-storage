package protocol

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestParseFileShareLink(t *testing.T) {
	payload := shareLinkPayload{
		Version:  1,
		Type:     "file-share",
		RoomID:   "room-1",
		Clock:    12,
		CID:      "bafy-test",
		Key:      "secret",
		FolderID: "folder-1",
		FileID:   "file-1",
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	linked, err := ParseShareLink("https://example.test/#tc-share=" + base64.RawURLEncoding.EncodeToString(raw))
	if err != nil {
		t.Fatal(err)
	}
	if linked.Share.Type != "file-share" || linked.Share.RoomID != "room-1" || linked.Share.CID != "bafy-test" || linked.Key != "secret" {
		t.Fatalf("unexpected linked share: %+v", linked)
	}
}
