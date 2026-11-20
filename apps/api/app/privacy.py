"""Never log the caller's location.

Installs one filter on uvicorn's access log that replaces the value of any
lat/lng-style query parameter with `redacted`, for every endpoint. A reverse
proxy in front of the API must do the same.
"""

from __future__ import annotations

import logging
import re

_COORD_PARAM = re.compile(r"((?:^|[?&])(?:lat|lng|lon|latitude|longitude)=)[^&\s]*", re.IGNORECASE)


def redact(text: str) -> str:
    return _COORD_PARAM.sub(r"\1redacted", text)


class RedactLocation(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and record.args:
            record.args = tuple(redact(a) if isinstance(a, str) else a for a in record.args)
        return True


def install() -> None:
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, RedactLocation) for f in access.filters):
        access.addFilter(RedactLocation())
