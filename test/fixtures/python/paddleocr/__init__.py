import os

if os.environ.get("PPOCR_FAKE_FAIL_ON_IMPORT") == "1":
    raise AssertionError("status imported PaddleOCR")


class _Result:
    @property
    def json(self):
        return {
            "res": {
                "rec_texts": ["登录"],
                "rec_scores": [0.98],
                "rec_boxes": [[0, 0, 1, 1]],
            }
        }


class PaddleOCR:
    def __init__(self, **kwargs):
        assert kwargs["text_detection_model_name"] == "PP-OCRv5_mobile_det"
        assert kwargs["text_recognition_model_name"] == "PP-OCRv5_mobile_rec"
        assert os.path.isdir(kwargs["text_detection_model_dir"])
        assert os.path.isdir(kwargs["text_recognition_model_dir"])
        assert kwargs["use_doc_orientation_classify"] is False
        assert kwargs["use_doc_unwarping"] is False
        assert kwargs["use_textline_orientation"] is False
        assert kwargs["enable_mkldnn"] is False

    def predict(self, input):
        assert input["decoded_bytes"] > 8
        return [_Result()]
