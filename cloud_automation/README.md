# Render video publisher POC

This service downloads the media library from MinIO, renders one lyric video with FFmpeg, publishes it through the existing Broken Reflection API, and saves the MP4 plus TikTok response in MinIO. The music queue is shuffled without repeats and is advanced only after TikTok accepts the upload.

## Before deployment

1. Commit and push this repository to GitHub.
2. In Render, create a Blueprint using `render-automation.yaml` in this repository. This creates MinIO with a 10 GB persistent disk and a disabled daily cron job. The cron's starter schedule is 03:00 UTC (midnight in São Paulo); change it in Render before enabling if you want another posting time.
3. Copy the generated `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` from the MinIO service environment. Set those same values as `S3_ACCESS_KEY` and `S3_SECRET_KEY` on your local computer, set `S3_ENDPOINT_URL` to the MinIO service's public HTTPS URL, and set `S3_BUCKET=broken-reflection-media`.
4. From `cloud_automation`, install `requirements.txt` and run `python sync_assets.py` once. This uploads the image library and every paired audio/SRT file from the source folders configured in the script.
5. Set `DASHBOARD_PASSWORD` on the cron service to the same dashboard password configured on the existing API service. Confirm `TIKTOK_ACCOUNT` is the intended connected account (`broken_reflection` or `tsr_music`) and confirm `TIKTOK_PRIVACY` is permitted for it.
6. Trigger one manual cron run while `ENABLE_AUTO_PUBLISH=false` to confirm the service starts without posting. Then enable `ENABLE_AUTO_PUBLISH=true` only when you intend the configured cron schedule to publish automatically.

The GitHub Pages static site does not run this automation. Render runs the cron independently, so your computer can be off after the one-time media upload. Render cron times use UTC. The generator uses 60 fps, original image dimensions, 15 random images, 8 frames per image, 45% opacity, 10 px horizontal ghost trails, centered lyrics, and 0.18-second lyric fades.

## Source libraries

- Images: `D:\BROKEN_REFLECTION\Image_Database_Broken`
- Songs with matching SRT: `C:\Users\victo\OneDrive\Documentos\2. Broken Reflection\1. SRT\BROKEN REFLECTION`

Do not commit the media library or any credentials to Git. Render secrets belong in the service's Environment settings.
