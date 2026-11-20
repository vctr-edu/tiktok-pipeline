#!/usr/bin/env python3
"""Generate lyric videos from the Broken Reflection image/audio libraries."""

from __future__ import annotations

import argparse
import json
import random
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IMAGE_DIR = Path(__import__("os").environ.get("IMAGE_DIR", r"D:\BROKEN_REFLECTION\Image_Database_Broken"))
SONG_DIR = Path(__import__("os").environ.get("SONG_DIR", r"C:\Users\victo\OneDrive\Documentos\2. Broken Reflection\1. SRT\BROKEN REFLECTION"))
OUTPUT_DIR = ROOT / "output"
STATE_FILE = ROOT / "music_shuffle_state.json"
FPS = 60
IMAGE_FRAMES = 8
IMAGE_OPACITY = 0.45
GHOST_TRAIL_PIXELS = 10
LYRIC_FADE_SECONDS = 0.18
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".aac", ".flac"}


def executable(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    codex_tools = Path.home() / "Documents" / "Codex" / "tools" / "ffmpeg" / f"{name}.exe"
    if codex_tools.is_file():
        return str(codex_tools)
    raise FileNotFoundError(f"{name} was not found. Install FFmpeg and add it to PATH.")


def probe_duration(path: Path) -> float:
    result = subprocess.run(
        [executable("ffprobe"), "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(result.stdout.strip())


def discover_songs() -> list[dict[str, Path]]:
    songs = []
    if not SONG_DIR.is_dir():
        raise FileNotFoundError(f"Song library not found: {SONG_DIR}")
    for folder in sorted(p for p in SONG_DIR.iterdir() if p.is_dir()):
        subtitles = sorted(folder.glob("*.srt"), key=lambda p: p.name.casefold())
        audio = sorted((p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS),
                       key=lambda p: p.name.casefold())
        if subtitles and audio:
            songs.append({"name": folder.name, "srt": subtitles[0], "audio": audio[0]})
    if not songs:
        raise RuntimeError(f"No song folders containing both audio and SRT were found in {SONG_DIR}")
    return songs


def choose_song(songs: list[dict[str, Path]], requested: str | None) -> dict[str, Path]:
    if requested:
        matches = [song for song in songs if song["name"].casefold() == requested.casefold()]
        if not matches:
            raise ValueError(f"Song '{requested}' was not found. Available: {', '.join(s['name'] for s in songs)}")
        return matches[0]

    names = {song["name"] for song in songs}
    state = {"remaining": [], "seen": []}
    if STATE_FILE.exists():
        try:
            state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    remaining = [name for name in state.get("remaining", []) if name in names]
    if not remaining:
        remaining = list(names)
        random.shuffle(remaining)
    name = remaining.pop()
    STATE_FILE.write_text(json.dumps({"remaining": remaining, "seen": state.get("seen", []) + [name]},
                                     indent=2), encoding="utf-8")
    return next(song for song in songs if song["name"] == name)


def parse_srt_time(value: str) -> float:
    value = value.strip().replace(".", ",")
    hours, minutes, rest = value.split(":")
    seconds, millis = rest.split(",")
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis.ljust(3, "0")[:3]) / 1000


def read_srt(path: Path) -> list[tuple[float, float, str]]:
    raw = path.read_text(encoding="utf-8-sig")
    entries = []
    for block in raw.replace("\r", "").strip().split("\n\n"):
        lines = block.splitlines()
        if len(lines) < 3 or "-->" not in lines[1]:
            continue
        start, end = (part.strip() for part in lines[1].split("-->", 1))
        text = "\\N".join(line.strip() for line in lines[2:] if line.strip())
        if text:
            entries.append((parse_srt_time(start), parse_srt_time(end), text))
    if not entries:
        raise ValueError(f"No valid subtitle cues in {path}")
    return entries


def ffmpeg_escape(path: Path) -> str:
    # Filter option escaping for Windows paths and FFmpeg's filter syntax.
    return str(path.resolve()).replace("\\", "/").replace(":", r"\:").replace("'", r"\'")


def generate(song_name: str | None, seed: int | None) -> Path:
    if not IMAGE_DIR.is_dir():
        raise FileNotFoundError(f"Image library not found: {IMAGE_DIR}")
    images = [p for p in IMAGE_DIR.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS]
    if len(images) < 15:
        raise RuntimeError(f"Need at least 15 images; found {len(images)} in {IMAGE_DIR}")
    rng = random.Random(seed)
    chosen_images = rng.sample(images, 15)

    songs = discover_songs()
    song = choose_song(songs, song_name)
    duration = probe_duration(song["audio"])
    cues = read_srt(song["srt"])
    if duration <= 0:
        raise RuntimeError("Could not determine audio duration")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    suffix = " - ghost motion" if GHOST_TRAIL_PIXELS > 0 else ""
    output = OUTPUT_DIR / f"{song['name']}{suffix}.mp4"
    command = [executable("ffmpeg"), "-hide_banner", "-y"]
    for image in chosen_images:
        command += ["-loop", "1", "-framerate", str(FPS), "-i", str(image)]
    command += ["-i", str(song["audio"])]

    filters = []
    for i in range(len(chosen_images)):
        filters.append(
            f"[{i}:v]scale=ceil(iw/2)*2:ceil(ih/2)*2,split=3[m{i}][g1_{i}][g2_{i}];"
            f"[g1_{i}]pad=iw+{GHOST_TRAIL_PIXELS*2}:ih:0:0:black,"
            f"crop=iw-{GHOST_TRAIL_PIXELS*2}:ih:{GHOST_TRAIL_PIXELS}:0[g1c_{i}];"
            f"[g2_{i}]pad=iw+{GHOST_TRAIL_PIXELS*2}:ih:{GHOST_TRAIL_PIXELS*2}:0:black,"
            f"crop=iw-{GHOST_TRAIL_PIXELS*2}:ih:{GHOST_TRAIL_PIXELS}:0[g2c_{i}];"
            f"[m{i}][g1c_{i}]blend=all_expr='A*0.62+B*0.38'[mix1_{i}];"
            f"[mix1_{i}][g2c_{i}]blend=all_expr='A*0.78+B*0.22',"
            f"format=rgba,colorchannelmixer=aa={IMAGE_OPACITY},"
            f"trim=duration={IMAGE_FRAMES/FPS:.9f},setpts=PTS-STARTPTS[v{i}]"
        )
    inputs = "".join(f"[v{i}]" for i in range(len(chosen_images)))
    filters.append(f"{inputs}concat=n={len(chosen_images)}:v=1:a=0,"
                   f"loop=loop=-1:size={IMAGE_FRAMES*len(chosen_images)}:start=0,"
                   f"trim=duration={duration:.6f},setpts=PTS-STARTPTS,fps={FPS}[base]")
    current = "base"
    subtitle_text_files = []
    for i, (start, end, text) in enumerate(cues):
        fade_in = min(LYRIC_FADE_SECONDS, max(0.01, (end - start) / 3))
        fade_out = min(LYRIC_FADE_SECONDS, max(0.01, (end - start) / 3))
        alpha = (f"if(lt(t,{start + fade_in:.6f}),(t-{start:.6f})/{fade_in:.6f},"
                 f"if(lt(t,{end - fade_out:.6f}),1,({end:.6f}-t)/{fade_out:.6f}))")
        next_label = f"lyr{i}"
        text_file = OUTPUT_DIR / f".lyric_{i}.txt"
        text_file.write_text(text.replace("\\N", "\n"), encoding="utf-8")
        subtitle_text_files.append(text_file)
        filters.append(
            f"[{current}]drawtext=textfile='{ffmpeg_escape(text_file)}':"
            f"font=Arial:fontsize=32:fontcolor=white:borderw=2:bordercolor=black@0.65:"
            f"x=(w-text_w)/2:y=(h-text_h)/2:alpha='{alpha}':"
            f"enable='between(t,{start:.6f},{end:.6f})'[{next_label}]"
        )
        current = next_label
    filters.append(f"[{current}]format=yuv420p[vout]")
    command += ["-filter_complex", ";".join(filters), "-map", "[vout]",
                "-map", f"{len(chosen_images)}:a:0", "-t", f"{duration:.6f}",
                "-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output)]
    try:
        subprocess.run(command, check=True)
    finally:
        for text_file in subtitle_text_files:
            text_file.unlink(missing_ok=True)
    print(f"Song: {song['name']}")
    print(f"Duration: {duration:.2f}s; selected 15 random images (8 frames/image, repeated as a loop)")
    print(f"Image opacity: {IMAGE_OPACITY:.0%}; ghost trail offset: {GHOST_TRAIL_PIXELS}px; "
          f"lyric center fades: {LYRIC_FADE_SECONDS:.2f}s")
    print(f"Output: {output}")
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a lyric video from the configured image and song libraries.")
    parser.add_argument("--song", help="Song folder to use; omit to shuffle without repeats until all songs are used")
    parser.add_argument("--seed", type=int, help="Optional deterministic random seed for image selection")
    args = parser.parse_args()
    try:
        generate(args.song, args.seed)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
