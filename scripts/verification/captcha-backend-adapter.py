#!/usr/bin/env python3
"""chrome-faithful verification backend adapter.

JSON protocol over stdin/stdout for the chrome-faithful verification solvers:

    {"action": "status"}            -> availability report
    {"action": "solve-audio", "audioPath": "..."}   -> {"text": "12345"}
    {"action": "solve-audio", "audioUrl": "..."}    -> downloads then transcribes
    {"action": "solve-image", "imagePath": "..."}   -> {"text": "58321"}
    {"action": "locate-gap", "imagePath": "..."}    -> {"x": 123.0}

Backends are optional and loaded lazily, newest first:

  1. bridge.captcha_connector.CaptchaConnector (the Agent OS captcha stack:
     faster-whisper audio, baidu/Unlimited-OCR or tesseract image, opencv gap).
  2. Standalone fallbacks: faster-whisper for audio, ddddocr/tesseract for
     images, opencv for gap detection when the connector module is absent.

Exit code 0 with a JSON answer, or non-zero with a message on stderr.
"""

import json
import sys


def _load_connector():
    try:
        from bridge.captcha_connector import CaptchaConnector  # type: ignore

        return CaptchaConnector()
    except Exception:
        return None


def _standalone_status():
    # Preferred when the Agent OS captcha stack (bridge.captcha_connector) is
    # importable; these standalone fallbacks keep the adapter usable without
    # that machine-specific module. They are intentionally simpler than the
    # connector's own fallbacks (which remain the higher-fidelity path).
    report = {
        "backend": "standalone",
        "whisper": False,
        "ocr": False,
        "opencv": False,
    }
    try:
        import faster_whisper  # noqa: F401

        report["whisper"] = True
    except Exception:
        pass
    for module in ("ddddocr", "pytesseract"):
        try:
            __import__(module)
            report["ocr"] = True
            break
        except Exception:
            continue
    try:
        import cv2  # noqa: F401

        report["opencv"] = True
    except Exception:
        pass
    return report


def _solve_audio_standalone(audio_path, digits_only=True):
    from faster_whisper import WhisperModel

    model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, _info = model.transcribe(audio_path, language=None, vad_filter=False)
    text = "".join(segment.text for segment in segments).strip()
    if digits_only:
        text = "".join(ch for ch in text if ch.isdigit())
    return text


def _solve_image_standalone(image_path, digits_only=False):
    try:
        import ddddocr

        ocr = ddddocr.DdddOcr(show_ad=False)
        with open(image_path, "rb") as handle:
            text = ocr.classification(handle.read())
    except Exception:
        import pytesseract
        from PIL import Image

        text = pytesseract.image_to_string(Image.open(image_path)).strip()
    if digits_only:
        text = "".join(ch for ch in text if ch.isdigit())
    return text


def _locate_gap_standalone(image_path):
    import cv2
    import numpy as np

    image = cv2.imread(str(image_path))
    if image is None:
        raise RuntimeError("cannot read image for gap detection")
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 100, 200)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w < 10 or h < 10:
            continue
        if best is None or w > best[2]:
            best = (x, y, w, h)
    if best is None:
        raise RuntimeError("no gap contour found")
    return float(best[0] + best[2] / 2)


def main():
    payload = json.load(sys.stdin)
    action = payload.get("action", "status")
    connector = _load_connector()

    if action == "status":
        if connector is not None:
            print(json.dumps(connector.status(), ensure_ascii=False))
            return 0
        print(json.dumps(_standalone_status(), ensure_ascii=False))
        return 0

    if action == "solve-audio":
        audio_path = payload.get("audioPath")
        audio_url = payload.get("audioUrl")
        if connector is not None:
            if audio_url:
                text = connector.solve_recaptcha_audio_from_url(audio_url)
            elif audio_path:
                text = connector.solve_recaptcha_audio(audio_path)
            else:
                raise RuntimeError("solve-audio requires audioPath or audioUrl")
            print(json.dumps({"text": text}, ensure_ascii=False))
            return 0
        if not audio_path:
            raise RuntimeError("standalone solve-audio requires a local audioPath")
        print(json.dumps({"text": _solve_audio_standalone(audio_path)}, ensure_ascii=False))
        return 0

    if action == "solve-image":
        image_path = payload.get("imagePath")
        if not image_path:
            raise RuntimeError("solve-image requires imagePath")
        if connector is not None:
            text = connector.solve_image_captcha(image_path)
            print(json.dumps({"text": text}, ensure_ascii=False))
            return 0
        print(json.dumps({"text": _solve_image_standalone(image_path)}, ensure_ascii=False))
        return 0

    if action == "locate-gap":
        image_path = payload.get("imagePath")
        if not image_path:
            raise RuntimeError("locate-gap requires imagePath")
        if connector is not None:
            x = connector.locate_slider_gap(image_path)
            print(json.dumps({"x": float(x)}, ensure_ascii=False))
            return 0
        print(json.dumps({"x": _locate_gap_standalone(image_path)}, ensure_ascii=False))
        return 0

    raise RuntimeError(f"unknown action: {action}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - adapter boundary
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
