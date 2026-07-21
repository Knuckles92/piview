package ui

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const maxAssetBytes = 5 << 20 // 5 MiB

var allowedImageTypes = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/jpg":  ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

// assetDir returns the directory used for plan screenshots.
// Prefers {cwd}/.piview/assets so the agent can read files from the workspace.
// Falls back to a process-temp directory when cwd is unknown.
func (s *Server) assetDir() (dir string, workspaceRelative bool, err error) {
	s.mu.RLock()
	cwd := strings.TrimSpace(s.cwd)
	s.mu.RUnlock()

	if cwd != "" {
		dir = filepath.Join(cwd, ".piview", "assets")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", false, err
		}
		return dir, true, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tempAssetDir == "" {
		dir, err = os.MkdirTemp("", "piview-assets-*")
		if err != nil {
			return "", false, err
		}
		s.tempAssetDir = dir
	}
	return s.tempAssetDir, false, nil
}

func randomAssetName(ext string) (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]) + ext, nil
}

func sniffImageExt(ct string, head []byte) (ext string, ok bool) {
	ct = strings.ToLower(strings.TrimSpace(strings.Split(ct, ";")[0]))
	if e, found := allowedImageTypes[ct]; found {
		return e, true
	}
	// Fallback: detect from magic bytes
	kind := http.DetectContentType(head)
	if e, found := allowedImageTypes[kind]; found {
		return e, true
	}
	return "", false
}

func (s *Server) handleUploadAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxAssetBytes+512)

	ct := r.Header.Get("Content-Type")
	var data []byte
	var err error

	if strings.HasPrefix(strings.ToLower(ct), "multipart/form-data") {
		if err := r.ParseMultipartForm(maxAssetBytes + 1024); err != nil {
			http.Error(w, "file too large or invalid multipart", http.StatusRequestEntityTooLarge)
			return
		}
		file, hdr, err := r.FormFile("file")
		if err != nil {
			http.Error(w, "missing file field", http.StatusBadRequest)
			return
		}
		defer file.Close()
		if ct == "" || strings.HasPrefix(strings.ToLower(ct), "multipart/") {
			ct = hdr.Header.Get("Content-Type")
		}
		data, err = io.ReadAll(io.LimitReader(file, maxAssetBytes+1))
		if err != nil {
			http.Error(w, "read failed", http.StatusBadRequest)
			return
		}
	} else {
		data, err = io.ReadAll(io.LimitReader(r.Body, maxAssetBytes+1))
		if err != nil {
			http.Error(w, "read failed", http.StatusBadRequest)
			return
		}
	}

	if len(data) == 0 {
		http.Error(w, "empty body", http.StatusBadRequest)
		return
	}
	if len(data) > maxAssetBytes {
		http.Error(w, "file too large (max 5MB)", http.StatusRequestEntityTooLarge)
		return
	}

	head := data
	if len(head) > 512 {
		head = head[:512]
	}
	ext, ok := sniffImageExt(ct, head)
	if !ok {
		// last resort: DetectContentType on full-ish head
		ext, ok = sniffImageExt(http.DetectContentType(head), head)
	}
	if !ok {
		http.Error(w, "only png/jpeg/gif/webp images are allowed", http.StatusUnsupportedMediaType)
		return
	}

	dir, workspaceRelative, err := s.assetDir()
	if err != nil {
		http.Error(w, "asset dir: "+err.Error(), http.StatusInternalServerError)
		return
	}

	name, err := randomAssetName(ext)
	if err != nil {
		http.Error(w, "id: "+err.Error(), http.StatusInternalServerError)
		return
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		http.Error(w, "write: "+err.Error(), http.StatusInternalServerError)
		return
	}

	urlPath := "/assets/" + name
	relPath := urlPath
	if workspaceRelative {
		relPath = ".piview/assets/" + name
	}

	writeJSON(w, map[string]any{
		"ok":   true,
		"url":  urlPath,
		"path": relPath,
		"name": name,
	})
}

func (s *Server) handleGetAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Accept /assets/<name> only — basename, no slashes
	name := strings.TrimPrefix(r.URL.Path, "/assets/")
	name = strings.TrimSpace(name)
	if name == "" || strings.Contains(name, "/") || strings.Contains(name, "\\") || name == ".." || strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	// Strict filename: uuid hex + ext
	if !safeAssetName(name) {
		http.NotFound(w, r)
		return
	}

	dir, _, err := s.assetDir()
	if err != nil {
		http.Error(w, "asset dir: "+err.Error(), http.StatusInternalServerError)
		return
	}

	full := filepath.Join(dir, name)
	// Ensure resolved path stays under dir
	cleanDir, err := filepath.Abs(dir)
	if err != nil {
		http.Error(w, "asset dir", http.StatusInternalServerError)
		return
	}
	cleanFull, err := filepath.Abs(full)
	if err != nil || !strings.HasPrefix(cleanFull, cleanDir+string(os.PathSeparator)) {
		http.NotFound(w, r)
		return
	}

	f, err := os.Open(cleanFull)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}

	// Content-Type from extension
	ct := "application/octet-stream"
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png":
		ct = "image/png"
	case ".jpg", ".jpeg":
		ct = "image/jpeg"
	case ".gif":
		ct = "image/gif"
	case ".webp":
		ct = "image/webp"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, name, st.ModTime(), f)
}

func safeAssetName(name string) bool {
	// <hex32>.<ext> from randomAssetName, but allow any [A-Za-z0-9._-] with a known ext
	if len(name) < 5 || len(name) > 80 {
		return false
	}
	for _, c := range name {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-' {
			continue
		}
		return false
	}
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp":
		return true
	default:
		return false
	}
}
