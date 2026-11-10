"""本地转写进程：stdout 只输出 JSON；依赖安装和模型准备由部署者负责。"""

import contextlib
import importlib.metadata
import json
import sys


def main():
    with contextlib.redirect_stdout(sys.stderr):
        from faster_whisper import WhisperModel

        if len(sys.argv) == 2 and sys.argv[1] == "--doctor":
            result = {"status": "ok", "version": importlib.metadata.version("faster-whisper")}
        elif len(sys.argv) == 3 and sys.argv[1] == "--transcribe":
            request = json.loads(sys.argv[2])
            model = WhisperModel(
                request["model"],
                device=request["device"],
                compute_type=request["computeType"],
                download_root=request.get("cacheDir"),
                local_files_only=request["localFilesOnly"],
            )
            segments, info = model.transcribe(
                request["file"], language=request.get("language"), word_timestamps=True,
            )
            rows = []
            for segment in segments:
                words = [
                    {"start": word.start, "end": word.end, "word": word.word}
                    for word in (segment.words or [])
                ]
                rows.append({
                    "start": segment.start, "end": segment.end,
                    "text": segment.text, "words": words,
                })
            result = {
                "text": "".join(row["text"] for row in rows),
                "language": info.language,
                "duration": info.duration,
                "segments": rows,
            }
        else:
            raise ValueError("需要 --doctor 或 --transcribe <JSON>")
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
