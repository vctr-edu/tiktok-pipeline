FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY generator.py run_scheduled.py sync_assets.py ./
CMD ["python", "run_scheduled.py"]
