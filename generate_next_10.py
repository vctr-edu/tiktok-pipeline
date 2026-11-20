#!/usr/bin/env python3
"""Render the next ten numbered videos with the existing TikTok automation."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
AUTOMATION_DIR = HERE.parent / "tiktok-automation"
AUTOMATION_SCRIPT = AUTOMATION_DIR / "automation.py"
CONFIG_FILE = AUTOMATION_DIR / "config.json"
STATE_FILE = AUTOMATION_DIR / "data" / "generate_next_10_state.json"
NUMBERED_VIDEO = re.compile(r"^Video\s*\((\d+)\)$", re.IGNORECASE)
VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm"}
MUSIC_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac"}
BATCH_SIZE = 10


def configured_path(config: dict, key: str) -> Path:
    path = Path(config[key]).expanduser()
    return path if path.is_absolute() else (AUTOMATION_DIR / path).resolve()


def video_number(path: Path) -> int | None:
    match = NUMBERED_VIDEO.fullmatch(path.stem)
    return int(match.group(1)) if match else None


def list_numbered_videos(folder: Path) -> list[tuple[int, Path]]:
    videos = [
        (number, path)
        for path in folder.iterdir()
        if path.is_file()
        and path.suffix.lower() in VIDEO_EXTENSIONS
        and (number := video_number(path)) is not None
    ]
    return sorted(videos, key=lambda item: item[0])


def most_recent_rendered_number(output_dir: Path) -> int | None:
    rendered = []
    for path in output_dir.glob("*.captioned.mp4"):
        match = re.fullmatch(r"Video\s*\((\d+)\)\.captioned", path.stem, re.IGNORECASE)
        if match:
            rendered.append((path.stat().st_mtime_ns, int(match.group(1))))
    return max(rendered)[1] if rendered else None


def load_last_number(videos: list[tuple[int, Path]], output_dir: Path) -> int | None:
    by_name = {path.name.casefold(): number for number, path in videos}

    # Persisted state is updated after each successful render, so a rerun
    # resumes after the last completed video if a batch was interrupted.
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        name = str(state.get("last_input_video", "")).casefold()
        if name in by_name:
            return by_name[name]
    except (OSError, json.JSONDecodeError, AttributeError):
        pass

    # Also recognize work rendered before this helper was installed.
    rendered_number = most_recent_rendered_number(output_dir)
    if rendered_number is not None and any(number == rendered_number for number, _ in videos):
        return rendered_number

    # With no render history, start at the first numbered source video.
    return None


def choose_music(config: dict) -> Path | None:
    if not config.get("replace_audio_with_music", True):
        return None

    folder = configured_path(config, "music_folder")
    extensions = {extension.lower() for extension in config.get("music_extensions", MUSIC_EXTENSIONS)}
    tracks = sorted(
        (path for path in folder.rglob("*") if path.is_file() and path.suffix.lower() in extensions),
        key=lambda path: (path.name.casefold(), str(path.parent).casefold()),
    )
    if not tracks:
        raise RuntimeError(f"No music tracks found in: {folder}")

    print("\nChoose the music track to use for all 10 videos:")
    for index, track in enumerate(tracks, start=1):
        try:
            display_path = track.relative_to(folder)
        except ValueError:
            display_path = track
        print(f"  {index}. {display_path}")

    while True:
        value = input(f"Music track number (1-{len(tracks)}): ").strip()
        if value.isdigit() and 1 <= int(value) <= len(tracks):
            return tracks[int(value) - 1]
        print("Enter one of the listed track numbers.")


def save_progress(video: Path, batch_position: int) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "last_input_video": video.name,
        "last_completed_batch_position": batch_position,
    }
    STATE_FILE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    try:
        if not AUTOMATION_SCRIPT.is_file():
            raise RuntimeError(f"Could not find the automation script: {AUTOMATION_SCRIPT}")
        if not CONFIG_FILE.is_file():
            raise RuntimeError(f"Could not find the automation config: {CONFIG_FILE}")
        config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        input_dir = configured_path(config, "input_folder")
        output_dir = configured_path(config, "output_folder")
        videos = list_numbered_videos(input_dir)
        if len(videos) < BATCH_SIZE:
            raise RuntimeError(
                f"Found {len(videos)} numbered source videos in {input_dir}; "
                f"at least {BATCH_SIZE} are needed to render 10 different videos."
            )

        last_number = load_last_number(videos, output_dir)
        numbers = [number for number, _ in videos]
        start_index = numbers.index(last_number) + 1 if last_number in numbers else 0
        batch = [videos[(start_index + offset) % len(videos)] for offset in range(BATCH_SIZE)]
        music = choose_music(config)

        print("\nThe next 10 videos will be rendered in this order:")
        for _, video in batch:
            print(f"  {video.name}")
        print(f"\nOutput folder: {output_dir}")
        input("Press Enter to start rendering, or Ctrl+C to cancel...")

        for index, (number, video) in enumerate(batch, start=1):
            print(f"\n[{index}/{BATCH_SIZE}] Rendering {video.name} (video #{number})")
            command = [sys.executable, str(AUTOMATION_SCRIPT), "render", "--video", str(video)]
            if music is not None:
                command += ["--music", str(music)]
            result = subprocess.run(command, cwd=AUTOMATION_DIR, check=False)
            if result.returncode != 0:
                print(f"\nStopped: rendering {video.name} failed. Progress is saved; run again to continue.", file=sys.stderr)
                return result.returncode
            save_progress(video, index)

        print(f"\nFinished rendering 10 videos. Files are in:\n{output_dir}")
        return 0
    except KeyboardInterrupt:
        print("\nCancelled. Completed video progress is saved.", file=sys.stderr)
        return 130
    except (OSError, KeyError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
