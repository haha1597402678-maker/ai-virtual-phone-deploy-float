import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const maxDuration = 15;

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";

function normalizeBaseUrl(value: unknown): string {
    const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ELEVENLABS_BASE_URL;
    return raw.replace(/\/+$/, "");
}

function getRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** ElevenLabs 的错误体形如 {detail:{message,status}} 或 {detail:"..."}，取出可读文案。 */
function upstreamMessage(text: string, status: number): string {
    try {
        const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
        const detail = parsed.detail;
        if (detail && typeof detail === "object") {
            const message = (detail as { message?: unknown }).message;
            if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
        }
        if (typeof detail === "string" && detail.trim()) return detail.trim().slice(0, 300);
        if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim().slice(0, 300);
    } catch { /* 非 JSON，落回原文 */ }
    return (text || `HTTP ${status}`).slice(0, 300);
}

/** GET /v1/voices → { voices: [{ voice_id, name, ... }] }，取 id/名称。 */
function extractVoices(payload: unknown): { id: string; name: string; createdAt?: number }[] {
    const root = getRecord(payload);
    const source = Array.isArray(root.voices) ? root.voices : [];
    return source.flatMap(item => {
        const record = getRecord(item);
        const rawId = record.voice_id ?? record.voiceId ?? record.id;
        if (typeof rawId !== "string" || !rawId.trim()) return [];
        const id = rawId.trim();
        const rawName = record.name;
        const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : `音色 (${id})`;
        const created = record.created_at_unix ?? record.createdAt;
        return [{ id, name, createdAt: typeof created === "number" ? created : undefined }];
    });
}

export async function POST(request: Request) {
    try {
        return await handleGetVoices(request);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: "get_voice_failed", message: message.slice(0, 500) }, { status: 502 });
    }
}

async function handleGetVoices(request: Request) {
    const body = await request.json().catch(() => ({}));
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const baseUrl = normalizeBaseUrl(body.baseUrl);

    if (!apiKey) return NextResponse.json({ error: "missing_api_key" }, { status: 400 });

    const response = await proxyFetch(`${baseUrl}/voices`, {
        method: "GET",
        headers: { "xi-api-key": apiKey, Accept: "application/json" },
    });

    const text = await response.text();
    let data: unknown = null;
    try {
        data = JSON.parse(text);
    } catch {
        return NextResponse.json({ error: "upstream_not_json", message: text.slice(0, 500) }, { status: 502 });
    }

    if (!response.ok) {
        return NextResponse.json(
            { error: "get_voice_failed", message: upstreamMessage(text, response.status) },
            { status: 502 },
        );
    }

    return NextResponse.json({ ok: true, voices: extractVoices(data) });
}
