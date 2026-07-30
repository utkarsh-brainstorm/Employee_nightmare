# AttendanceProcessor

**School Staff Attendance Analytics Application**

A professional Python desktop application for processing, analyzing and reporting on ONtime (Secureye) attendance exports.

---

## Features

- 📂 **Import** XLS/XLSX attendance files via drag-and-drop or file picker
- 🗄️ **SQLite storage** — all records stored locally, survives re-imports
- 🔍 **Filter Builder** — chain multiple filters with AND/OR logic
- ⚡ **9 Quick Reports** — one-click summaries for school admin needs
- 💰 **Salary Manager** — enter salaries once, stored permanently
- 🔡 **SQL Panel** — auto-populated SQL + manual query support
- 📊 **Results Table** — color-coded, sortable, scrollable
- ⬇️ **Export** results to CSV or PDF (print-ready)
- 🖥️ **Cross-platform** — works on Linux, Windows, macOS

---

## Requirements

- Python 3.9+
- Conda environment `ds_env` (or any env with the listed packages)

## Install Dependencies

```bash
conda activate ds_env
pip install -r requirements.txt
```

## Run

```bash
conda activate ds_env
python main.py
```

---

## File Format

The application expects **ONtime (Secureye)** monthly attendance export files (`.xls` or `.xlsx`).

Supported cell values:

- `A` — Absent
- `WO-I` — Weekly Off
- `HH:MM` — Punch-in only
- `HH:MM\nHH:MM` — Punch-in and Punch-out

---

## Database Location

`data/attendance.db` — created automatically on first run.

---

## Project Structure

```
Atndnc_prcs/
├── main.py                  # Entry point
├── core/
│   ├── parser.py            # XLS/XLSX file parser
│   ├── db.py                # SQLite layer
│   ├── query_builder.py     # GUI filter → SQL
│   └── exporter.py          # CSV + PDF export
├── gui/
│   ├── theme.py             # Design system
│   ├── app.py               # Main window
│   ├── import_panel.py      # Import UI
│   ├── filter_panel.py      # Filter builder UI
│   ├── quick_panel.py       # Quick summaries UI
│   ├── salary_panel.py      # Salary editor UI
│   ├── results_panel.py     # Results table UI
│   └── sql_panel.py         # SQL bar UI
├── data/
│   └── attendance.db        # Auto-created
├── assets/
└── requirements.txt
```

---

## Building a Binary

### Linux (PyInstaller)

```bash
pip install pyinstaller
pyinstaller --onefile --windowed --name AttendanceProcessor main.py
```

### Windows (cross-compile via GitHub Actions)

Push to GitHub and configure a Windows build Action.

---

## Salary Notes

- Enter monthly salary in ₹ in the Salary Manager
- Daily rate = Monthly Salary ÷ Working Days (default 26)
- Earned salary = (Days Present + Half Days × 0.5) × Daily Rate
- Works without salary data — N/A shown where salary is missing

---

*Built with Python + tkinter. Apple-inspired design.*

179831360



mayank anmol santosh
