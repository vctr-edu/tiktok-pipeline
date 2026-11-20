"""One Render cron run: sync library from MinIO, render one song, publish via API."""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import boto3
import requests
from botocore.client import Config


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing Render environment variable: {name}")
    return value


def storage():
    return boto3.client(
        "s3",
        endpoint_url=required("S3_ENDPOINT_URL"),
        aws_access_key_id=required("S3_ACCESS_KEY"),
        aws_secret_access_key=required("S3_SECRET_KEY"),
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),
    )


def download_prefix(client, bucket: str, prefix: str, folder: Path) -> None:
    paginator = client.get_paginator("list_objects_v2")
    found = False
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for item in page.get("Contents", []):
            key = item["Key"]
            relative = key[len(prefix):].lstrip("/")
            if not relative:
                continue
            target = folder / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            client.download_file(bucket, key, str(target))
            found = True
    if not found:
        raise RuntimeError(f"No source files found in object storage prefix '{prefix}'")


def select_song(client, bucket: str, songs: list[Path]) -> tuple[str, list[str]]:
    key = "state/music_shuffle.json"
    names = sorted(folder.name for folder in songs)
    try:
        state = json.loads(client.get_object(Bucket=bucket, Key=key)["Body"].read())
    except client.exceptions.NoSuchKey:
        state = {"remaining": []}
    except Exception as error:
        if "NoSuchKey" not in str(error):
            raise
        state = {"remaining": []}
    remaining = [name for name in state.get("remaining", []) if name in names]
    if not remaining:
        remaining = names[:]
        random.SystemRandom().shuffle(remaining)
    selection = remaining.pop()
    return selection, remaining


def publish(video: Path, duration: float) -> dict:
    api = required("TIKTOK_API_URL").rstrip("/")
    password = required("DASHBOARD_PASSWORD")
    account = os.environ.get("TIKTOK_ACCOUNT", "broken_reflection")
    privacy = os.environ.get("TIKTOK_PRIVACY", "PUBLIC_TO_EVERYONE")
    login = requests.post(f"{api}/api/dashboard/login", json={"password": password}, timeout=30)
    login.raise_for_status()
    token = login.json()["token"]
    with video.open("rb") as stream:
        response = requests.post(
            f"{api}/api/tiktok/publish",
            headers={"Authorization": f"Bearer {token}"},
            data={"accountKey": account, "privacy": privacy, "consent": "true",
                  "durationSeconds": f"{duration:.6f}",
                  "allowComments": "true", "allowDuet": "true", "allowStitch": "true"},
            files={"video": (video.name, stream, "video/mp4")},
            timeout=(30, 900),
        )
    response.raise_for_status()
    return response.json()


def main() -> int:
    if os.environ.get("ENABLE_AUTO_PUBLISH", "false").lower() != "true":
        print("Automatic publishing is disabled. Set ENABLE_AUTO_PUBLISH=true in Render after review.")
        return 0
    client = storage()
    bucket = required("S3_BUCKET")
    with tempfile.TemporaryDirectory(prefix="br-automation-") as temporary:
        work = Path(temporary)
        images = work / "images"
        songs_dir = work / "songs"
        images.mkdir()
        songs_dir.mkdir()
        download_prefix(client, bucket, "images/", images)
        download_prefix(client, bucket, "songs/", songs_dir)
        songs = [p for p in songs_dir.iterdir() if p.is_dir() and list(p.glob("*.srt"))]
        if not songs:
            raise RuntimeError("No song folders with SRT files were found in MinIO")
        chosen, remaining = select_song(client, bucket, songs)
        env = os.environ.copy()
        env["IMAGE_DIR"] = str(images)
        env["SONG_DIR"] = str(songs_dir)
        generator = Path(__file__).with_name("generator.py")
        subprocess.run([sys.executable, str(generator), "--song", chosen], check=True, env=env)
        video = generator.parent / "output" / f"{chosen} - ghost motion.mp4"
        if not video.is_file():
            raise RuntimeError(f"Rendered video not found: {video}")
        duration = float(subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
            text=True,
        ).strip())
        result = publish(video, duration)
        client.upload_file(video, bucket, f"published/{chosen}/{video.name}")
        client.put_object(
            Bucket=bucket,
            Key="state/music_shuffle.json",
            Body=json.dumps({"remaining": remaining}, indent=2).encode("utf-8"),
            ContentType="application/json",
        )
        client.put_object(
            Bucket=bucket,
            Key=f"published/{chosen}/result.json",
            Body=json.dumps({"song": chosen, **result}, indent=2).encode("utf-8"),
            ContentType="application/json",
        )
        print(json.dumps({"song": chosen, "publish": result}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Automation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
