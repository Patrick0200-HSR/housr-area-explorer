"""Pre-save nearby-places data for the example properties.

Why: the free OpenStreetMap (Overpass) service is sometimes busy. Saving the
results for the example properties means they always load instantly.

Run from the repo root whenever you change properties.json:
    python3 scripts/save_example_data.py
"""
import json
import pathlib
import re
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
HEADERS = {"User-Agent": "HousrAreaExplorer/1.0"}


def get_json(url, data=None):
    req = urllib.request.Request(url, data=data, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


def build_query(lat, lon):
    """Read the same query the web page uses, straight from app.js, so they never drift apart."""
    app_js = (ROOT / "app.js").read_text()
    parts = re.findall(r"query: \(r\) => `(.*?)`,", app_js)
    body = "".join(parts).replace("${r.uni}", "3000").replace("${r.base}", "1500")
    return f"[out:json][timeout:25];({body});out center tags;".replace("LAT", str(lat)).replace("LON", str(lon))


def main():
    properties = json.loads((ROOT / "properties.json").read_text())
    (ROOT / "data").mkdir(exist_ok=True)

    for prop in properties:
        slug = prop["postcode"].replace(" ", "").upper()
        pc = get_json(f"https://api.postcodes.io/postcodes/{slug}")["result"]
        query = build_query(pc["latitude"], pc["longitude"])

        for attempt in range(6):
            try:
                result = get_json(OVERPASS_URL, urllib.parse.urlencode({"data": query}).encode())
                break
            except Exception as err:  # server busy – wait and retry
                print(f"  {slug}: attempt {attempt + 1} failed ({err}), retrying…")
                time.sleep(5 * (attempt + 1))
        else:
            print(f"✗ {slug}: gave up")
            continue

        out = ROOT / "data" / f"{slug}.json"
        out.write_text(json.dumps(result["elements"], separators=(",", ":")))
        print(f"✓ {prop['name']}: {len(result['elements'])} places saved")
        time.sleep(2)  # be polite to the free service


if __name__ == "__main__":
    main()
