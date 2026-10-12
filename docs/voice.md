# Voice-over (optional)

Without voice, reels are rendered with animated on-screen text and no speech. With voice, each line is spoken by a **local text-to-speech server** and the picture is timed to the audio, line by line.

Reelwright talks to any server that implements the OpenAI endpoint `POST {baseUrl}/audio/speech` and can answer with WAV. That includes [VoiceStudio](https://github.com/debpalash/VoiceStudio), a fully local, open-source alternative to ElevenLabs with voice cloning.

1. Start your TTS server (for VoiceStudio, follow its README; it exposes an OpenAI-compatible API on its local backend).
2. `reelwright setup` → voice → enter the base URL (for example `http://127.0.0.1:8000/v1`, **use the port your server prints**), the model name and the voice or cloned-voice profile.
3. Ask Claude to render with `voiceover: true`.

Notes

- CPU-only machines work but are slow; the first request may download models.
- VoiceStudio is AGPL-3.0 and runs as a separate process; Reelwright only talks to it over HTTP.
- Only clone voices you have the right to clone, and label AI voices where required.
- The server must return WAV. If yours returns MP3, switch its output format.
