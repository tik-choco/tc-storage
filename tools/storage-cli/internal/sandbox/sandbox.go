package sandbox

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var ErrOutsideSandbox = errors.New("path escapes content sandbox")

type Sandbox struct {
	root string
}

func New(root string) (*Sandbox, error) {
	if strings.TrimSpace(root) == "" {
		return nil, fmt.Errorf("sandbox root is required")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, err
	}
	return &Sandbox{root: abs}, nil
}

func (s *Sandbox) Root() string {
	return s.root
}

func (s *Sandbox) ImportFile(source string) (string, error) {
	return s.ImportFileToDir(source, "")
}

func (s *Sandbox) ImportFileToDir(source string, dir string) (string, error) {
	info, err := os.Stat(source)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("directories cannot be imported yet: %s", source)
	}

	name := filepath.Base(source)
	rel := name
	if strings.TrimSpace(dir) != "" {
		rel = filepath.Join(dir, name)
	}
	target, err := s.Resolve(rel)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", err
	}

	in, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer in.Close()

	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return "", err
	}
	return filepath.ToSlash(rel), nil
}

func (s *Sandbox) Resolve(name string) (string, error) {
	if strings.TrimSpace(name) == "" {
		return "", fmt.Errorf("sandbox path is required")
	}
	clean := filepath.Clean(name)
	if filepath.IsAbs(clean) || clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", ErrOutsideSandbox
	}
	target := filepath.Join(s.root, clean)
	rel, err := filepath.Rel(s.root, target)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", ErrOutsideSandbox
	}
	return target, nil
}

func (s *Sandbox) ReadFile(name string) ([]byte, os.FileInfo, error) {
	path, err := s.Resolve(name)
	if err != nil {
		return nil, nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	if info.IsDir() {
		return nil, nil, fmt.Errorf("not a file: %s", name)
	}
	data, err := os.ReadFile(path)
	return data, info, err
}

func (s *Sandbox) Remove(name string) error {
	path, err := s.Resolve(name)
	if err != nil {
		return err
	}
	return os.RemoveAll(path)
}

func (s *Sandbox) List() ([]string, error) {
	var entries []string
	err := filepath.WalkDir(s.root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == s.root || entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(s.root, path)
		if err != nil {
			return err
		}
		entries = append(entries, filepath.ToSlash(rel))
		return nil
	})
	sort.Strings(entries)
	return entries, err
}
