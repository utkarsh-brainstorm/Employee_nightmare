#!/usr/bin/env python3
"""
main.py
=======
Entry point for AttendanceProcessor.

Usage:
    python main.py
"""

import os
import sys

# Ensure project root is on the path when bundled
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import core.db as db
from gui.app import AttendanceApp


def main():
    # Initialise database (creates tables if first run)
    db.init_db()

    # Launch GUI
    app = AttendanceApp()
    app.run()


if __name__ == "__main__":
    main()
