"""Whose Facebook account the Marketplace browser uses.

Password mode uses one shared account from the server's environment
(FACEBOOK_EMAIL / FACEBOOK_PASSWORD) and /data/facebook-session.json.
Google mode gives each signed-in person their own profile: their own login
details and their own saved browser session, kept in their Google Drive.
"""
import contextvars
import os
from pathlib import Path


class FacebookProfile:
    def __init__(self, state_path=None, email='', password='', on_saved=None):
        self.state_path = Path(state_path) if state_path else None
        self.email = email
        self.password = password
        self.on_saved = on_saved
        self.last_failed_attempt = 0.0

    @property
    def personal(self):
        return self.state_path is not None

    def managed_path(self):
        if self.state_path:
            return self.state_path
        return Path(os.environ.get('DATA_DIR', '/data')) / 'facebook-session.json'

    def credentials(self):
        if self.personal:
            return self.email.strip(), self.password
        return os.environ.get('FACEBOOK_EMAIL', '').strip(), os.environ.get('FACEBOOK_PASSWORD', '')

    def where_to_set(self):
        return ('your Facebook login in Car Search Settings' if self.personal
                else 'FACEBOOK_EMAIL and FACEBOOK_PASSWORD in Railway Variables')

    def saved(self):
        """The browser session file changed (a verified sign-in)."""
        if self.on_saved:
            self.on_saved()


SERVER_PROFILE = FacebookProfile()
PROFILE = contextvars.ContextVar('car_search_facebook_profile', default=None)


def active():
    return PROFILE.get() or SERVER_PROFILE
