package domain

type VersionStamp struct {
	UpdatedAt string `json:"updatedAt"`
	NodeID    string `json:"nodeId"`
}

type FolderRecord struct {
	ID            string                  `json:"id"`
	Name          string                  `json:"name"`
	ParentID      *string                 `json:"parentId"`
	SortOrder     *float64                `json:"sortOrder,omitempty"`
	Color         string                  `json:"color"`
	Encrypted     bool                    `json:"encrypted"`
	ShareEnabled  bool                    `json:"shareEnabled"`
	SharedRoomID  string                  `json:"sharedRoomId"`
	LastCID       string                  `json:"lastCid,omitempty"`
	LastSavedAt   string                  `json:"lastSavedAt,omitempty"`
	LastSharedAt  string                  `json:"lastSharedAt,omitempty"`
	DeletedAt     string                  `json:"deletedAt,omitempty"`
	CreatedAt     string                  `json:"createdAt"`
	UpdatedAt     string                  `json:"updatedAt"`
	FieldVersions map[string]VersionStamp `json:"fieldVersions,omitempty"`
}

type FileRecord struct {
	ID            string                  `json:"id"`
	FolderID      string                  `json:"folderId"`
	SortOrder     *float64                `json:"sortOrder,omitempty"`
	Name          string                  `json:"name"`
	MimeType      string                  `json:"mimeType"`
	Size          int64                   `json:"size"`
	DataURL       string                  `json:"dataUrl,omitempty"`
	Checksum      string                  `json:"checksum"`
	Version       int                     `json:"version"`
	Starred       bool                    `json:"starred"`
	LastCID       string                  `json:"lastCid,omitempty"`
	LastShareCID  string                  `json:"lastShareCid,omitempty"`
	DeletedAt     string                  `json:"deletedAt,omitempty"`
	CreatedAt     string                  `json:"createdAt"`
	UpdatedAt     string                  `json:"updatedAt"`
	FieldVersions map[string]VersionStamp `json:"fieldVersions,omitempty"`
}

type FolderBundle struct {
	Version    int            `json:"version"`
	ExportedAt string         `json:"exportedAt"`
	OriginNode string         `json:"originNode"`
	Folder     FolderRecord   `json:"folder"`
	Folders    []FolderRecord `json:"folders,omitempty"`
	Files      []FileRecord   `json:"files"`
}

type FileBundle struct {
	Version    int          `json:"version"`
	ExportedAt string       `json:"exportedAt"`
	OriginNode string       `json:"originNode"`
	Folder     FolderRecord `json:"folder"`
	File       FileRecord   `json:"file"`
}
