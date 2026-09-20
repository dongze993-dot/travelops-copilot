"""TravelOps Copilot application package.

The project deliberately keeps the application layer small and inspectable.  It
can run entirely in deterministic mock mode, which makes it safe to demonstrate
without an API key or a third-party travel account.
"""

def create_app(*args: object, **kwargs: object):
    """Lazily import the API factory without side effects on model imports."""

    from .main import create_app as _create_app

    return _create_app(*args, **kwargs)


__all__ = ["create_app"]
