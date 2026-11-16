"""Conservative visible-write-off indicators in scraped Auto Trader adverts.

The site's exclude-writeoff-categories=on switch is the primary filter.
Card data may omit history, so this supplement can only reject adverts
whose visible text explicitly identifies a recorded write-off.
"""
import re

_MARKERS = (
    re.compile(r"\bcat(?:egory)?\s*[-:]?\s*[NSCDAB]\b", re.I),
    re.compile(r"\b(?:previously\s+)?written[-\s]*off\b", re.I),
    re.compile(r"\b(?:insurance\s+)?write[-\s]*off\s*(?:category|cat)\s*[-:]?\s*[NSCDAB]\b", re.I),
    re.compile(r"\binsurance\s+total\s+loss\b", re.I),
)
_NEGATED = re.compile(
    r"\b(?:not|never|no|without|non|free\s+of)\s+(?:(?:a|an|any|recorded|previously|history\s+of)\s+)?$", re.I
)


def is_visible_writeoff(item):
    if not isinstance(item, dict):
        return False
    for field in ("title", "description", "writeOffCategory"):
        text = str(item.get(field) or "")
        if len(text) > 5000:
            text = text[:5000]
        for marker in _MARKERS:
            for hit in marker.finditer(text):
                if _NEGATED.search(text[max(0, hit.start() - 40):hit.start()]):
                    continue
                return True
    return False
