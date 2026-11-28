import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { runApiTask } from "./api.js";
import { runGeminiTask } from "./gemini.js";
import { runOpenAiTask } from "./openai.js";
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
function jsonLines(stdout) {
    const out = [];
    for (const line of stdout.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith("{"))
            continue;
        try {
            out.push(JSON.parse(t));
        }
        catch {
            /* ignore non-JSON line */
        }
    }
    return out;
}
export function parseClaude(stdout) {
    const r = jsonLines(stdout)
        .filter((e) => e.type === "result")
        .pop();
    if (!r)
        return { text: "", isError: true };
    return {
        text: typeof r.result === "string" ? r.result : "",
        costUsd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : undefined,
        isError: r.is_error === true,
    };
}
// (verify) event names: `codex exec --json` emits {"type":"item.completed","item":{"type":"agent_message","text":...}}
export function parseCodex(stdout) {
    let text = "";
    let isError = false;
    for (const e of jsonLines(stdout)) {
        if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") {
            text = e.item.text;
        }
        else if (e.type === "turn.failed" || e.type === "error") {
            isError = true;
        }
    }
    return { text, isError: isError || text === "" };
}
// (verify) `gemini -p ... --output-format json` prints one JSON object {"response": "...", ...}
export function parseGemini(stdout) {
    const start = stdout.indexOf("{");
    if (start < 0)
        return { text: "", isError: true };
    try {
        const o = JSON.parse(stdout.slice(start));
        if (o.error)
            return { text: "", isError: true };
        return { text: typeof o.response === "string" ? o.response : "", isError: typeof o.response !== "string" };
    }
    catch {
        return { text: "", isError: true };
    }
}
/** Windows only: locate the CLI via `where`. A .exe is used directly; a .cmd/.bat shim is refused (it would need shell parsing of the prompt). */
function resolveWin(spawnImpl, bin) {
    return new Promise((resolve) => {
        let out = "";
        try {
            const w = spawnImpl("where", [bin], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
            w.stdout?.on("data", (d) => (out += d.toString()));
            w.on("error", () => resolve({}));
            w.on("close", () => {
                const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                resolve({
                    exe: lines.find((l) => /\.exe$/i.test(l)),
                    shim: lines.find((l) => /\.(cmd|bat)$/i.test(l)),
                });
            });
        }
        catch {
            resolve({});
        }
    });
}
function validUrl(url) {
    if (/["'\\\s]/.test(url))
        return false;
    try {
        const u = new URL(url);
        return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
    }
    catch {
        return false;
    }
}
/** Shared name/tokenEnv/url validation for all backends. */
export function validMcpSpec(mcp) {
    return (typeof mcp?.name === "string" &&
        typeof mcp.tokenEnv === "string" &&
        typeof mcp.url === "string" &&
        NAME_RE.test(mcp.name) &&
        !mcp.name.includes("__") &&
        ENV_RE.test(mcp.tokenEnv) &&
        validUrl(mcp.url));
}
async function plan(opts, dir) {
    const { name, url, tokenEnv } = opts.mcp;
    if (!validMcpSpec(opts.mcp)) {
        throw new Error("invalid mcp name, url or tokenEnv");
    }
    switch (opts.backend) {
        case "claude": {
            const file = join(dir, "mcp.json");
            // (verify) Claude Code expands ${VAR} in --mcp-config; the token is never written to disk.
            const auth = "Bearer ${" + tokenEnv + "}";
            const cfg = { mcpServers: { [name]: { type: "http", url, headers: { Authorization: auth } } } };
            await writeFile(file, JSON.stringify(cfg), { mode: 0o600 });
            return {
                args: [
                    "-p",
                    opts.prompt,
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--mcp-config",
                    file,
                    "--strict-mcp-config",
                    "--allowedTools",
                    `mcp__${name}__search mcp__${name}__execute`,
                ],
                parse: parseClaude,
            };
        }
        case "codex":
            return {
                args: [
                    "exec",
                    "--json",
                    "-c",
                    `mcp_servers.${name}.url="${url}"`,
                    "-c",
                    `mcp_servers.${name}.bearer_token_env_var="${tokenEnv}"`,
                    "--",
                    opts.prompt,
                ],
                parse: parseCodex,
            };
        case "api":
        case "api-openai":
        case "api-gemini":
            throw new Error(`${opts.backend} backend is handled by its own runner`);
        case "gemini": {
            const file = join(dir, "settings.json");
            // (verify) GEMINI_CLI_SYSTEM_SETTINGS_PATH overrides system settings, and "$VAR" is expanded in headers.
            const auth = "Bearer $" + tokenEnv;
            const cfg = { mcpServers: { [name]: { httpUrl: url, headers: { Authorization: auth } } } };
            await writeFile(file, JSON.stringify(cfg), { mode: 0o600 });
            return {
                args: ["-p", opts.prompt, "--output-format", "json", "--allowed-mcp-server-names", name],
                env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: file },
                parse: parseGemini,
            };
        }
    }
}
function killTree(child, spawnImpl) {
    if (process.platform === "win32" && child.pid) {
        try {
            spawnImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore" });
            return;
        }
        catch {
            /* fall through */
        }
    }
    child.kill("SIGKILL");
}
/**
 * Runs one headless task through the user's own CLI login. The child inherits process.env unchanged
 * (the CLI uses whatever login or API key it already has).
 */
export async function runTask(opts) {
    if (opts.backend === "api")
        return runApiTask(opts);
    if (opts.backend === "api-openai")
        return runOpenAiTask(opts);
    if (opts.backend === "api-gemini")
        return runGeminiTask(opts);
    const spawnImpl = opts.spawnImpl ?? spawn;
    const timeoutMs = opts.timeoutMs ?? 600000;
    const bin = opts.backend;
    const dir = await mkdtemp(join(tmpdir(), "agent-runner-"));
    try {
        let p;
        try {
            p = await plan(opts, dir);
        }
        catch (e) {
            return { ok: false, text: "", error: e.message, exitCode: null };
        }
        return await new Promise((resolve) => {
            let stdout = "";
            let stderr = "";
            let done = false;
            let timer;
            const finish = (r) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                resolve(r);
            };
            const notFound = `${bin} CLI not found — install and log in`;
            const launch = (cmd, retryOnWin) => {
                const onFail = (err) => {
                    if (done)
                        return;
                    if (retryOnWin && process.platform === "win32" && (err.code === "ENOENT" || err.code === "EINVAL")) {
                        resolveWin(spawnImpl, bin).then((found) => {
                            if (found.exe) {
                                stdout = stderr = "";
                                launch(found.exe, false);
                            }
                            else if (found.shim) {
                                finish({
                                    ok: false,
                                    text: "",
                                    error: `${bin} on Windows: run under WSL/VPS or install the native binary (.exe)`,
                                    exitCode: null,
                                });
                            }
                            else {
                                finish({ ok: false, text: "", error: notFound, exitCode: null });
                            }
                        });
                        return;
                    }
                    const error = err.code === "ENOENT" ? notFound : `failed to start ${bin}: ${err.message}`;
                    finish({ ok: false, text: "", error, exitCode: null });
                };
                let child;
                try {
                    child = spawnImpl(cmd, p.args, {
                        cwd: opts.cwd,
                        shell: false,
                        stdio: ["ignore", "pipe", "pipe"],
                        env: p.env ? { ...process.env, ...p.env } : process.env,
                    });
                }
                catch (e) {
                    onFail(e);
                    return;
                }
                const outDec = new StringDecoder("utf8");
                const errDec = new StringDecoder("utf8");
                clearTimeout(timer);
                timer = setTimeout(() => {
                    killTree(child, spawnImpl);
                    finish({ ok: false, text: "", error: "timeout", exitCode: null });
                }, timeoutMs);
                child.stdout?.on("data", (d) => (stdout += outDec.write(d)));
                child.stderr?.on("data", (d) => (stderr += errDec.write(d)));
                child.on("error", onFail);
                child.on("close", (code) => {
                    if (done)
                        return;
                    stdout += outDec.end();
                    stderr += errDec.end();
                    if (code !== 0) {
                        const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-20).join("\n");
                        finish({ ok: false, text: "", error: tail || `exit code ${code}`, exitCode: code });
                        return;
                    }
                    const r = p.parse(stdout);
                    finish({
                        ok: !r.isError,
                        text: r.text,
                        costUsd: r.costUsd,
                        error: r.isError ? "CLI reported an error or produced no result" : undefined,
                        exitCode: code,
                    });
                });
            };
            launch(bin, true);
        });
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
