#!/usr/bin/env python3
"""ddddocr 工作进程：由 hotwave 的 TS 侧按需 spawn，不常驻、不占端口。

为什么不用常驻服务：ddddocr 的全链路开销只有 import≈0.45s + 模型加载≈0.2s，
单次识别 <1s；验证码只在实盘登录（每天一次、失败重试 1-2 次）出现，
一次性 spawn 比维护一个 HTTP 服务的生命周期更简单可靠。

协议（stdin 一行 JSON → stdout 一行 JSON）：
  请求 {"op":"predict","image_base64":"<不带 data URL 前缀或带均可>",
        "expected_length":4,"max_times":5}
  响应 {"ok":true,"code":"3982"}
        {"ok":false,"error":"...","stage":"import|predict"}

  请求 {"op":"selftest"}        生成一张 4 位数字验证码并识别，返回 code + b64（自测/doctor 用）
  请求 {"op":"info"}            返回 python / ddddocr / pillow 版本，用于安装自检

退出码：0 成功（响应里 ok 字段为准）；非 0 表示进程/依赖级失败（stdout 可能为空，
TS 侧回退 stderr 诊断）。

依赖：requirements.txt（ddddocr，pillow 仅 selftest 生成验证码用）。
"""
from __future__ import annotations

import base64
import io
import json
import sys
import time
import traceback

_ocr = None


def _load_ocr():
    global _ocr
    if _ocr is None:
        import ddddocr  # noqa: F401  （导入放这里：info/selftest 失败也能给出明确 stage）

        try:
            _ocr = ddddocr.DdddOcr(show_ad=False)
        except TypeError:  # 老版本没有 show_ad
            _ocr = ddddocr.DdddOcr()
    return _ocr


def _clean(image: str) -> str:
    if image.startswith("data:") and "," in image:
        return image.split(",", 1)[1]
    return image


def _via_bytes(image: str):
    """base64 → bytes：兼容 ddddocr 对 str/bytes 的处理差异，二段式避免重复解码报错。"""
    try:
        raw = base64.b64decode(_clean(image), validate=False)
    except Exception:  # noqa: BLE001
        raw = None
    return raw if raw else None


def predict(image_base64: str, expected_length: int = 4, max_times: int = 5) -> str:
    ocr = _load_ocr()
    img = _via_bytes(image_base64) or image_base64
    code = str(ocr.classification(img))
    times = max_times
    while times > 0 and expected_length and len(code) != expected_length:
        code = str(ocr.classification(img))
        times -= 1
    return code


def selftest() -> dict:
    """用 PIL 画一张 4 位数字验证码，再交给同一个 ddddocr 实例识别（端到端自检）。"""
    from PIL import Image, ImageDraw, ImageFont

    text = "3982"
    img = Image.new("RGB", (96, 34), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 24)
    except Exception:  # noqa: BLE001  （Linux 容器里没有该字体就走默认位图字体）
        font = ImageFont.load_default()
    draw.text((8, 3), text, fill=(20, 20, 20), font=font)
    draw.line((0, 30, 96, 6), fill=(160, 160, 160), width=1)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    code = predict(b64, expected_length=4, max_times=1)
    return {"ok": True, "op": "selftest", "expect": text, "code": code,
            "match": code == text, "image_base64": b64}


def info() -> dict:
    from importlib.metadata import version

    def ver(name: str) -> str:
        try:
            return version(name)
        except Exception:  # noqa: BLE001
            return "missing"

    return {
        "ok": True,
        "op": "info",
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "ddddocr": ver("ddddocr"),
        "pillow": ver("pillow"),
    }


def main() -> int:
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except Exception:  # noqa: BLE001
        print(json.dumps({"ok": False, "stage": "request", "error": "invalid JSON on stdin"}))
        return 0

    op = str(req.get("op") or "predict")
    t0 = time.time()
    try:
        if op == "info":
            out = info()
        elif op == "selftest":
            out = selftest()
        elif op == "predict":
            image = req.get("image_base64")
            if not isinstance(image, str) or not image:
                out = {"ok": False, "stage": "request", "error": "image_base64 required"}
            else:
                out = {"ok": True, "op": "predict",
                       "code": predict(image,
                                        int(req.get("expected_length") or 4),
                                        int(req.get("max_times") or 5))}
        else:
            out = {"ok": False, "stage": "request", "error": "unknown op: " + op}
        out.setdefault("elapsed", round(time.time() - t0, 3))
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        out = {"ok": False, "stage": op, "error": type(exc).__name__ + ": " + str(exc)[:300],
               "elapsed": round(time.time() - t0, 3)}

    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
