"""Upload the local image/audio/SRT libraries to MinIO before enabling the cron."""

from __future__ import annotations

import os
from pathlib import Path

import boto3
from botocore.client import Config

IMAGE_DIR = Path(os.environ.get("IMAGE_DIR", r"D:\BROKEN_REFLECTION\Image_Database_Broken"))
SONG_DIR = Path(os.environ.get(
    "SONG_DIR",
    r"C:\Users\victo\OneDrive\Documentos\2. Broken Reflection\1. SRT\BROKEN REFLECTION",
))


def main() -> None:
    client = boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT_URL"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET_KEY"],
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),
    )
    bucket = os.environ["S3_BUCKET"]
    client.create_bucket(Bucket=bucket)
    count = 0
    for source, prefix, allowed in (
        (IMAGE_DIR, "images", {".jpg", ".jpeg", ".png", ".webp"}),
        (SONG_DIR, "songs", {".wav", ".mp3", ".m4a", ".aac", ".flac", ".srt"}),
    ):
        if not source.is_dir():
            raise FileNotFoundError(f"Source folder not found: {source}")
        for path in source.rglob("*"):
            if path.is_file() and path.suffix.lower() in allowed:
                key = f"{prefix}/{path.relative_to(source).as_posix()}"
                client.upload_file(str(path), bucket, key)
                count += 1
                print(f"Uploaded {key}")
    print(f"Uploaded {count} media/source files to bucket {bucket}.")


if __name__ == "__main__":
    main()
