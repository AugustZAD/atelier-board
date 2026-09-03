import io
import os
from typing import Annotated

import modal

APP_NAME = "atelier-board-cutout"
MODEL_ID = "ZhengPeng7/BiRefNet"
MODEL_REVISION = "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4"
MODEL_CACHE = "/models"
PRODUCTION_BATCH_SIZE = 2


def download_model() -> None:
    from transformers import AutoModelForImageSegmentation

    AutoModelForImageSegmentation.from_pretrained(MODEL_ID, revision=MODEL_REVISION, trust_remote_code=True)


gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.5.1",
        "torchvision==0.20.1",
        "transformers==4.57.1",
        "huggingface-hub==0.36.0",
        "timm==1.0.22",
        "kornia==0.8.2",
        "einops==0.8.1",
        "numpy<2",
        "pillow==11.3.0",
        "requests==2.32.5",
    )
    .env({"HF_HOME": MODEL_CACHE})
    .run_function(download_model)
)

web_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "fastapi[standard]==0.116.1",
    "pydantic==2.11.7",
)

app = modal.App(APP_NAME)
service_secret = modal.Secret.from_name("atelier-board-service")


@app.cls(
    image=gpu_image,
    gpu="L4",
    enable_memory_snapshot=True,
    max_containers=2,
    scaledown_window=2,
    timeout=600,
)
class CutoutModel:
    @modal.enter(snap=True)
    def load(self) -> None:
        import torch
        from torchvision import transforms
        from transformers import AutoModelForImageSegmentation

        torch.set_float32_matmul_precision("high")
        self.transforms = transforms
        self.preprocess = transforms.Compose(
            [
                transforms.Resize((1024, 1024)),
                transforms.ToTensor(),
                transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
            ]
        )
        self.model = AutoModelForImageSegmentation.from_pretrained(
            MODEL_ID,
            revision=MODEL_REVISION,
            trust_remote_code=True,
            local_files_only=True,
        ).eval().half()

    @modal.enter(snap=False)
    def attach_gpu(self) -> None:
        import torch

        self.torch = torch
        self.model.to("cuda")

    @modal.method()
    def process(self, api_base: str, count: int, job_id: str, job_token: str) -> None:
        import requests
        from PIL import Image, ImageOps

        headers = {"Authorization": f"Bearer {job_token}"}
        status_url = f"{api_base}/api/internal/jobs/{job_id}/status"
        session = requests.Session()
        try:
            session.patch(status_url, headers=headers, json={"status": "processing", "completed": 0}, timeout=30).raise_for_status()
            for start in range(0, count, PRODUCTION_BATCH_SIZE):
                indices = list(range(start, min(start + PRODUCTION_BATCH_SIZE, count)))
                images = []
                for index in indices:
                    image_url = f"{api_base}/api/internal/jobs/{job_id}/images/{index}"
                    response = session.get(image_url, headers=headers, timeout=60)
                    response.raise_for_status()
                    images.append(ImageOps.exif_transpose(Image.open(io.BytesIO(response.content))).convert("RGB"))
                tensor = self.torch.stack([self.preprocess(image) for image in images]).to("cuda").half()
                with self.torch.inference_mode():
                    masks = self.model(tensor)[-1].sigmoid().float().cpu()
                for offset, index in enumerate(indices):
                    image = images[offset]
                    mask = self.transforms.ToPILImage()(masks[offset].squeeze()).resize(image.size, Image.Resampling.LANCZOS)
                    image.putalpha(mask)
                    image = crop_transparent(image)
                    output = io.BytesIO()
                    image.save(output, format="WEBP", quality=90, method=4)
                    image_url = f"{api_base}/api/internal/jobs/{job_id}/images/{index}"
                    response = session.put(image_url, headers={**headers, "Content-Type": "image/webp"}, data=output.getvalue(), timeout=60)
                    response.raise_for_status()
            session.patch(status_url, headers=headers, json={"status": "complete", "completed": count}, timeout=30).raise_for_status()
        except Exception as exc:
            try:
                session.patch(
                    status_url,
                    headers=headers,
                    json={"status": "error", "error": f"云端抠图失败：{type(exc).__name__}"},
                    timeout=20,
                )
            finally:
                raise

    @modal.method()
    def benchmark(self, image_bytes: bytes, total: int = 30) -> list[dict]:
        import time
        from PIL import Image, ImageOps

        image = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes))).convert("RGB")
        base = self.preprocess(image)
        warmup = base.unsqueeze(0).to("cuda").half()
        with self.torch.inference_mode():
            self.model(warmup)[-1]
        self.torch.cuda.synchronize()
        results = []
        for batch_size in (1, 2, 4, 8):
            self.torch.cuda.empty_cache()
            self.torch.cuda.reset_peak_memory_stats()
            started = time.perf_counter()
            try:
                for start in range(0, total, batch_size):
                    size = min(batch_size, total - start)
                    tensor = base.unsqueeze(0).repeat(size, 1, 1, 1).to("cuda").half()
                    with self.torch.inference_mode():
                        masks = self.model(tensor)[-1].sigmoid().float().cpu()
                    del tensor, masks
                self.torch.cuda.synchronize()
                elapsed = time.perf_counter() - started
                results.append({
                    "batch_size": batch_size,
                    "elapsed_seconds": round(elapsed, 3),
                    "images_per_second": round(total / elapsed, 3),
                    "peak_allocated_gib": round(self.torch.cuda.max_memory_allocated() / 1024**3, 3),
                    "peak_reserved_gib": round(self.torch.cuda.max_memory_reserved() / 1024**3, 3),
                })
            except self.torch.cuda.OutOfMemoryError:
                self.torch.cuda.empty_cache()
                results.append({"batch_size": batch_size, "error": "out_of_memory"})
        return results


@app.local_entrypoint()
def benchmark(image_path: str, total: int = 30):
    with open(image_path, "rb") as handle:
        results = CutoutModel().benchmark.remote(handle.read(), total)
    print(results)


def crop_transparent(image):
    alpha = image.getchannel("A")
    threshold = alpha.point(lambda value: 255 if value > 8 else 0)
    box = threshold.getbbox()
    if not box:
        raise ValueError("No foreground detected")
    padding = round(max(image.size) * 0.025)
    left, top, right, bottom = box
    box = (
        max(0, left - padding),
        max(0, top - padding),
        min(image.width, right + padding),
        min(image.height, bottom + padding),
    )
    return image.crop(box)


@app.function(image=web_image, secrets=[service_secret], timeout=30, name="start")
@modal.asgi_app()
def web_app():
    from fastapi import FastAPI, Header, HTTPException
    from pydantic import BaseModel, Field

    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    class JobRequest(BaseModel):
        api_base: str
        count: int = Field(ge=1, le=50)
        job_id: str = Field(pattern=r"^[0-9a-f]{32}$")
        job_token: str = Field(min_length=64, max_length=128)

    @api.post("/")
    def start(payload: JobRequest, authorization: Annotated[str | None, Header()] = None):
        expected = f"Bearer {os.environ['MODAL_SHARED_SECRET']}"
        if authorization != expected:
            raise HTTPException(status_code=401, detail="Unauthorized")
        call = CutoutModel().process.spawn(
            payload.api_base,
            payload.count,
            payload.job_id,
            payload.job_token,
        )
        return {"call_id": call.object_id, "status": "queued"}

    return api
