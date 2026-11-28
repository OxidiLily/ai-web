# WebBridge - AI File Connector

Koneksi AI chat web (Claude, Qwen, dan DeepSeek) ke file lokal via browser extension + local bridge server.

## Arsitektur

```
Browser (AI Chat Site)
  ↕ Chrome Extension (content script + background service worker)
  ↕ WebSocket ws://127.0.0.1:9800
Node.js Bridge Server
  ↕ File System API
Local Files (dalam workspace)
```

## Quick Start

### 1. Start Bridge Server

```bash
cd server
npm install
npm start
```

Atau double-click `server/start.bat` (Windows).

### 2. Install Extension

1. Buka `chrome://extensions`
2. Aktifkan "Developer mode"
3. Klik "Load unpacked"
4. Pilih folder `extension/`

### 3. Sync Workspace VS Code (Windows)

1. Pastikan server WebBridge berjalan (`server/start.bat`).
2. Di VS Code, buka folder project yang ingin dipakai.
3. Install dependency companion sekali dari terminal di folder `vscode/`: `npm install`.
4. Buka folder `vscode/` di VS Code, lalu tekan `F5` untuk menjalankan companion dalam Extension Development Host.
5. Di jendela VS Code yang membuka project target, jalankan command palette → `WebBridge: Sync Active Workspace`.
6. Popup browser menampilkan folder aktif. Bridge membatasi baca/tulis ke folder itu.

Catatan: F5 menjalankan companion hanya di Extension Development Host. Untuk penggunaan biasa, pasang companion sebagai VS Code extension atau jalankan sync dari jendela Development Host yang membuka project target.

Fallback: masukkan path workspace dari popup WebBridge jika tidak memakai companion VS Code.

### 4. Gunakan

- Buka Claude, Qwen, atau DeepSeek
- Klik tombol 🔗 (kanan bawah) untuk mengaktifkan sesi WebBridge
- Chat seperti biasa: minta AI membaca, menulis, mengedit, atau mencari file di workspace kamu
- WebBridge akan mengeksekusi perintah file tool secara otomatis di latar belakang dan AI akan membalas dengan jawaban final

## Fitur

| Fitur | Status |
|-------|--------|
| Read file / lines | ✅ |
| Write / Create file | ✅ |
| Edit file (find & replace / patch) | ✅ |
| Delete file & directory | ✅ |
| Create directory | ✅ |
| Move / Copy file | ✅ |
| Search files (glob + content regex) | ✅ |
| File info & tree listing | ✅ |
| Automated Agent tool execution | ✅ |
| Workspace sandbox & security | ✅ |
| Countdown cooldown / rate limit / jeda kirim (realtime, 50 ms) | ✅ |
| Tombol ⏹ Stop untuk menghentikan agent | ✅ |

## Security

- Server hanya bind ke `127.0.0.1` (tidak bisa diakses dari luar)
- Semua operasi file di-sandbox ke workspace yang di-set
- Path traversal dilindungi (tidak bisa akses file di luar workspace)
- Proteksi symlink dan proteksi workspace root
- Max file size 10MB
- Max WebSocket payload 128MB

## Tombol Stop

Saat agent berjalan, tombol **⏹ Stop** muncul di status bar (kanan bawah). Jika salah memberi perintah, klik Stop lalu ketik perintah baru di chat. Stop akan:

1. membatalkan hitung mundur dan tool call yang sedang ditunggu,
2. membunuh `run_command` yang masih berjalan di bridge server,
3. menekan tombol stop bawaan AI (Claude/Qwen/DeepSeek) agar AI berhenti menjawab,
4. menandai jawaban yang terpotong sebagai "sudah ditangani" sehingga tool call setengah jadi tidak dieksekusi.

Tool file yang sudah terkirim ke server (mis. `write_file`) berjalan sangat cepat dan tetap selesai; yang dibatalkan adalah langkah-langkah berikutnya.

## Supported AI Sites

- Claude (claude.ai)
- Qwen (chat.qwen.ai, chat.qwenlm.ai, tongyi.aliyun.com)
- DeepSeek (chat.deepseek.com)
