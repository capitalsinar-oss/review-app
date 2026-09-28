"""Builds public/index.html and dist/worker.js from src/v4. Run: python3 build.py"""
import json, os
here = os.path.dirname(os.path.abspath(__file__))
src = lambda p: open(os.path.join(here, "src", "v4", p), encoding="utf-8").read()
page = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="robots" content="noindex">\n'
        + src("_page_head.html") + "</head>\n<body>\n" + src("_page_body.html")
        + "<script>\n" + src("_faces.js") + src("_page.js") + "</script>\n</body>\n</html>\n")
roster = json.load(open(os.path.join(here, "roster.json"))) if os.path.exists(os.path.join(here, "roster.json")) else None
worker = ("// Built by build.py. Edit src/v4/*, not this file.\nconst HTML = " + json.dumps(page) + ";\n"
          + "const ROSTER_JSON = " + json.dumps(roster) + ";\n"
          + "const DEFAULT_MODEL = \"claude-sonnet-5\";\nconst PRICES = { \"claude-sonnet-5\": [2, 10], \"claude-haiku-4-5-20251001\": [1, 5], \"claude-opus-5-5\": [4, 20] };\n"
          + "const MAX_IMAGES = 5;\nconst MAX_IMAGE_B64 = 5_000_000;\nconst MEDIA = [\"image/jpeg\", \"image/png\", \"image/webp\", \"image/gif\"];\n"
          + "const DEFAULT_NOTION_DB = \"5aaa91bcb19d4e84a346bde65635fd53\";\nconst CHANNELS = [\"Google\", \"Airbnb\", \"Booking.com\", \"Trip.com\"];\n"
          + "const VILLAS = [\"ESV\", \"Kapuk\", \"Palem\", \"Jati\", \"Ceylon\"];\nconst VILLA_IDS = { ESV: 1001, Kapuk: 1002, Palem: 1003, Jati: 1004, Ceylon: 1005 };\n"
          + src("_grader_core.js") + "\n" + src("_server.js"))
os.makedirs(os.path.join(here, "public"), exist_ok=True); os.makedirs(os.path.join(here, "dist"), exist_ok=True)
open(os.path.join(here, "public", "index.html"), "w", encoding="utf-8").write(page)
open(os.path.join(here, "dist", "worker.js"), "w", encoding="utf-8").write(worker)
print("built", len(page), "bytes page,", len(worker), "bytes worker")
