package protocol

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"
)

type ShareProfile struct {
	Name string `json:"name"`
}

type PendingShare struct {
	Type            string        `json:"type"`
	From            string        `json:"from"`
	RoomID          string        `json:"roomId"`
	SentAt          string        `json:"sentAt"`
	ReceivedAt      string        `json:"receivedAt"`
	Clock           int64         `json:"clock"`
	FolderID        string        `json:"folderId,omitempty"`
	FolderName      string        `json:"folderName,omitempty"`
	FileID          string        `json:"fileId,omitempty"`
	FileName        string        `json:"fileName,omitempty"`
	OwnerNodeID     string        `json:"ownerNodeId,omitempty"`
	AccessGrantMode string        `json:"accessGrantMode,omitempty"`
	FolderKeyHash   string        `json:"folderKeyHash,omitempty"`
	CID             string        `json:"cid,omitempty"`
	SenderProfile   *ShareProfile `json:"senderProfile,omitempty"`
}

type LinkedShare struct {
	Share PendingShare
	Key   string
}

type shareLinkPayload struct {
	Version         int           `json:"v"`
	Type            string        `json:"type"`
	RoomID          string        `json:"roomId"`
	Clock           int64         `json:"clock,omitempty"`
	CID             string        `json:"cid,omitempty"`
	Key             string        `json:"key,omitempty"`
	FolderID        string        `json:"folderId,omitempty"`
	FolderName      string        `json:"folderName,omitempty"`
	FileID          string        `json:"fileId,omitempty"`
	FileName        string        `json:"fileName,omitempty"`
	OwnerNodeID     string        `json:"ownerNodeId,omitempty"`
	AccessGrantMode string        `json:"accessGrantMode,omitempty"`
	FolderKeyHash   string        `json:"folderKeyHash,omitempty"`
	SenderProfile   *ShareProfile `json:"senderProfile,omitempty"`
}

func ParseShareLink(raw string) (LinkedShare, error) {
	token := raw
	if parsed, err := url.Parse(raw); err == nil && parsed.Fragment != "" {
		token = parsed.Fragment
	}
	token = strings.TrimPrefix(token, "#")
	values, err := url.ParseQuery(token)
	if err != nil {
		return LinkedShare{}, err
	}
	encoded := values.Get("tc-share")
	if encoded == "" {
		return LinkedShare{}, fmt.Errorf("tc-share payload not found")
	}
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return LinkedShare{}, err
	}
	var payload shareLinkPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return LinkedShare{}, err
	}
	if err := validateSharePayload(payload); err != nil {
		return LinkedShare{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	return LinkedShare{
		Key: payload.Key,
		Share: PendingShare{
			Type:            payload.Type,
			From:            "share-url",
			RoomID:          payload.RoomID,
			SentAt:          now,
			ReceivedAt:      now,
			Clock:           payload.Clock,
			FolderID:        payload.FolderID,
			FolderName:      payload.FolderName,
			FileID:          payload.FileID,
			FileName:        payload.FileName,
			OwnerNodeID:     payload.OwnerNodeID,
			AccessGrantMode: payload.AccessGrantMode,
			FolderKeyHash:   payload.FolderKeyHash,
			CID:             payload.CID,
			SenderProfile:   payload.SenderProfile,
		},
	}, nil
}

func validateSharePayload(payload shareLinkPayload) error {
	if payload.Version != 1 {
		return fmt.Errorf("unsupported share link version")
	}
	if payload.Type != "folder-share" && payload.Type != "file-share" {
		return fmt.Errorf("unsupported share link type")
	}
	if payload.RoomID == "" {
		return fmt.Errorf("roomId is required")
	}
	if payload.Type == "folder-share" {
		if payload.OwnerNodeID == "" || payload.FolderKeyHash == "" || payload.CID != "" || payload.Key != "" {
			return fmt.Errorf("invalid folder share link")
		}
		return nil
	}
	if payload.CID == "" || payload.Key == "" {
		return fmt.Errorf("invalid file share link")
	}
	return nil
}
