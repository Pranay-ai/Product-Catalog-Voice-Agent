# Voicebot Frontend (React + Vite)

This is a **mobile-style web UI** for the voicebot.  
It connects to the Node.js backend via WebSockets and displays ASR + LLM responses with optional TTS playback.

## Requirements
- Node.js 20+
- Backend (`voicebot-nodejs-backend`) running
- Browser with microphone + Web Speech API support

## Setup
```bash
cd voicebot-frontend/web
npm install
```

## Run Dev Server
```bash
npm run dev
```
Open in browser:
```
http://localhost:5173
```

## Proxy
```js
server: {
  proxy: {
    "/control": { target: "http://localhost:8080", ws: true },
    "/audio":   { target: "http://localhost:8080", ws: true },
  }
}
```

## Features
- Call / End Call buttons  
- Real-time ASR transcript display  
- Assistant responses (opener + final)  
- TTS playback via browser `speechSynthesis`
