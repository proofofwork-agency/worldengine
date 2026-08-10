# SPDX-License-Identifier: Apache-2.0
"""Box-prompted SAM 2.1 mask worker with no network or dynamic code execution."""
import argparse
import json
import numpy as np
from PIL import Image
import torch
from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor


def main(job_path):
    with open(job_path, "r", encoding="utf-8") as handle:
        job = json.load(handle)
    if job.get("operation") != "segment-box":
        raise RuntimeError("Only segment-box is permitted")
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = build_sam2(job["modelConfig"], job["checkpointPath"], device=device)
    predictor = SAM2ImagePredictor(model)
    image = np.array(Image.open(job["inputPath"]).convert("RGB"))
    predictor.set_image(image)
    box = job["box"]
    masks, scores, _ = predictor.predict(box=np.array([box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]]), multimask_output=True)
    mask = masks[int(np.argmax(scores))].astype(np.uint8) * 255
    Image.fromarray(mask, mode="L").save(job["outputPath"], format="PNG")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    main(parser.parse_args().job)
