# SPDX-License-Identifier: GPL-3.0-or-later
"""Custom properties that the glTF exporter (export_extras=True) writes as node extras: Plan 4's node table."""


def tag(obj, **kw):
    for key, value in kw.items():
        obj[key] = value
    return obj
