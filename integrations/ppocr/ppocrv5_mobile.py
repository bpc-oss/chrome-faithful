#!/usr/bin/env python3
"""Bounded stdin/stdout adapter for user-installed PP-OCRv5 mobile models."""

import base64
import binascii
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys


BACKEND = "ppocrv5-mobile"
MAX_REQUEST_BYTES = 67_108_864
MAX_IMAGE_BYTES = 50_331_648
MAX_PIXELS = 40_000_000
MAX_BLOCKS = 2_000
MAX_BLOCK_TEXT = 4_096
DET_MODEL_ENV = "CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR"
REC_MODEL_ENV = "CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR"


class ProtocolError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.public_message = message


def _model_directories():
    det = os.environ.get(DET_MODEL_ENV, "")
    rec = os.environ.get(REC_MODEL_ENV, "")
    if not det or not rec:
        return None
    det_path = Path(det)
    rec_path = Path(rec)
    if not det_path.is_absolute() or not rec_path.is_absolute():
        return None
    if not det_path.is_dir() or not rec_path.is_dir():
        return None
    return det_path, rec_path


def _dependencies_available():
    return all(importlib.util.find_spec(name) is not None for name in (
        "paddleocr", "numpy", "cv2"
    ))


def _status():
    if not _dependencies_available():
        return {
            "available": False,
            "backend": BACKEND,
            "reason": "python_dependencies_missing",
        }
    if _model_directories() is None:
        return {
            "available": False,
            "backend": BACKEND,
            "reason": "local_models_missing",
        }
    return {"available": True, "backend": BACKEND}


def _decode_png(request):
    if request.get("mimeType") != "image/png":
        raise ProtocolError(
            "PPOCR_INVALID_IMAGE",
            "The OCR request must contain one bounded PNG image.",
        )
    encoded = request.get("imageBase64")
    if not isinstance(encoded, str) or len(encoded) > (MAX_IMAGE_BYTES * 4 // 3 + 8):
        raise ProtocolError(
            "PPOCR_INVALID_IMAGE",
            "The OCR request must contain one bounded PNG image.",
        )
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ProtocolError(
            "PPOCR_INVALID_IMAGE",
            "The OCR request must contain one bounded PNG image.",
        ) from None
    if len(image_bytes) < 24 or len(image_bytes) > MAX_IMAGE_BYTES:
        raise ProtocolError(
            "PPOCR_INVALID_IMAGE",
            "The OCR request must contain one bounded PNG image.",
        )
    if image_bytes[:8] != b"\x89PNG\r\n\x1a\n" or image_bytes[12:16] != b"IHDR":
        raise ProtocolError(
            "PPOCR_INVALID_IMAGE",
            "The OCR request must contain one bounded PNG image.",
        )
    width = int.from_bytes(image_bytes[16:20], "big")
    height = int.from_bytes(image_bytes[20:24], "big")
    if width < 1 or height < 1 or width > MAX_PIXELS // height:
        raise ProtocolError(
            "PPOCR_INVALID_IMAGE",
            "The OCR request must contain one bounded PNG image.",
        )

    try:
        with contextlib.redirect_stdout(sys.stderr):
            import cv2
            import numpy as np
            image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        raise ProtocolError(
            "PPOCR_RUNTIME_UNAVAILABLE",
            "Install the local PaddleOCR runtime and its image dependencies.",
        ) from None
    if image is None:
        raise ProtocolError(
            "PPOCR_INVALID_IMAGE",
            "The OCR request must contain one bounded PNG image.",
        )
    return image


def _plain(value):
    return value.tolist() if hasattr(value, "tolist") else value


def _result_payload(result):
    value = getattr(result, "json", result)
    if callable(value):
        value = value()
    if not isinstance(value, dict):
        raise ProtocolError("PPOCR_INVALID_OUTPUT", "The local OCR backend returned invalid output.")
    payload = value.get("res", value)
    if not isinstance(payload, dict):
        raise ProtocolError("PPOCR_INVALID_OUTPUT", "The local OCR backend returned invalid output.")
    return payload


def _rectangle(box):
    points = _plain(box)
    if not isinstance(points, (list, tuple)):
        raise ProtocolError("PPOCR_INVALID_OUTPUT", "The local OCR backend returned invalid output.")
    if len(points) == 4 and all(not isinstance(item, (list, tuple)) for item in points):
        return [float(item) for item in points]
    if len(points) < 1:
        raise ProtocolError("PPOCR_INVALID_OUTPUT", "The local OCR backend returned invalid output.")
    coordinates = [_plain(point) for point in points]
    if any(not isinstance(point, (list, tuple)) or len(point) != 2 for point in coordinates):
        raise ProtocolError("PPOCR_INVALID_OUTPUT", "The local OCR backend returned invalid output.")
    xs = [float(point[0]) for point in coordinates]
    ys = [float(point[1]) for point in coordinates]
    return [min(xs), min(ys), max(xs), max(ys)]


def _convert_predictions(predictions):
    blocks = []
    for result in predictions:
        payload = _result_payload(result)
        texts = _plain(payload.get("rec_texts"))
        scores = _plain(payload.get("rec_scores"))
        boxes = _plain(payload.get("rec_boxes"))
        if boxes is None:
            boxes = _plain(payload.get("rec_polys"))
        if not isinstance(texts, (list, tuple)) or not isinstance(scores, (list, tuple)):
            raise ProtocolError("PPOCR_INVALID_OUTPUT", "The local OCR backend returned invalid output.")
        if not isinstance(boxes, (list, tuple)) or len(texts) != len(scores) or len(texts) != len(boxes):
            raise ProtocolError("PPOCR_INVALID_OUTPUT", "The local OCR backend returned invalid output.")
        for text, score, box in zip(texts, scores, boxes):
            if not isinstance(text, str) or len(text) > MAX_BLOCK_TEXT:
                raise ProtocolError("PPOCR_INVALID_OUTPUT", "The local OCR backend returned invalid output.")
            blocks.append({
                "text": text,
                "confidence": float(score),
                "box": _rectangle(box),
            })
            if len(blocks) > MAX_BLOCKS:
                raise ProtocolError("PPOCR_INVALID_OUTPUT", "The local OCR backend returned invalid output.")
    return {"blocks": blocks}


def _ocr(request):
    model_directories = _model_directories()
    if model_directories is None:
        raise ProtocolError(
            "PPOCR_LOCAL_MODELS_REQUIRED",
            "Configure both local PP-OCRv5 mobile model directories.",
        )
    if not _dependencies_available():
        raise ProtocolError(
            "PPOCR_RUNTIME_UNAVAILABLE",
            "Install the local PaddleOCR runtime and its image dependencies.",
        )
    image = _decode_png(request)
    det_model_dir, rec_model_dir = model_directories
    try:
        with contextlib.redirect_stdout(sys.stderr):
            from paddleocr import PaddleOCR
            engine = PaddleOCR(
                text_detection_model_name="PP-OCRv5_mobile_det",
                text_recognition_model_name="PP-OCRv5_mobile_rec",
                text_detection_model_dir=str(det_model_dir),
                text_recognition_model_dir=str(rec_model_dir),
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
            )
            predictions = engine.predict(input=image)
            return _convert_predictions(predictions)
    except ProtocolError:
        raise
    except Exception:
        raise ProtocolError(
            "PPOCR_INFERENCE_FAILED",
            "The local PP-OCRv5 mobile inference failed.",
        ) from None


def handle(request):
    if not isinstance(request, dict):
        raise ProtocolError("PPOCR_INVALID_REQUEST", "The OCR request is invalid.")
    action = request.get("action")
    if action == "status":
        return _status()
    if action == "ocr":
        return _ocr(request)
    raise ProtocolError("PPOCR_INVALID_REQUEST", "The OCR request is invalid.")


def main():
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        response = {"error": {"code": "PPOCR_INVALID_REQUEST", "message": "The OCR request is invalid."}}
    else:
        try:
            request = json.loads(raw.decode("utf-8"))
            response = handle(request)
        except (UnicodeDecodeError, json.JSONDecodeError):
            response = {"error": {"code": "PPOCR_INVALID_REQUEST", "message": "The OCR request is invalid."}}
        except ProtocolError as error:
            response = {"error": {"code": error.code, "message": error.public_message}}
        except Exception:
            response = {"error": {"code": "PPOCR_INTERNAL_ERROR", "message": "The local OCR adapter failed."}}
    payload = json.dumps(response, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.buffer.write((payload + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
