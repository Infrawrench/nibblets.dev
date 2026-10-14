# Makes src/singalong/song.json for the singalong, from the song and its lyrics:
#
#   uv run --python 3.12 --with stable-ts --with demucs --with librosa \
#     scripts/singalong.py song.mp3 scripts/kernow-lyrics.txt src/singalong/song.json
#
# It separates the vocals (demucs), force-aligns the lyrics to them word by word (stable-ts, with
# Whisper's medium model), finds the beats, and measures the song's loudness 30 times a second.
import base64, json, re, subprocess, sys, tempfile
from pathlib import Path

import librosa
import numpy as np
import stable_whisper

song, lyrics, out = sys.argv[1:4]

# the vocals alone
tmp = Path(tempfile.mkdtemp())
subprocess.run([sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", tmp, song], check=True)
vocals = str(next(tmp.glob("htdemucs/*/vocals.wav")))

# the words, each with when it starts and ends
lines, section = [], None
for raw in Path(lyrics).read_text().splitlines():
    raw = raw.strip()
    if m := re.fullmatch(r"\[(\w+)\]", raw):
        section = m.group(1)
    elif raw:
        lines.append([section, raw.split()])
aligned = stable_whisper.load_model("medium").align(
    vocals, "\n".join(" ".join(ws) for _, ws in lines), language="en", original_split=False
)
found = iter(w for s in aligned.segments for w in s.words)
rows = []
for section, ws in lines:
    row = []
    for text in ws:
        w = next(found)
        row.append([text, round(w.start, 3), round(w.end, 3)])
    # no word starts before the one before it, or lasts less than 80ms (the aligner gives a line's
    # first word nothing when it starts on a held note)
    for i in range(1, len(row)):
        row[i][1] = round(max(row[i][1], row[i - 1][1] + 0.08), 3)
        row[i - 1][2] = round(min(max(row[i - 1][2], row[i - 1][1] + 0.08), row[i][1]), 3)
    row[-1][2] = round(max(row[-1][2], row[-1][1] + 0.25), 3)
    rows.append([section, row])

# the beats, and how loud it is: bass, overall, treble and the voice, one byte each
sr = 22050
hop = sr // 30
y, _ = librosa.load(song, sr=sr, mono=True)
v, _ = librosa.load(vocals, sr=sr, mono=True)
spec = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)


def norm(x):
    x = np.log1p(x * 50)
    return np.clip(x / np.percentile(x, 99.5), 0, 1)


bands = [
    norm(spec[(freqs >= 30) & (freqs < 180)].mean(axis=0)),
    norm(librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]),
    norm(spec[(freqs >= 3000) & (freqs < 9000)].mean(axis=0)),
    norm(librosa.feature.rms(y=v, frame_length=2048, hop_length=hop)[0]),
]
n = min(len(b) for b in bands)
loudness = (np.stack([b[:n] for b in bands], axis=1) * 255).round().astype(np.uint8).tobytes()
_, beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=512, units="time")

Path(out).write_text(
    json.dumps(
        {"lines": rows, "beats": [round(float(b), 3) for b in beats], "env": base64.b64encode(loudness).decode()},
        separators=(",", ":"),
    )
)
