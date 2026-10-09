"""Client for the Node.js pi-durable translation agent worker."""

from __future__ import annotations

import json
import logging
import os
from typing import Any, AsyncGenerator

import httpx

logger = logging.getLogger(__name__)

DEFAULT_WORKER_URL = os.getenv("TRANSLATION_AGENT_WORKER_URL", "http://127.0.0.1:8788").rstrip("/")


class AgentWorkerError(RuntimeError):
    """Error communicating with or executing on the durable translation worker."""


class AgentWorkerClient:
    def __init__(self, base_url: str = DEFAULT_WORKER_URL, timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def check_health(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{self.base_url}/internal/health")
            if resp.status_code != 200:
                raise AgentWorkerError(f"Worker health check failed ({resp.status_code}): {resp.text}")
            return resp.json()

    async def submit_or_attach(
        self,
        *,
        job_key: str | None = None,
        cues: list[dict[str, Any]],
        video_id: str,
        title: str,
        from_lang: str,
        to_lang: str,
        segmentation: str = "rule",
        provider: str = "openai",
        model: str = "gpt-4o",
        base_url: str | None = None,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        payload = {
            "jobKey": job_key,
            "cues": cues,
            "videoId": video_id,
            "title": title,
            "fromLang": from_lang,
            "toLang": to_lang,
            "segmentation": segmentation,
            "provider": provider,
            "model": model,
            "baseUrl": base_url or "https://api.openai.com/v1",
        }
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(f"{self.base_url}/internal/jobs", json=payload)
            if resp.status_code >= 400:
                raise AgentWorkerError(f"Worker job submission failed ({resp.status_code}): {resp.text}")
            return resp.json()

    async def get_job(self, job_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.get(f"{self.base_url}/internal/jobs/{job_id}")
            if resp.status_code >= 400:
                raise AgentWorkerError(f"Failed to get job {job_id} ({resp.status_code}): {resp.text}")
            return resp.json()

    async def stream_job(self, job_id: str) -> AsyncGenerator[dict[str, Any], None]:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("GET", f"{self.base_url}/internal/jobs/{job_id}/stream") as resp:
                if resp.status_code >= 400:
                    error_text = await resp.aread()
                    raise AgentWorkerError(f"Worker stream failed ({resp.status_code}): {error_text.decode('utf-8')}")
                async for line in resp.aiter_lines():
                    if line.startswith(": keepalive"):
                        yield {"type": "keepalive"}
                    elif line.startswith("data: "):
                        data_str = line[6:].strip()
                        if data_str:
                            try:
                                yield json.loads(data_str)
                            except json.JSONDecodeError:
                                continue

    async def abort_job(self, job_id: str) -> bool:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{self.base_url}/internal/jobs/{job_id}/abort")
            return resp.status_code == 200
