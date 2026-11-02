import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";

const STORAGE_KEY = "codetime.stats.v2";
const OPEN_KEY = "codetime.openTime.v1";
const GOAL_KEY = "codetime.goalNotifiedFor";
const SAVE_EVERY_TICKS = 30;
// Only count real editing surfaces (not output panels, git diffs, etc.)
const TRACKED_SCHEMES = new Set(["file", "untitled", "vscode-remote", "vscode-vfs"]);

type Range = "today" | "7d" | "30d" | "all";
// date -> project -> language -> seconds
type Stats = Record<string, Record<string, Record<string, number>>>;
type TrackState = "tracking" | "idle" | "off";

interface Summary {
    total: number;
    languages: [string, number][];
    projects: [string, number][];
    daily: { date: string; seconds: number }[];
    activeDays: number;
    bestDay?: { date: string; seconds: number };
}

// ---------- helpers ----------

function dateKey(d: Date = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function lastDays(n: number): string[] {
    const out: string[] = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        out.push(dateKey(d));
    }
    return out;
}

function fmt(seconds: number): string {
    const t = Math.round(seconds);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    if (h > 0) { return `${h}h ${m}m`; }
    if (m > 0) { return `${m}m ${s}s`; }
    return `${s}s`;
}

function esc(s: string): string {
    const map: Record<string, string> = {
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    };
    return s.replace(/[&<>"']/g, (c) => map[c]);
}

function colorFor(lang: string): string {
    let h = 0;
    for (const ch of lang) { h = (h * 31 + ch.charCodeAt(0)) % 360; }
    return `hsl(${h} 60% 55%)`;
}

function isRange(v: unknown): v is Range {
    return v === "today" || v === "7d" || v === "30d" || v === "all";
}

const RANGE_LABEL: Record<Range, string> = {
    today: "Today",
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    all: "All time",
};

// ---------- tracker ----------

class Tracker implements vscode.Disposable {
    private stats: Stats;
    private enabled = false;
    private state: TrackState = "off";
    private lastActivity = Date.now();
    private lastTick = Date.now();
    private sessionSeconds = 0;
    private ticksSinceSave = 0;
    private dirty = false;
    private timer: ReturnType<typeof setInterval> | undefined;
    private panel: vscode.WebviewPanel | undefined;
    private range: Range = "7d";
    private readonly statusBar: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private openTime: Record<string, number>; // date -> seconds VS Code was open
    private sessionOpenSeconds = 0;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.stats = context.globalState.get<Stats>(STORAGE_KEY, {});
        this.openTime = context.globalState.get<Record<string, number>>(OPEN_KEY, {});
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBar.command = "codetime.overview";
        this.statusBar.show();

        const markActive = () => { this.lastActivity = Date.now(); };
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(markActive),
            vscode.window.onDidChangeTextEditorSelection(markActive),
            vscode.window.onDidChangeTextEditorVisibleRanges(markActive), // scrolling = reading
            vscode.window.onDidChangeActiveTextEditor(markActive),
            vscode.window.onDidChangeWindowState((s) => { if (s.focused) { markActive(); } })
        );

        this.timer = setInterval(() => this.tick(), 1000);

        const autoStart = vscode.workspace.getConfiguration("codetime").get<boolean>("autoStart", true);
        if (autoStart) { this.start(false); } else { this.updateStatusBar(); }
    }

    // ----- control -----

    start(notify = true): void {
        this.enabled = true;
        this.lastActivity = Date.now();
        this.lastTick = Date.now();
        this.updateStatusBar();
        if (notify) { vscode.window.showInformationMessage("CodeTime: tracking started."); }
    }

    stop(notify = true): void {
        this.enabled = false;
        this.state = "off";
        this.save();
        this.updateStatusBar();
        if (notify) { vscode.window.showInformationMessage("CodeTime: tracking stopped."); }
    }

    // ----- ticking -----

    private tick(): void {
        const now = Date.now();
        const delta = Math.min((now - this.lastTick) / 1000, 2);
        this.lastTick = now;

        // Window-open time: counts every tick, regardless of focus, idle or tracking state
        const today = dateKey();
        this.openTime[today] = (this.openTime[today] ?? 0) + delta;
        this.sessionOpenSeconds += delta;
        this.dirty = true;

        if (this.enabled) {
            const idleMs = vscode.workspace.getConfiguration("codetime").get<number>("idleTimeoutSeconds", 60) * 1000;
            const editor = vscode.window.activeTextEditor;
            const focused = vscode.window.state.focused;
            const active = now - this.lastActivity < idleMs;

            if (editor && focused && active && TRACKED_SCHEMES.has(editor.document.uri.scheme)) {
                const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)?.name;
                const project = folder ?? vscode.workspace.name ?? "(no folder)";
                const lang = editor.document.languageId;

                const day = (this.stats[today] ??= {});
                const proj = (day[project] ??= {});
                proj[lang] = (proj[lang] ?? 0) + delta;

                this.sessionSeconds += delta;
                this.state = "tracking";
                this.checkGoal();
            } else {
                this.state = "idle";
            }
        }

        this.updateStatusBar();

        if (++this.ticksSinceSave >= SAVE_EVERY_TICKS) {
            this.ticksSinceSave = 0;
            this.save();
        }
    }

    private checkGoal(): void {
        const goalMin = vscode.workspace.getConfiguration("codetime").get<number>("dailyGoalMinutes", 0);
        if (goalMin <= 0) { return; }
        const today = dateKey();
        if (this.context.globalState.get<string>(GOAL_KEY) === today) { return; }
        if (this.dayTotal(today) >= goalMin * 60) {
            void this.context.globalState.update(GOAL_KEY, today);
            vscode.window.showInformationMessage(`CodeTime: daily goal of ${goalMin} min reached. Nice work!`);
        }
    }

    private updateStatusBar(): void {
        const total = fmt(this.dayTotal(dateKey()));
        const icon = this.state === "tracking" ? "$(watch)" : this.state === "idle" ? "$(debug-pause)" : "$(circle-slash)";
        this.statusBar.text = this.state === "off" ? `${icon} CodeTime off` : `${icon} ${total}`;
        const label = this.state === "tracking" ? "tracking" : this.state === "idle" ? "idle / paused" : "stopped";
        this.statusBar.tooltip = `CodeTime (${label})\nToday: ${total}\nThis session: ${fmt(this.sessionSeconds)}\nClick for overview`;
        this.statusBar.tooltip =
            `CodeTime (${label})\n` +
            `Coding today: ${total}\n` +
            `VS Code open today: ${fmt(this.openTime[dateKey()] ?? 0)}\n` +
            `This session: ${fmt(this.sessionSeconds)} coding / ${fmt(this.sessionOpenSeconds)} open\n` +
            `Click for overview`;
    }

    private save(): void {
        if (!this.dirty) { return; }
        this.dirty = false;
        void this.context.globalState.update(STORAGE_KEY, this.stats);
        void this.context.globalState.update(OPEN_KEY, this.openTime);
    }

    // ----- data -----

    private dayTotal(key: string): number {
        let t = 0;
        for (const langs of Object.values(this.stats[key] ?? {})) {
            for (const s of Object.values(langs)) { t += s; }
        }
        return t;
    }

    private keysFor(range: Range): string[] {
        switch (range) {
            case "today": return [dateKey()];
            case "7d": return lastDays(7);
            case "30d": return lastDays(30);
            case "all": return Object.keys(this.stats).sort();
        }
    }

    private streak(): number {
        let count = 0;
        const d = new Date();
        if (this.dayTotal(dateKey(d)) < 60) { d.setDate(d.getDate() - 1); } // today may not have started yet
        while (this.dayTotal(dateKey(d)) >= 60) {
            count++;
            d.setDate(d.getDate() - 1);
        }
        return count;
    }

    private summarize(range: Range): Summary {
        const langs: Record<string, number> = {};
        const projects: Record<string, number> = {};
        let total = 0;
        let activeDays = 0;
        let bestDay: Summary["bestDay"];

        for (const key of this.keysFor(range)) {
            const day = this.stats[key];
            if (!day) { continue; }
            const dayTotal = this.dayTotal(key);
            if (dayTotal >= 1) { activeDays++; }
            if (!bestDay || dayTotal > bestDay.seconds) { bestDay = { date: key, seconds: dayTotal }; }
            for (const [p, ls] of Object.entries(day)) {
                for (const [l, s] of Object.entries(ls)) {
                    langs[l] = (langs[l] ?? 0) + s;
                    projects[p] = (projects[p] ?? 0) + s;
                    total += s;
                }
            }
        }

        const chartDays = range === "7d" ? 7 : 30;
        const daily = lastDays(chartDays).map((date) => ({ date, seconds: this.dayTotal(date) }));
        const sortDesc = (o: Record<string, number>) =>
            Object.entries(o).sort((a, b) => b[1] - a[1]);

        return { total, languages: sortDesc(langs), projects: sortDesc(projects), daily, activeDays, bestDay };
    }

    // ----- overview webview -----

    showOverview(): void {
        if (this.panel) {
            this.panel.reveal();
            this.refreshPanel();
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            "codetimeOverview",
            "CodeTime Overview",
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        this.panel.onDidDispose(() => { this.panel = undefined; });
        this.panel.webview.onDidReceiveMessage((msg: { type?: string; value?: string }) => {
            if (msg.type === "range" && isRange(msg.value)) {
                this.range = msg.value;
                this.refreshPanel();
            } else if (msg.type === "action") {
                if (msg.value === "refresh") { this.refreshPanel(); }
                if (msg.value === "export") { void vscode.commands.executeCommand("codetime.export"); }
                if (msg.value === "reset") { void vscode.commands.executeCommand("codetime.reset"); }
                if (msg.value === "toggle") {
                    if (this.enabled) { this.stop(false); } else { this.start(false); }
                    this.refreshPanel();
                }
            }
        });
        this.refreshPanel();
    }

    private refreshPanel(): void {
        if (!this.panel) { return; }
        this.panel.webview.html = this.render(this.panel.webview, this.range);
    }

    private render(webview: vscode.Webview, range: Range): string {
        const nonce = randomBytes(16).toString("hex");
        const s = this.summarize(range);
        const today = this.dayTotal(dateKey());
        const avg = s.activeDays > 0 ? s.total / s.activeDays : 0;
        const openTotal = this.keysFor(range).reduce((a, k) => a + (this.openTime[k] ?? 0), 0);
        const share = openTotal > 0 ? Math.round((s.total / openTotal) * 100) : 0;

        const card = (label: string, value: string) =>
            `<div class="card"><div class="cl">${esc(label)}</div><div class="cv">${esc(value)}</div></div>`;

        const cards = [
            card(RANGE_LABEL[range], fmt(s.total)),
            card("Today", fmt(today)),
            card("This session", fmt(this.sessionSeconds)),
            card("Active days", String(s.activeDays)),
            card("Avg / active day", fmt(avg)),
            card("Best day", s.bestDay && s.bestDay.seconds > 0 ? `${fmt(s.bestDay.seconds)} (${s.bestDay.date})` : "-"),
            card("Current streak", `${this.streak()} day${this.streak() === 1 ? "" : "s"}`), card(`VS Code open (${RANGE_LABEL[range]})`, fmt(openTotal)),
            card("Active share", `${share}%`),
            card("Open this session", fmt(this.sessionOpenSeconds)),
        ].join("");

        const bars = (items: [string, number][], colored: boolean) =>
            items.length === 0
                ? `<p class="muted">No data for this range yet.</p>`
                : items.map(([name, secs]) => {
                    const pct = s.total > 0 ? (secs / s.total) * 100 : 0;
                    const color = colored ? colorFor(name) : "var(--vscode-button-background)";
                    return `<div class="row">
                        <span class="name" title="${esc(name)}">${esc(name)}</span>
                        <div class="bar"><div class="fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
                        <span class="val">${fmt(secs)}</span>
                        <span class="pct">${pct.toFixed(0)}%</span>
                    </div>`;
                }).join("");

        const maxDay = Math.max(1, ...s.daily.map((d) => d.seconds));
        const chart = range === "today" ? "" : `
            <h2>Daily activity</h2>
            <div class="chart">${s.daily.map((d) => {
            const h = (d.seconds / maxDay) * 100;
            return `<div class="col" title="${d.date}: ${fmt(d.seconds)}">
                    <div class="colbar" style="height:${h.toFixed(1)}%"></div>
                    <div class="collabel">${s.daily.length <= 7 ? d.date.slice(5) : ""}</div>
                </div>`;
        }).join("")}</div>`;

        const rangeBtn = (r: Range) =>
            `<button data-range="${r}" class="${r === range ? "active" : ""}">${RANGE_LABEL[r]}</button>`;

        const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 24px; max-width: 900px; }
  h1 { font-weight: 600; margin-bottom: 4px; }
  h2 { font-size: 1.05em; margin: 28px 0 10px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0; }
  .spacer { flex: 1; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: none; padding: 5px 12px; border-radius: 3px; cursor: pointer; font-size: 0.9em; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border);
          border-radius: 6px; padding: 10px 12px; }
  .cl { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  .cv { font-size: 1.15em; font-weight: 600; margin-top: 4px; }
  .row { display: grid; grid-template-columns: 140px 1fr 80px 42px; align-items: center; gap: 10px; margin: 6px 0; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { background: var(--vscode-editorWidget-background); height: 10px; border-radius: 5px; overflow: hidden; }
  .fill { height: 100%; border-radius: 5px; }
  .val, .pct { text-align: right; font-variant-numeric: tabular-nums; }
  .pct { color: var(--vscode-descriptionForeground); }
  .chart { display: flex; align-items: flex-end; gap: 3px; height: 140px; padding-top: 8px; }
  .col { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: stretch; }
  .colbar { background: var(--vscode-button-background); border-radius: 3px 3px 0 0; min-height: 2px; }
  .collabel { font-size: 0.7em; text-align: center; color: var(--vscode-descriptionForeground); height: 14px; }
</style></head>
<body>
  <h1>CodeTime</h1>
  <div class="muted">Status: ${this.enabled ? "tracking enabled" : "tracking stopped"}</div>

  <div class="toolbar">
    ${rangeBtn("today")}${rangeBtn("7d")}${rangeBtn("30d")}${rangeBtn("all")}
    <span class="spacer"></span>
    <button data-action="toggle">${this.enabled ? "Stop tracking" : "Start tracking"}</button>
    <button data-action="refresh">Refresh</button>
    <button data-action="export">Export</button>
    <button data-action="reset">Reset</button>
  </div>

  <div class="cards">${cards}</div>

  <h2>Languages (${RANGE_LABEL[range]})</h2>
  ${bars(s.languages, true)}

  <h2>Projects (${RANGE_LABEL[range]})</h2>
  ${bars(s.projects, false)}

  ${chart}

<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  document.querySelectorAll('[data-range]').forEach(b =>
    b.addEventListener('click', () => api.postMessage({ type: 'range', value: b.dataset.range })));
  document.querySelectorAll('[data-action]').forEach(b =>
    b.addEventListener('click', () => api.postMessage({ type: 'action', value: b.dataset.action })));
</script>
</body></html>`;
    }

    // ----- export / reset -----

    async exportData(): Promise<void> {
        const pick = await vscode.window.showQuickPick(["JSON", "CSV"], { title: "Export CodeTime data as..." });
        if (!pick) { return; }
        const ext = pick.toLowerCase();
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(os.homedir(), `codetime-${dateKey()}.${ext}`)),
            filters: { [pick]: [ext] },
        });
        if (!target) { return; }

        let content: string;
        if (pick === "JSON") {
            content = JSON.stringify(this.stats, null, 2);
        } else {
            const rows = ["date,project,language,seconds"];
            for (const [date, projects] of Object.entries(this.stats).sort()) {
                for (const [project, langs] of Object.entries(projects)) {
                    for (const [lang, secs] of Object.entries(langs)) {
                        rows.push(`${date},"${project.replace(/"/g, '""')}",${lang},${Math.round(secs)}`);
                    }
                }
            }
            content = rows.join("\n");
        }
        await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
        vscode.window.showInformationMessage(`CodeTime: exported to ${target.fsPath}`);
    }

    async resetData(): Promise<void> {
        const answer = await vscode.window.showWarningMessage(
            "Delete ALL CodeTime statistics? This cannot be undone.",
            { modal: true },
            "Delete all"
        );
        if (answer !== "Delete all") { return; }
        this.stats = {};
        this.openTime = {};
        this.sessionSeconds = 0;
        this.dirty = true;
        this.save();
        this.updateStatusBar();
        this.refreshPanel();
        vscode.window.showInformationMessage("CodeTime: all statistics deleted.");
    }

    dispose(): void {
        if (this.timer) { clearInterval(this.timer); }
        this.save();
        this.statusBar.dispose();
        this.panel?.dispose();
        this.disposables.forEach((d) => d.dispose());
    }
}

// ---------- activation ----------

export function activate(context: vscode.ExtensionContext): void {
    const tracker = new Tracker(context);

    context.subscriptions.push(
        tracker,
        vscode.commands.registerCommand("timeon", () => tracker.start()),
        vscode.commands.registerCommand("codetime.stop", () => tracker.stop()),
        vscode.commands.registerCommand("codetime.overview", () => tracker.showOverview()),
        vscode.commands.registerCommand("codetime.export", () => tracker.exportData()),
        vscode.commands.registerCommand("codetime.reset", () => tracker.resetData())
    );
}

export function deactivate(): void {
    // Saving is handled in Tracker.dispose()
}