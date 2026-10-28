"""Optional live smoke test for image OCR and translation with the configured model."""

import io
import sys
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.main import ApiError, Region, ask_gemini, normalize_image


parser = argparse.ArgumentParser()
parser.add_argument("--image", type=Path)
parser.add_argument("--crop", help="left,top,right,bottom")
args = parser.parse_args()
if args.image:
    image = Image.open(args.image).convert("RGB")
    if args.crop:
        image = image.crop(tuple(map(int, args.crop.split(","))))
else:
    image = Image.new("RGB", (700, 400), "white")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((80, 90, 620, 310), radius=80, outline="black", width=5)
    draw.text((190, 170), "HELLO!", fill="black", font=ImageFont.load_default(size=64))
output = io.BytesIO()
image.save(output, format="PNG")

try:
    result = ask_gemini(normalize_image(output.getvalue()), "en", "vi", "")
    regions = result.get("regions", [])
    print(f"Gemini returned {len(regions)} regions")
    for index, region in enumerate(regions):
        try:
            Region.model_validate(region)
        except ValidationError as error:
            print(f"Region {index} invalid: {error.errors(include_input=False)}")
except ApiError as error:
    print(f"Image translation failed; code={error.code}; message={error.message}")
    raise SystemExit(1) from None
