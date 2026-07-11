package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"tc-storage-cli/internal/domain"
)

type ShareEnvelope struct {
	Type            string               `json:"type"`
	From            string               `json:"from"`
	RoomID          string               `json:"roomId"`
	SentAt          string               `json:"sentAt"`
	Clock           int64                `json:"clock"`
	ChangeType      string               `json:"changeType,omitempty"`
	FolderSignature string               `json:"folderSignature,omitempty"`
	FolderID        string               `json:"folderId,omitempty"`
	FolderName      string               `json:"folderName,omitempty"`
	Folder          *domain.FolderRecord `json:"folder,omitempty"`
	FileID          string               `json:"fileId,omitempty"`
	FileName        string               `json:"fileName,omitempty"`
	File            *domain.FileRecord   `json:"file,omitempty"`
	CID             string               `json:"cid,omitempty"`
	SenderProfile   *ShareProfile        `json:"senderProfile,omitempty"`
	Signature       string               `json:"signature,omitempty"`
	OwnerNodeID     string               `json:"ownerNodeId,omitempty"`
	AccessGrantMode string               `json:"accessGrantMode,omitempty"`
	FolderKeyHash   string               `json:"folderKeyHash,omitempty"`
	TargetNodeID    string               `json:"targetNodeId,omitempty"`
	RequestID       string               `json:"requestId,omitempty"`

	AccessPublicKey       string `json:"accessPublicKey,omitempty"`
	AccessGrantProof      string `json:"accessGrantProof,omitempty"`
	AccessGrantPublicKey  string `json:"accessGrantPublicKey,omitempty"`
	AccessGrantIv         string `json:"accessGrantIv,omitempty"`
	AccessGrantCipherText string `json:"accessGrantCipherText,omitempty"`
}

// SignEnvelope returns a copy of envelope with an Ed25519 signature over the
// deterministic signing payload (matches signShareEnvelope in p2pEnvelope.ts).
func SignEnvelope(envelope ShareEnvelope, identity DidIdentity) (ShareEnvelope, error) {
	if !IsEd25519DidKey(envelope.From) {
		return ShareEnvelope{}, fmt.Errorf("envelope sender must be an Ed25519 did:key")
	}
	payload, err := EnvelopeSigningPayload(envelope)
	if err != nil {
		return ShareEnvelope{}, err
	}
	envelope.Signature = identity.Sign(payload)
	return envelope, nil
}

// VerifyEnvelope checks the Ed25519 signature against the sender's did:key.
func VerifyEnvelope(envelope ShareEnvelope) bool {
	if envelope.Signature == "" || !IsEd25519DidKey(envelope.From) {
		return false
	}
	payload, err := EnvelopeSigningPayload(envelope)
	if err != nil {
		return false
	}
	return VerifyWithDid(envelope.From, payload, envelope.Signature)
}

// Short abbreviates long identifiers (did:key, cids) for log/progress output.
func Short(value string) string {
	if len(value) <= 28 {
		return value
	}
	return value[:14] + "..." + value[len(value)-8:]
}

// ParseEnvelopeBytes decodes a JSON share envelope from a raw mist message.
// It returns false when the bytes are not a recognizable envelope.
func ParseEnvelopeBytes(data []byte) (ShareEnvelope, bool) {
	var env ShareEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return ShareEnvelope{}, false
	}
	if env.Type == "" || env.From == "" || env.RoomID == "" || env.SentAt == "" {
		return ShareEnvelope{}, false
	}
	return env, true
}

func EnvelopeSigningPayload(envelope ShareEnvelope) (string, error) {
	raw, err := json.Marshal(envelope)
	if err != nil {
		return "", err
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", err
	}
	if object, ok := value.(map[string]any); ok {
		delete(object, "signature")
	}
	return stableStringify(value), nil
}

func stableStringify(value any) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case string:
		return strconv.Quote(v)
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case []any:
		var buf bytes.Buffer
		buf.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				buf.WriteByte(',')
			}
			buf.WriteString(stableStringify(item))
		}
		buf.WriteByte(']')
		return buf.String()
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key, item := range v {
			if item != nil {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		var buf bytes.Buffer
		buf.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			buf.WriteString(strconv.Quote(key))
			buf.WriteByte(':')
			buf.WriteString(stableStringify(v[key]))
		}
		buf.WriteByte('}')
		return buf.String()
	default:
		return fmt.Sprintf("%v", v)
	}
}
