package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"tc-storage-cli/internal/app"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

func runTUI(ctx context.Context, rt *app.Runtime) error {
	_, err := tea.NewProgram(newModel(ctx, rt), tea.WithContext(ctx)).Run()
	return err
}

// screen identifies which view the TUI is currently showing.
type screen int

const (
	screenBrowse screen = iota
	screenPicker
	screenForm
	screenRunning
	screenResult
	screenConfirm
)

// entry is one item in the sandbox file listing.
type entry struct {
	name     string
	display  string
	size     int64
	dir      bool
	up       bool
	remote   bool
	remoteID string
}

type pickerEntry struct {
	name string
	path string
	size int64
	dir  bool
	up   bool
}

// action is a task triggered by a keybinding from the browser. It collects the
// fields it needs (the selected file is passed implicitly via selName) and then
// runs against the runtime.
type action struct {
	title  string
	fields []string
	inline bool
	run    func(ctx context.Context, rt *app.Runtime, selName string, args []string) (any, error)
}

var (
	titleStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("63"))
	pathStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	selectedStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("212")).Bold(true)
	dirStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("75"))
	labelStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	errorStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	helpStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
)

type model struct {
	ctx    context.Context
	rt     *app.Runtime
	screen screen

	entries   []entry
	cursor    int
	browseDir string
	loadErr   error

	pickDir       string
	pickTargetDir string
	pickEntries   []pickerEntry
	pickCursor    int
	pickErr       error

	act     action
	inputs  []string
	field   int
	current string

	result string
	err    error

	// connection status shown in the header
	connecting bool
	connErr    error
	peers      int

	syncEvents <-chan app.SyncEvent
	syncCount  int
	syncErr    error
}

func newModel(ctx context.Context, rt *app.Runtime) model {
	m := model{ctx: ctx, rt: rt, screen: screenBrowse, connecting: true}
	if rt.Networked() {
		m.syncEvents = rt.StartContentSync(ctx)
	}
	m.reload()
	return m
}

// connection lifecycle messages
type establishedMsg struct{ err error }
type peersMsg struct{ count int }
type tickMsg struct{}
type syncMsg struct{ event app.SyncEvent }

// establishCmd starts the mist session (init + join + position) in the
// background so the TUI begins connecting as soon as it launches.
func (m model) establishCmd() tea.Cmd {
	return func() tea.Msg {
		return establishedMsg{err: m.rt.Establish(m.ctx)}
	}
}

// pollCmd re-asserts the overlay position and reports the current peer count.
func (m model) pollCmd() tea.Cmd {
	return func() tea.Msg {
		_ = m.rt.Reposition(m.ctx)
		return peersMsg{count: len(m.rt.ConnectedPeers(m.ctx))}
	}
}

func tickCmd() tea.Cmd {
	return tea.Tick(time.Second, func(time.Time) tea.Msg { return tickMsg{} })
}

func waitSyncCmd(events <-chan app.SyncEvent) tea.Cmd {
	if events == nil {
		return nil
	}
	return func() tea.Msg {
		event, ok := <-events
		if !ok {
			return nil
		}
		return syncMsg{event: event}
	}
}

func (m *model) reload() {
	names, err := m.rt.Sandbox.List()
	m.loadErr = err
	m.entries = nil
	root := m.rt.Sandbox.Root()
	current := cleanBrowseDir(m.browseDir)
	localNames := map[string]bool{}
	dirs := map[string]bool{}
	addDirs := func(name string) {
		parent := filepath.ToSlash(filepath.Dir(name))
		if parent == "." {
			parent = ""
		}
		for parent != "" && parent != "." {
			dirs[parent] = true
			parent = filepath.ToSlash(filepath.Dir(parent))
			if parent == "." {
				parent = ""
			}
		}
	}
	for _, name := range names {
		name = filepath.ToSlash(name)
		localNames[name] = true
		addDirs(name)
		if parentDir(name) != current {
			continue
		}
		e := entry{name: name, display: filepath.Base(name)}
		if info, statErr := os.Stat(filepath.Join(root, filepath.FromSlash(name))); statErr == nil {
			e.size = info.Size()
			e.dir = info.IsDir()
		}
		m.entries = append(m.entries, e)
	}
	for _, remote := range m.rt.RemoteFiles() {
		if remote.SyncedPath != "" {
			continue
		}
		name := remote.Path
		if name == "" {
			name = remote.Name
			if remote.FolderName != "" {
				name = remote.FolderName + "/" + name
			}
		}
		name = filepath.ToSlash(name)
		if localNames[name] {
			continue
		}
		addDirs(name)
		if parentDir(name) != current {
			continue
		}
		m.entries = append(m.entries, entry{name: name, display: filepath.Base(name), size: remote.Size, remote: true, remoteID: remote.FileID})
	}
	for dir := range dirs {
		if parentDir(dir) == current {
			m.entries = append(m.entries, entry{name: dir, display: filepath.Base(dir), dir: true})
		}
	}
	sort.Slice(m.entries, func(i, j int) bool {
		if m.entries[i].dir != m.entries[j].dir {
			return m.entries[i].dir
		}
		return strings.ToLower(m.entries[i].display) < strings.ToLower(m.entries[j].display)
	})
	if current != "" {
		m.entries = append([]entry{{name: parentDir(current), display: "..", dir: true, up: true}}, m.entries...)
	}
	if m.cursor >= len(m.entries) {
		m.cursor = max(0, len(m.entries)-1)
	}
}

func (m model) Init() tea.Cmd {
	if !m.rt.Networked() {
		// Local backend never has peers; skip the connecting state.
		m.connecting = false
		return nil
	}
	return tea.Batch(m.establishCmd(), tickCmd(), waitSyncCmd(m.syncEvents))
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case establishedMsg:
		m.connecting = false
		m.connErr = msg.err
		return m, nil
	case peersMsg:
		m.peers = msg.count
		return m, nil
	case tickMsg:
		return m, tea.Batch(m.pollCmd(), tickCmd())
	case syncMsg:
		m.syncCount++
		m.syncErr = msg.event.Err
		m.reload()
		return m, waitSyncCmd(m.syncEvents)
	case actionDoneMsg:
		m.err = msg.err
		m.result = formatResult(msg.value)
		if msg.inline {
			m.screen = screenBrowse
			m.reload()
			return m, nil
		}
		m.screen = screenResult
		return m, nil
	}

	key, ok := msg.(tea.KeyMsg)
	if !ok {
		return m, nil
	}
	switch m.screen {
	case screenBrowse:
		return m.updateBrowse(key)
	case screenPicker:
		return m.updatePicker(key)
	case screenForm:
		return m.updateForm(key)
	case screenRunning:
		if s := key.String(); s == "ctrl+c" || s == "q" {
			return m, tea.Quit
		}
		return m, nil
	case screenConfirm:
		return m.updateConfirm(key)
	default:
		return m.updateResult(key)
	}
}

func (m model) selectedEntry() (entry, bool) {
	if m.cursor < 0 || m.cursor >= len(m.entries) {
		return entry{}, false
	}
	return m.entries[m.cursor], true
}

func (m model) selectedName() string {
	entry, ok := m.selectedEntry()
	if !ok {
		return ""
	}
	return entry.name
}

func (m model) updateBrowse(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.entries)-1 {
			m.cursor++
		}
	case "r":
		m.reload()
	case "backspace", "h":
		if m.browseDir != "" {
			m.browseDir = cleanBrowseDir(parentDir(m.browseDir))
			m.cursor = 0
			m.reload()
		}
	case "a", "i":
		return m.openPicker()
	case "enter":
		selected, ok := m.selectedEntry()
		if !ok {
			return m, nil
		}
		if selected.dir {
			openedChild := !selected.up
			m.browseDir = cleanBrowseDir(selected.name)
			m.cursor = 0
			m.reload()
			if openedChild && m.browseDir != "" && len(m.entries) > 1 {
				m.cursor = 1
			}
			return m, nil
		}
		if selected.remote {
			remoteID := selected.remoteID
			return m.runAction(action{
				title: "retrieve from storage",
				run: func(ctx context.Context, rt *app.Runtime, _ string, _ []string) (any, error) {
					return rt.FetchRemoteFile(ctx, remoteID)
				},
			})
		}
		return m.runAction(action{
			title: "available on this PC",
			run: func(_ context.Context, rt *app.Runtime, sel string, _ []string) (any, error) {
				return "available " + filepath.Join(rt.Sandbox.Root(), filepath.FromSlash(sel)), nil
			},
		})
	case "delete":
		return m.confirmDelete()
	case "shift+delete", "alt+delete":
		return m.deleteSelected()
	case "p":
		selected, ok := m.selectedEntry()
		if !ok || selected.remote || selected.dir {
			return m, nil
		}
		return m.runAction(action{
			title: "store local in shared folder",
			run: func(ctx context.Context, rt *app.Runtime, sel string, _ []string) (any, error) {
				file, err := rt.StoreLocalFile(ctx, sel)
				if err != nil {
					return nil, err
				}
				return "stored " + file.SyncedPath, nil
			},
		})
	case "g":
		return m.begin(action{
			title:  "get encrypted file",
			fields: []string{"cid", "passphrase"},
			run: func(ctx context.Context, rt *app.Runtime, _ string, args []string) (any, error) {
				return rt.GetFile(ctx, args[0], args[1])
			},
		})
	case "l":
		return m.begin(action{
			title:  "parse share link",
			fields: []string{"share url/hash"},
			run: func(ctx context.Context, rt *app.Runtime, _ string, args []string) (any, error) {
				return app.ParseShareLink(args[0])
			},
		})
	case "f":
		return m.begin(action{
			title:  "fetch folder share",
			fields: []string{"folder share url"},
			run: func(ctx context.Context, rt *app.Runtime, _ string, args []string) (any, error) {
				return rt.FetchFolderShare(ctx, args[0], nil)
			},
		})
	}
	return m, nil
}

func (m model) confirmDelete() (tea.Model, tea.Cmd) {
	selected, ok := m.selectedEntry()
	if !ok || selected.up {
		return m, nil
	}
	m.screen = screenConfirm
	m.act = action{title: "delete " + selected.name}
	return m, nil
}

func (m model) updateConfirm(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	case "esc", "n", "backspace":
		m.screen = screenBrowse
		return m, nil
	case "enter", "y":
		return m.deleteSelected()
	}
	return m, nil
}

func (m model) deleteSelected() (tea.Model, tea.Cmd) {
	selected, ok := m.selectedEntry()
	if !ok || selected.up {
		return m, nil
	}
	if selected.remote {
		remoteID := selected.remoteID
		return m.runAction(action{
			title: "delete remote file",
			run: func(ctx context.Context, rt *app.Runtime, _ string, _ []string) (any, error) {
				return rt.DeleteRemoteFile(ctx, remoteID)
			},
		})
	}
	name := selected.name
	return m.runAction(action{
		title: "delete local path",
		run: func(ctx context.Context, rt *app.Runtime, _ string, _ []string) (any, error) {
			return rt.DeleteLocalPath(ctx, name)
		},
	})
}

func (m model) openPicker() (tea.Model, tea.Cmd) {
	dir, err := os.Getwd()
	if err != nil || dir == "" {
		dir = filepath.Dir(m.rt.Sandbox.Root())
	}
	m.screen = screenPicker
	m.pickDir = dir
	m.pickTargetDir = cleanBrowseDir(m.browseDir)
	m.pickCursor = 0
	m.loadPicker()
	return m, nil
}

func (m *model) loadPicker() {
	m.pickErr = nil
	m.pickEntries = nil
	entries, err := os.ReadDir(m.pickDir)
	if err != nil {
		m.pickErr = err
		return
	}
	if parent := filepath.Dir(m.pickDir); parent != m.pickDir {
		m.pickEntries = append(m.pickEntries, pickerEntry{name: "..", path: parent, dir: true, up: true})
	}
	for _, item := range entries {
		info, err := item.Info()
		if err != nil {
			continue
		}
		m.pickEntries = append(m.pickEntries, pickerEntry{
			name: item.Name(),
			path: filepath.Join(m.pickDir, item.Name()),
			size: info.Size(),
			dir:  item.IsDir(),
		})
	}
	sort.SliceStable(m.pickEntries, func(i, j int) bool {
		left, right := m.pickEntries[i], m.pickEntries[j]
		if left.up || right.up {
			return left.up
		}
		if left.dir != right.dir {
			return left.dir
		}
		return strings.ToLower(left.name) < strings.ToLower(right.name)
	})
	if m.pickCursor >= len(m.pickEntries) {
		m.pickCursor = max(0, len(m.pickEntries)-1)
	}
}

func (m model) selectedPickerEntry() (pickerEntry, bool) {
	if m.pickCursor < 0 || m.pickCursor >= len(m.pickEntries) {
		return pickerEntry{}, false
	}
	return m.pickEntries[m.pickCursor], true
}

func (m model) updatePicker(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	case "esc":
		m.screen = screenBrowse
		return m, nil
	case "up", "k":
		if m.pickCursor > 0 {
			m.pickCursor--
		}
	case "down", "j":
		if m.pickCursor < len(m.pickEntries)-1 {
			m.pickCursor++
		}
	case "backspace", "h":
		parent := filepath.Dir(m.pickDir)
		if parent != m.pickDir {
			m.pickDir = parent
			m.pickCursor = 0
			m.loadPicker()
		}
	case "r":
		m.loadPicker()
	case "enter", "l":
		selected, ok := m.selectedPickerEntry()
		if !ok {
			return m, nil
		}
		if selected.dir {
			m.pickDir = selected.path
			m.pickCursor = 0
			m.loadPicker()
			return m, nil
		}
		path := selected.path
		targetDir := m.pickTargetDir
		return m.runAction(action{
			title: "add file",
			run: func(ctx context.Context, rt *app.Runtime, _ string, _ []string) (any, error) {
				imported, err := rt.Sandbox.ImportFileToDir(path, targetDir)
				if err != nil {
					return nil, err
				}
				stored, err := rt.StoreLocalFile(ctx, imported)
				if err != nil {
					return "added " + imported + " (not shared: " + err.Error() + ")", nil
				}
				return "added " + imported + "; shared " + stored.SyncedPath, nil
			},
		})
	}
	return m, nil
}

func (m model) begin(a action) (tea.Model, tea.Cmd) {
	m.act = a
	m.screen = screenForm
	m.inputs = make([]string, len(a.fields))
	m.field = 0
	m.current = ""
	return m, nil
}

func (m model) runAction(a action) (tea.Model, tea.Cmd) {
	a.inline = true
	m.act = a
	m.inputs = nil
	m.field = 0
	m.current = ""
	return m.execute()
}

func (m model) updateForm(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc":
		m.screen = screenBrowse
	case "enter":
		m.inputs[m.field] = strings.TrimSpace(m.current)
		m.current = ""
		if m.field < len(m.act.fields)-1 {
			m.field++
			return m, nil
		}
		return m.execute()
	case "backspace":
		if len(m.current) > 0 {
			m.current = m.current[:len(m.current)-1]
		}
	default:
		if r := key.Runes; len(r) > 0 {
			m.current += string(r)
		}
	}
	return m, nil
}

func (m model) updateResult(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	default:
		m.screen = screenBrowse
		m.result = ""
		m.err = nil
		m.reload()
	}
	return m, nil
}

// actionDoneMsg carries the outcome of an asynchronously executed action.
type actionDoneMsg struct {
	value  any
	err    error
	inline bool
}

// execute runs the action in the background (a tea.Cmd) so long-running actions
// like folder-get do not block the UI event loop.
func (m model) execute() (tea.Model, tea.Cmd) {
	act := m.act
	rt := m.rt
	ctx := m.ctx
	sel := m.selectedName()
	inputs := append([]string(nil), m.inputs...)
	m.screen = screenRunning
	return m, func() tea.Msg {
		value, err := act.run(ctx, rt, sel, inputs)
		return actionDoneMsg{value: value, err: err, inline: act.inline}
	}
}

func (m model) View() string {
	switch m.screen {
	case screenPicker:
		return m.viewPicker()
	case screenForm:
		return m.viewForm()
	case screenRunning:
		return m.viewRunning()
	case screenResult:
		return m.viewResult()
	case screenConfirm:
		return m.viewConfirm()
	default:
		return m.viewBrowse()
	}
}

func (m model) viewRunning() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render(m.act.title) + "  " + m.connStatus() + "\n\n")
	b.WriteString(helpStyle.Render("running... this can take a while (approval / storage transfer)") + "\n")
	b.WriteString("\n" + helpStyle.Render("q / ctrl+c quit"))
	return b.String()
}

func (m model) viewPicker() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("Add file") + "  " + m.connStatus() + "\n")
	b.WriteString(pathStyle.Render(m.pickDir) + "\n\n")
	if m.pickErr != nil {
		b.WriteString(errorStyle.Render("error: "+m.pickErr.Error()) + "\n")
	} else if len(m.pickEntries) == 0 {
		b.WriteString(helpStyle.Render("(empty)") + "\n")
	} else {
		b.WriteString(helpStyle.Render(fmt.Sprintf("  %-10s %8s  %s", "MODE", "SIZE", "NAME")) + "\n")
		for i, e := range m.pickEntries {
			line := formatPickerLine(e, i == m.pickCursor)
			if i == m.pickCursor {
				line = selectedStyle.Render(line)
			}
			b.WriteString(line + "\n")
		}
	}
	b.WriteString("\n" + helpStyle.Render("↑/↓ move • enter open/add • backspace parent • r refresh • esc cancel • q quit"))
	return b.String()
}

func formatPickerLine(e pickerEntry, selected bool) string {
	cursor := " "
	if selected {
		cursor = ">"
	}
	mode := "-rw-r--r--"
	name := e.name
	if e.dir {
		mode = "drwxr-xr-x"
		if !e.up {
			name += "/"
		}
	}
	return fmt.Sprintf("%s %-10s %8s  %s", cursor, mode, humanSize(e.size), name)
}

func (m model) viewBrowse() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("TC Storage") + "  " + m.connStatus() + "\n")
	browsePath := m.rt.Sandbox.Root()
	if m.browseDir != "" {
		browsePath = filepath.Join(browsePath, filepath.FromSlash(m.browseDir))
	}
	b.WriteString(pathStyle.Render(browsePath) + "\n\n")

	switch {
	case m.loadErr != nil:
		b.WriteString(errorStyle.Render("error: "+m.loadErr.Error()) + "\n")
	case len(m.entries) == 0:
		b.WriteString(helpStyle.Render("(empty — press i to import a file)") + "\n")
	default:
		b.WriteString(helpStyle.Render(fmt.Sprintf("  %-10s %-7s %8s  %s", "MODE", "SOURCE", "SIZE", "PATH")) + "\n")
		for i, e := range m.entries {
			line := formatEntryLine(e, i == m.cursor)
			if i == m.cursor {
				line = selectedStyle.Render(line)
			}
			b.WriteString(line + "\n")
		}
	}

	if m.result != "" || m.err != nil {
		b.WriteString("\n")
		if m.err != nil {
			b.WriteString(errorStyle.Render("error: "+m.err.Error()) + "\n")
		} else {
			b.WriteString(pathStyle.Render(m.result) + "\n")
		}
	}

	b.WriteString("\n" + helpStyle.Render("↑/↓ move • enter open/use • backspace parent • a add file • p store local • delete remove • shift+delete force • r refresh • q quit"))
	return b.String()
}

func formatEntryLine(e entry, selected bool) string {
	cursor := " "
	if selected {
		cursor = ">"
	}
	mode := "-rw-r--r--"
	source := "local"
	name := e.display
	if name == "" {
		name = e.name
	}
	if e.dir {
		mode = "drwxr-xr-x"
		source = "local"
		if !e.up {
			name += "/"
		}
	}
	if e.remote {
		mode = "-r--r--r--"
		source = "remote"
	}
	return fmt.Sprintf("%s %-10s %-7s %8s  %s", cursor, mode, source, humanSize(e.size), name)
}

func (m model) viewConfirm() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("Delete") + "  " + m.connStatus() + "\n\n")
	b.WriteString("delete " + m.selectedName() + "?\n\n")
	b.WriteString(helpStyle.Render("enter/y confirm • esc/n cancel • shift+delete skips confirmation"))
	return b.String()
}

func cleanBrowseDir(dir string) string {
	clean := filepath.ToSlash(filepath.Clean(dir))
	if clean == "." || clean == "/" {
		return ""
	}
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return ""
	}
	return clean
}

func parentDir(path string) string {
	parent := filepath.ToSlash(filepath.Dir(path))
	if parent == "." {
		return ""
	}
	return parent
}

// connStatus renders the live connection indicator shown in the header.
func (m model) connStatus() string {
	if !m.rt.Networked() {
		return helpStyle.Render("(local store)")
	}
	switch {
	case m.connErr != nil:
		return errorStyle.Render("connect error: " + m.connErr.Error())
	case m.connecting:
		return helpStyle.Render("connecting…")
	case m.peers > 0:
		status := fmt.Sprintf("● connected (%d peer%s)", m.peers, plural(m.peers))
		if m.syncCount > 0 {
			status += fmt.Sprintf(" • synced %d", m.syncCount)
		}
		return selectedStyle.Render(status)
	default:
		return helpStyle.Render("○ waiting for peers…")
	}
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func (m model) viewForm() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render(m.act.title) + "\n")
	if sel := m.selectedName(); sel != "" && (m.act.title == "encrypt + store" || m.act.title == "store local in shared folder") {
		b.WriteString(pathStyle.Render("file: "+sel) + "\n")
	}
	b.WriteString("\n")
	for i, label := range m.act.fields {
		value := m.inputs[i]
		if i == m.field {
			value = m.current + "▍"
		}
		b.WriteString(labelStyle.Render(label+": ") + value + "\n")
	}
	b.WriteString("\n" + helpStyle.Render("enter confirm • esc cancel"))
	return b.String()
}

func (m model) viewResult() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render(m.act.title) + "\n\n")
	if m.err != nil {
		b.WriteString(errorStyle.Render("error: "+m.err.Error()) + "\n")
	} else {
		b.WriteString(m.result + "\n")
	}
	b.WriteString("\n" + helpStyle.Render("any key back • q quit"))
	return b.String()
}

func formatResult(value any) string {
	switch v := value.(type) {
	case nil:
		return "(done)"
	case app.RemoteFile:
		if v.SyncedPath != "" {
			return fmt.Sprintf("retrieved %s", v.SyncedPath)
		}
		return fmt.Sprintf("remote %s", v.Name)
	case app.FolderShareResult:
		var b strings.Builder
		fmt.Fprintf(&b, "folder: %s\nretrieved %d file(s)\n", v.FolderName, len(v.Files))
		for _, f := range v.Files {
			b.WriteString("  " + f + "\n")
		}
		for _, s := range v.Skipped {
			b.WriteString("  skipped: " + s + "\n")
		}
		return strings.TrimRight(b.String(), "\n")
	case []string:
		if len(v) == 0 {
			return "(empty)"
		}
		return strings.Join(v, "\n")
	case string:
		return v
	default:
		return fmt.Sprintf("%+v", v)
	}
}

func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}
