from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

from dotenv import load_dotenv

from .errors import IngestError
from .pipeline import ingest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="youtube-ingest",
        description="Fetch YouTube metadata and produce a raw transcript.",
    )
    parser.add_argument("url", help="YouTube video URL")
    parser.add_argument("-o", "--output-dir", type=Path, default=Path("output"))
    parser.add_argument(
        "--languages",
        default="zh-Hans,zh-Hant,zh,en",
        help="Comma-separated subtitle preference order",
    )
    parser.add_argument(
        "--manual-subtitles-only",
        action="store_true",
        help="Ignore automatically generated captions",
    )
    parser.add_argument("--chunk-seconds", type=int, default=600)
    parser.add_argument(
        "--transcription-language",
        help="Optional ISO-639-1 hint passed to Whisper, e.g. zh or en",
    )
    parser.add_argument("--whisper-base-url", help="OpenAI-compatible API base URL")
    parser.add_argument("--whisper-model", help="Transcription model name")
    return parser


def main(argv: list[str] | None = None) -> None:
    load_dotenv(dotenv_path=Path.cwd() / ".env")
    args = build_parser().parse_args(argv)
    try:
        result = ingest(
            url=args.url,
            output_dir=args.output_dir,
            languages=args.languages.split(","),
            allow_automatic_subtitles=not args.manual_subtitles_only,
            chunk_seconds=args.chunk_seconds,
            transcription_language=args.transcription_language,
            whisper_base_url=args.whisper_base_url,
            whisper_model=args.whisper_model,
        )
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
