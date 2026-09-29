<div align="center">
  <h1>Attendance Processor Pro — V12</h1>
  <p><strong>An ultra-performant, cross-platform, native webview desktop application for dynamic employee attendance management, automated minute-rate salary computation, and SQL-driven reporting.</strong></p>
</div>

<br>

**Architected, tested, and maintained by Utkarsh for Sanskar Valley Higher Secondary Public School** *(Developed with AI assistance)*. 
Engineered specifically to replace rigid, outdated legacy GUI software with an ultra-flexible, completely customizable desktop platform designed for both HR administrators and technical power users.

> **Disclaimer:** All data, names, and numbers shown in the screenshots below are entirely fabricated for testing purposes and do not belong to real individuals.

---

## 📸 Interface Preview

### The Dashboard & Dynamic Reporting Engine

![Dashboard](assets/screenshots/screenshot_01.png)
*(A completely bespoke reporting engine rendering Tailwind CSS within a native PyWebView instance)*

---

## ⚡ Technical Architecture & Stack

Attendance Processor Pro V12 is a major milestone release implementing a complete minute-based salary engine, the Sandwich Rule, per-day time overrides, school bus transport exemption, and paid/unpaid leave policy configuration.

### The Stack

- **Frontend Layer:** Pure HTML5, Vanilla JavaScript, and TailwindCSS delivering a zero-latency, highly responsive desktop interface without the overhead of heavy SPA frameworks like React or Angular.
- **Rendering Engine:** Cross-platform native webviews via `pywebview`.
  - **Linux:** `WebKit2GTK`
  - **macOS:** `WKWebView`
  - **Windows:** `EdgeWebView2`
    This approach results in an extremely small binary footprint (under 30MB) completely avoiding the massive Chromium bundling bloat typical of Electron applications.
- **Backend Bridge:** Pure Python 3 using a bi-directional RPC communication bridge exposed directly to the `window.pywebview.api` object in the frontend JS runtime.
- **Data Persistence Layer:** A fully decoupled, normalized SQLite database layer optimized for rapid read/write operations using parameterized queries to prevent SQL injection vulnerabilities.

---

## 🧠 Core Engineering Innovations

### 1. The Minute-Rate Salary Execution Engine

Traditional attendance software calculates salaries using static daily wages. We identified this as a massive vector for time-fraud and completely rewrote the mathematical logic.

- The engine calculates a dynamic **per-minute salary rate**: `(Base Salary / Total Required Monthly Minutes)`.

- It evaluates strict check-in and check-out temporal bounds against custom employee schedules using complex SQLite epoch string manipulation:
  
  ```sql
  MAX(0, (strftime('%s', MIN(punch_out, custom_departure)) - strftime('%s', MAX(punch_in, custom_arrival))) / 60)
  ```

- **Anti-Fraud Truncation:** Any physical time logged *before* a scheduled arrival or *after* a scheduled departure is silently dropped from the valid calculation pool at the database query execution level. 

### 2. Autonomous SQL Macro System & AST Builder

The application features a fully autonomous SQL reporting system that bridges the gap between technical and non-technical users.

- **For Non-Technical Users:** The GUI features a visual filter builder. Users can select fields, operators (`contains`, `between`, `greater than`), and values. The JavaScript engine dynamically constructs an Abstract Syntax Tree (AST), maps it to database columns, builds the parameterized `WHERE`, `GROUP BY`, and `HAVING` clauses, and dispatches it to the Python backend for execution.
- **For Power Users:** The system includes a raw SQL editor with real-time execution logging and syntax validation, allowing limitless data extraction capabilities across the raw relational tables (`attendance_raw`, `employee_salary`, `app_settings`, `calendar_days`).

### 3. Dynamic Retroactive Logic

The system completely abandons static parse-time logic. Features like "Late Arrivals" and "Early Leavers" do not rely on static boolean flags saved in the database during Excel import.
Instead, they are evaluated entirely at runtime via dynamic SQL. This means if an HR administrator retroactively updates an employee's custom shift schedule, all past attendance reports instantly and automatically conform to the newly updated thresholds without requiring database modifications.

### 4. Paid Leave Credit Injection

We engineered a dynamic background formula that evaluates total monthly absences on the fly. If absences > 0, the system automatically injects exactly 1 standard daily shift's worth of minutes as a paid leave credit, mathematically capped per billing cycle.

---

## 🚀 Installation & Deployment

Attendance Processor can be deployed instantly via pre-compiled binaries or run locally via a Python environment.

### Method 1: Direct Executable Release (Recommended)

Download the `.exe` or `.tar.gz` from the [Releases page](https://github.com/utkarsh-brainstorm/Employee_nightmare/releases). This requires absolutely zero dependencies.

> [!WARNING] 
> **OS Security Bypasses:** Because this application is compiled locally and is not signed with an expensive enterprise certificate, your operating system will aggressively flag it as an unknown publisher.
> 
> - **Windows:** SmartScreen will block execution. Click **More info** -> **Run anyway**.
> - **macOS:** Gatekeeper will block execution. Go to **System Settings -> Privacy & Security** and click **Open Anyway**.
> - *Note: The source code is entirely open-source and visible in this repository. The binaries are compiled transparently via GitHub Actions.*

### Method 2: Python / Conda Setup (For Developers)

If you wish to audit the source code, modify the SQL macros, or run the platform natively from your terminal:

1. **Clone the repository:**
   
   ```bash
   git clone https://github.com/utkarsh-brainstorm/Employee_nightmare.git
   cd Employee_nightmare
   ```

2. **Create a Conda or Python virtual environment:**
   
   ```bash
   conda create -n atndnc python=3.10
   conda activate atndnc
   ```

3. **Install the dependencies:**
   
   ```bash
   pip install -r requirements.txt
   ```
   
   *(Note for Linux Developers: You must install the system WebView development packages: `sudo apt-get install libgirepository1.0-dev python3-dev gir1.2-webkit2-4.1`)*

4. **Initialize the database & Launch:**
   
   ```bash
   python main.py
   ```
