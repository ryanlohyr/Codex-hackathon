# MindCanvas 3D

AI-powered interactive educational visualization platform with voice-first agent interface.

## Setup

```bash
pnpm install
cp .env.example .env
# Fill in your API keys in .env
```

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key (GPT-5.2 / GPT-5.3-codex) |
| `VITE_ELEVENLABS_AGENT_ID` | ElevenLabs Conversational AI Agent ID |

## ElevenLabs Voice Agent Setup

This app uses ElevenLabs Conversational AI with a **Custom LLM** backend. ElevenLabs handles STT/TTS while our backend handles all LLM reasoning and tool calling.

### 1. Expose your local server

```bash
ngrok http 3000
```

Copy the generated `https://xxxx.ngrok-free.app` URL.

### 2. Configure ElevenLabs Dashboard

1. Create an Agent at [elevenlabs.io](https://elevenlabs.io)
2. Under **LLM settings**, select **Custom LLM**
3. Set the server URL to: `https://xxxx.ngrok-free.app/api/custom-llm`
4. Enable **"Custom LLM extra body"**
5. Copy the **Agent ID** into your `.env` as `VITE_ELEVENLABS_AGENT_ID`

### 3. Run the app

```bash
pnpm run dev
```

## Tech Stack

- **Frontend:** React 19, React Three Fiber, ReactFlow, Zustand, Framer Motion
- **Voice:** ElevenLabs Conversational AI SDK
- **AI:** OpenAI GPT-5.2 (generation) + GPT-5.3-codex (code editing)
- **Build:** Vite, TanStack Router/Start, TailwindCSS v4

