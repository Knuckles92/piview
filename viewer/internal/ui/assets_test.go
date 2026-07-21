package ui

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAssetUploadAndGet(t *testing.T) {
	cwd := t.TempDir()
	s := New(os.DirFS(cwd), nil)
	s.SetHello(cwd)

	// Minimal PNG header + IHDR/IDAT/IEND (1x1)
	png := []byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
		0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
		0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
		0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
		0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
		0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
	}

	req := httptest.NewRequest(http.MethodPost, "/api/assets", bytes.NewReader(png))
	req.Header.Set("Content-Type", "image/png")
	rr := httptest.NewRecorder()
	s.handleUploadAsset(rr, req)
	if rr.Code != 200 {
		t.Fatalf("upload status %d: %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		OK   bool   `json:"ok"`
		URL  string `json:"url"`
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if !resp.OK || !strings.HasPrefix(resp.URL, "/assets/") || !strings.HasPrefix(resp.Path, ".piview/assets/") {
		t.Fatalf("unexpected resp: %+v", resp)
	}
	disk := filepath.Join(cwd, resp.Path)
	if _, err := os.Stat(disk); err != nil {
		t.Fatalf("file not on disk: %v", err)
	}

	get := httptest.NewRequest(http.MethodGet, resp.URL, nil)
	gr := httptest.NewRecorder()
	s.handleGetAsset(gr, get)
	if gr.Code != 200 {
		t.Fatalf("get status %d", gr.Code)
	}
	body, _ := io.ReadAll(gr.Body)
	if !bytes.Equal(body, png) {
		t.Fatalf("body mismatch len %d", len(body))
	}
	if ct := gr.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type %s", ct)
	}

	// traversal
	bad := httptest.NewRequest(http.MethodGet, "/assets/../secret.png", nil)
	br := httptest.NewRecorder()
	s.handleGetAsset(br, bad)
	if br.Code != 404 {
		t.Fatalf("expected 404 for traversal, got %d", br.Code)
	}

	// reject non-image
	req2 := httptest.NewRequest(http.MethodPost, "/api/assets", bytes.NewReader([]byte("#!/bin/sh\n")))
	req2.Header.Set("Content-Type", "text/plain")
	rr2 := httptest.NewRecorder()
	s.handleUploadAsset(rr2, req2)
	if rr2.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415, got %d %s", rr2.Code, rr2.Body.String())
	}
}
