"""Local speech-to-text for WHATSAPP_TRANSCRIBE_COMMAND, using faster-whisper.

The MCP server runs this with one or more WAV paths and reads one JSON line per file:
    {"file": "<path>", "text": "...", "language": "de", "seconds": 12.3}

Audio never leaves the machine. Settings (all optional), read from the environment:
    WHISPER_MODEL         model name or local folder (default: large-v3)
    WHISPER_DEVICE        cuda, cpu or auto (default: auto)
    WHISPER_COMPUTE_TYPE  e.g. int8_float16 on a GPU, int8 on a CPU (default: default)
    WHISPER_LANGUAGE      e.g. de; empty means detect per voice note
    WHISPER_PROMPT        names and terms that often come up, to spell them right
    WHISPER_BEAM_SIZE     default 5

Set HF_HUB_OFFLINE=1 once the model is downloaded, so nothing is fetched at run time.
Install: pip install faster-whisper
"""
import json
import os
import sys
import wave

import numpy as np

try:  # On Windows, importing torch first makes the CUDA libraries it ships findable.
    import torch  # noqa: F401
except ImportError:
    pass

from faster_whisper import WhisperModel


def read_wav(path):
    """The server always sends 16 kHz mono 16-bit WAV, so no audio library is needed."""
    with wave.open(path, "rb") as audio:
        if audio.getframerate() != 16000 or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            return path  # anything else: let faster-whisper decode it
        frames = audio.readframes(audio.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def main(paths):
    if not paths:
        sys.exit("usage: transcribe-faster-whisper.py <audio> [<audio> ...]")
    model = WhisperModel(
        os.environ.get("WHISPER_MODEL", "large-v3"),
        device=os.environ.get("WHISPER_DEVICE", "auto"),
        compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "default"),
    )
    options = {
        "language": os.environ.get("WHISPER_LANGUAGE") or None,
        "initial_prompt": os.environ.get("WHISPER_PROMPT") or None,
        "beam_size": int(os.environ.get("WHISPER_BEAM_SIZE", "5")),
        "vad_filter": True,
    }
    for path in paths:
        segments, info = model.transcribe(read_wav(path), **options)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        # ensure_ascii keeps the line readable whatever the console encoding is
        print(json.dumps({"file": path, "text": text, "language": info.language, "seconds": round(info.duration, 1)}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
