import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

/**
 * Desktop-only configuration (LAN access, etc.).
 * The Electron main process reads the same file at startup to decide the
 * server bind address. Changing allowLan requires an app restart to take
 * effect because the Node server is already bound.
 */

function configPath(): string {
  const dataDir = process.env.MMH_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dataDir, "desktop-config.json");
}

function readConfig(): { allowLan: boolean } {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    return { allowLan: Boolean(parsed.allowLan) };
  } catch {
    return { allowLan: false };
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, data: readConfig() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const allowLan = Boolean(body.allowLan);
    const cfg = readConfig();
    cfg.allowLan = allowLan;
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
    return NextResponse.json({ ok: true, data: cfg, restartRequired: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
