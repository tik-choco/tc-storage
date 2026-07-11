package sandbox

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveRejectsEscapes(t *testing.T) {
	box, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../x", "/tmp/x", "nested/../../x"} {
		if _, err := box.Resolve(name); !errors.Is(err, ErrOutsideSandbox) {
			t.Fatalf("Resolve(%q) error = %v, want ErrOutsideSandbox", name, err)
		}
	}
}

func TestImportFileCopiesIntoSandbox(t *testing.T) {
	sourceDir := t.TempDir()
	source := filepath.Join(sourceDir, "hello.txt")
	if err := os.WriteFile(source, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	box, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	name, err := box.ImportFile(source)
	if err != nil {
		t.Fatal(err)
	}
	data, _, err := box.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" {
		t.Fatalf("imported data = %q", data)
	}
}

func TestImportFileToDirCopiesIntoNestedSandboxFolder(t *testing.T) {
	sourceDir := t.TempDir()
	source := filepath.Join(sourceDir, "hello.txt")
	if err := os.WriteFile(source, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	box, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	name, err := box.ImportFileToDir(source, "Shared/Docs")
	if err != nil {
		t.Fatal(err)
	}
	if name != "Shared/Docs/hello.txt" {
		t.Fatalf("imported name = %q", name)
	}
	data, _, err := box.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" {
		t.Fatalf("imported data = %q", data)
	}
}
